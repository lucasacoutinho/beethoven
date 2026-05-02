import type { Settings } from "../config/schema.ts"
import { delegateTaskTool } from "./delegate-task.ts"
import { linearGraphqlTool } from "./linear-graphql.ts"
import {
  failureToolResponse,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolImplementation,
} from "./tool.ts"

const TOOLS: ReadonlyArray<ToolImplementation> = [linearGraphqlTool, delegateTaskTool]

export const beethovenTools = (
  settings: Settings,
): ReadonlyArray<ToolImplementation> =>
  TOOLS.filter((tool) => tool.isEnabled?.(settings) ?? true)

export const beethovenToolDefinitions = (
  settings: Settings,
): ReadonlyArray<ToolDefinition> =>
  beethovenTools(settings).map((tool) => tool.definition)

export async function executeBeethovenTool(
  settings: Settings,
  toolName: string | null,
  argumentsValue: unknown,
  context: ToolExecutionContext = {},
): Promise<ToolExecutionResult> {
  const tools = beethovenTools(settings)
  const tool = tools.find((candidate) => candidate.definition.name === toolName)
  if (!tool) {
    return failureToolResponse({
      error: {
        message: `Unsupported dynamic tool: ${JSON.stringify(toolName)}.`,
        supportedTools: tools.map((candidate) => candidate.definition.name),
      },
    })
  }
  return tool.execute(settings, argumentsValue, context)
}

export type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolImplementation,
}
