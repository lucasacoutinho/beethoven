import { describe, expect, test } from "bun:test"

import type { Settings } from "../../config/schema.ts"
import type { AgentRunInput } from "../harness.ts"
import { DELEGATE_TASK_TOOL } from "../../tools/delegate-task.ts"
import { LINEAR_GRAPHQL_TOOL } from "../../tools/linear-graphql.ts"
import {
  CLAUDE_BEETHOVEN_MCP_SERVER,
  claudeBeethovenMcpServers,
  claudeBeethovenToolNames,
} from "./claude-tools.ts"

describe("Claude tool adapter", () => {
  test("registers Beethoven tools as an in-process SDK MCP server", async () => {
    const settings = makeSettings()
    const servers = claudeBeethovenMcpServers(settings, makeInput())
    const server = servers[CLAUDE_BEETHOVEN_MCP_SERVER]

    expect(server?.type).toBe("sdk")
    expect(serverName(server)).toBe(CLAUDE_BEETHOVEN_MCP_SERVER)
    expect(claudeBeethovenToolNames(settings)).toContain(
      `mcp__${CLAUDE_BEETHOVEN_MCP_SERVER}__${LINEAR_GRAPHQL_TOOL}`,
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
    expect(result?.content?.[0]?.text).toContain("Beethoven is missing Linear auth")
  })

  test("registers delegate_task only when agent pool members are configured", async () => {
    const settings = makeSettings({
      agentPool: {
        primaryAgent: undefined,
        primaryCandidates: [],
        primaryFallbackRoles: ["maestro"],
        onPrimaryUnavailable: "reassign",
        aiReviewState: "AI Review",
        aiReviewCapabilities: ["review"],
        aiReviewPreferDifferentHarness: true,
        members: [
          {
            id: "codex-gpt-5.4-soloist",
            role: "soloist",
            capabilities: ["diff-review"],
            kind: "codex",
            model: "gpt-5.4",
            effort: "medium",
            instructions: undefined,
            cwd: undefined,
            timeoutMs: 60_000,
            maxOutputChars: 4_000,
            permissionMode: undefined,
            allowedTools: undefined,
            disallowedTools: undefined,
            env: undefined,
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
              sandboxPolicy: "readOnly",
              personality: undefined,
              skillsPath: ".codex/skills",
            },
            gemini: {
              includeDirectories: undefined,
              executable: undefined,
              skillsPath: ".gemini/skills",
              sandbox: undefined,
              skipTrust: undefined,
              policies: undefined,
              adminPolicies: undefined,
            },
            opencode: {
              provider: undefined,
              attachUrl: undefined,
              resumeSession: undefined,
              executable: undefined,
              skillsPath: ".agents/skills",
            },
          },
        ],
      },
    })
    const servers = claudeBeethovenMcpServers(settings, {
      ...makeInput(),
      delegateTask: async (request) => ({
        agentId: request.agentId ?? "codex-gpt-5.4-soloist",
        status: "completed",
        output: "soloist result",
        sessionId: null,
        threadId: null,
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      }),
    })
    const tools = registeredTools(servers[CLAUDE_BEETHOVEN_MCP_SERVER])

    expect(Object.keys(tools)).toContain(DELEGATE_TASK_TOOL)
    expect(claudeBeethovenToolNames(settings)).toContain(
      `mcp__${CLAUDE_BEETHOVEN_MCP_SERVER}__${DELEGATE_TASK_TOOL}`,
    )

    const result = await tools[DELEGATE_TASK_TOOL]?.handler(
      { agent: "codex-gpt-5.4-soloist", task: "Inspect the diff." },
      {},
    )
    expect(result?.isError).toBe(false)
    expect(result?.content?.[0]?.text).toContain("soloist result")
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

function makeSettings(overrides: Partial<Settings> = {}): Settings {
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
    workspace: { root: "/tmp/beethoven-test" },
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
        skillsPath: "",
        sandbox: undefined,
        skipTrust: undefined,
        policies: undefined,
        adminPolicies: undefined,
      },
      opencode: {
        provider: undefined,
        attachUrl: undefined,
        resumeSession: undefined,
        executable: undefined,
        skillsPath: ".agents/skills",
      },
    },
    agentPool: {
      primaryAgent: undefined,
      primaryCandidates: [],
      primaryFallbackRoles: ["maestro"],
      onPrimaryUnavailable: "reassign",
      aiReviewState: "AI Review",
      aiReviewCapabilities: ["review"],
      aiReviewPreferDifferentHarness: true,
      members: [],
    },
    ...overrides,
  }
}

function makeInput(): AgentRunInput {
  return {
    workspace: { path: "/tmp/beethoven-test", workspaceKey: "BLE-1", createdNow: true },
    issue: {
      id: "issue-1",
      identifier: "BLE-1",
      title: "Claude tool adapter test",
      description: null,
      priority: null,
      state: "In Progress",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    prompt: "Run the Claude tool adapter test.",
    turnNumber: 1,
  }
}
