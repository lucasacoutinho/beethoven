import { Effect, Ref, Stream } from "effect"
import * as path from "node:path"

import type {
  AgentEvent,
  AgentRunInput,
  AgentRunResult,
  AgentTokens,
  Harness,
  HarnessKind,
} from "../harness.ts"
import { AgentRunError } from "../harness.ts"
import type { Settings } from "../../config/schema.ts"

const KIND: HarnessKind = "gemini"

export const makeGeminiHarness = (settings: Settings): Harness => {
  const gemini = settings.runtime.gemini
  const common = settings.runtime.common

  const runWithEvents: Harness["runWithEvents"] = (input) =>
    Stream.async<AgentEvent, AgentRunError>((emit) => {
      let cumulative: AgentTokens = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }

        ; (async () => {
          try {
            const sessionCwd = path.resolve(input.workspace.path, common.cwd)
            const executable = gemini.executable ?? "gemini"
            const args = ["-p", input.prompt, "--output-format", "stream-json"]

            if (common.model) {
              args.push("--model", common.model)
            }
            if (gemini.includeDirectories && gemini.includeDirectories.length > 0) {
              for (const dir of gemini.includeDirectories) {
                args.push("--include-directories", dir)
              }
            }
            if (common.permissionMode === "bypassPermissions") {
              args.push("--approval-mode", "yolo")
            } else if (common.permissionMode === "acceptEdits") {
              args.push("--approval-mode", "auto_edit")
            } else {
              args.push("--approval-mode", "default")
            }

            if (gemini.sandbox) {
              args.push("--sandbox")
            }
            if (gemini.skipTrust) {
              args.push("--skip-trust")
            }
            if (gemini.policies) {
              for (const p of gemini.policies) args.push("--policy", p)
            }
            if (gemini.adminPolicies) {
              for (const p of gemini.adminPolicies) args.push("--admin-policy", p)
            }
            const baseEnv: Record<string, string> = {}
            for (const [k, v] of Object.entries(Bun.env)) {
              if (typeof v === "string") baseEnv[k] = v
            }
            const mergedEnv = common.env ? { ...baseEnv, ...common.env } : baseEnv

            const proc = Bun.spawn([executable, ...args], {
              cwd: sessionCwd,
              env: mergedEnv,
              stdio: ["ignore", "pipe", "ignore"],
            })

            const decoder = new TextDecoder()
            let buffer = ""
            const reader = proc.stdout.getReader()
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              let index = buffer.indexOf("\n")
              while (index >= 0) {
                const line = buffer.slice(0, index)
                buffer = buffer.slice(index + 1)
                index = buffer.indexOf("\n")

                if (!line.trim()) continue

                try {
                  const parsed = JSON.parse(line.trim())
                  const normalized = normalizeGeminiEvent(parsed)
                  for (const event of normalized) {
                    if (event._tag === "tokens_updated") {
                      const usage = event.cumulative
                      const delta = {
                        inputTokens: Math.max(0, usage.inputTokens - cumulative.inputTokens),
                        outputTokens: Math.max(0, usage.outputTokens - cumulative.outputTokens),
                        totalTokens: Math.max(0, usage.totalTokens - cumulative.totalTokens),
                      }
                      cumulative = usage
                      await emit.single({ _tag: "tokens_updated", delta, cumulative })
                    } else {
                      await emit.single(event)
                    }
                  }
                } catch (e) {
                  // Ignore non-json lines
                }
              }
            }

            await proc.exited
            await emit.end()
          } catch (cause) {
            await emit.fail(new AgentRunError({ harness: KIND, cause }))
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
    kind: KIND,
    skillsPath: gemini.skillsPath,
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
    case "text_delta":
      return {
        ...prev,
        finalText: event.text.length > 200 ? event.text.slice(0, 200) + "..." : event.text,
      }
    case "run_failed":
      return { ...prev, status: "errored", finalText: event.reason }
    case "rate_limits_updated":
    case "reasoning_delta":
    case "tool_call":
    case "tool_result":
    case "approval_requested":
    case "raw":
      return prev
  }
}

function normalizeGeminiEvent(parsed: any): AgentEvent[] {
  const events: AgentEvent[] = []

  if (!parsed || typeof parsed !== "object") return events

  const kind = typeof parsed.type === "string" ? parsed.type : "unknown"
  events.push({ _tag: "raw", harness: KIND, kind })

  if (typeof parsed.session_id === "string") {
    events.push({ _tag: "session_started", sessionId: parsed.session_id, threadId: null })
  }

  if (kind === "message" && parsed.role === "assistant") {
    const text = typeof parsed.text === "string" ? parsed.text : typeof parsed.content === "string" ? parsed.content : null
    if (text) {
      events.push({ _tag: "text_delta", text })
    }
  }

  if ((kind === "tool_call" || kind === "function_call") && typeof parsed.name === "string") {
    events.push({
      _tag: "tool_call",
      toolName: parsed.name,
      toolCallId: typeof parsed.id === "string" ? parsed.id : null,
      input: parsed.input ?? null,
    })
  }

  if (kind === "tool_result") {
    let output = null
    if (typeof parsed.output === "string") {
      output = parsed.output
    } else if (parsed.output !== undefined) {
      output = JSON.stringify(parsed.output)
    }
    events.push({
      _tag: "tool_result",
      toolCallId: typeof parsed.id === "string" ? parsed.id : null,
      output,
      isError: parsed.is_error === true,
    })
  }

  const usageNode = parsed.usage ?? parsed.stats
  if (usageNode && typeof usageNode === "object") {
    const inputLoc = typeof usageNode.input_tokens === "number" ? usageNode.input_tokens : typeof usageNode.input === "number" ? usageNode.input : 0
    const outputLoc = typeof usageNode.output_tokens === "number" ? usageNode.output_tokens : typeof usageNode.output === "number" ? usageNode.output : 0
    const total = typeof usageNode.total_tokens === "number" ? usageNode.total_tokens : inputLoc + outputLoc
    events.push({
      _tag: "tokens_updated",
      delta: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cumulative: { inputTokens: inputLoc, outputTokens: outputLoc, totalTokens: total },
    })
  }

  if (kind === "result" && parsed.status !== "success") {
    const reason = typeof parsed.message === "string" ? parsed.message : "Run finished with no success status"
    events.push({ _tag: "run_failed", reason })
  }

  if (kind === "error") {
    const reason = typeof parsed.message === "string" ? parsed.message : "Error running gemini process"
    events.push({ _tag: "run_failed", reason })
  }

  return events
}
