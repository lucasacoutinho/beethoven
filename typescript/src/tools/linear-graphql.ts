import type { Settings } from "../config/schema.ts"
import {
  encodeToolPayload,
  failureToolResponse,
  toolResponse,
  type ToolImplementation,
} from "./tool.ts"

export const LINEAR_GRAPHQL_TOOL = "linear_graphql"

const linearGraphqlInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description: "GraphQL query or mutation document to execute against Linear.",
    },
    variables: {
      type: ["object", "null"],
      description: "Optional GraphQL variables object.",
      additionalProperties: true,
    },
  },
}

export const linearGraphqlTool: ToolImplementation = {
  definition: {
    name: LINEAR_GRAPHQL_TOOL,
    description:
      "Execute a raw GraphQL query or mutation against Linear using Bethoveen's configured auth.",
    inputJsonSchema: linearGraphqlInputSchema,
  },
  execute: executeLinearGraphqlTool,
}

export async function executeLinearGraphqlTool(
  settings: Settings,
  argumentsValue: unknown,
) {
  const normalized = normalizeLinearGraphqlArguments(argumentsValue)
  if (!normalized.ok) return failureToolResponse(toolErrorPayload(normalized.reason))
  if (!settings.tracker.apiKey) {
    return failureToolResponse(toolErrorPayload("missing_linear_api_token"))
  }

  try {
    const response = await fetch(settings.tracker.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: settings.tracker.apiKey,
      },
      body: JSON.stringify({
        query: normalized.query,
        variables: normalized.variables,
      }),
    })

    const body = await response.text()
    if (!response.ok) {
      return failureToolResponse(
        toolErrorPayload({ type: "linear_api_status", status: response.status }),
      )
    }

    let payload: unknown = body
    try {
      payload = JSON.parse(body)
    } catch {
      // Keep non-JSON responses visible to whichever harness invoked the tool.
    }

    const success =
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray((payload as Record<string, unknown>).errors) ||
      ((payload as Record<string, unknown>).errors as unknown[]).length === 0

    return toolResponse(success, encodeToolPayload(payload))
  } catch (cause) {
    return failureToolResponse(
      toolErrorPayload({
        type: "linear_api_request",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
    )
  }
}

type NormalizeResult =
  | { readonly ok: true; readonly query: string; readonly variables: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string }

function normalizeLinearGraphqlArguments(argumentsValue: unknown): NormalizeResult {
  if (typeof argumentsValue === "string") {
    const query = argumentsValue.trim()
    return query
      ? { ok: true, query, variables: {} }
      : { ok: false, reason: "missing_query" }
  }

  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    return { ok: false, reason: "invalid_arguments" }
  }

  const args = argumentsValue as Record<string, unknown>
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) return { ok: false, reason: "missing_query" }

  const variables = args.variables ?? {}
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return { ok: false, reason: "invalid_variables" }
  }

  return { ok: true, query, variables: variables as Record<string, unknown> }
}

function toolErrorPayload(reason: unknown): Record<string, unknown> {
  if (reason === "missing_query") {
    return { error: { message: "`linear_graphql` requires a non-empty `query` string." } }
  }
  if (reason === "invalid_arguments") {
    return {
      error: {
        message:
          "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`.",
      },
    }
  }
  if (reason === "invalid_variables") {
    return { error: { message: "`linear_graphql.variables` must be a JSON object when provided." } }
  }
  if (reason === "missing_linear_api_token") {
    return {
      error: {
        message:
          "Bethoveen is missing Linear auth. Set `tracker.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`.",
      },
    }
  }
  if (reason && typeof reason === "object") {
    const r = reason as Record<string, unknown>
    if (r.type === "linear_api_status") {
      return {
        error: {
          message: `Linear GraphQL request failed with HTTP ${r.status}.`,
          status: r.status,
        },
      }
    }
    if (r.type === "linear_api_request") {
      return {
        error: {
          message: "Linear GraphQL request failed before receiving a successful response.",
          reason: r.reason,
        },
      }
    }
  }
  return {
    error: {
      message: "Linear GraphQL tool execution failed.",
      reason: String(reason),
    },
  }
}
