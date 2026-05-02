import { Effect, Ref, Stream } from "effect"
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import type {
  AgentEvent,
  AgentRunInput,
  AgentRunResult,
  AgentTokens,
  Harness,
  HarnessKind,
  RateLimitBucket,
  RateLimitCredits,
  RateLimitSnapshot,
} from "../harness.ts"
import { AgentRunError } from "../harness.ts"
import type { Settings } from "../../config/schema.ts"
import {
  beethovenToolDefinitions,
  executeBeethovenTool,
} from "../../tools/index.ts"
import type { ToolExecutionContext } from "../../tools/tool.ts"
import { toCodexDynamicTools } from "./codex-tools.ts"

const KIND: HarnessKind = "codex"
const INITIALIZE_ID = 1
const THREAD_START_ID = 2
const TURN_START_ID = 3
const NON_INTERACTIVE_ANSWER =
  "This is a non-interactive session. Operator input is unavailable."
const BRIDGE_READY = "beethoven/codex-stdio-bridge-ready"

const CODEX_STDIO_BRIDGE = String.raw`
const { spawn } = require("node:child_process")
const { appendFileSync, existsSync, readFileSync, statSync, unwatchFile, watchFile, writeFileSync } = require("node:fs")

const command = process.env.BEETHOVEN_CODEX_COMMAND
const cwd = process.env.BEETHOVEN_CODEX_CWD
const inputPath = process.env.BEETHOVEN_CODEX_INPUT
const outputPath = process.env.BEETHOVEN_CODEX_OUTPUT
const readyPath = process.env.BEETHOVEN_CODEX_READY
const shell = process.env.BEETHOVEN_CODEX_SHELL || "sh"

if (!command || !cwd || !inputPath || !outputPath || !readyPath) {
  console.error("Missing Codex bridge configuration.")
  process.exit(1)
}

let offset = 0
let closed = false
const child = spawn(shell, ["-lc", command], {
  cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
})

function pumpInput() {
  if (closed || !existsSync(inputPath)) return
  let size = 0
  try {
    size = statSync(inputPath).size
  } catch {
    return
  }
  if (size <= offset) return
  const chunk = readFileSync(inputPath).subarray(offset, size)
  offset = size
  if (chunk.length > 0) child.stdin.write(chunk)
}

function shutdown(code = 0) {
  if (closed) return
  closed = true
  unwatchFile(inputPath)
  child.kill()
  process.exit(code)
}

child.stdout.on("data", (chunk) => appendFileSync(outputPath, chunk))
child.stderr.on("data", () => {})
child.on("exit", (code) => shutdown(code ?? 0))
child.on("error", (error) => {
  console.error(error && error.stack ? error.stack : String(error))
  shutdown(1)
})

watchFile(inputPath, { interval: 10 }, pumpInput)
setInterval(pumpInput, 10).unref()
process.on("SIGTERM", () => shutdown(0))
process.on("SIGINT", () => shutdown(0))
writeFileSync(readyPath, "${BRIDGE_READY}")
`

interface JsonRpcMessage {
  readonly id?: number | string
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
  readonly error?: unknown
}

interface CodexSession {
  readonly transport: CodexTransport
  readonly settings: Settings
  readonly input: AgentRunInput
  readonly cwd: string
  readonly approvalPolicy: unknown
  readonly threadSandbox: string
  readonly sandboxPolicy: unknown
  readonly autoApproveRequests: boolean
}

interface CodexTransport {
  readonly reader: JsonLineReader
  readonly pid: number | null
  readonly send: (message: Record<string, unknown>) => void
  readonly close: () => void
}

interface JsonLineReader {
  nextLine(): Promise<string | null>
}

export const makeCodexHarness = (settings: Settings): Harness => {
  const codex = settings.runtime.codex
  const common = settings.runtime.common

  const runWithEvents: Harness["runWithEvents"] = (input) =>
    Stream.async<AgentEvent, AgentRunError>((emit) => {
      ;(async () => {
        let session: CodexSession | null = null
        try {
          session = await startSession(settings, input)
          if (session.transport.pid !== null) {
            await emit.single({
              _tag: "process_started",
              pid: session.transport.pid,
            })
          }
          const threadId = await startThread(session)
          const turnId = await startTurn(session, threadId, input)
          await emit.single({
            _tag: "session_started",
            sessionId: `${threadId}-${turnId}`,
            threadId,
          })

          await readTurn(session, emit)
          await emit.end()
        } catch (cause) {
          await emit.fail(new AgentRunError({ harness: KIND, cause }))
        } finally {
          session?.transport.close()
        }
      })()
    })

  const run: Harness["run"] = (input, onEvent) =>
    Effect.gen(function* () {
      const stateRef = yield* Ref.make<AgentRunResult>({
        status: "completed",
        sessionId: null,
        threadId: null,
        finalText: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      })

      yield* runWithEvents(input).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* Ref.update(stateRef, (prev) => mergeEvent(prev, event))
            if (onEvent) yield* onEvent(event)
          }),
        ),
        Effect.timeoutFail({
          duration: `${common.turnTimeoutMs} millis`,
          onTimeout: () => null,
        }),
        Effect.catchTag("AgentRunError", (e) =>
          Ref.update(stateRef, (prev) => ({
            ...prev,
            status: "errored" as const,
          })).pipe(Effect.flatMap(() => Effect.fail(e))),
        ),
        Effect.catchAll((e) =>
          e === null
            ? Ref.update(stateRef, (prev) => ({
                ...prev,
                status: "timed_out" as const,
              }))
            : Effect.fail(e as AgentRunError),
        ),
      )

      return yield* Ref.get(stateRef)
    })

  return {
    kind: KIND,
    skillsPath: codex.skillsPath,
    run,
    runWithEvents,
  }
}

async function startSession(
  settings: Settings,
  input: AgentRunInput,
): Promise<CodexSession> {
  const cwd = path.resolve(input.workspace.path, settings.runtime.common.cwd)
  const command = settings.runtime.codex.command ?? defaultCodexCommand(settings)
  const shell = Bun.which("bash") ?? Bun.which("sh") ?? "sh"
  const env = {
    ...Bun.env,
    ...(settings.runtime.common.env ?? {}),
  } as Record<string, string>

  const transport = await startCodexTransport(command, cwd, shell, env)

  const session: CodexSession = {
    transport,
    settings,
    input,
    cwd,
    approvalPolicy: toCodexApprovalPolicy(settings),
    threadSandbox: settings.runtime.codex.threadSandbox,
    sandboxPolicy: toCodexSandboxPolicy(settings, cwd),
    autoApproveRequests:
      settings.runtime.codex.autoApproveRequests ||
      settings.runtime.codex.approvalPolicy === "never",
  }

  send(session, {
    id: INITIALIZE_ID,
    method: "initialize",
    params: {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "beethoven-orchestrator",
        title: "Beethoven Orchestrator",
        version: "0.1.0",
      },
    },
  })
  await readResponse(session, INITIALIZE_ID)
  send(session, { method: "initialized", params: {} })

  return session
}

function defaultCodexCommand(settings: Settings): string {
  const common = settings.runtime.common
  const config: string[] = []
  if (common.model) config.push(`model=${JSON.stringify(common.model)}`)
  if (common.effort) {
    config.push(`model_reasoning_effort=${JSON.stringify(toCodexReasoningEffort(common.effort))}`)
  }

  const configArgs = config.map((value) => `-c ${shellQuote(value)}`).join(" ")
  return configArgs ? `codex ${configArgs} app-server` : "codex app-server"
}

function toCodexReasoningEffort(
  effort: NonNullable<Settings["runtime"]["common"]["effort"]>,
): string {
  return effort === "max" ? "xhigh" : effort
}

async function startThread(session: CodexSession): Promise<string> {
  send(session, {
    id: THREAD_START_ID,
    method: "thread/start",
    params: {
      approvalPolicy: session.approvalPolicy,
      sandbox: session.threadSandbox,
      cwd: session.cwd,
      dynamicTools: toCodexDynamicTools(beethovenToolDefinitions(session.settings)),
    },
  })

  const result = await readResponse(session, THREAD_START_ID)
  const threadId = getPath(result, ["thread", "id"])
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error(`Invalid Codex thread/start response: ${safeJson(result)}`)
  }
  return threadId
}

async function startTurn(
  session: CodexSession,
  threadId: string,
  input: AgentRunInput,
): Promise<string> {
  send(session, {
    id: TURN_START_ID,
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: input.prompt }],
      cwd: session.cwd,
      title: `${input.issue.identifier}: ${input.issue.title}`,
      approvalPolicy: session.approvalPolicy,
      sandboxPolicy: session.sandboxPolicy,
    },
  })

  const result = await readResponse(session, TURN_START_ID)
  const turnId = getPath(result, ["turn", "id"])
  if (typeof turnId !== "string" || turnId.length === 0) {
    throw new Error(`Invalid Codex turn/start response: ${safeJson(result)}`)
  }
  return turnId
}

async function readTurn(
  session: CodexSession,
  emit: Parameters<Parameters<typeof Stream.async<AgentEvent, AgentRunError>>[0]>[0],
): Promise<void> {
  let cumulative: AgentTokens = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }

  while (true) {
    const message = await readJson(session.transport.reader)
    if (message === null) {
      throw new Error("Codex app-server exited before turn completed")
    }

    const method = message.method
    if (typeof method === "string") {
      await emit.single({ _tag: "raw", harness: KIND, kind: method })
    }

    const rateLimits = extractRateLimits(message)
    if (rateLimits) {
      await emit.single({ _tag: "rate_limits_updated", rateLimits })
    }

    const usage = extractTokenUsage(message)
    if (usage) {
      const delta = {
        inputTokens: Math.max(0, usage.inputTokens - cumulative.inputTokens),
        outputTokens: Math.max(0, usage.outputTokens - cumulative.outputTokens),
        totalTokens: Math.max(0, usage.totalTokens - cumulative.totalTokens),
      }
      cumulative = usage
      await emit.single({ _tag: "tokens_updated", delta, cumulative })
    }

    const normalized = normalizeMethod(message)
    for (const event of normalized) {
      await emit.single(event)
    }

    if (method && (await handleApproval(session, message, emit))) {
      continue
    }

    if (method === "turn/completed") return
    if (method === "turn/failed" || method === "turn/cancelled") {
      const reason = `${method}: ${safeJson(message.params ?? message)}`
      await emit.single({ _tag: "run_failed", reason })
      return
    }

    if (needsInput(method, message)) {
      const reason = `${method ?? "codex/input_required"}: ${safeJson(message)}`
      await emit.single({ _tag: "run_failed", reason })
      return
    }
  }
}

function normalizeMethod(message: JsonRpcMessage): ReadonlyArray<AgentEvent> {
  const method = message.method
  const params = message.params ?? {}

  switch (method) {
    case "item/agentMessage/delta": {
      const text = stringParam(params, ["delta", "text", "message"])
      return text ? [{ _tag: "text_delta", text }] : []
    }
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/plan/delta": {
      const text = stringParam(params, [
        "textDelta",
        "summaryText",
        "delta",
        "text",
      ])
      return text ? [{ _tag: "reasoning_delta", text }] : []
    }
    case "item/commandExecution/requestApproval":
      return [
        {
          _tag: "approval_requested",
          kind: "command",
          summary: stringParam(params, ["parsedCmd", "command", "reason"]) ?? "command approval requested",
        },
      ]
    case "item/fileChange/requestApproval":
      return [
        {
          _tag: "approval_requested",
          kind: "file",
          summary:
            stringParam(params, ["summary", "reason"]) ??
            `file change approval requested`,
        },
      ]
    case "item/tool/call": {
      const toolName = toolCallName(params) ?? "dynamic_tool"
      return [
        {
          _tag: "tool_call",
          toolName,
          toolCallId: typeof message.id === "string" ? message.id : String(message.id ?? ""),
          input: toolCallArguments(params),
        },
      ]
    }
    case "item/started": {
      const item = objectParam(params, "item")
      const itemType = typeof item?.type === "string" ? item.type : "item"
      return [
        {
          _tag: "tool_call",
          toolName: itemType,
          toolCallId: typeof item?.id === "string" ? item.id : null,
          input: item ?? params,
        },
      ]
    }
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta": {
      const output = stringParam(params, ["outputDelta", "delta", "text"])
      return output
        ? [
            {
              _tag: "tool_result",
              toolCallId: null,
              output,
              isError: false,
            },
          ]
        : []
    }
    default:
      return []
  }
}

async function handleApproval(
  session: CodexSession,
  message: JsonRpcMessage,
  emit: Parameters<Parameters<typeof Stream.async<AgentEvent, AgentRunError>>[0]>[0],
): Promise<boolean> {
  const id = message.id
  if (id === undefined) return false

  if (
    message.method === "item/commandExecution/requestApproval" ||
    message.method === "item/fileChange/requestApproval"
  ) {
    if (!session.autoApproveRequests) return false
    send(session, { id, result: { decision: "acceptForSession" } })
    await emit.single({
      _tag: "text_delta",
      text: "Codex approval request auto-approved for this session.",
    })
    return true
  }

  if (message.method === "execCommandApproval" || message.method === "applyPatchApproval") {
    if (!session.autoApproveRequests) return false
    send(session, { id, result: { decision: "approved_for_session" } })
    await emit.single({
      _tag: "text_delta",
      text: "Codex approval request auto-approved for this session.",
    })
    return true
  }

  if (message.method === "item/tool/requestUserInput") {
    const answers = toolInputAnswers(message.params, session.autoApproveRequests)
    if (!answers) return false
    send(session, { id, result: { answers } })
    await emit.single({
      _tag: "text_delta",
      text: "Codex tool input prompt answered automatically.",
    })
    return true
  }

  if (message.method === "item/tool/call") {
    const params = message.params ?? {}
    const toolName = toolCallName(params)
    const result = await executeBeethovenTool(
      session.settings,
      toolName,
      toolCallArguments(params),
      toolContext(session.input),
    )
    send(session, { id, result })
    await emit.single({
      _tag: "tool_result",
      toolCallId: typeof id === "string" ? id : String(id),
      output: result,
      isError: result.success !== true,
    })
    return true
  }

  return false
}

function toolContext(input: AgentRunInput): ToolExecutionContext {
  return {
    workspace: input.workspace,
    issue: input.issue,
    prompt: input.prompt,
    ...(input.delegateTask ? { delegateTask: input.delegateTask } : {}),
  }
}

function toolInputAnswers(
  params: Record<string, unknown> | undefined,
  approve: boolean,
): Record<string, { answers: string[] }> | null {
  const questions = Array.isArray(params?.questions) ? params.questions : []
  const answers: Record<string, { answers: string[] }> = {}

  for (const q of questions) {
    if (!q || typeof q !== "object") continue
    const question = q as Record<string, unknown>
    const id = typeof question.id === "string" ? question.id : null
    if (!id) continue
    const options = Array.isArray(question.options) ? question.options : []
    const approvalLabel = approve ? approvalOptionLabel(options) : null
    answers[id] = { answers: [approvalLabel ?? NON_INTERACTIVE_ANSWER] }
  }

  return Object.keys(answers).length > 0 ? answers : null
}

function approvalOptionLabel(options: ReadonlyArray<unknown>): string | null {
  const labels = options
    .map((option) =>
      option && typeof option === "object"
        ? (option as Record<string, unknown>).label
        : null,
    )
    .filter((label): label is string => typeof label === "string")

  return (
    labels.find((label) => label === "Approve this Session") ??
    labels.find((label) => label === "Approve Once") ??
    labels.find((label) => {
      const normalized = label.trim().toLowerCase()
      return normalized.startsWith("approve") || normalized.startsWith("allow")
    }) ??
    null
  )
}

async function readResponse(
  session: CodexSession,
  requestId: number,
): Promise<unknown> {
  while (true) {
    const message = await readJson(session.transport.reader)
    if (message === null) {
      throw new Error(`Codex app-server exited while waiting for response ${requestId}`)
    }
    if (message.id !== requestId) continue
    if (message.error !== undefined) {
      throw new Error(`Codex response ${requestId} errored: ${safeJson(message.error)}`)
    }
    return message.result
  }
}

async function readJson(reader: JsonLineReader): Promise<JsonRpcMessage | null> {
  while (true) {
    const line = await reader.nextLine()
    if (line === null) return null
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === "object") {
        return parsed as JsonRpcMessage
      }
    } catch {
      continue
    }
  }
}

function send(session: CodexSession, message: Record<string, unknown>): void {
  session.transport.send(message)
}

async function startCodexTransport(
  command: string,
  cwd: string,
  shell: string,
  env: Record<string, string>,
): Promise<CodexTransport> {
  const node = Bun.which("node")
  if (!node) {
    throw new Error("Codex harness requires `node` to run the stdio bridge.")
  }

  const bridgeDir = mkdtempSync(path.join(tmpdir(), "beethoven-codex-"))
  const inputPath = path.join(bridgeDir, "stdin.jsonl")
  const outputPath = path.join(bridgeDir, "stdout.jsonl")
  const readyPath = path.join(bridgeDir, "ready")
  writeFileSync(inputPath, "")
  writeFileSync(outputPath, "")

  const bridge = Bun.spawn([node, "-e", CODEX_STDIO_BRIDGE], {
    cwd,
    env: {
      ...env,
      BEETHOVEN_CODEX_COMMAND: command,
      BEETHOVEN_CODEX_CWD: cwd,
      BEETHOVEN_CODEX_INPUT: inputPath,
      BEETHOVEN_CODEX_OUTPUT: outputPath,
      BEETHOVEN_CODEX_READY: readyPath,
      BEETHOVEN_CODEX_SHELL: shell,
    },
    stdout: "ignore",
    stderr: "ignore",
  })

  await waitForBridgeReady(readyPath, bridgeDir)

  const reader = new FileLineReader(outputPath)
  bridge.exited.then(() => reader.close()).catch(() => reader.close())

  return {
    reader,
    pid: typeof bridge.pid === "number" ? bridge.pid : null,
    send: (message) => {
      appendFileSync(inputPath, `${JSON.stringify(message)}\n`)
    },
    close: () => {
      reader.close()
      bridge.kill()
      rmSync(bridgeDir, { recursive: true, force: true })
    },
  }
}

async function waitForBridgeReady(
  readyPath: string,
  bridgeDir: string,
): Promise<void> {
  const startedAt = Date.now()
  while (!existsSync(readyPath)) {
    if (Date.now() - startedAt > 2_000) {
      rmSync(bridgeDir, { recursive: true, force: true })
      throw new Error("Codex stdio bridge did not become ready within 2s.")
    }
    await sleep(10)
  }
  const marker = readFileSync(readyPath, "utf8")
  if (marker !== BRIDGE_READY) {
    rmSync(bridgeDir, { recursive: true, force: true })
    throw new Error("Codex stdio bridge produced an invalid ready marker.")
  }
}

function mergeEvent(prev: AgentRunResult, event: AgentEvent): AgentRunResult {
  switch (event._tag) {
    case "process_started":
      return prev
    case "session_started":
      return {
        ...prev,
        sessionId: event.sessionId ?? prev.sessionId,
        threadId: event.threadId ?? prev.threadId,
      }
    case "tokens_updated":
      return { ...prev, ...event.cumulative }
    case "text_delta":
      return {
        ...prev,
        finalText: event.text.length > 200 ? event.text.slice(0, 200) + "..." : event.text,
      }
    case "run_failed":
      return { ...prev, status: "errored", finalText: event.reason }
    case "rate_limits_updated":
    case "reasoning_delta":
    case "tool_call":
    case "tool_result":
    case "approval_requested":
    case "raw":
      return prev
  }
}

function toCodexApprovalPolicy(settings: Settings): unknown {
  const policy = settings.runtime.codex.approvalPolicy
  if (policy === undefined) {
    return { reject: { sandbox_approval: true, rules: true, mcp_elicitations: true } }
  }
  if (typeof policy === "object") return policy
  if (policy === "onRequest") return "on-request"
  if (policy === "unlessTrusted") return "unless-trusted"
  return policy
}

function toCodexSandboxPolicy(settings: Settings, cwd: string): unknown {
  if (settings.runtime.codex.turnSandboxPolicy) {
    return settings.runtime.codex.turnSandboxPolicy
  }
  switch (settings.runtime.codex.sandboxPolicy) {
    case "readOnly":
      return { type: "readOnly" }
    case "dangerFullAccess":
      return { type: "dangerFullAccess" }
    case "externalSandbox":
      return { type: "externalSandbox" }
    case "workspaceWrite":
    case undefined:
      return {
        type: "workspaceWrite",
        writableRoots: [cwd],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
  }
}

function toolCallName(params: Record<string, unknown>): string | null {
  const name = params.tool ?? params.name
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null
}

function toolCallArguments(params: Record<string, unknown>): unknown {
  return params.arguments ?? {}
}

function extractTokenUsage(message: JsonRpcMessage): AgentTokens | null {
  const usage =
    objectAt(message, ["params", "tokenUsage", "total"]) ??
    objectAt(message, ["params", "usage"]) ??
    objectAt(message, ["usage"])
  if (!usage) return null

  const inputTokens = numberFromKeys(usage, ["input_tokens", "inputTokens", "input"])
  const outputTokens = numberFromKeys(usage, ["output_tokens", "outputTokens", "output"])
  const totalTokens =
    numberFromKeys(usage, ["total_tokens", "totalTokens", "total"]) ??
    (inputTokens ?? 0) + (outputTokens ?? 0)

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === 0) {
    return null
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens,
  }
}

function extractRateLimits(message: JsonRpcMessage): RateLimitSnapshot | null {
  const payload =
    objectAt(message, ["params", "rate_limits"]) ??
    objectAt(message, ["params", "rateLimits"]) ??
    objectAt(message, ["rate_limits"]) ??
    objectAt(message, ["rateLimits"])
  if (!payload) return null

  const limitId =
    stringParam(payload, ["limit_id", "limitId", "limit_name", "limitName"]) ??
    "codex"
  const primary = objectParam(payload, "primary")
  const secondary = objectParam(payload, "secondary")
  const credits = objectParam(payload, "credits")
  const primaryBucket = primary ? rateLimitBucket(primary) : null
  const secondaryBucket = secondary ? rateLimitBucket(secondary) : null
  const creditBucket = credits ? rateLimitCredits(credits) : null

  return {
    harness: KIND,
    limitId,
    status: limitStatus(primary, secondary),
    ...(primaryBucket ? { primary: primaryBucket } : {}),
    ...(secondaryBucket ? { secondary: secondaryBucket } : {}),
    ...(creditBucket ? { credits: creditBucket } : {}),
  }
}

function rateLimitBucket(bucket: Record<string, unknown>): RateLimitBucket | null {
  const remaining = numberFromKeys(bucket, ["remaining"])
  const limit = numberFromKeys(bucket, ["limit"])
  const resetInSeconds = numberFromKeys(bucket, ["reset_in_seconds", "resetInSeconds"])
  const result: RateLimitBucket = {
    ...(remaining !== undefined ? { remaining } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(resetInSeconds !== undefined ? { resetInSeconds } : {}),
  }
  return Object.keys(result).length > 0 ? result : null
}

function rateLimitCredits(credits: Record<string, unknown>): RateLimitCredits | null {
  const balance = numberFromKeys(credits, ["balance"])
  const hasCredits =
    typeof credits.has_credits === "boolean"
      ? credits.has_credits
      : typeof credits.hasCredits === "boolean"
        ? credits.hasCredits
        : undefined
  const result: RateLimitCredits = {
    ...(typeof credits.unlimited === "boolean" ? { unlimited: credits.unlimited } : {}),
    ...(hasCredits !== undefined ? { hasCredits } : {}),
    ...(balance !== undefined ? { balance } : {}),
  }
  return Object.keys(result).length > 0 ? result : null
}

function limitStatus(
  primary: Record<string, unknown> | null,
  secondary: Record<string, unknown> | null,
): NonNullable<RateLimitSnapshot["status"]> {
  const primaryRemaining = primary ? numberFromKeys(primary, ["remaining"]) : undefined
  const secondaryRemaining = secondary ? numberFromKeys(secondary, ["remaining"]) : undefined
  if (primaryRemaining === 0 || secondaryRemaining === 0) return "rejected"
  return "allowed"
}

function needsInput(method: string | undefined, message: JsonRpcMessage): boolean {
  if (!method?.startsWith("turn/")) return false
  if (
    [
      "turn/input_required",
      "turn/needs_input",
      "turn/need_input",
      "turn/request_input",
      "turn/request_response",
      "turn/provide_input",
      "turn/approval_required",
    ].includes(method)
  ) {
    return true
  }
  return inputRequired(message) || inputRequired(message.params)
}

function inputRequired(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    v.requiresInput === true ||
    v.needsInput === true ||
    v.input_required === true ||
    v.inputRequired === true ||
    v.type === "input_required" ||
    v.type === "needs_input"
  )
}

function objectAt(value: unknown, path: ReadonlyArray<string>): Record<string, unknown> | null {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== "object") return null
    current = (current as Record<string, unknown>)[key]
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null
}

function getPath(value: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function objectParam(
  params: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = params?.[key]
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringParam(
  params: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function numberFromKeys(
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const key of keys) {
    const n = value[key]
    if (typeof n === "number" && Number.isFinite(n)) return n
  }
  return undefined
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

class FileLineReader implements JsonLineReader {
  private readonly decoder = new TextDecoder()
  private offset = 0
  private buffer = ""
  private closed = false

  constructor(private readonly filePath: string) {}

  close(): void {
    this.closed = true
  }

  async nextLine(): Promise<string | null> {
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        return line.replace(/\r$/, "")
      }

      if (existsSync(this.filePath)) {
        const size = statSync(this.filePath).size
        if (size > this.offset) {
          const length = size - this.offset
          const chunk = Buffer.allocUnsafe(length)
          const fd = openSync(this.filePath, "r")
          try {
            readSync(fd, chunk, 0, length, this.offset)
          } finally {
            closeSync(fd)
          }
          this.offset = size
          this.buffer += this.decoder.decode(chunk, { stream: true })
          continue
        }
      }

      if (this.closed) {
        if (this.buffer.length === 0) return null
        const line = this.buffer
        this.buffer = ""
        return line.replace(/\r$/, "")
      }

      await sleep(10)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
