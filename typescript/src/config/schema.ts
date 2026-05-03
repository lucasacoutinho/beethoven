import { Schema, Effect, Data } from "effect"
import * as path from "node:path"
import * as os from "node:os"

import { DEFAULT_SKILLS_PATHS } from "../agent/harness.ts"

export class ConfigParseError extends Data.TaggedError("ConfigParseError")<{
  readonly issues: ReadonlyArray<string>
  readonly cause: unknown
}> { }

const TrackerSchema = Schema.Struct({
  kind: Schema.Literal("linear"),
  endpoint: Schema.optionalWith(Schema.String, {
    default: () => "https://api.linear.app/graphql",
  }),
  api_key: Schema.optional(Schema.String),
  project_slug: Schema.String,
  active_states: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => ["Todo", "In Progress", "AI Review"] as const,
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
  sandbox: Schema.optional(Schema.Boolean),
  skip_trust: Schema.optional(Schema.Boolean),
  policies: Schema.optional(Schema.Array(Schema.String)),
  admin_policies: Schema.optional(Schema.Array(Schema.String)),
})

const RuntimeOpencodeSchema = Schema.Struct({
  provider: Schema.optional(Schema.String),
  attach_url: Schema.optional(Schema.String),
  resume_session: Schema.optional(Schema.String),
  executable: Schema.optional(Schema.String),
  skills_path: Schema.optional(Schema.String),
})

const AgentPoolMemberSchema = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("maestro", "soloist", "accompanist"),
  capabilities: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [] as const,
  }),
  kind: Schema.Literal("claude", "codex", "gemini", "opencode"),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(
    Schema.Literal("low", "medium", "high", "xhigh", "max"),
  ),
  instructions: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  timeout_ms: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), {
    default: () => 600_000,
  }),
  max_output_chars: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), {
    default: () => 12_000,
  }),
  permission_mode: Schema.optional(
    Schema.Literal("default", "acceptEdits", "bypassPermissions"),
  ),
  allowed_tools: Schema.optional(Schema.Array(Schema.String)),
  disallowed_tools: Schema.optional(Schema.Array(Schema.String)),
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

const AgentPoolSchema = Schema.Struct({
  primary_agent: Schema.optional(Schema.String),
  primary_candidates: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        weight: Schema.optionalWith(Schema.Number.pipe(Schema.positive()), {
          default: () => 1,
        }),
      }),
    ),
    { default: () => [] as const },
  ),
  primary_fallback_roles: Schema.optionalWith(
    Schema.Array(Schema.Literal("maestro", "soloist", "accompanist")),
    { default: () => ["maestro"] as const },
  ),
  on_primary_unavailable: Schema.optionalWith(
    Schema.Literal("reassign", "pause", "fail"),
    { default: () => "reassign" as const },
  ),
  ai_review_state: Schema.optionalWith(Schema.String, {
    default: () => "AI Review",
  }),
  ai_review_capabilities: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => ["review"] as const,
  }),
  ai_review_prefer_different_harness: Schema.optionalWith(Schema.Boolean, {
    default: () => true,
  }),
  members: Schema.optionalWith(Schema.Array(AgentPoolMemberSchema), {
    default: () => [] as const,
  }),
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
  agent_pool: AgentPoolSchema,
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
      readonly sandbox: boolean | undefined
      readonly skipTrust: boolean | undefined
      readonly policies: ReadonlyArray<string> | undefined
      readonly adminPolicies: ReadonlyArray<string> | undefined
    }
    readonly opencode: {
      readonly provider: string | undefined
      readonly attachUrl: string | undefined
      readonly resumeSession: string | undefined
      readonly executable: string | undefined
      readonly skillsPath: string
    }
  }
  readonly agentPool: {
    readonly primaryAgent: string | undefined
    readonly primaryCandidates: ReadonlyArray<{
      readonly id: string
      readonly weight: number
    }>
    readonly primaryFallbackRoles: ReadonlyArray<"maestro" | "soloist" | "accompanist">
    readonly onPrimaryUnavailable: "reassign" | "pause" | "fail"
    readonly aiReviewState: string
    readonly aiReviewCapabilities: ReadonlyArray<string>
    readonly aiReviewPreferDifferentHarness: boolean
    readonly members: ReadonlyArray<AgentPoolMemberSettings>
  }
}

export interface AgentPoolMemberSettings {
  readonly id: string
  readonly role: "maestro" | "soloist" | "accompanist"
  readonly capabilities: ReadonlyArray<string>
  readonly kind: "claude" | "codex" | "gemini" | "opencode"
  readonly model: string | undefined
  readonly effort:
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | undefined
  readonly instructions: string | undefined
  readonly cwd: string | undefined
  readonly timeoutMs: number
  readonly maxOutputChars: number
  readonly permissionMode:
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | undefined
  readonly allowedTools: ReadonlyArray<string> | undefined
  readonly disallowedTools: ReadonlyArray<string> | undefined
  readonly env: Record<string, string> | undefined
  readonly claude: Settings["runtime"]["claude"]
  readonly codex: Settings["runtime"]["codex"]
  readonly gemini: Settings["runtime"]["gemini"]
  readonly opencode: Settings["runtime"]["opencode"]
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
    agent_pool: r.agent_pool ?? {},
  }
}

function resolve(parsed: RawWorkflowConfig, workflowFilePath: string): Settings {
  const baseDir = path.dirname(workflowFilePath)

  const workspaceRoot = parsed.workspace.root
    ? resolveWorkflowPath(parsed.workspace.root, baseDir)
    : path.join(os.tmpdir(), "beethoven_workspaces")

  const apiKey =
    resolveEnv(parsed.tracker.api_key) ?? Bun.env.LINEAR_API_KEY

  const concurrencyByState = new Map<string, number>(
    Object.entries(parsed.agent.max_concurrent_agents_by_state).map(
      ([k, v]) => [k.toLowerCase(), v as number],
    ),
  )

  const agentPoolMembers = parsed.agent_pool.members.map((member) =>
    resolveAgentPoolMember(member),
  )
  const primaryMember = parsed.agent_pool.primary_agent
    ? agentPoolMembers.find((member) => member.id === parsed.agent_pool.primary_agent)
    : undefined
  const runtimeSettings = primaryMember
    ? settingsForAgentPoolMember(parsed.runtime, primaryMember)
    : settingsForRuntime(parsed.runtime)

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
    runtime: runtimeSettings,
    agentPool: {
      primaryAgent: parsed.agent_pool.primary_agent,
      primaryCandidates: parsed.agent_pool.primary_candidates,
      primaryFallbackRoles: parsed.agent_pool.primary_fallback_roles,
      onPrimaryUnavailable: parsed.agent_pool.on_primary_unavailable,
      aiReviewState: parsed.agent_pool.ai_review_state,
      aiReviewCapabilities: parsed.agent_pool.ai_review_capabilities,
      aiReviewPreferDifferentHarness:
        parsed.agent_pool.ai_review_prefer_different_harness,
      members: agentPoolMembers,
    },
  }
}

function settingsForRuntime(
  runtime: RawWorkflowConfig["runtime"],
): Settings["runtime"] {
  return {
    kind: runtime.kind,
    common: {
      model: runtime.model,
      permissionMode: runtime.permission_mode,
      effort: runtime.effort,
      allowedTools: runtime.allowed_tools,
      disallowedTools: runtime.disallowed_tools,
      cwd: runtime.cwd,
      turnTimeoutMs: runtime.turn_timeout_ms,
      readTimeoutMs: runtime.read_timeout_ms,
      stallTimeoutMs: runtime.stall_timeout_ms,
      mcpServers: runtime.mcp_servers as Record<string, unknown> | undefined,
      env: runtime.env as Record<string, string> | undefined,
    },
    claude: resolveClaudeSettings(runtime.claude, runtime.kind),
    codex: resolveCodexSettings(runtime.codex),
    gemini: resolveGeminiSettings(runtime.gemini, runtime.kind),
    opencode: resolveOpencodeSettings(runtime.opencode, runtime.kind),
  }
}

function settingsForAgentPoolMember(
  runtime: RawWorkflowConfig["runtime"],
  member: AgentPoolMemberSettings,
): Settings["runtime"] {
  const baseRuntime = settingsForRuntime(runtime)
  return {
    ...baseRuntime,
    kind: member.kind,
    common: {
      ...baseRuntime.common,
      model: member.model,
      effort: member.effort,
      permissionMode: member.permissionMode,
      allowedTools: member.allowedTools,
      disallowedTools: member.disallowedTools,
      cwd: member.cwd ?? runtime.cwd,
      turnTimeoutMs: member.timeoutMs,
      env: {
        ...(runtime.env as Record<string, string> | undefined),
        ...(member.env ?? {}),
      },
    },
    claude: member.claude,
    codex: member.codex,
    gemini: member.gemini,
    opencode: member.opencode,
  }
}

function resolveAgentPoolMember(
  member: RawWorkflowConfig["agent_pool"]["members"][number],
): AgentPoolMemberSettings {
  return {
    id: member.id,
    role: member.role,
    capabilities: member.capabilities,
    kind: member.kind,
    model: member.model,
    effort: member.effort,
    instructions: member.instructions,
    cwd: member.cwd,
    timeoutMs: member.timeout_ms,
    maxOutputChars: member.max_output_chars,
    permissionMode: member.permission_mode,
    allowedTools: member.allowed_tools,
    disallowedTools: member.disallowed_tools,
    env: member.env as Record<string, string> | undefined,
    claude: resolveClaudeSettings(member.claude, member.kind),
    codex: resolveCodexSettings(member.codex),
    gemini: resolveGeminiSettings(member.gemini, member.kind),
    opencode: resolveOpencodeSettings(member.opencode, member.kind),
  }
}

function resolveClaudeSettings(
  claude: RawWorkflowConfig["runtime"]["claude"],
  kind: RawWorkflowConfig["runtime"]["kind"],
): Settings["runtime"]["claude"] {
  return {
    thinkingMode: claude.thinking_mode,
    thinkingBudgetTokens: claude.thinking_budget_tokens,
    executable:
      resolveEnv(claude.executable) ??
      (kind === "claude" ? (Bun.which("claude") ?? undefined) : undefined),
    skillsPath: claude.skills_path ?? DEFAULT_SKILLS_PATHS.claude,
  }
}

function resolveCodexSettings(
  codex: RawWorkflowConfig["runtime"]["codex"],
): Settings["runtime"]["codex"] {
  return {
    command: codex.command,
    approvalPolicy: codex.approval_policy,
    autoApproveRequests: codex.auto_approve_requests,
    threadSandbox: codex.thread_sandbox,
    turnSandboxPolicy: codex.turn_sandbox_policy as
      | Record<string, unknown>
      | undefined,
    sandboxPolicy: codex.sandbox_policy,
    personality: codex.personality,
    skillsPath: codex.skills_path ?? DEFAULT_SKILLS_PATHS.codex,
  }
}

function resolveGeminiSettings(
  gemini: RawWorkflowConfig["runtime"]["gemini"],
  kind: RawWorkflowConfig["runtime"]["kind"],
): Settings["runtime"]["gemini"] {
  return {
    includeDirectories: gemini.include_directories,
    executable:
      resolveEnv(gemini.executable) ??
      (kind === "gemini" ? (Bun.which("gemini") ?? undefined) : undefined),
    skillsPath: gemini.skills_path ?? DEFAULT_SKILLS_PATHS.gemini,
    sandbox: gemini.sandbox,
    skipTrust: gemini.skip_trust,
    policies: gemini.policies,
    adminPolicies: gemini.admin_policies,
  }
}

function resolveOpencodeSettings(
  opencode: RawWorkflowConfig["runtime"]["opencode"],
  kind: RawWorkflowConfig["runtime"]["kind"],
): Settings["runtime"]["opencode"] {
  return {
    provider: opencode.provider,
    attachUrl: opencode.attach_url,
    resumeSession: opencode.resume_session,
    executable:
      resolveEnv(opencode.executable) ??
      (kind === "opencode" ? (Bun.which("opencode") ?? undefined) : undefined),
    skillsPath: opencode.skills_path ?? DEFAULT_SKILLS_PATHS.opencode,
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
