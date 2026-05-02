import { describe, expect, test } from "bun:test"

import type { Settings } from "../../config/schema.ts"
import { LINEAR_GRAPHQL_TOOL } from "../../tools/linear-graphql.ts"
import {
  CLAUDE_BETHOVEEN_MCP_SERVER,
  claudeBethoveenMcpServers,
  claudeBethoveenToolNames,
} from "./claude-tools.ts"

describe("Claude tool adapter", () => {
  test("registers Bethoveen tools as an in-process SDK MCP server", async () => {
    const servers = claudeBethoveenMcpServers(makeSettings())
    const server = servers[CLAUDE_BETHOVEEN_MCP_SERVER]

    expect(server?.type).toBe("sdk")
    expect(serverName(server)).toBe(CLAUDE_BETHOVEEN_MCP_SERVER)
    expect(claudeBethoveenToolNames()).toContain(
      `mcp__${CLAUDE_BETHOVEEN_MCP_SERVER}__${LINEAR_GRAPHQL_TOOL}`,
    )

    const tools = registeredTools(server)
    expect(Object.keys(tools)).toContain(LINEAR_GRAPHQL_TOOL)
    expect(tools[LINEAR_GRAPHQL_TOOL]?.description).toContain("Linear")

    const result = await tools[LINEAR_GRAPHQL_TOOL]?.handler(
      { query: "query Viewer { viewer { id } }" },
      {},
    )
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]).toMatchObject({
      type: "text",
    })
    expect(result?.content?.[0]?.text).toContain("Bethoveen is missing Linear auth")
  })
})

function registeredTools(
  server: unknown,
): Record<
  string,
  {
    readonly description?: string
    readonly handler: (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<{ readonly content?: Array<{ readonly type: string; readonly text?: string }>; readonly isError?: boolean }>
  }
> {
  const instance =
    server && typeof server === "object"
      ? (server as Record<string, unknown>).instance
      : undefined
  const tools =
    instance && typeof instance === "object"
      ? (instance as Record<string, unknown>)._registeredTools
      : undefined
  return tools && typeof tools === "object"
    ? (tools as ReturnType<typeof registeredTools>)
    : {}
}

function serverName(server: unknown): string | undefined {
  return server && typeof server === "object"
    ? ((server as Record<string, unknown>).name as string | undefined)
    : undefined
}

function makeSettings(): Settings {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://linear.example/graphql",
      apiKey: undefined,
      projectSlug: "beacon",
      activeStates: ["Todo", "In Progress", "Rework"],
      terminalStates: ["Done", "Cancelled", "Duplicate"],
    },
    polling: { intervalMs: 30_000 },
    workspace: { root: "/tmp/bethoveen-test" },
    hooks: {
      afterCreate: undefined,
      beforeRun: undefined,
      afterRun: undefined,
      beforeRemove: undefined,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 5,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: new Map(),
    },
    runtime: {
      kind: "claude",
      common: {
        model: undefined,
        permissionMode: undefined,
        effort: undefined,
        allowedTools: undefined,
        disallowedTools: undefined,
        cwd: ".",
        turnTimeoutMs: 5_000,
        readTimeoutMs: 5_000,
        stallTimeoutMs: 300_000,
        mcpServers: undefined,
        env: undefined,
      },
      claude: {
        thinkingMode: undefined,
        thinkingBudgetTokens: undefined,
        executable: undefined,
        skillsPath: ".claude/skills",
      },
      codex: {
        command: undefined,
        approvalPolicy: undefined,
        autoApproveRequests: false,
        threadSandbox: "workspace-write",
        turnSandboxPolicy: undefined,
        sandboxPolicy: undefined,
        personality: undefined,
        skillsPath: ".codex/skills",
      },
      gemini: {
        includeDirectories: undefined,
        executable: undefined,
        skillsPath: ".gemini/skills",
      },
      opencode: {
        provider: undefined,
        attachUrl: undefined,
        resumeSession: undefined,
        executable: undefined,
        skillsPath: ".agents/skills",
      },
    },
  }
}
