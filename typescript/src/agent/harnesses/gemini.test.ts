import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentEvent, AgentRunInput, AgentRunResult } from "../harness.ts"
import { makeGeminiHarness } from "./gemini.ts"
import type { Settings } from "../../config/schema.ts"

const fakeGeminiServer = `#!/usr/bin/env bun
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n")
}

// Emulate a gemini stream
write({ type: "init", session_id: "test-session" })
write({ type: "message", role: "assistant", content: "Hello" })
write({ type: "message", role: "assistant", content: " World" })
write({ type: "tool_call", id: "call1", name: "test_tool", input: { arg: 1 } })
write({ type: "tool_result", id: "call1", output: "success", is_error: false })
write({ type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })
`

describe("Gemini harness", () => {
    test("sends proper payloads and maps outputs", async () => {
        const root = await mkdtemp(join(tmpdir(), "beethoven-gemini-test-"))
        try {
            const workspace = join(root, "workspace")
            const serverPath = join(root, "fake-gemini.ts")
            await mkdir(workspace, { recursive: true })
            await writeFile(serverPath, fakeGeminiServer, "utf8")
            await chmod(serverPath, 0o755)

            const settings = makeSettings(root, serverPath)
            const events: AgentEvent[] = []
            const harness = makeGeminiHarness(settings)

            const result = await Effect.runPromise(
                harness.run(makeInput(workspace), (event) =>
                    Effect.sync(() => {
                        events.push(event)
                    }),
                ),
            )

            expect(result.status).toBe("completed")
            expect(result.sessionId).toBe("test-session")
            expect(result.inputTokens).toBe(10)
            expect(result.outputTokens).toBe(5)
            expect(result.totalTokens).toBe(15)

            // Test event mapping
            const textEvents = events.filter((e) => e._tag === "text_delta")
            expect(textEvents.length).toBe(2)
            const text0 = textEvents[0]
            if (text0 && text0._tag === "text_delta") expect(text0.text).toBe("Hello")

            const callEvents = events.filter((e) => e._tag === "tool_call")
            expect(callEvents.length).toBe(1)
            const call0 = callEvents[0]
            if (call0 && call0._tag === "tool_call") expect(call0.toolName).toBe("test_tool")

            const resultEvents = events.filter((e) => e._tag === "tool_result")
            expect(resultEvents.length).toBe(1)
            const result0 = resultEvents[0]
            if (result0 && result0._tag === "tool_result") expect(result0.output).toBe("success")

        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})

function makeSettings(root: string, executable: string): Settings {
    return {
        tracker: {
            kind: "linear",
            endpoint: "https://linear.example/graphql",
            apiKey: undefined,
            projectSlug: "beacon",
            activeStates: [],
            terminalStates: [],
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
            kind: "gemini",
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
                executable,
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
            title: "Gemini harness test",
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
        prompt: "Run the Gemini harness test.",
        turnNumber: 1,
    }
}
