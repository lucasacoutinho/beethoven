import type { Settings } from "../config/schema.ts"
import {
  encodeToolPayload,
  failureToolResponse,
  toolResponse,
  type ToolExecutionContext,
  type ToolImplementation,
} from "./tool.ts"

export const DELEGATE_TASK_TOOL = "delegate_task"

const delegateTaskInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task"],
  properties: {
    agent: {
      type: "string",
      description: "Optional exact agent pool member id.",
    },
    worker: {
      type: "string",
      description: "Deprecated alias for agent.",
    },
    role: {
      type: "string",
      enum: ["maestro", "soloist", "accompanist"],
      description: "Optional agent pool role to select when agent is omitted.",
    },
    capabilities: {
      type: "array",
      items: { type: "string" },
      description: "Optional capabilities every selected pool member must provide.",
    },
    task: {
      type: "string",
      description: "Substantial, self-contained work package for the delegated agent.",
    },
    context: {
      type: "string",
      description: "Optional context the delegated agent needs to complete the work package.",
    },
    files: {
      type: "array",
      items: { type: "string" },
      description: "Optional workspace-relative files or directories to inspect.",
    },
    output_format: {
      type: "string",
      description: "Optional requested answer shape, for example findings table or patch plan.",
    },
    max_output_chars: {
      type: "integer",
      minimum: 1,
      description: "Optional output cap for this delegation result.",
    },
  },
}

export const delegateTaskTool: ToolImplementation = {
  definition: {
    name: DELEGATE_TASK_TOOL,
    description:
      "Delegate a substantial work package to a configured agent-pool member and return its handoff.",
    inputJsonSchema: delegateTaskInputSchema,
  },
  isEnabled: (settings) => settings.agentPool.members.length > 0,
  execute: executeDelegateTaskTool,
}

async function executeDelegateTaskTool(
  settings: Settings,
  argumentsValue: unknown,
  context: ToolExecutionContext,
) {
  const normalized = normalizeDelegateTaskArguments(argumentsValue)
  if (!normalized.ok) return failureToolResponse(toolErrorPayload(normalized.reason))

  const member = selectAgentPoolMember(settings, normalized)
  if (!member) {
    return failureToolResponse(
      toolErrorPayload({
        type: "unknown_agent",
        agent: normalized.agent,
        role: normalized.role,
        capabilities: normalized.capabilities,
        available: settings.agentPool.members.map((candidate) => ({
          id: candidate.id,
          role: candidate.role,
          capabilities: candidate.capabilities,
        })),
      }),
    )
  }

  if (!context.delegateTask) {
    return failureToolResponse(toolErrorPayload("delegation_unavailable"))
  }

  const request = {
    agentId: member.id,
    task: normalized.task,
    maxOutputChars: normalized.maxOutputChars ?? member.maxOutputChars,
    ...(normalized.role ? { role: normalized.role } : {}),
    ...(normalized.capabilities ? { capabilities: normalized.capabilities } : {}),
    ...(normalized.context ? { context: normalized.context } : {}),
    ...(normalized.files ? { files: normalized.files } : {}),
    ...(normalized.outputFormat ? { outputFormat: normalized.outputFormat } : {}),
  }
  let result: Awaited<ReturnType<NonNullable<ToolExecutionContext["delegateTask"]>>>
  try {
    result = await context.delegateTask(request)
  } catch (cause) {
    return failureToolResponse(
      toolErrorPayload({
        type: "delegation_failed",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
    )
  }

  return toolResponse(
    result.status === "completed",
    encodeToolPayload({
      agent: result.agentId,
      status: result.status,
      output: result.output,
      sessionId: result.sessionId,
      threadId: result.threadId,
      tokens: {
        input: result.inputTokens,
        output: result.outputTokens,
        total: result.totalTokens,
      },
    }),
  )
}

type NormalizeResult =
  | {
      readonly ok: true
      readonly agent: string | undefined
      readonly role: "maestro" | "soloist" | "accompanist" | undefined
      readonly capabilities: ReadonlyArray<string> | undefined
      readonly task: string
      readonly context: string | undefined
      readonly files: ReadonlyArray<string> | undefined
      readonly outputFormat: string | undefined
      readonly maxOutputChars: number | undefined
    }
  | { readonly ok: false; readonly reason: unknown }

function normalizeDelegateTaskArguments(argumentsValue: unknown): NormalizeResult {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    return { ok: false, reason: "invalid_arguments" }
  }

  const args = argumentsValue as Record<string, unknown>
  const agent =
    typeof args.agent === "string"
      ? args.agent.trim()
      : typeof args.worker === "string"
        ? args.worker.trim()
        : ""
  const role = normalizeRole(args.role)
  const task = typeof args.task === "string" ? args.task.trim() : ""
  const context = typeof args.context === "string" ? args.context.trim() : undefined
  const outputFormat =
    typeof args.output_format === "string" ? args.output_format.trim() : undefined
  const maxOutputChars =
    typeof args.max_output_chars === "number" && Number.isInteger(args.max_output_chars)
      ? args.max_output_chars
      : undefined

  if (!task) return { ok: false, reason: "missing_task" }
  if (args.role !== undefined && !role) return { ok: false, reason: "invalid_role" }
  if (maxOutputChars !== undefined && maxOutputChars <= 0) {
    return { ok: false, reason: "invalid_max_output_chars" }
  }

  let files: ReadonlyArray<string> | undefined
  if (args.files !== undefined) {
    if (
      !Array.isArray(args.files) ||
      !args.files.every((file) => typeof file === "string" && file.trim().length > 0)
    ) {
      return { ok: false, reason: "invalid_files" }
    }
    files = args.files.map((file) => file.trim())
  }

  let capabilities: ReadonlyArray<string> | undefined
  if (args.capabilities !== undefined) {
    if (
      !Array.isArray(args.capabilities) ||
      !args.capabilities.every(
        (capability) => typeof capability === "string" && capability.trim().length > 0,
      )
    ) {
      return { ok: false, reason: "invalid_capabilities" }
    }
    capabilities = args.capabilities.map((capability) => capability.trim())
  }

  return {
    ok: true,
    agent: agent || undefined,
    role: role ?? undefined,
    capabilities,
    task,
    context: context || undefined,
    files,
    outputFormat: outputFormat || undefined,
    maxOutputChars,
  }
}

function normalizeRole(value: unknown): "maestro" | "soloist" | "accompanist" | null {
  if (value === undefined) return null
  return value === "maestro" || value === "soloist" || value === "accompanist"
    ? value
    : null
}

function selectAgentPoolMember(
  settings: Settings,
  request: Extract<NormalizeResult, { readonly ok: true }>,
): Settings["agentPool"]["members"][number] | undefined {
  if (request.agent) {
    return settings.agentPool.members.find((candidate) => candidate.id === request.agent)
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

function toolErrorPayload(reason: unknown): Record<string, unknown> {
  if (reason === "invalid_arguments") {
    return {
      error: {
        message:
          "`delegate_task` expects an object with `task` and optional `agent`, `role`, `capabilities`, `context`, `files`, `output_format`, or `max_output_chars`.",
      },
    }
  }
  if (reason === "missing_task") {
    return { error: { message: "`delegate_task.task` is required." } }
  }
  if (reason === "invalid_role") {
    return { error: { message: "`delegate_task.role` must be maestro, soloist, or accompanist." } }
  }
  if (reason === "invalid_capabilities") {
    return { error: { message: "`delegate_task.capabilities` must be an array of non-empty strings." } }
  }
  if (reason === "invalid_files") {
    return { error: { message: "`delegate_task.files` must be an array of non-empty strings." } }
  }
  if (reason === "invalid_max_output_chars") {
    return { error: { message: "`delegate_task.max_output_chars` must be a positive integer." } }
  }
  if (reason === "delegation_unavailable") {
    return {
      error: {
        message:
          "`delegate_task` is unavailable in this run. Beethoven only enables it for primary agent turns.",
      },
    }
  }
  if (reason && typeof reason === "object") {
    const r = reason as Record<string, unknown>
    if (r.type === "unknown_agent") {
      return {
        error: {
          message: "No configured agent pool member matched this delegation request.",
          agent: r.agent,
          role: r.role,
          capabilities: r.capabilities,
          available: r.available,
        },
      }
    }
    if (r.type === "delegation_failed") {
      return {
        error: {
          message: "Agent delegation failed.",
          reason: r.reason,
        },
      }
    }
  }
  return {
    error: {
      message: "Delegate task tool execution failed.",
      reason: String(reason),
    },
  }
}
