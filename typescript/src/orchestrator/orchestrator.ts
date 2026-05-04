import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  HashMap,
  HashSet,
  Layer,
  PubSub,
  Ref,
  Schedule,
  Stream,
} from "effect"
import * as fs from "node:fs"
import * as path from "node:path"

import type { Settings } from "../config/schema.ts"
import type { AgentPoolRole, HarnessKind } from "../agent/harness.ts"
import type { Issue } from "../tracker/issue.ts"
import { normalizeState } from "../tracker/issue.ts"
import { LinearClient } from "../tracker/linear-client.ts"
import { WorkspaceManager, type Workspace } from "../workspace/workspace.ts"
import { makeHarness } from "../agent/runner.ts"
import type {
  AgentTaskDelegate,
  AgentTaskRequest,
  AgentTaskResult,
  RateLimitSnapshot,
} from "../agent/harness.ts"
import { buildPrompt } from "../workflow/prompt-builder.ts"

export interface DispatchSnapshot {
  readonly running: ReadonlyArray<{
    readonly issueId: string
    readonly identifier: string
    readonly title: string
    readonly state: string
    readonly agent: RunningAgentInfo
    readonly processPid: number | null
    readonly startedAt: number
    readonly turn: number
    readonly latestTool: string | null
    readonly latestMessage: string | null
    readonly liveTokens: { readonly input: number; readonly output: number; readonly total: number }
  }>
  readonly retries: ReadonlyArray<{
    readonly issueId: string
    readonly identifier: string
    readonly attempt: number
    readonly dueAt: number
  }>
  readonly completed: ReadonlyArray<string>
  readonly tokensTotal: { readonly input: number; readonly output: number; readonly total: number }
  readonly rateLimits: RateLimitSnapshot | null
  readonly dispatchPausedUntil: number | null
  readonly lastTickAt: number | null
}

export interface RunningAgentInfo {
  readonly id: string
  readonly role: AgentPoolRole | null
  readonly kind: HarnessKind
  readonly model: string
  readonly effort: string
}

export type OrchestratorEvent =
  | { readonly _tag: "tick"; readonly candidates: number }
  | { readonly _tag: "dispatched"; readonly issue: Issue; readonly attempt: number }
  | { readonly _tag: "completed"; readonly issueId: string; readonly identifier: string }
  | { readonly _tag: "handed_off"; readonly issueId: string; readonly identifier: string; readonly state: string }
  | { readonly _tag: "failed"; readonly issueId: string; readonly identifier: string; readonly reason: string }
  | { readonly _tag: "max_turns_reached"; readonly issueId: string; readonly identifier: string; readonly turns: number }
  | { readonly _tag: "retry_scheduled"; readonly issueId: string; readonly identifier: string; readonly attempt: number; readonly delayMs: number }
  | { readonly _tag: "rate_limits_updated"; readonly rateLimits: RateLimitSnapshot }
  | { readonly _tag: "agent_tool"; readonly issueId: string; readonly identifier: string; readonly toolName: string }
  | { readonly _tag: "agent_message"; readonly issueId: string; readonly identifier: string; readonly preview: string }

type RunOutcome =
  | { kind: "issue_done"; finalState: string }
  | { kind: "issue_handed_off"; finalState: string }
  | { kind: "max_turns_reached" }
  | { kind: "rate_limited"; reason: string; releaseForAlternate: boolean }
  | { kind: "agent_error" }

export interface OrchestratorService {
  readonly start: Effect.Effect<never, never, never>
  readonly snapshot: Effect.Effect<DispatchSnapshot>
  readonly events: Stream.Stream<OrchestratorEvent>
}

export class Orchestrator extends Context.Tag("beethoven/Orchestrator")<
  Orchestrator,
  OrchestratorService
>() {}

const RETRY_BASE_MS = 10_000

interface RunningEntry {
  readonly issue: Issue
  readonly agent: RunningAgentInfo
  readonly processPid: number | null
  readonly startedAt: number
  readonly turn: number
  readonly latestTool: string | null
  readonly latestMessage: string | null
  readonly liveTokens: { input: number; output: number; total: number }
  readonly fiber: Fiber.RuntimeFiber<RunOutcome, never>
}

interface RetryEntry {
  readonly issue: Issue
  readonly attempt: number
  readonly dueAt: number
  readonly delayMs: number
  readonly fiber: Fiber.RuntimeFiber<void, never>
}

interface State {
  readonly running: HashMap.HashMap<string, RunningEntry>
  readonly claimed: HashSet.HashSet<string>
  readonly completed: HashSet.HashSet<string>
  readonly retries: HashMap.HashMap<string, RetryEntry>
  readonly pausedAgents: HashMap.HashMap<string, number>
  readonly tokensTotal: { input: number; output: number; total: number }
  readonly rateLimits: RateLimitSnapshot | null
  readonly dispatchPausedUntil: number | null
  readonly lastTickAt: number | null
}

const initialState = (): State => ({
  running: HashMap.empty(),
  claimed: HashSet.empty(),
  completed: HashSet.empty(),
  retries: HashMap.empty(),
  pausedAgents: HashMap.empty(),
  tokensTotal: { input: 0, output: 0, total: 0 },
  rateLimits: null,
  dispatchPausedUntil: null,
  lastTickAt: null,
})

export const OrchestratorLive = (
  settings: Settings,
  promptTemplate: string,
) =>
  Layer.scoped(
    Orchestrator,
    Effect.gen(function* () {
      const tracker = yield* LinearClient
      const workspaces = yield* WorkspaceManager

      const state = yield* Ref.make<State>(initialState())
      const events = yield* PubSub.unbounded<OrchestratorEvent>()

      const isActive = (s: string) =>
        settings.tracker.activeStates.some(
          (x) => normalizeState(x) === normalizeState(s),
        )
      const isTerminal = (s: string) =>
        settings.tracker.terminalStates.some(
          (x) => normalizeState(x) === normalizeState(s),
        )

      const canDispatch = (issue: Issue, current: State): boolean => {
        if (
          current.dispatchPausedUntil !== null &&
          current.dispatchPausedUntil > Date.now()
        ) {
          return false
        }
        if (HashSet.has(current.claimed, issue.id)) return false
        if (HashMap.size(current.running) >= settings.agent.maxConcurrentAgents) {
          return false
        }

        const stateLimit = settings.agent.maxConcurrentAgentsByState.get(
          normalizeState(issue.state),
        )
        if (typeof stateLimit === "number") {
          let inState = 0
          for (const e of HashMap.values(current.running)) {
            if (normalizeState(e.issue.state) === normalizeState(issue.state)) {
              inState++
            }
          }
          if (inState >= stateLimit) return false
        }

        if (issue.blockedBy.some((b) => b.state && !isTerminal(b.state))) {
          return false
        }
        return true
      }

      const runIssue = (
        issue: Issue,
        attempt: number,
        assignedMember: Settings["agentPool"]["members"][number] | undefined,
      ) =>
        Effect.gen(function* () {
          const agentSettings = assignedMember
            ? settingsForTopLevelPoolMember(settings, assignedMember)
            : settings
          const issueAgent = agentInfoForSettings(agentSettings, assignedMember)
          const issueHarness = makeHarness(agentSettings)
          const ws = yield* workspaces.createForIssue(issue)

          const linkResult = yield* workspaces.linkAgentSkills(ws, issueHarness.skillsPath)
          yield* Effect.logDebug("skills_link").pipe(
            Effect.annotateLogs({
              issue_identifier: issue.identifier,
              harness: issueHarness.kind,
              ...linkResult,
            }),
          )
          yield* Effect.logInfo("workspace_context_sizes").pipe(
            Effect.annotateLogs({
              issue_id: issue.id,
              identifier: issue.identifier,
              agent: issueAgent.id,
              harness: issueHarness.kind,
              ...workspaceContextSizes(ws.path, issueHarness.skillsPath),
            }),
          )

          const work = Effect.gen(function* () {
            yield* workspaces.runBeforeRun(ws, issue)

            let currentIssue = issue
            let rateLimitedReason: string | null = null
            let releaseForAlternate = false
            for (let turn = 1; turn <= settings.agent.maxTurns; turn++) {
              yield* Ref.update(state, (s) => ({
                ...s,
                running: HashMap.modify(s.running, currentIssue.id, (e) => ({
                  ...e,
                  turn,
                  liveTokens: { input: 0, output: 0, total: 0 },
                })),
              }))

              const prompt = yield* buildPrompt({
                template: promptTemplate,
                issue: currentIssue,
                attempt: turn === 1 ? (attempt > 1 ? attempt : null) : turn,
                agent: issueAgent,
              })
              yield* Effect.logInfo("agent_prompt_built").pipe(
                Effect.annotateLogs({
                  issue_id: currentIssue.id,
                  identifier: currentIssue.identifier,
                  agent: issueAgent.id,
                  harness: issueHarness.kind,
                  model: issueAgent.model,
                  turn,
                  attempt,
                  prompt_chars: prompt.length,
                  issue_description_chars: currentIssue.description?.length ?? 0,
                  issue_label_count: currentIssue.labels.length,
                }),
              )
              const delegateTask = makeAgentPoolDelegate(
                settings,
                ws,
                currentIssue,
                turn,
              )

              const onAgentEvent = (event: import("../agent/runner.ts").AgentEvent) =>
                Effect.gen(function* () {
                  if (event._tag === "process_started") {
                    yield* Ref.update(state, (s) => ({
                      ...s,
                      running: HashMap.modify(s.running, currentIssue.id, (e) => ({
                        ...e,
                        processPid: event.pid,
                      })),
                    }))
                  } else if (event._tag === "tool_call") {
                    yield* Effect.logInfo("agent_tool_call_size").pipe(
                      Effect.annotateLogs({
                        issue_id: currentIssue.id,
                        identifier: currentIssue.identifier,
                        agent: issueAgent.id,
                        tool: event.toolName,
                        tool_input_chars: approxJsonChars(event.input),
                      }),
                    )
                    yield* Ref.update(state, (s) => ({
                      ...s,
                      running: HashMap.modify(s.running, currentIssue.id, (e) => ({
                        ...e,
                        latestTool: event.toolName,
                      })),
                    }))
                    yield* PubSub.publish(events, {
                      _tag: "agent_tool",
                      issueId: currentIssue.id,
                      identifier: currentIssue.identifier,
                      toolName: event.toolName,
                    })
                  } else if (event._tag === "tool_result") {
                    yield* Effect.logInfo("agent_tool_result_size").pipe(
                      Effect.annotateLogs({
                        issue_id: currentIssue.id,
                        identifier: currentIssue.identifier,
                        agent: issueAgent.id,
                        tool_call_id: event.toolCallId,
                        tool_result_chars: approxJsonChars(event.output),
                        is_error: event.isError,
                      }),
                    )
                  } else if (event._tag === "text_delta") {
                    const preview =
                      event.text.length > 200
                        ? event.text.slice(0, 200) + "…"
                        : event.text
                    yield* Ref.update(state, (s) => ({
                      ...s,
                      running: HashMap.modify(s.running, currentIssue.id, (e) => ({
                        ...e,
                        latestMessage: preview,
                      })),
                    }))
                    yield* PubSub.publish(events, {
                      _tag: "agent_message",
                      issueId: currentIssue.id,
                      identifier: currentIssue.identifier,
                      preview,
                    })
                  } else if (event._tag === "tokens_updated") {
                    yield* Effect.logInfo("agent_tokens_updated").pipe(
                      Effect.annotateLogs({
                        issue_id: currentIssue.id,
                        identifier: currentIssue.identifier,
                        agent: issueAgent.id,
                        turn,
                        input_delta: event.delta.inputTokens,
                        output_delta: event.delta.outputTokens,
                        total_delta: event.delta.totalTokens,
                        input_total: event.cumulative.inputTokens,
                        output_total: event.cumulative.outputTokens,
                        total_tokens: event.cumulative.totalTokens,
                      }),
                    )
                    yield* Ref.update(state, (s) => ({
                      ...s,
                      running: HashMap.modify(s.running, currentIssue.id, (e) => ({
                        ...e,
                        liveTokens: {
                          input: event.cumulative.inputTokens,
                          output: event.cumulative.outputTokens,
                          total: event.cumulative.totalTokens,
                        },
                      })),
                    }))
                  } else if (event._tag === "rate_limits_updated") {
                    if (event.rateLimits.status === "rejected") {
                      const unavailableAgentIds = agentIdsPausedByRateLimit(
                        settings,
                        issueAgent,
                      )
                      releaseForAlternate = hasAlternateAgentForIssue(
                        settings,
                        currentIssue,
                        issueAgent,
                        unavailableAgentIds,
                      )
                      rateLimitedReason = rateLimitReleaseReason(
                        event.rateLimits,
                        releaseForAlternate,
                      )
                    }
                    yield* Ref.update(state, (s) => {
                      const pausedUntil = effectivePausedUntil(event.rateLimits)
                      const effectivePauseUntil =
                        event.rateLimits.status === "rejected"
                          ? pausedUntil ?? Date.now() + settings.agent.maxRetryBackoffMs
                          : pausedUntil
                      const shouldPauseDispatch =
                        event.rateLimits.status !== "rejected" || !releaseForAlternate
                      return {
                        ...s,
                        rateLimits: event.rateLimits,
                        pausedAgents:
                          event.rateLimits.status === "rejected" && effectivePauseUntil !== null
                            ? pauseEquivalentAgents(
                                s.pausedAgents,
                                settings,
                                issueAgent,
                                effectivePauseUntil,
                              )
                            : s.pausedAgents,
                        dispatchPausedUntil:
                          event.rateLimits.status === "allowed"
                            ? null
                            : !shouldPauseDispatch || effectivePauseUntil === null
                              ? s.dispatchPausedUntil
                              : Math.max(s.dispatchPausedUntil ?? 0, effectivePauseUntil),
                      }
                    })
                    yield* Effect.logInfo("rate_limits_updated").pipe(
                      Effect.annotateLogs({
                        harness: event.rateLimits.harness,
                        limit_id: event.rateLimits.limitId,
                        status: event.rateLimits.status ?? "unknown",
                        paused_until: event.rateLimits.pausedUntil ?? null,
                        reason: event.rateLimits.reason ?? null,
                      }),
                    )
                    yield* PubSub.publish(events, {
                      _tag: "rate_limits_updated",
                      rateLimits: event.rateLimits,
                    })
                  }
                })

              const result = yield* issueHarness
                .run(
                  { workspace: ws, issue: currentIssue, prompt, turnNumber: turn, delegateTask },
                  onAgentEvent,
                )
                .pipe(Effect.either)

              if (result._tag === "Left") {
                if (rateLimitedReason !== null) {
                  return {
                    kind: "rate_limited",
                    reason: rateLimitedReason,
                    releaseForAlternate,
                  } as RunOutcome
                }
                yield* Effect.logError("agent_run_errored").pipe(
                  Effect.annotateLogs({
                    issue_id: issue.id,
                    identifier: issue.identifier,
                    cause: stringifyCause(result.left.cause),
                  }),
                )
                return { kind: "agent_error" } as RunOutcome
              }

              yield* Ref.update(state, (s) => ({
                ...s,
                tokensTotal: {
                  input: s.tokensTotal.input + result.right.inputTokens,
                  output: s.tokensTotal.output + result.right.outputTokens,
                  total: s.tokensTotal.total + result.right.totalTokens,
                },
              }))

              if (result.right.status !== "completed") {
                if (rateLimitedReason !== null) {
                  return {
                    kind: "rate_limited",
                    reason: rateLimitedReason,
                    releaseForAlternate,
                  } as RunOutcome
                }
                return { kind: "agent_error" } as RunOutcome
              }

              const refreshed = yield* tracker
                .fetchIssuesByIds([currentIssue.id])
                .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<Issue>))

              const next = refreshed[0]
              if (!next) {
                return {
                  kind: "issue_handed_off",
                  finalState: currentIssue.state,
                } as RunOutcome
              }
              if (!isActive(next.state)) {
                return isTerminal(next.state)
                  ? ({ kind: "issue_done", finalState: next.state } as RunOutcome)
                  : ({
                      kind: "issue_handed_off",
                      finalState: next.state,
                    } as RunOutcome)
              }
              currentIssue = next
            }
            return { kind: "max_turns_reached" } as RunOutcome
          })

          return yield* work.pipe(
            Effect.ensuring(workspaces.runAfterRun(ws, issue)),
          )
        })

      const dispatch = (issue: Issue, attempt: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          const assignedMember = selectIssueAgentPoolMember(
            settings,
            issue,
            activePausedAgentIds(current),
          )
          if (hasConfiguredAgentPool(settings) && assignedMember === undefined) {
            yield* Effect.logWarning("dispatch_deferred_no_available_agent").pipe(
              Effect.annotateLogs({
                issue_id: issue.id,
                identifier: issue.identifier,
                attempt,
              }),
            )
            yield* scheduleRetry(issue, attempt)
            return
          }
          const assignedAgent = agentInfoForSettings(
            assignedMember ? settingsForTopLevelPoolMember(settings, assignedMember) : settings,
            assignedMember,
          )
          const work = runIssue(issue, attempt, assignedMember).pipe(
            Effect.catchAll((cause) =>
              Effect.logError("dispatch_failed").pipe(
                Effect.annotateLogs({
                  issue_id: issue.id,
                  identifier: issue.identifier,
                  cause: String(cause),
                }),
                Effect.as({ kind: "agent_error" } as RunOutcome),
              ),
            ),
          )

          const onComplete = (exit: Exit.Exit<RunOutcome, never>) =>
            Effect.gen(function* () {
              const outcome: RunOutcome = Exit.isSuccess(exit)
                ? exit.value
                : { kind: "agent_error" }
              // External interruption (terminal-state reconcile) is not a failure.
              const interrupted =
                Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)
              const trulyCompleted = interrupted || outcome.kind === "issue_done"

              yield* Ref.update(state, (s) => ({
                ...s,
                running: HashMap.remove(s.running, issue.id),
                claimed:
                  outcome.kind === "rate_limited" && !outcome.releaseForAlternate
                    ? s.claimed
                    : HashSet.remove(s.claimed, issue.id),
                completed: trulyCompleted
                  ? HashSet.add(s.completed, issue.id)
                  : s.completed,
              }))

              if (trulyCompleted) {
                yield* PubSub.publish(events, {
                  _tag: "completed",
                  issueId: issue.id,
                  identifier: issue.identifier,
                })
              } else if (outcome.kind === "issue_handed_off") {
                yield* PubSub.publish(events, {
                  _tag: "handed_off",
                  issueId: issue.id,
                  identifier: issue.identifier,
                  state: outcome.finalState,
                })
              } else if (outcome.kind === "max_turns_reached") {
                yield* PubSub.publish(events, {
                  _tag: "max_turns_reached",
                  issueId: issue.id,
                  identifier: issue.identifier,
                  turns: settings.agent.maxTurns,
                })
              } else if (outcome.kind === "rate_limited" && outcome.releaseForAlternate) {
                yield* Effect.logWarning("agent_rate_limited_released").pipe(
                  Effect.annotateLogs({
                    issue_id: issue.id,
                    identifier: issue.identifier,
                    agent: assignedAgent.id,
                    reason: outcome.reason,
                  }),
                )
                yield* PubSub.publish(events, {
                  _tag: "failed",
                  issueId: issue.id,
                  identifier: issue.identifier,
                  reason: outcome.reason,
                })
              } else if (outcome.kind === "rate_limited") {
                yield* Effect.logWarning("agent_rate_limited_waiting").pipe(
                  Effect.annotateLogs({
                    issue_id: issue.id,
                    identifier: issue.identifier,
                    agent: assignedAgent.id,
                    reason: outcome.reason,
                  }),
                )
                yield* PubSub.publish(events, {
                  _tag: "failed",
                  issueId: issue.id,
                  identifier: issue.identifier,
                  reason: outcome.reason,
                })
              } else {
                yield* PubSub.publish(events, {
                  _tag: "failed",
                  issueId: issue.id,
                  identifier: issue.identifier,
                  reason: "agent run errored",
                })
              }

              // max_turns and handed_off are "not done yet" signals — the issue
              // is either still active or waiting on a human. The next poll
              // tick handles both naturally. Retry only when this agent should
              // resume later instead of releasing the issue for another model.
              if (
                (outcome.kind === "agent_error" ||
                  (outcome.kind === "rate_limited" && !outcome.releaseForAlternate)) &&
                !interrupted
              ) {
                yield* scheduleRetry(issue, attempt + 1)
              }
            })

          const fiber = yield* Effect.forkDaemon(
            work.pipe(Effect.onExit(onComplete)),
          )

          yield* Ref.update(state, (s) => ({
            ...s,
            claimed: HashSet.add(s.claimed, issue.id),
            running: HashMap.set(s.running, issue.id, {
              issue,
              agent: assignedAgent,
              processPid: null,
              startedAt: Date.now(),
              turn: 1,
              latestTool: null,
              latestMessage: null,
              liveTokens: { input: 0, output: 0, total: 0 },
              fiber,
            }),
          }))

          yield* PubSub.publish(events, { _tag: "dispatched", issue, attempt })
        })

      const scheduleRetry = (
        issue: Issue,
        attempt: number,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          const prevDelay = HashMap.get(current.retries, issue.id).pipe(
            (opt) => (opt._tag === "Some" ? opt.value.delayMs : RETRY_BASE_MS),
          )
          const delayMs = decorrelatedJitter(
            prevDelay,
            RETRY_BASE_MS,
            settings.agent.maxRetryBackoffMs,
          )
          const pauseDelayMs =
            current.dispatchPausedUntil !== null
              ? Math.max(0, current.dispatchPausedUntil - Date.now())
              : 0
          const effectiveDelayMs = Math.max(delayMs, pauseDelayMs)

          const fiber = yield* Effect.forkDaemon(
            Effect.sleep(Duration.millis(effectiveDelayMs)).pipe(
              Effect.flatMap(() =>
                Ref.update(state, (s) => ({
                  ...s,
                  retries: HashMap.remove(s.retries, issue.id),
                })),
              ),
              Effect.flatMap(() => dispatch(issue, attempt)),
            ),
          )

          yield* Ref.update(state, (s) => ({
            ...s,
            claimed: HashSet.add(s.claimed, issue.id),
            retries: HashMap.set(s.retries, issue.id, {
              issue,
              attempt,
              dueAt: Date.now() + effectiveDelayMs,
              delayMs: effectiveDelayMs,
              fiber,
            }),
          }))
          yield* PubSub.publish(events, {
            _tag: "retry_scheduled",
            issueId: issue.id,
            identifier: issue.identifier,
            attempt,
            delayMs: effectiveDelayMs,
          })
        })

      const reconcileTerminal = Effect.gen(function* () {
        const s = yield* Ref.get(state)
        const ids = [
          ...HashMap.keys(s.running),
          ...HashMap.keys(s.retries),
        ]
        if (ids.length === 0) return
        const refreshed = yield* tracker
          .fetchIssuesByIds(ids)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<Issue>))

        for (const issue of refreshed) {
          if (!isTerminal(issue.state)) continue
          const running = HashMap.get(s.running, issue.id)
          if (running._tag === "Some") {
            yield* Fiber.interrupt(running.value.fiber)
          }
          const retry = HashMap.get(s.retries, issue.id)
          if (retry._tag === "Some") {
            yield* Fiber.interrupt(retry.value.fiber)
            yield* Ref.update(state, (s2) => ({
              ...s2,
              retries: HashMap.remove(s2.retries, issue.id),
              claimed: HashSet.remove(s2.claimed, issue.id),
            }))
          }
        }
      })

      const tick = Effect.gen(function* () {
        const candidates = yield* tracker
          .fetchIssuesByStates(settings.tracker.activeStates)
          .pipe(
            Effect.tapError((e) =>
              Effect.logError("tracker_poll_failed").pipe(
                Effect.annotateLogs({ error: String(e) }),
              ),
            ),
            Effect.orElseSucceed(() => [] as ReadonlyArray<Issue>),
          )

        yield* Ref.update(state, (s) => ({ ...s, lastTickAt: Date.now() }))
        yield* PubSub.publish(events, { _tag: "tick", candidates: candidates.length })

        for (const issue of sortForDispatch(candidates, settings.tracker.activeStates)) {
          const updated = yield* Ref.get(state)
          if (!canDispatch(issue, updated)) continue
          if (
            hasConfiguredAgentPool(settings) &&
            selectIssueAgentPoolMember(
              settings,
              issue,
              activePausedAgentIds(updated),
            ) === undefined
          ) {
            yield* scheduleRetry(issue, 1)
            continue
          }
          yield* dispatch(issue, 1)
        }

        yield* reconcileTerminal
      })

      const start: OrchestratorService["start"] = Effect.repeat(
        tick.pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError("tick_failed").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            ),
          ),
        ),
        Schedule.spaced(`${settings.polling.intervalMs} millis`),
      ) as Effect.Effect<never, never, never>

      const snapshot: OrchestratorService["snapshot"] = Ref.get(state).pipe(
        Effect.map((s) => ({
          running: Array.from(HashMap.values(s.running)).map((e) => ({
            issueId: e.issue.id,
            identifier: e.issue.identifier,
            title: e.issue.title,
            state: e.issue.state,
            agent: e.agent,
            processPid: e.processPid,
            startedAt: e.startedAt,
            turn: e.turn,
            latestTool: e.latestTool,
            latestMessage: e.latestMessage,
            liveTokens: { ...e.liveTokens },
          })),
          retries: Array.from(HashMap.values(s.retries)).map((e) => ({
            issueId: e.issue.id,
            identifier: e.issue.identifier,
            attempt: e.attempt,
            dueAt: e.dueAt,
          })),
          completed: Array.from(HashSet.values(s.completed)),
          tokensTotal: { ...s.tokensTotal },
          rateLimits: s.rateLimits,
          dispatchPausedUntil:
            s.dispatchPausedUntil !== null && s.dispatchPausedUntil > Date.now()
              ? s.dispatchPausedUntil
              : null,
          lastTickAt: s.lastTickAt,
        })),
      )

      return {
        start,
        snapshot,
        events: Stream.fromPubSub(events),
      }
    }),
  )

function sortForDispatch(
  issues: ReadonlyArray<Issue>,
  activeStates: ReadonlyArray<string>,
): ReadonlyArray<Issue> {
  const stateRank = new Map(
    activeStates.map((state, index) => [normalizeState(state), index]),
  )
  return [...issues].sort((a, b) => {
    const ar = stateRank.get(normalizeState(a.state)) ?? -1
    const br = stateRank.get(normalizeState(b.state)) ?? -1
    if (ar !== br) return br - ar
    const ap = a.priority ?? Number.POSITIVE_INFINITY
    const bp = b.priority ?? Number.POSITIVE_INFINITY
    if (ap !== bp) return ap - bp
    const at = a.updatedAt ?? ""
    const bt = b.updatedAt ?? ""
    return at < bt ? -1 : at > bt ? 1 : 0
  })
}

function agentInfoForSettings(
  settings: Settings,
  member: Settings["agentPool"]["members"][number] | undefined,
): RunningAgentInfo {
  return {
    id: member?.id ?? settings.runtime.kind,
    role: member?.role ?? null,
    kind: member?.kind ?? settings.runtime.kind,
    model: member?.model ?? settings.runtime.common.model ?? settings.runtime.kind,
    effort: member?.effort ?? settings.runtime.common.effort ?? "default",
  }
}

function selectIssueAgentPoolMember(
  settings: Settings,
  issue: Issue,
  unavailableAgentIds: ReadonlySet<string> = new Set(),
): Settings["agentPool"]["members"][number] | undefined {
  if (
    normalizeState(issue.state) ===
    normalizeState(settings.agentPool.aiReviewState)
  ) {
    return selectAiReviewMember(settings, unavailableAgentIds)
  }

  return selectPrimaryMember(settings, unavailableAgentIds)
}

function selectPrimaryMember(
  settings: Settings,
  unavailableAgentIds: ReadonlySet<string> = new Set(),
): Settings["agentPool"]["members"][number] | undefined {
  const weighted = settings.agentPool.primaryCandidates
    .map((entry) => ({
      member: settings.agentPool.members.find((candidate) => candidate.id === entry.id),
      weight: entry.weight,
    }))
    .filter(
      (entry): entry is {
        readonly member: Settings["agentPool"]["members"][number]
        readonly weight: number
      } => entry.member !== undefined && entry.weight > 0,
    )
    .filter((entry) => !unavailableAgentIds.has(entry.member.id))

  if (weighted.length > 0) {
    return weightedRandom(weighted)
  }

  if (settings.agentPool.primaryCandidates.length > 0) {
    return undefined
  }

  if (settings.agentPool.primaryAgent) {
    const primary = settings.agentPool.members.find(
      (candidate) => candidate.id === settings.agentPool.primaryAgent,
    )
    if (primary && !unavailableAgentIds.has(primary.id)) return primary
  }

  const fallback = settings.agentPool.members.find(
    (candidate) =>
      settings.agentPool.primaryFallbackRoles.includes(candidate.role) &&
      !unavailableAgentIds.has(candidate.id),
  )
  if (fallback) {
    return fallback
  }

  return undefined
}

function selectAiReviewMember(
  settings: Settings,
  unavailableAgentIds: ReadonlySet<string> = new Set(),
): Settings["agentPool"]["members"][number] | undefined {
  const primary = selectPrimaryReferenceMember(settings)
  const requestedCapabilities = settings.agentPool.aiReviewCapabilities
  const reviewers = settings.agentPool.members.filter(
    (candidate) =>
      !unavailableAgentIds.has(candidate.id) &&
      requestedCapabilities.every((capability) =>
        candidate.capabilities.includes(capability),
      ),
  )

  if (reviewers.length === 0) return selectPrimaryMember(settings, unavailableAgentIds)

  const notPrimary = primary
    ? reviewers.filter((candidate) => candidate.id !== primary.id)
    : reviewers
  const pool = notPrimary.length > 0 ? notPrimary : reviewers

  if (settings.agentPool.aiReviewPreferDifferentHarness && primary) {
    const differentHarness = pool.filter(
      (candidate) => candidate.kind !== primary.kind,
    )
    if (differentHarness.length > 0) return randomMember(differentHarness)
  }

  if (primary) {
    const differentModel = pool.filter(
      (candidate) => candidate.model !== primary.model,
    )
    if (differentModel.length > 0) return randomMember(differentModel)
  }

  return randomMember(pool)
}

function selectPrimaryReferenceMember(
  settings: Settings,
): Settings["agentPool"]["members"][number] | undefined {
  if (settings.agentPool.primaryAgent) {
    const primary = settings.agentPool.members.find(
      (candidate) => candidate.id === settings.agentPool.primaryAgent,
    )
    if (primary) return primary
  }
  const firstCandidate = settings.agentPool.primaryCandidates[0]
  return firstCandidate
    ? settings.agentPool.members.find((candidate) => candidate.id === firstCandidate.id)
    : undefined
}

function weightedRandom(
  entries: ReadonlyArray<{
    readonly member: Settings["agentPool"]["members"][number]
    readonly weight: number
  }>,
): Settings["agentPool"]["members"][number] {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  let target = Math.random() * total
  for (const entry of entries) {
    target -= entry.weight
    if (target <= 0) return entry.member
  }
  return entries[entries.length - 1]!.member
}

function randomMember<T>(members: ReadonlyArray<T>): T {
  return members[Math.floor(Math.random() * members.length)]!
}

function activePausedAgentIds(state: State): ReadonlySet<string> {
  const now = Date.now()
  return new Set(
    HashMap.toEntries(state.pausedAgents)
      .filter(([, pausedUntil]) => pausedUntil > now)
      .map(([agentId]) => agentId),
  )
}

function agentIdsPausedByRateLimit(
  settings: Settings,
  currentAgent: RunningAgentInfo,
): ReadonlySet<string> {
  const ids = new Set<string>([currentAgent.id])

  for (const member of settings.agentPool.members) {
    const memberInfo = agentInfoForSettings(
      settingsForTopLevelPoolMember(settings, member),
      member,
    )
    if (
      memberInfo.kind === currentAgent.kind &&
      memberInfo.model === currentAgent.model
    ) {
      ids.add(memberInfo.id)
    }
  }

  return ids
}

function pauseEquivalentAgents(
  pausedAgents: HashMap.HashMap<string, number>,
  settings: Settings,
  currentAgent: RunningAgentInfo,
  pausedUntil: number,
): HashMap.HashMap<string, number> {
  let next = HashMap.set(pausedAgents, currentAgent.id, pausedUntil)

  for (const member of settings.agentPool.members) {
    const memberInfo = agentInfoForSettings(
      settingsForTopLevelPoolMember(settings, member),
      member,
    )
    if (
      memberInfo.kind === currentAgent.kind &&
      memberInfo.model === currentAgent.model
    ) {
      next = HashMap.set(next, memberInfo.id, pausedUntil)
    }
  }

  return next
}

function hasAlternateAgentForIssue(
  settings: Settings,
  issue: Issue,
  currentAgent: RunningAgentInfo,
  unavailableAgentIds: ReadonlySet<string> = new Set(),
): boolean {
  if (settings.agentPool.onPrimaryUnavailable !== "reassign") return false

  const member = selectIssueAgentPoolMember(settings, issue, unavailableAgentIds)
  if (member === undefined) return false

  const alternateInfo = agentInfoForSettings(
    settingsForTopLevelPoolMember(settings, member),
    member,
  )
  return (
    alternateInfo.id !== currentAgent.id &&
    (alternateInfo.kind !== currentAgent.kind ||
      alternateInfo.model !== currentAgent.model)
  )
}

function hasConfiguredAgentPool(settings: Settings): boolean {
  return settings.agentPool.members.length > 0
}

function makeAgentPoolDelegate(
  settings: Settings,
  workspace: Workspace,
  issue: Issue,
  turnNumber: number,
): AgentTaskDelegate {
  return async (request) => {
    const member = selectAgentPoolMember(settings, request)
    if (!member) {
      throw new Error(`No agent pool member matched delegation request`)
    }

    const maxOutputChars = request.maxOutputChars ?? member.maxOutputChars
    const memberSettings = settingsForPoolMember(settings, member)
    const harness = makeHarness(memberSettings)
    const result = await Effect.runPromise(
      harness.run({
        workspace,
        issue,
        prompt: buildDelegatedAgentPrompt(member, issue, request),
        turnNumber,
      }),
    )
    return {
      agentId: member.id,
      status: result.status,
      output: truncate(result.finalText ?? "", maxOutputChars),
      sessionId: result.sessionId,
      threadId: result.threadId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
    } satisfies AgentTaskResult
  }
}

function selectAgentPoolMember(
  settings: Settings,
  request: AgentTaskRequest,
): Settings["agentPool"]["members"][number] | undefined {
  if (request.agentId) {
    return settings.agentPool.members.find((candidate) => candidate.id === request.agentId)
  }

  const requestedRole = request.role ?? "soloist"
  const requestedCapabilities = request.capabilities ?? []
  return settings.agentPool.members.find((candidate) => {
    if (candidate.role !== requestedRole) return false
    return requestedCapabilities.every((capability) =>
      candidate.capabilities.includes(capability),
    )
  })
}

function settingsForPoolMember(
  settings: Settings,
  member: Settings["agentPool"]["members"][number],
): Settings {
  return {
    ...settings,
    runtime: {
      ...settings.runtime,
      kind: member.kind,
      common: {
        ...settings.runtime.common,
        model: member.model,
        effort: member.effort,
        permissionMode: member.permissionMode,
        allowedTools: member.allowedTools,
        disallowedTools: member.disallowedTools,
        cwd: member.cwd ?? settings.runtime.common.cwd,
        turnTimeoutMs: member.timeoutMs,
        env: {
          ...(settings.runtime.common.env ?? {}),
          ...(member.env ?? {}),
        },
      },
      claude: member.claude,
      codex: {
        ...member.codex,
        sandboxPolicy: member.codex.sandboxPolicy ?? "readOnly",
      },
      gemini: member.gemini,
      opencode: member.opencode,
    },
    agentPool: {
      ...settings.agentPool,
      members: [],
    },
  }
}

function settingsForTopLevelPoolMember(
  settings: Settings,
  member: Settings["agentPool"]["members"][number],
): Settings {
  const memberSettings = settingsForPoolMember(settings, member)
  return {
    ...memberSettings,
    agentPool: settings.agentPool,
  }
}

function buildDelegatedAgentPrompt(
  member: Settings["agentPool"]["members"][number],
  issue: Issue,
  request: AgentTaskRequest,
): string {
  const files =
    request.files && request.files.length > 0
      ? request.files.map((file) => `- ${file}`).join("\n")
      : "- No specific files supplied. Inspect only what is needed."

  return [
    "You are a Beethoven delegated agent handling a substantial work package.",
    "",
    "You are not the primary owner for this Linear issue. Do not commit, push, merge, create PRs, edit tracker state, or make durable file changes unless the task explicitly asks for a patch. Prefer read-only investigation and concise advice.",
    "Do not add filler comments that restate identifiers, branches, function names, types, or obvious control flow. Add comments only for non-obvious domain invariants, safety/security constraints, concurrency concerns, migration rationale, or cross-module contracts.",
    "",
    `Agent: ${member.id}`,
    `Role: ${member.role}`,
    member.capabilities.length > 0
      ? `Capabilities: ${member.capabilities.join(", ")}`
      : null,
    `Harness: ${member.kind}`,
    member.model ? `Model: ${member.model}` : null,
    member.effort ? `Effort: ${member.effort}` : null,
    member.instructions ? `Instructions:\n${member.instructions}` : null,
    "",
    "Issue:",
    `- ${issue.identifier}: ${issue.title}`,
    issue.url ? `- URL: ${issue.url}` : null,
    issue.description ? `- Description:\n${issue.description}` : null,
    "",
    "Task:",
    request.task,
    request.context ? `\nContext:\n${request.context}` : null,
    "",
    "Relevant files or directories:",
    files,
    request.outputFormat ? `\nReturn format:\n${request.outputFormat}` : null,
    "",
    "Return only the answer needed by the primary agent. Include blockers or uncertainty explicitly.",
  ]
    .filter((part): part is string => part !== null)
    .join("\n")
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) + "\n[truncated]" : value
}

function approxJsonChars(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === "string") return value.length
  try {
    return JSON.stringify(value).length
  } catch {
    return String(value).length
  }
}

function workspaceContextSizes(
  workspaceRoot: string,
  harnessSkillsPath: string,
): Record<string, number | string> {
  const agentsSkills = scanWorkspacePath(workspaceRoot, ".agents/skills")
  const harnessSkills = scanWorkspacePath(workspaceRoot, harnessSkillsPath)
  const remember = scanWorkspacePath(workspaceRoot, ".remember")
  const beaconSkills = scanWorkspacePath(workspaceRoot, ".beacon-skills")
  const rootReadme = scanWorkspacePath(workspaceRoot, "README.md")
  return {
    agents_skills_bytes: agentsSkills.bytes,
    agents_skills_files: agentsSkills.files,
    agents_skills_dirs: agentsSkills.dirs,
    harness_skills_path: harnessSkillsPath,
    harness_skills_bytes: harnessSkills.bytes,
    harness_skills_files: harnessSkills.files,
    harness_skills_dirs: harnessSkills.dirs,
    harness_skills_symlink: harnessSkills.symlink ? 1 : 0,
    remember_bytes: remember.bytes,
    remember_files: remember.files,
    remember_dirs: remember.dirs,
    beacon_skills_bytes: beaconSkills.bytes,
    beacon_skills_files: beaconSkills.files,
    beacon_skills_dirs: beaconSkills.dirs,
    root_readme_bytes: rootReadme.bytes,
  }
}

interface PathScan {
  readonly bytes: number
  readonly files: number
  readonly dirs: number
  readonly symlink: boolean
}

function scanWorkspacePath(workspaceRoot: string, relativePath: string): PathScan {
  const target = path.resolve(workspaceRoot, relativePath)
  try {
    return scanPath(target)
  } catch {
    return { bytes: 0, files: 0, dirs: 0, symlink: false }
  }
}

function scanPath(target: string): PathScan {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink()) {
    return { bytes: stat.size, files: 0, dirs: 0, symlink: true }
  }
  if (stat.isFile()) {
    return { bytes: stat.size, files: 1, dirs: 0, symlink: false }
  }
  if (!stat.isDirectory()) {
    return { bytes: stat.size, files: 0, dirs: 0, symlink: false }
  }

  let bytes = stat.size
  let files = 0
  let dirs = 1
  const stack = [target]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = path.join(dir, entry)
      let childStat: fs.Stats
      try {
        childStat = fs.lstatSync(child)
      } catch {
        continue
      }
      bytes += childStat.size
      if (childStat.isSymbolicLink()) continue
      if (childStat.isDirectory()) {
        dirs++
        stack.push(child)
      } else if (childStat.isFile()) {
        files++
      }
    }
  }
  return { bytes, files, dirs, symlink: false }
}

// AWS-classic decorrelated jitter: prev = min(cap, randomBetween(base, prev * 3)).
// Bounded growth per step keeps operator dashboards readable while still
// decorrelating concurrent retries.
function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}${cause.stack ? "\n" + cause.stack : ""}`
  }
  if (typeof cause === "string") return cause
  try {
    return JSON.stringify(cause)
  } catch {
    return String(cause)
  }
}

function decorrelatedJitter(prev: number, base: number, cap: number): number {
  const upper = Math.min(cap, prev * 3)
  if (upper <= base) return Math.min(cap, base)
  return Math.floor(base + Math.random() * (upper - base))
}

function effectivePausedUntil(rateLimits: RateLimitSnapshot): number | null {
  if (rateLimits.pausedUntil !== undefined && rateLimits.pausedUntil > Date.now()) {
    return rateLimits.pausedUntil
  }
  if (rateLimits.status !== "rejected") return null

  const resetAt = rateLimits.primary?.resetAt ?? rateLimits.secondary?.resetAt
  return resetAt !== undefined && resetAt > Date.now() ? resetAt : null
}

function rateLimitReleaseReason(
  rateLimits: RateLimitSnapshot,
  releaseForAlternate: boolean,
): string {
  const resetAt = effectivePausedUntil(rateLimits)
  const resetSuffix =
    resetAt === null
      ? ""
      : ` until ${new Date(resetAt).toISOString()}`
  const detail = rateLimits.reason ? `: ${rateLimits.reason}` : ""
  const action = releaseForAlternate
    ? "released issue for another harness/model"
    : "waiting for rate limit reset"
  return `agent rate limit exhausted for ${rateLimits.harness}/${rateLimits.limitId}${resetSuffix}; ${action}${detail}`
}

export const __testing = {
  agentIdsPausedByRateLimit,
  hasAlternateAgentForIssue,
  selectIssueAgentPoolMember,
  sortForDispatch,
} as const
