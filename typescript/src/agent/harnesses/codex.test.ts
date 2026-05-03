import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentEvent, AgentRunInput, AgentRunResult } from "../harness.ts"
import { makeCodexHarness } from "./codex.ts"
import type { Settings } from "../../config/schema.ts"

const fakeCodexServer = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs"

const trace = process.env.BEETHOVEN_CODEX_TRACE
const scenario = process.env.BEETHOVEN_CODEX_SCENARIO || "complete"
const decoder = new TextDecoder()
let buffer = ""

function record(message) {
  appendFileSync(trace, JSON.stringify(message) + "\\n")
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n")
}

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let index = buffer.indexOf("\\n")
  while (index >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf("\\n")
    if (!line.trim()) continue

    const message = JSON.parse(line)
    record(message)

    if (message.id === 1) {
      write({ id: 1, result: {} })
      continue
    }

    if (message.id === 2) {
      write({ id: 2, result: { thread: { id: "thread-1" } } })
      continue
    }

    if (message.id === 3) {
      write({ id: 3, result: { turn: { id: "turn-1" } } })
      if (scenario === "approval") {
        write({
          id: 44,
          method: "item/commandExecution/requestApproval",
          params: { parsedCmd: "echo hello" },
        })
      } else if (scenario === "tool") {
        write({
          id: "tool-1",
          method: "item/tool/call",
          params: {
            tool: "linear_graphql",
            arguments: { query: "query Viewer { viewer { id } }" },
          },
        })
      } else {
        write({
          method: "thread/tokenUsage/updated",
          params: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
        })
        write({ method: "turn/completed" })
      }
      continue
    }

    if (message.id === 44 || message.id === "tool-1") {
      write({ method: "turn/completed" })
    }
  }
}
`

describe("Codex harness", () => {
  test("sends Symphony-compatible startup payloads", async () => {
    const { result, requests } = await runCodexScenario("complete")

    expect(result.status).toBe("completed")
    expect(result.sessionId).toBe("thread-1-turn-1")
    expect(result.inputTokens).toBe(4)
    expect(result.outputTokens).toBe(2)
    expect(result.totalTokens).toBe(6)

    expect(findRequest(requests, "initialize")?.params).toEqual({
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "beethoven-orchestrator",
        title: "Beethoven Orchestrator",
        version: "0.1.0",
      },
    })

    const threadStart = findRequest(requests, "thread/start")
    expect(paramsOf(threadStart).approvalPolicy).toEqual({
      reject: { sandbox_approval: true, rules: true, mcp_elicitations: true },
    })
    expect(paramsOf(threadStart).sandbox).toBe("workspace-write")
    expect(hasDynamicTool(threadStart, "linear_graphql")).toBe(true)

    const turnStart = findRequest(requests, "turn/start")
    expect(paramsOf(turnStart).title).toBe("BLE-1: Codex harness test")
    expect(paramsOf(turnStart).sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
    })
  }, 10_000)

  test("honors Codex approval and sandbox overrides", async () => {
    const turnSandboxPolicy = { type: "dangerFullAccess" }
    const { result, requests, events } = await runCodexScenario("approval", {
      approvalPolicy: "onRequest",
      autoApproveRequests: true,
      threadSandbox: "danger-full-access",
      turnSandboxPolicy,
    })

    expect(result.status).toBe("completed")
    expect(paramsOf(findRequest(requests, "thread/start")).approvalPolicy).toBe("on-request")
    expect(paramsOf(findRequest(requests, "thread/start")).sandbox).toBe("danger-full-access")
    expect(paramsOf(findRequest(requests, "turn/start")).sandboxPolicy).toEqual(turnSandboxPolicy)

    const approvalReply = requests.find((request) => request.id === 44)
    expect(approvalReply?.result).toEqual({ decision: "acceptForSession" })
    expect(events.some((event) => event._tag === "approval_requested")).toBe(true)
  }, 10_000)

  test("executes Codex dynamic tool calls through the harness", async () => {
    const { result, requests, events } = await runCodexScenario("tool")

    expect(result.status).toBe("completed")
    expect(events.some((event) => event._tag === "tool_call" && event.toolName === "linear_graphql")).toBe(true)

    const toolReply = requests.find((request) => request.id === "tool-1")
    expect(toolReply?.result).toMatchObject({ success: false })
    expect(String((toolReply?.result as Record<string, unknown>).output)).toContain(
      "Beethoven is missing Linear auth",
    )
    expect(events.some((event) => event._tag === "tool_result" && event.isError)).toBe(true)
  }, 10_000)
})

async function runCodexScenario(
  scenario: string,
  codexOverrides: Partial<Settings["runtime"]["codex"]> = {},
): Promise<{
  readonly result: AgentRunResult
  readonly requests: ReadonlyArray<Record<string, unknown>>
  readonly events: ReadonlyArray<AgentEvent>
}> {
  const root = await mkdtemp(join(tmpdir(), "beethoven-codex-test-"))
  try {
    const workspace = join(root, "workspace")
    const tracePath = join(root, "trace.jsonl")
    const serverPath = join(root, "fake-codex.ts")
    await mkdir(workspace, { recursive: true })
    await writeFile(serverPath, fakeCodexServer, "utf8")
    await chmod(serverPath, 0o755)

    const settings = makeSettings(root, `${shellQuote(serverPath)} app-server`, {
      ...codexOverrides,
      command: `${shellQuote(serverPath)} app-server`,
    }, {
      BEETHOVEN_CODEX_TRACE: tracePath,
      BEETHOVEN_CODEX_SCENARIO: scenario,
    })

    const events: AgentEvent[] = []
    const harness = makeCodexHarness(settings)
    const result = await Effect.runPromise(
      harness.run(makeInput(workspace), (event) =>
        Effect.sync(() => {
          events.push(event)
        }),
      ),
    )

    if (!(await Bun.file(tracePath).exists())) {
      throw new Error(`fake Codex trace was not created; result=${JSON.stringify(result)}`)
    }
    const requests = await readRequests(tracePath)
    return { result, requests, events }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function makeSettings(
  root: string,
  command: string,
  codexOverrides: Partial<Settings["runtime"]["codex"]>,
  env: Record<string, string>,
): Settings {
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
    workspace: { root },
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
      kind: "codex",
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
        env,
      },
      claude: {
        thinkingMode: undefined,
        thinkingBudgetTokens: undefined,
        executable: undefined,
        skillsPath: ".claude/skills",
      },
      codex: {
        command,
        approvalPolicy: undefined,
        autoApproveRequests: false,
        threadSandbox: "workspace-write",
        turnSandboxPolicy: undefined,
        sandboxPolicy: undefined,
        personality: undefined,
        skillsPath: ".codex/skills",
        ...codexOverrides,
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
  }
}

function makeInput(workspace: string): AgentRunInput {
  return {
    workspace: { path: workspace, workspaceKey: "BLE-1", createdNow: true },
    issue: {
      id: "issue-1",
      identifier: "BLE-1",
      title: "Codex harness test",
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
    prompt: "Run the Codex harness test.",
    turnNumber: 1,
  }
}

async function readRequests(tracePath: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  const contents = await readFile(tracePath, "utf8")
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function findRequest(
  requests: ReadonlyArray<Record<string, unknown>>,
  method: string,
): Record<string, unknown> | undefined {
  return requests.find((request) => request.method === method)
}

function paramsOf(request: Record<string, unknown> | undefined): Record<string, unknown> {
  return request?.params && typeof request.params === "object"
    ? (request.params as Record<string, unknown>)
    : {}
}

function hasDynamicTool(
  request: Record<string, unknown> | undefined,
  name: string,
): boolean {
  const params = request?.params as Record<string, unknown> | undefined
  const tools = Array.isArray(params?.dynamicTools) ? params.dynamicTools : []
  return tools.some(
    (tool) =>
      tool &&
      typeof tool === "object" &&
      (tool as Record<string, unknown>).name === name,
  )
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
