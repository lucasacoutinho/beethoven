import type { Settings } from "../config/schema.ts"
import { linearGraphqlTool } from "./linear-graphql.ts"
import {
  failureToolResponse,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolImplementation,
} from "./tool.ts"

const TOOLS: ReadonlyArray<ToolImplementation> = [linearGraphqlTool]

export const beethovenTools = (): ReadonlyArray<ToolImplementation> => TOOLS

export const beethovenToolDefinitions = (): ReadonlyArray<ToolDefinition> =>
  TOOLS.map((tool) => tool.definition)

export async function executeBeethovenTool(
  settings: Settings,
  toolName: string | null,
  argumentsValue: unknown,
): Promise<ToolExecutionResult> {
  const tool = TOOLS.find((candidate) => candidate.definition.name === toolName)
  if (!tool) {
    return failureToolResponse({
      error: {
        message: `Unsupported dynamic tool: ${JSON.stringify(toolName)}.`,
        supportedTools: TOOLS.map((candidate) => candidate.definition.name),
      },
    })
  }
  return tool.execute(settings, argumentsValue)
}

export type { ToolDefinition, ToolExecutionResult, ToolImplementation }
