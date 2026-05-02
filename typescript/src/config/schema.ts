import { Schema, Effect, Data } from "effect"
import * as path from "node:path"
import * as os from "node:os"

import { DEFAULT_SKILLS_PATHS } from "../agent/harness.ts"

export class ConfigParseError extends Data.TaggedError("ConfigParseError")<{
  readonly issues: ReadonlyArray<string>
  readonly cause: unknown
}> {}

const TrackerSchema = Schema.Struct({
  kind: Schema.Literal("linear"),
  endpoint: Schema.optionalWith(Schema.String, {
    default: () => "https://api.linear.app/graphql",
  }),
  api_key: Schema.optional(Schema.String),
  project_slug: Schema.String,
  active_states: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => ["Todo", "In Progress"] as const,
  }),
  terminal_states: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () =>
      ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"] as const,
  }),
})

const PollingSchema = Schema.Struct({
  interval_ms: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), {
    default: () => 30_000,
  }),
})

const WorkspaceSchema = Schema.Struct({
  root: Schema.optional(Schema.String),
})

const HooksSchema = Schema.Struct({
  after_create: Schema.optional(Schema.String),
  before_run: Schema.optional(Schema.String),
  after_run: Schema.optional(Schema.String),
  before_remove: Schema.optional(Schema.String),
  timeout_ms: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), {
    default: () => 60_000,
  }),
})

const AgentSchema = Schema.Struct({
  max_concurrent_agents: Schema.optionalWith(
    Schema.Int.pipe(Schema.positive()),
    { default: () => 10 },
  ),
  max_turns: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), {
    default: () => 20,
  }),
  max_retry_backoff_ms: Schema.optionalWith(
    Schema.Int.pipe(Schema.positive()),
    { default: () => 300_000 },
  ),
  max_concurrent_agents_by_state: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Int.pipe(Schema.positive()) }),
    { default: () => ({}) },
  ),
})

const RuntimeClaudeSchema = Schema.Struct({
  thinking_mode: Schema.optional(
    Schema.Literal("adaptive", "enabled", "disabled"),
  ),
  thinking_budget_tokens: Schema.optional(Schema.Int.pipe(Schema.positive())),
  executable: Schema.optional(Schema.String),
  skills_path: Schema.optional(Schema.String),
})

const RuntimeCodexSchema = Schema.Struct({
  command: Schema.optional(Schema.String),
  approval_policy: Schema.optional(
    Schema.Union(
      Schema.Literal("never", "unlessTrusted", "onRequest"),
      Schema.String,
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    ),
  ),
  auto_approve_requests: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
  }),
  thread_sandbox: Schema.optionalWith(Schema.String, {
    default: () => "workspace-write",
  }),
  turn_sandbox_policy: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  sandbox_policy: Schema.optional(
    Schema.Literal("readOnly", "workspaceWrite", "dangerFullAccess", "externalSandbox"),
  ),
  personality: Schema.optional(Schema.String),
  skills_path: Schema.optional(Schema.String),
})

const RuntimeGeminiSchema = Schema.Struct({
  include_directories: Schema.optional(Schema.Array(Schema.String)),
  executable: Schema.optional(Schema.String),
  skills_path: Schema.optional(Schema.String),
})

const RuntimeOpencodeSchema = Schema.Struct({
  provider: Schema.optional(Schema.String),
  attach_url: Schema.optional(Schema.String),
  resume_session: Schema.optional(Schema.String),
  executable: Schema.optional(Schema.String),
  skills_path: Schema.optional(Schema.String),
})

const RuntimeSchema = Schema.Struct({
  kind: Schema.optionalWith(
    Schema.Literal("claude", "codex", "gemini", "opencode"),
    { default: () => "claude" as const },
  ),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(
    Schema.Literal("low", "medium", "high", "xhigh", "max"),
  ),
  permission_mode: Schema.optional(
    Schema.Literal("default", "acceptEdits", "bypassPermissions"),
  ),
  allowed_tools: Schema.optional(Schema.Array(Schema.String)),
  disallowed_tools: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optionalWith(Schema.String, { default: () => "." }),
  turn_timeout_ms: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), {
    default: () => 3_600_000,
  }),
  read_timeout_ms: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), {
    default: () => 5_000,
  }),
  stall_timeout_ms: Schema.optionalWith(Schema.Int, {
    default: () => 300_000,
  }),
  mcp_servers: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  env: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
  claude: Schema.optionalWith(RuntimeClaudeSchema, {
    default: () => ({}) as never,
  }),
  codex: Schema.optionalWith(RuntimeCodexSchema, {
    default: () =>
      ({
        auto_approve_requests: false,
        thread_sandbox: "workspace-write",
      }) as never,
  }),
  gemini: Schema.optionalWith(RuntimeGeminiSchema, {
    default: () => ({}) as never,
  }),
  opencode: Schema.optionalWith(RuntimeOpencodeSchema, {
    default: () => ({}) as never,
  }),
})

export const RawWorkflowConfigSchema = Schema.Struct({
  tracker: TrackerSchema,
  polling: PollingSchema,
  workspace: WorkspaceSchema,
  hooks: HooksSchema,
  agent: AgentSchema,
  runtime: RuntimeSchema,
})

export type RawWorkflowConfig = Schema.Schema.Type<typeof RawWorkflowConfigSchema>

export interface Settings {
  readonly tracker: {
    readonly kind: "linear"
    readonly endpoint: string
    readonly apiKey: string | undefined
    readonly projectSlug: string
    readonly activeStates: ReadonlyArray<string>
    readonly terminalStates: ReadonlyArray<string>
  }
  readonly polling: { readonly intervalMs: number }
  readonly workspace: { readonly root: string }
  readonly hooks: {
    readonly afterCreate: string | undefined
    readonly beforeRun: string | undefined
    readonly afterRun: string | undefined
    readonly beforeRemove: string | undefined
    readonly timeoutMs: number
  }
  readonly agent: {
    readonly maxConcurrentAgents: number
    readonly maxTurns: number
    readonly maxRetryBackoffMs: number
    readonly maxConcurrentAgentsByState: ReadonlyMap<string, number>
  }
  readonly runtime: {
    readonly kind: "claude" | "codex" | "gemini" | "opencode"
    readonly common: {
      readonly model: string | undefined
      readonly permissionMode:
        | "default"
        | "acceptEdits"
        | "bypassPermissions"
        | undefined
      readonly effort:
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max"
        | undefined
      readonly allowedTools: ReadonlyArray<string> | undefined
      readonly disallowedTools: ReadonlyArray<string> | undefined
      readonly cwd: string
      readonly turnTimeoutMs: number
      readonly readTimeoutMs: number
      readonly stallTimeoutMs: number
      readonly mcpServers: Record<string, unknown> | undefined
      readonly env: Record<string, string> | undefined
    }
    readonly claude: {
      readonly thinkingMode: "adaptive" | "enabled" | "disabled" | undefined
      readonly thinkingBudgetTokens: number | undefined
      readonly executable: string | undefined
      readonly skillsPath: string
    }
    readonly codex: {
      readonly command: string | undefined
      readonly approvalPolicy:
        | "never"
        | "unlessTrusted"
        | "onRequest"
        | string
        | Record<string, unknown>
        | undefined
      readonly autoApproveRequests: boolean
      readonly threadSandbox: string
      readonly turnSandboxPolicy: Record<string, unknown> | undefined
      readonly sandboxPolicy:
        | "readOnly"
        | "workspaceWrite"
        | "dangerFullAccess"
        | "externalSandbox"
        | undefined
      readonly personality: string | undefined
      readonly skillsPath: string
    }
    readonly gemini: {
      readonly includeDirectories: ReadonlyArray<string> | undefined
      readonly executable: string | undefined
      readonly skillsPath: string
    }
    readonly opencode: {
      readonly provider: string | undefined
      readonly attachUrl: string | undefined
      readonly resumeSession: string | undefined
      readonly executable: string | undefined
      readonly skillsPath: string
    }
  }
}

const decodeRaw = Schema.decodeUnknown(RawWorkflowConfigSchema)

export const parseSettings = (
  raw: unknown,
  workflowFilePath: string,
): Effect.Effect<Settings, ConfigParseError> =>
  decodeRaw(ensureGroups(raw)).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigParseError({
          issues: [String(cause)],
          cause,
        }),
    ),
    Effect.map((parsed) => resolve(parsed, workflowFilePath)),
  )

function ensureGroups(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw
  const r = raw as Record<string, unknown>
  return {
    ...r,
    polling: r.polling ?? {},
    workspace: r.workspace ?? {},
    hooks: r.hooks ?? {},
    agent: r.agent ?? {},
    runtime: r.runtime ?? {},
  }
}

function resolve(parsed: RawWorkflowConfig, workflowFilePath: string): Settings {
  const baseDir = path.dirname(workflowFilePath)

  const workspaceRoot = parsed.workspace.root
    ? resolveWorkflowPath(parsed.workspace.root, baseDir)
    : path.join(os.tmpdir(), "bethoveen_workspaces")

  const apiKey =
    resolveEnv(parsed.tracker.api_key) ?? Bun.env.LINEAR_API_KEY

  const concurrencyByState = new Map<string, number>(
    Object.entries(parsed.agent.max_concurrent_agents_by_state).map(
      ([k, v]) => [k.toLowerCase(), v as number],
    ),
  )

  return {
    tracker: {
      kind: parsed.tracker.kind,
      endpoint: parsed.tracker.endpoint,
      apiKey,
      projectSlug: parsed.tracker.project_slug,
      activeStates: parsed.tracker.active_states,
      terminalStates: parsed.tracker.terminal_states,
    },
    polling: { intervalMs: parsed.polling.interval_ms },
    workspace: { root: workspaceRoot },
    hooks: {
      afterCreate: parsed.hooks.after_create,
      beforeRun: parsed.hooks.before_run,
      afterRun: parsed.hooks.after_run,
      beforeRemove: parsed.hooks.before_remove,
      timeoutMs: parsed.hooks.timeout_ms,
    },
    agent: {
      maxConcurrentAgents: parsed.agent.max_concurrent_agents,
      maxTurns: parsed.agent.max_turns,
      maxRetryBackoffMs: parsed.agent.max_retry_backoff_ms,
      maxConcurrentAgentsByState: concurrencyByState,
    },
    runtime: {
      kind: parsed.runtime.kind,
      common: {
        model: parsed.runtime.model,
        permissionMode: parsed.runtime.permission_mode,
        effort: parsed.runtime.effort,
        allowedTools: parsed.runtime.allowed_tools,
        disallowedTools: parsed.runtime.disallowed_tools,
        cwd: parsed.runtime.cwd,
        turnTimeoutMs: parsed.runtime.turn_timeout_ms,
        readTimeoutMs: parsed.runtime.read_timeout_ms,
        stallTimeoutMs: parsed.runtime.stall_timeout_ms,
        mcpServers: parsed.runtime.mcp_servers as
          | Record<string, unknown>
          | undefined,
        env: parsed.runtime.env as Record<string, string> | undefined,
      },
      claude: {
        thinkingMode: parsed.runtime.claude.thinking_mode,
        thinkingBudgetTokens: parsed.runtime.claude.thinking_budget_tokens,
        executable:
          resolveEnv(parsed.runtime.claude.executable) ??
          (parsed.runtime.kind === "claude"
            ? (Bun.which("claude") ?? undefined)
            : undefined),
        skillsPath:
          parsed.runtime.claude.skills_path ?? DEFAULT_SKILLS_PATHS.claude,
      },
      codex: {
        command: parsed.runtime.codex.command,
        approvalPolicy: parsed.runtime.codex.approval_policy,
        autoApproveRequests: parsed.runtime.codex.auto_approve_requests,
        threadSandbox: parsed.runtime.codex.thread_sandbox,
        turnSandboxPolicy: parsed.runtime.codex.turn_sandbox_policy as
          | Record<string, unknown>
          | undefined,
        sandboxPolicy: parsed.runtime.codex.sandbox_policy,
        personality: parsed.runtime.codex.personality,
        skillsPath:
          parsed.runtime.codex.skills_path ?? DEFAULT_SKILLS_PATHS.codex,
      },
      gemini: {
        includeDirectories: parsed.runtime.gemini.include_directories,
        executable:
          resolveEnv(parsed.runtime.gemini.executable) ??
          (parsed.runtime.kind === "gemini"
            ? (Bun.which("gemini") ?? undefined)
            : undefined),
        skillsPath:
          parsed.runtime.gemini.skills_path ?? DEFAULT_SKILLS_PATHS.gemini,
      },
      opencode: {
        provider: parsed.runtime.opencode.provider,
        attachUrl: parsed.runtime.opencode.attach_url,
        resumeSession: parsed.runtime.opencode.resume_session,
        executable:
          resolveEnv(parsed.runtime.opencode.executable) ??
          (parsed.runtime.kind === "opencode"
            ? (Bun.which("opencode") ?? undefined)
            : undefined),
        skillsPath:
          parsed.runtime.opencode.skills_path ?? DEFAULT_SKILLS_PATHS.opencode,
      },
    },
  }
}

function resolveEnv(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (!value.startsWith("$")) return value
  const resolved = Bun.env[value.slice(1)]
  if (!resolved || resolved.trim() === "") return undefined
  return resolved
}

function resolveWorkflowPath(value: string, baseDir: string): string {
  let v = value
  if (v.startsWith("$")) {
    const env = resolveEnv(v)
    if (env) v = env
  }
  if (v.startsWith("~")) {
    v = path.join(os.homedir(), v.slice(1))
  }
  if (path.isAbsolute(v)) return path.normalize(v)
  return path.normalize(path.resolve(baseDir, v))
}
