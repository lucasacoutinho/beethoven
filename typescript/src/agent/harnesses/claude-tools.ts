import {
  createSdkMcpServer,
  tool,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod/v4"

import type { Settings } from "../../config/schema.ts"
import type { AgentRunInput } from "../harness.ts"
import { executeBeethovenTool } from "../../tools/index.ts"
import type { ToolExecutionContext } from "../../tools/tool.ts"
import {
  DELEGATE_TASK_TOOL,
  delegateTaskTool,
} from "../../tools/delegate-task.ts"
import {
  LINEAR_GRAPHQL_TOOL,
  linearGraphqlTool,
} from "../../tools/linear-graphql.ts"
import type { ToolExecutionResult } from "../../tools/tool.ts"

export const CLAUDE_BEETHOVEN_MCP_SERVER = "beethoven"

export function claudeBeethovenMcpServers(
  settings: Settings,
  input: AgentRunInput,
): Record<string, McpServerConfig> {
  const context = toolContext(input)
  const toolList: any[] = [
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
          await executeBeethovenTool(settings, LINEAR_GRAPHQL_TOOL, args, context),
        ),
    ),
  ]

  if (delegateTaskTool.isEnabled?.(settings)) {
    toolList.push(
      tool(
        DELEGATE_TASK_TOOL,
        delegateTaskTool.definition.description,
        {
          agent: z.string().optional().describe("Optional exact agent pool member id."),
          worker: z.string().optional().describe("Deprecated alias for agent."),
          role: z
            .enum(["maestro", "soloist", "accompanist"])
            .optional()
            .describe("Optional agent pool role to select when agent is omitted."),
          capabilities: z
            .array(z.string())
            .optional()
            .describe("Optional capabilities every selected pool member must provide."),
          task: z.string().describe("Substantial, self-contained work package for the delegated agent."),
          context: z.string().optional().describe("Optional context for the subtask."),
          files: z
            .array(z.string())
            .optional()
            .describe("Optional workspace-relative files or directories to inspect."),
          output_format: z.string().optional().describe("Optional requested answer shape."),
          max_output_chars: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Optional output cap for this delegation result."),
        },
        async (args) =>
          toClaudeToolResult(
            await executeBeethovenTool(settings, DELEGATE_TASK_TOOL, args, context),
          ),
      ),
    )
  }

  return {
    [CLAUDE_BEETHOVEN_MCP_SERVER]: createSdkMcpServer({
      name: CLAUDE_BEETHOVEN_MCP_SERVER,
      version: "0.1.0",
      tools: toolList,
    }),
  }
}

export const claudeBeethovenToolNames = (
  settings: Settings,
): ReadonlyArray<string> => {
  const names = [`mcp__${CLAUDE_BEETHOVEN_MCP_SERVER}__${LINEAR_GRAPHQL_TOOL}`]
  if (delegateTaskTool.isEnabled?.(settings)) {
    names.push(`mcp__${CLAUDE_BEETHOVEN_MCP_SERVER}__${DELEGATE_TASK_TOOL}`)
  }
  return names
}

function toolContext(input: AgentRunInput): ToolExecutionContext {
  return {
    workspace: input.workspace,
    issue: input.issue,
    prompt: input.prompt,
    ...(input.delegateTask ? { delegateTask: input.delegateTask } : {}),
  }
}

function toClaudeToolResult(result: ToolExecutionResult) {
  return {
    content: [{ type: "text" as const, text: result.output }],
    isError: !result.success,
  }
}
