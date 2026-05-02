import { Context, Layer } from "effect"

import type { Harness } from "./harness.ts"
import { makeClaudeHarness } from "./harnesses/claude.ts"
import { makeCodexHarness } from "./harnesses/codex.ts"
import { makeGeminiHarness } from "./harnesses/gemini.ts"
import { makeOpencodeHarness } from "./harnesses/opencode.ts"
import type { Settings } from "../config/schema.ts"

export type {
  AgentEvent,
  AgentRunInput,
  AgentRunResult,
  AgentTokens,
  Harness,
  HarnessKind,
  RuntimeCommon,
} from "./harness.ts"
export { AgentRunError } from "./harness.ts"

/**
 * Effect service tag preserved as `AgentRunner` (not `Harness`) so call sites
 * upstream don't need to rename. Internally it's a Harness — every concrete
 * adapter implements the same interface.
 */
export class AgentRunner extends Context.Tag("bethoveen/AgentRunner")<
  AgentRunner,
  Harness
>() {}

export const makeHarness = (settings: Settings): Harness => {
  switch (settings.runtime.kind) {
    case "claude":
      return makeClaudeHarness(settings)
    case "codex":
      return makeCodexHarness(settings)
    case "gemini":
      return makeGeminiHarness(settings)
    case "opencode":
      return makeOpencodeHarness(settings)
  }
}

export const AgentRunnerLive = (settings: Settings) =>
  Layer.sync(AgentRunner, () => makeHarness(settings))
