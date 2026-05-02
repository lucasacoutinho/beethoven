import { Data, Effect, Stream } from "effect"

import type { Issue } from "../tracker/issue.ts"
import type { Workspace } from "../workspace/workspace.ts"

export type HarnessKind = "claude" | "codex" | "gemini" | "opencode"

export interface AgentRunInput {
  readonly workspace: Workspace
  readonly issue: Issue
  readonly prompt: string
  readonly turnNumber: number
  /** Optional session ID to resume; semantics are harness-specific. */
  readonly resumeSessionId?: string
  /** Optional subtask executor exposed to dynamic tools for model delegation. */
  readonly delegateTask?: AgentTaskDelegate
}

export interface AgentTokens {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

export interface RateLimitBucket {
  readonly remaining?: number
  readonly limit?: number
  readonly resetInSeconds?: number
  readonly resetAt?: number
  readonly utilization?: number
  readonly status?: string
}

export interface RateLimitCredits {
  readonly unlimited?: boolean
  readonly hasCredits?: boolean
  readonly balance?: number | null
  readonly status?: string
  readonly reason?: string
}

export interface RateLimitSnapshot {
  readonly harness: HarnessKind
  readonly limitId: string
  readonly status?: "allowed" | "allowed_warning" | "rejected" | "unknown"
  readonly primary?: RateLimitBucket
  readonly secondary?: RateLimitBucket
  readonly credits?: RateLimitCredits
  readonly pausedUntil?: number
  readonly reason?: string
}

export interface AgentRunResult extends AgentTokens {
  readonly status: "completed" | "stalled" | "timed_out" | "errored"
  readonly sessionId: string | null
  readonly threadId: string | null
  readonly finalText: string | null
}

export type AgentPoolRole = "maestro" | "soloist" | "accompanist"

export interface AgentTaskRequest {
  readonly agentId?: string
  readonly role?: AgentPoolRole
  readonly capabilities?: ReadonlyArray<string>
  readonly task: string
  readonly context?: string
  readonly files?: ReadonlyArray<string>
  readonly outputFormat?: string
  readonly maxOutputChars?: number
}

export interface AgentTaskResult extends AgentTokens {
  readonly agentId: string
  readonly status: AgentRunResult["status"]
  readonly output: string
  readonly sessionId: string | null
  readonly threadId: string | null
}

export type AgentTaskDelegate = (
  request: AgentTaskRequest,
) => Promise<AgentTaskResult>

/**
 * Normalized event stream emitted by every harness. Shapes are aligned to
 * Vercel AI SDK content-block conventions (TextPart / ToolCallPart /
 * ToolResultPart / ReasoningPart) so consumers can map to AI SDK message
 * shapes when needed. Each harness adapter is responsible for translating
 * its native event stream into this union; lossy mappings are acceptable
 * (use `_tag: "raw"` for harness-specific events that don't fit).
 */
export type AgentEvent =
  | {
      readonly _tag: "process_started"
      readonly pid: number
    }
  | {
      readonly _tag: "session_started"
      readonly sessionId: string | null
      readonly threadId: string | null
    }
  /** Delta of an assistant message's text content (one line of TextPart). */
  | { readonly _tag: "text_delta"; readonly text: string }
  /** Reasoning/thinking delta (Codex `item/reasoning/textDelta`, Claude extended thinking). */
  | { readonly _tag: "reasoning_delta"; readonly text: string }
  /** A tool the agent invoked (ToolCallPart shape). */
  | {
      readonly _tag: "tool_call"
      readonly toolName: string
      readonly toolCallId: string | null
      readonly input: unknown
    }
  /** A tool's result (ToolResultPart shape). */
  | {
      readonly _tag: "tool_result"
      readonly toolCallId: string | null
      readonly output: unknown
      readonly isError: boolean
    }
  /** Token usage update; cumulative is current context size, delta is per-event growth. */
  | {
      readonly _tag: "tokens_updated"
      readonly cumulative: AgentTokens
      readonly delta: AgentTokens
    }
  /** Latest upstream rate-limit/session-limit state exposed by the harness. */
  | {
      readonly _tag: "rate_limits_updated"
      readonly rateLimits: RateLimitSnapshot
    }
  /** Terminal failure surfaced by a harness result message. */
  | {
      readonly _tag: "run_failed"
      readonly reason: string
    }
  /**
   * The agent (or its harness) is asking for an out-of-band decision: a
   * command execution to confirm, a file change to approve, etc. Harnesses
   * that do not support inline approvals (Claude SDK with `bypassPermissions`)
   * never emit this. Codex emits it via `item/commandExecution/requestApproval`.
   */
  | {
      readonly _tag: "approval_requested"
      readonly kind: "command" | "file" | "other"
      readonly summary: string
    }
  /** Compatibility escape hatch for events not yet normalized. */
  | {
      readonly _tag: "raw"
      readonly harness: HarnessKind
      readonly kind: string
    }

export class AgentRunError extends Data.TaggedError("AgentRunError")<{
  readonly harness: HarnessKind
  readonly cause: unknown
}> {}

/**
 * The contract every harness adapter implements. Both `run` (folded result)
 * and `runWithEvents` (streamed events) are exposed because the orchestrator
 * and the dashboard observe the same dispatch from different angles.
 */
export interface Harness {
  readonly kind: HarnessKind
  /**
   * Workspace-relative path where this harness expects to find skills. The
   * orchestrator symlinks this path to the canonical `.agents/skills/` so
   * one source-of-truth feeds every harness. Adapters may override the
   * default via per-harness config (`runtime.{kind}.skills_path`).
   */
  readonly skillsPath: string
  readonly run: (
    input: AgentRunInput,
    onEvent?: (event: AgentEvent) => Effect.Effect<void>,
  ) => Effect.Effect<AgentRunResult, AgentRunError>
  readonly runWithEvents: (
    input: AgentRunInput,
  ) => Stream.Stream<AgentEvent, AgentRunError, never>
}

/**
 * Workspace-relative source-of-truth for skill files. `WORKFLOW.md` hooks
 * (or any equivalent installer) should populate this directory; Beethoven
 * then symlinks the active harness's `skillsPath` to point here so each
 * harness finds its expected layout without duplication.
 */
export const CANONICAL_SKILLS_SOURCE = ".agents/skills"

export const DEFAULT_SKILLS_PATHS: Record<HarnessKind, string> = {
  claude: ".claude/skills",
  codex: ".codex/skills",
  gemini: ".gemini/skills",
  // opencode reads `.agents/skills` natively, so no symlink is needed —
  // the harness path is the canonical source itself. The link step
  // detects this and no-ops.
  opencode: CANONICAL_SKILLS_SOURCE,
}

/**
 * Common runtime options surfaced from `runtime:` in WORKFLOW.md. Per-harness
 * extensions live under their own nested key (`runtime.claude`, `runtime.codex`,
 * etc.) — see `RuntimeSettings` in `config/schema.ts`.
 */
export interface RuntimeCommon {
  readonly model: string | undefined
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined
  readonly permissionMode:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | undefined
  readonly cwd: string
  readonly turnTimeoutMs: number
  readonly stallTimeoutMs: number
  readonly env: Record<string, string> | undefined
  readonly allowedTools: ReadonlyArray<string> | undefined
  readonly disallowedTools: ReadonlyArray<string> | undefined
  readonly mcpServers: Record<string, unknown> | undefined
}
