import { Effect, Stream } from "effect"

import type {
  AgentRunInput,
  AgentRunResult,
  Harness,
  HarnessKind,
} from "../harness.ts"
import { AgentRunError } from "../harness.ts"
import type { Settings } from "../../config/schema.ts"

const KIND: HarnessKind = "opencode"

/**
 * opencode CLI driver. Spawns `opencode run --format json "<prompt>"` (or
 * attaches to a long-lived `opencode serve` instance to amortize cold-start)
 * and parses the JSON event stream.
 *
 * Planned mapping (from opencode's --format json output):
 *   assistant message events     -> text_delta
 *   tool call / tool result      -> tool_call / tool_result
 *   session id on first event    -> session_started
 *   token usage events           -> tokens_updated
 *
 * Configuration mapping (from `runtime.opencode`):
 *   model           -> --model <provider/model>
 *   attach_url      -> --attach <url> (use a shared `opencode serve` daemon)
 *   permissions     -> OPENCODE_PERMISSION env or --dangerously-skip-permissions
 *   resume_session  -> --session <id> / --continue / --fork
 *
 * Note: opencode does not have a --cwd flag. The harness must spawn with
 * the workspace path as the child process's cwd, not via a CLI argument.
 *
 * SPEC §5.3.5.opencode documents the field surface.
 */
export const makeOpencodeHarness = (settings: Settings): Harness => {
  const fail = <A>() =>
    Effect.fail(
      new AgentRunError({
        harness: KIND,
        cause: new Error(
          "opencode harness is not yet implemented. " +
            "See src/agent/harnesses/opencode.ts for the planned wiring.",
        ),
      }),
    ) as Effect.Effect<A, AgentRunError>

  const run: Harness["run"] = (_input: AgentRunInput) =>
    fail<AgentRunResult>()

  const runWithEvents: Harness["runWithEvents"] = (_input) =>
    Stream.fail(
      new AgentRunError({
        harness: KIND,
        cause: new Error("opencode harness is not yet implemented."),
      }),
    )

  return {
    kind: KIND,
    skillsPath: settings.runtime.opencode.skillsPath,
    run,
    runWithEvents,
  }
}
