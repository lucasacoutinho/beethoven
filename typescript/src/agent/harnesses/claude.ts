import { Effect, Ref, Stream } from "effect"
import * as path from "node:path"
import {
  query,
  type SDKMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk"

import type {
  AgentEvent,
  AgentRunInput,
  AgentRunResult,
  AgentTokens,
  Harness,
  RateLimitBucket,
  RateLimitSnapshot,
} from "../harness.ts"
import { AgentRunError } from "../harness.ts"
import type { Settings } from "../../config/schema.ts"
import {
  claudeBeethovenMcpServers,
  claudeBeethovenToolNames,
} from "./claude-tools.ts"

const FALLBACK_LIMIT_PAUSE_MS = 300_000

export const makeClaudeHarness = (settings: Settings): Harness => {
  const claude = settings.runtime.claude
  const common = settings.runtime.common

  const buildOptions = (input: AgentRunInput): Options => {
    const sessionCwd = path.resolve(input.workspace.path, common.cwd)

    const baseEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(Bun.env)) {
      if (typeof v === "string") baseEnv[k] = v
    }
    const mergedEnv = common.env ? { ...baseEnv, ...common.env } : baseEnv

    const thinking: Options["thinking"] | undefined =
      claude.thinkingMode === "adaptive"
        ? { type: "adaptive" }
        : claude.thinkingMode === "disabled"
          ? { type: "disabled" }
          : claude.thinkingMode === "enabled"
            ? {
                type: "enabled",
                budgetTokens: claude.thinkingBudgetTokens ?? 8_000,
              }
            : undefined
    const mcpServers = {
      ...(common.mcpServers
        ? (common.mcpServers as NonNullable<Options["mcpServers"]>)
        : {}),
      ...claudeBeethovenMcpServers(settings, input),
    }
    const allowedTools = common.allowedTools
      ? Array.from(new Set([...common.allowedTools, ...claudeBeethovenToolNames(settings)]))
      : undefined

    return {
      cwd: sessionCwd,
      ...(common.model ? { model: common.model } : {}),
      ...(common.permissionMode
        ? { permissionMode: common.permissionMode }
        : {}),
      ...(common.effort ? { effort: common.effort } : {}),
      ...(thinking ? { thinking } : {}),
      ...(claude.executable
        ? { pathToClaudeCodeExecutable: claude.executable }
        : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(common.disallowedTools
        ? { disallowedTools: [...common.disallowedTools] }
        : {}),
      mcpServers,
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
      env: mergedEnv,
    }
  }

  const runWithEvents: Harness["runWithEvents"] = (input) =>
    Stream.async<AgentEvent, AgentRunError>((emit) => {
      let cumulative: AgentTokens = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }

      ;(async () => {
        try {
          const iter = query({
            prompt: input.prompt,
            options: buildOptions(input),
          })
          for await (const message of iter) {
            const m = message as Record<string, unknown>
            const tag = typeof m.type === "string" ? m.type : "unknown"

            const sessionId =
              typeof m.session_id === "string" ? m.session_id : null
            if (sessionId) {
              await emit.single({
                _tag: "session_started",
                sessionId,
                threadId: null,
              })
            }

            if (tag === "assistant") {
              const inner = (m.message as { content?: unknown }) ?? {}
              const blocks = Array.isArray(inner.content) ? inner.content : []
              for (const block of blocks as Array<Record<string, unknown>>) {
                if (block.type === "text" && typeof block.text === "string") {
                  await emit.single({ _tag: "text_delta", text: block.text })
                } else if (
                  block.type === "thinking" &&
                  typeof block.thinking === "string"
                ) {
                  await emit.single({
                    _tag: "reasoning_delta",
                    text: block.thinking,
                  })
                } else if (
                  block.type === "tool_use" &&
                  typeof block.name === "string"
                ) {
                  await emit.single({
                    _tag: "tool_call",
                    toolName: block.name,
                    toolCallId:
                      typeof block.id === "string" ? block.id : null,
                    input: block.input ?? null,
                  })
                }
              }
            }

            if (tag === "user") {
              // Tool results come back as user messages with tool_result blocks.
              const inner = (m.message as { content?: unknown }) ?? {}
              const blocks = Array.isArray(inner.content) ? inner.content : []
              for (const block of blocks as Array<Record<string, unknown>>) {
                if (block.type === "tool_result") {
                  await emit.single({
                    _tag: "tool_result",
                    toolCallId:
                      typeof block.tool_use_id === "string"
                        ? block.tool_use_id
                        : null,
                    output: block.content ?? null,
                    isError: block.is_error === true,
                  })
                }
              }
            }

            if (tag === "result" && typeof m.result === "string") {
              await emit.single({ _tag: "text_delta", text: m.result })
            }

            const rateLimits = extractRateLimits(message)
            if (rateLimits) {
              await emit.single({ _tag: "rate_limits_updated", rateLimits })
            }

            if (tag === "system" && m.subtype === "api_retry") {
              const apiRetryRateLimits = extractApiRetryRateLimits(m)
              if (apiRetryRateLimits) {
                await emit.single({
                  _tag: "rate_limits_updated",
                  rateLimits: apiRetryRateLimits,
                })
              }
            }

            if (tag === "result" && m.is_error === true) {
              const reason = readResultErrorReason(m)
              const classified = classifyLimitText(reason)
              if (classified) {
                await emit.single({
                  _tag: "rate_limits_updated",
                  rateLimits: classified,
                })
              }
              await emit.single({ _tag: "run_failed", reason })
            }

            const usage = extractUsage(message)
            if (usage) {
              const newInput = usage.input
              const newOutput = cumulative.outputTokens + usage.output
              const next = {
                inputTokens: newInput,
                outputTokens: newOutput,
                totalTokens: newInput + newOutput,
              }
              const delta = {
                inputTokens: newInput - cumulative.inputTokens,
                outputTokens: usage.output,
                totalTokens: next.totalTokens - cumulative.totalTokens,
              }
              cumulative = next
              await emit.single({ _tag: "tokens_updated", delta, cumulative })
            }

            await emit.single({ _tag: "raw", harness: "claude", kind: tag })
          }
          await emit.end()
        } catch (cause) {
          const classified = classifyLimitCause(cause)
          if (classified) {
            await emit.single({
              _tag: "rate_limits_updated",
              rateLimits: classified,
            })
          }
          await emit.fail(new AgentRunError({ harness: "claude", cause }))
        }
      })()
    })

  const run: Harness["run"] = (input, onEvent) =>
    Effect.gen(function* () {
      const stateRef = yield* Ref.make<AgentRunResult>({
        status: "completed",
        sessionId: null,
        threadId: null,
        finalText: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      })

      yield* runWithEvents(input).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* Ref.update(stateRef, (prev) => mergeEvent(prev, event))
            if (onEvent) yield* onEvent(event)
          }),
        ),
        Effect.timeoutFail({
          duration: `${common.turnTimeoutMs} millis`,
          onTimeout: () => null,
        }),
        Effect.catchTag("AgentRunError", (e) =>
          Ref.update(stateRef, (prev) => ({
            ...prev,
            status: "errored" as const,
          })).pipe(Effect.flatMap(() => Effect.fail(e))),
        ),
        Effect.catchAll((e) =>
          e === null
            ? Ref.update(stateRef, (prev) => ({
                ...prev,
                status: "timed_out" as const,
              }))
            : Effect.fail(e as AgentRunError),
        ),
      )

      return yield* Ref.get(stateRef)
    })

  return {
    kind: "claude",
    skillsPath: claude.skillsPath,
    run,
    runWithEvents,
  }
}

function mergeEvent(prev: AgentRunResult, event: AgentEvent): AgentRunResult {
  switch (event._tag) {
    case "process_started":
      return prev
    case "session_started":
      return {
        ...prev,
        sessionId: event.sessionId ?? prev.sessionId,
        threadId: event.threadId ?? prev.threadId,
      }
    case "tokens_updated":
      return { ...prev, ...event.cumulative }
    case "rate_limits_updated":
      return prev
    case "run_failed":
      return { ...prev, status: "errored", finalText: event.reason }
    case "text_delta":
      return {
        ...prev,
        finalText: event.text.length > 200 ? event.text.slice(0, 200) + "…" : event.text,
      }
    case "reasoning_delta":
    case "tool_call":
    case "tool_result":
    case "approval_requested":
    case "raw":
      return prev
  }
}

function extractRateLimits(message: SDKMessage): RateLimitSnapshot | null {
  const m = message as {
    type?: string
    rate_limit_info?: {
      status?: string
      resetsAt?: number
      rateLimitType?: string
      utilization?: number
      overageStatus?: string
      overageResetsAt?: number
      overageDisabledReason?: string
      isUsingOverage?: boolean
    }
  }
  if (m.type !== "rate_limit_event" || !m.rate_limit_info) return null

  const info = m.rate_limit_info
  const status = normalizeStatus(info.status)
  const resetAt = normalizeResetAt(info.resetsAt)
  const primary = buildBucket({
    resetAt,
    utilization: info.utilization,
    status: info.status,
  })
  const overageResetAt = normalizeResetAt(info.overageResetsAt)
  const secondary = buildBucket({
    resetAt: overageResetAt,
    status: info.overageStatus,
  })

  const limitId = info.rateLimitType ?? "claude"
  const snapshot: RateLimitSnapshot = {
    harness: "claude",
    limitId,
    ...(status ? { status } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(info.overageStatus || info.overageDisabledReason || info.isUsingOverage !== undefined
      ? {
          credits: {
            ...(info.isUsingOverage !== undefined
              ? { hasCredits: info.isUsingOverage }
              : {}),
            ...(info.overageStatus ? { status: info.overageStatus } : {}),
            ...(info.overageDisabledReason
              ? { reason: info.overageDisabledReason }
              : {}),
          },
        }
      : {}),
    ...(status === "rejected"
      ? { pausedUntil: resetAt ?? Date.now() + FALLBACK_LIMIT_PAUSE_MS }
      : {}),
  }

  return snapshot
}

function extractApiRetryRateLimits(
  message: Record<string, unknown>,
): RateLimitSnapshot | null {
  if (message.error !== "rate_limit") return null
  const retryDelayMs =
    typeof message.retry_delay_ms === "number" ? message.retry_delay_ms : null
  const pausedUntil =
    retryDelayMs !== null
      ? Date.now() + Math.max(0, retryDelayMs)
      : Date.now() + FALLBACK_LIMIT_PAUSE_MS
  const resetInSeconds = Math.max(0, Math.ceil((pausedUntil - Date.now()) / 1000))

  return {
    harness: "claude",
    limitId: "claude-api",
    status: "allowed_warning",
    primary: { resetAt: pausedUntil, resetInSeconds, status: "retrying" },
    pausedUntil,
    reason: "api retry after rate_limit",
  }
}

function readResultErrorReason(message: Record<string, unknown>): string {
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((x): x is string => typeof x === "string")
    : []
  if (errors.length > 0) return errors.join("; ")
  if (typeof message.result === "string" && message.result.length > 0) {
    return message.result
  }
  if (typeof message.subtype === "string") return message.subtype
  return "Claude run errored"
}

function classifyLimitCause(cause: unknown): RateLimitSnapshot | null {
  const text = stringifyUnknown(cause)
  return classifyLimitText(text)
}

function classifyLimitText(text: string): RateLimitSnapshot | null {
  const lower = text.toLowerCase()
  const isSessionLimit =
    lower.includes("session limit") ||
    lower.includes("usage limit") ||
    lower.includes("limit reached") ||
    lower.includes("hit your limit") ||
    lower.includes("you've hit your limit") ||
    lower.includes("you have hit your limit")
  const isRateLimit =
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    /\b429\b/.test(lower)
  const isQuota =
    lower.includes("quota") ||
    lower.includes("billing") ||
    lower.includes("credit")

  if (!isSessionLimit && !isRateLimit && !isQuota) return null

  const resetAt = extractResetAt(text)
  const pausedUntil = resetAt ?? Date.now() + FALLBACK_LIMIT_PAUSE_MS
  const limitId = isSessionLimit
    ? "claude-session"
    : isQuota
      ? "claude-quota"
      : "claude-api"
  const primary = buildBucket({
    resetAt: pausedUntil,
    remaining: 0,
    status: "rejected",
  })

  return {
    harness: "claude",
    limitId,
    status: "rejected",
    ...(primary ? { primary } : {}),
    pausedUntil,
    reason: text.length > 300 ? text.slice(0, 300) + "..." : text,
  }
}

function buildBucket(input: {
  readonly remaining?: number | undefined
  readonly limit?: number | undefined
  readonly resetAt?: number | undefined
  readonly utilization?: number | undefined
  readonly status?: string | undefined
}): RateLimitBucket | null {
  const bucket: RateLimitBucket = {
    ...(input.remaining !== undefined ? { remaining: input.remaining } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.resetAt !== undefined
      ? {
          resetAt: input.resetAt,
          resetInSeconds: Math.max(
            0,
            Math.ceil((input.resetAt - Date.now()) / 1000),
          ),
        }
      : {}),
    ...(input.utilization !== undefined ? { utilization: input.utilization } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  }

  return Object.keys(bucket).length > 0 ? bucket : null
}

function normalizeStatus(
  status: string | undefined,
): RateLimitSnapshot["status"] | undefined {
  if (
    status === "allowed" ||
    status === "allowed_warning" ||
    status === "rejected"
  ) {
    return status
  }
  return status ? "unknown" : undefined
}

function normalizeResetAt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  if (value > 1_000_000_000_000) return value
  if (value > 1_000_000_000) return value * 1000
  return Date.now() + value
}

function extractResetAt(text: string): number | undefined {
  const relative = text.match(
    /(?:retry|reset|try again|available).*?(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i,
  )
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2]?.toLowerCase()
    if (Number.isFinite(amount) && unit) {
      const multiplier = unit.startsWith("h")
        ? 3_600_000
        : unit.startsWith("m")
          ? 60_000
          : 1000
      return Date.now() + amount * multiplier
    }
  }

  const timeOfDay = text.match(
    /reset(?:s)?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
  )
  if (!timeOfDay) return undefined

  const hourText = timeOfDay[1]
  const minuteText = timeOfDay[2]
  const meridiem = timeOfDay[3]?.toLowerCase()
  if (!hourText || !meridiem) return undefined

  let hour = Number(hourText)
  const minute = minuteText ? Number(minuteText) : 0
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return undefined

  if (meridiem === "pm" && hour !== 12) hour += 12
  if (meridiem === "am" && hour === 12) hour = 0

  const reset = new Date()
  reset.setHours(hour, minute, 0, 0)
  if (reset.getTime() <= Date.now()) {
    reset.setDate(reset.getDate() + 1)
  }
  return reset.getTime()
}

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? "\n" + value.stack : ""}`
  }
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

interface RawIterationUsage {
  type?: string
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  iterations?: ReadonlyArray<RawIterationUsage> | null
}

function extractUsage(
  message: SDKMessage,
): { input: number; output: number; total: number } | null {
  const m = message as { type?: string; message?: { usage?: RawUsage } }
  if (m.type === "assistant" && m.message?.usage) {
    return readUsage(m.message.usage)
  }
  return null
}

function readUsage(
  u: RawUsage,
): { input: number; output: number; total: number } {
  // Per Anthropic docs: "Calculate the true context window size from the
  // last iteration." Outer fields are billing-cumulative across server-side
  // iterations (extended thinking + tool loops within ONE API call).
  const iters = u.iterations
  const lastIter =
    Array.isArray(iters) && iters.length > 0 ? iters[iters.length - 1] : null
  const useIter =
    lastIter && lastIter.type !== "compaction_iteration" ? lastIter : null

  const input = useIter
    ? (useIter.input_tokens ?? 0) +
      (useIter.cache_creation_input_tokens ?? 0) +
      (useIter.cache_read_input_tokens ?? 0)
    : (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0)

  const output = u.output_tokens ?? 0
  return { input, output, total: input + output }
}
