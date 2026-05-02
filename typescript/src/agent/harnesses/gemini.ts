import { Effect, Stream } from "effect"

import type {
  AgentRunInput,
  AgentRunResult,
  Harness,
  HarnessKind,
} from "../harness.ts"
import { AgentRunError } from "../harness.ts"
import type { Settings } from "../../config/schema.ts"

const KIND: HarnessKind = "gemini"

/**
 * Gemini CLI driver. Spawns `gemini` in headless mode with the per-issue
 * prompt and parses the structured event stream. The CLI's non-interactive
 * surface is still maturing — V1 should ship this as "experimental" until
 * the headless protocol stabilizes.
 *
 * Planned mapping (subject to revision once headless mode is verified):
 *   stdout text deltas                 -> text_delta
 *   tool invocations (per /stats schema) -> tool_call / tool_result
 *   token usage from /stats model      -> tokens_updated
 *   session checkpoints               -> session_started (per /resume save)
 *
 * Configuration mapping (from `runtime.gemini`):
 *   model               -> /model set <name> (or --model flag if available)
 *   include_directories -> --include-directories or /directory add
 *   thinking_effort     -> via /agents config
 *
 * SPEC §5.3.5.gemini documents the field surface.
 */
export const makeGeminiHarness = (settings: Settings): Harness => {
  const fail = <A>() =>
    Effect.fail(
      new AgentRunError({
        harness: KIND,
        cause: new Error(
          "Gemini harness is not yet implemented. " +
            "See src/agent/harnesses/gemini.ts for the planned wiring.",
        ),
      }),
    ) as Effect.Effect<A, AgentRunError>

  const run: Harness["run"] = (_input: AgentRunInput) =>
    fail<AgentRunResult>()

  const runWithEvents: Harness["runWithEvents"] = (_input) =>
    Stream.fail(
      new AgentRunError({
        harness: KIND,
        cause: new Error("Gemini harness is not yet implemented."),
      }),
    )

  return {
    kind: KIND,
    skillsPath: settings.runtime.gemini.skillsPath,
    run,
    runWithEvents,
  }
}
