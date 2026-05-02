import {
  createSdkMcpServer,
  tool,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod/v4"

import type { Settings } from "../../config/schema.ts"
import { executeBethoveenTool } from "../../tools/index.ts"
import {
  LINEAR_GRAPHQL_TOOL,
  linearGraphqlTool,
} from "../../tools/linear-graphql.ts"
import type { ToolExecutionResult } from "../../tools/tool.ts"

export const CLAUDE_BETHOVEEN_MCP_SERVER = "bethoveen"

export function claudeBethoveenMcpServers(
  settings: Settings,
): Record<string, McpServerConfig> {
  return {
    [CLAUDE_BETHOVEEN_MCP_SERVER]: createSdkMcpServer({
      name: CLAUDE_BETHOVEEN_MCP_SERVER,
      version: "0.1.0",
      tools: [
        tool(
          LINEAR_GRAPHQL_TOOL,
          linearGraphqlTool.definition.description,
          {
            query: z
              .string()
              .describe("GraphQL query or mutation document to execute against Linear."),
            variables: z
              .record(z.string(), z.unknown())
              .nullable()
              .optional()
              .describe("Optional GraphQL variables object."),
          },
          async (args) =>
            toClaudeToolResult(
              await executeBethoveenTool(settings, LINEAR_GRAPHQL_TOOL, args),
            ),
        ),
      ],
    }),
  }
}

export const claudeBethoveenToolNames = (): ReadonlyArray<string> => [
  `mcp__${CLAUDE_BETHOVEEN_MCP_SERVER}__${LINEAR_GRAPHQL_TOOL}`,
]

function toClaudeToolResult(result: ToolExecutionResult) {
  return {
    content: [{ type: "text" as const, text: result.output }],
    isError: !result.success,
  }
}
