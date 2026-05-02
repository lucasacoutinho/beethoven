#!/usr/bin/env bun
import React from "react"
import { render } from "ink"
import { Effect, Fiber, Layer, Logger, LogLevel, Stream } from "effect"
import { BunContext } from "@effect/platform-bun"

import { loadWorkflow } from "../workflow/loader.ts"
import { parseSettings } from "../config/schema.ts"
import { LinearClientLive, makeLinearClient } from "../tracker/linear-client.ts"
import type { Issue } from "../tracker/issue.ts"
import { FileLoggerLive } from "../logging/file-logger.ts"
import { WorkspaceManagerLive } from "../workspace/workspace.ts"
import { AgentRunnerLive } from "../agent/runner.ts"
import {
  Orchestrator,
  OrchestratorLive,
  type DispatchSnapshot,
  type OrchestratorEvent,
} from "../orchestrator/orchestrator.ts"
import { Dashboard } from "./ui/Dashboard.tsx"

interface CliArgs {
  readonly command: "run" | "validate" | "list" | "help"
  readonly workflow: string
  readonly logLevel: "Debug" | "Info" | "Warning" | "Error"
  readonly ui: boolean
  readonly logFile: string
}

const HELP_TEXT = `bethoveen — Claude Code-native Symphony port

Usage:
  bethoveen run [--workflow WORKFLOW.md] [--no-ui] [--log-level Info] [--log-file PATH]
  bethoveen list [--workflow WORKFLOW.md]
  bethoveen validate [--workflow WORKFLOW.md]
  bethoveen help

Run renders an Ink dashboard by default; pass --no-ui for log-only stderr.
List polls the tracker once and prints candidates, then exits — no dispatch.

Run mode always writes JSON-line logs to --log-file (default ./log/bethoveen.log).
With --ui (default), stderr is silenced so the dashboard renders cleanly.
With --no-ui, logs go to both stderr and the file.
`

function parseCli(argv: ReadonlyArray<string>): CliArgs {
  let command: CliArgs["command"] = "help"
  let workflow = "WORKFLOW.md"
  let logLevel: CliArgs["logLevel"] = "Info"
  let ui = true
  let logFile = "log/bethoveen.log"

  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--help" || a === "-h") {
      return { command: "help", workflow, logLevel, ui, logFile }
    }
    if (a === "--workflow" || a === "-w") {
      workflow = argv[++i] ?? workflow
      continue
    }
    if (a === "--log-level") {
      const v = argv[++i] ?? logLevel
      logLevel = (v.charAt(0).toUpperCase() + v.slice(1)) as CliArgs["logLevel"]
      continue
    }
    if (a === "--log-file") {
      logFile = argv[++i] ?? logFile
      continue
    }
    if (a === "--no-ui") {
      ui = false
      continue
    }
    if (a === "--ui") {
      ui = true
      continue
    }
    positional.push(a!)
  }

  command = (positional[0] as CliArgs["command"]) ?? "help"
  return { command, workflow, logLevel, ui, logFile }
}

const program = Effect.gen(function* () {
  const args = parseCli(Bun.argv.slice(2))
  if (args.command === "help") {
    process.stdout.write(HELP_TEXT)
    return
  }

  const workflow = yield* loadWorkflow(args.workflow)
  const settings = yield* parseSettings(workflow.config, workflow.sourcePath)

  if (args.command === "validate") {
    yield* Effect.log("validate_ok").pipe(
      Effect.annotateLogs({
        workflow: workflow.sourcePath,
        tracker: settings.tracker.kind,
        project_slug: settings.tracker.projectSlug,
        workspace_root: settings.workspace.root,
      }),
    )
    return
  }

  if (args.command === "list") {
    if (!settings.tracker.apiKey) {
      yield* Effect.logError("missing_linear_api_key").pipe(
        Effect.annotateLogs({
          hint: "Set LINEAR_API_KEY in env or tracker.api_key in WORKFLOW.md",
        }),
      )
      process.exit(1)
    }
    const tracker = makeLinearClient({
      endpoint: settings.tracker.endpoint,
      apiKey: settings.tracker.apiKey,
      projectSlug: settings.tracker.projectSlug,
    })
    const issues = yield* tracker
      .fetchIssuesByStates(settings.tracker.activeStates)
      .pipe(
        Effect.tapError((e) =>
          Effect.logError("linear_fetch_failed").pipe(
            Effect.annotateLogs({ error: String(e) }),
          ),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<Issue>),
      )

    process.stdout.write(
      `${issues.length} candidate${issues.length === 1 ? "" : "s"} in [${settings.tracker.activeStates.join(", ")}]\n`,
    )
    for (const issue of issues) {
      const labels = issue.labels.length ? `[${issue.labels.join(", ")}]` : ""
      const priority = issue.priority ?? "—"
      process.stdout.write(
        `  ${issue.identifier.padEnd(8)} ${issue.state.padEnd(14)} p=${priority} ${labels} ${issue.title}\n`,
      )
    }
    return
  }

  if (!settings.tracker.apiKey) {
    yield* Effect.logError("missing_linear_api_key").pipe(
      Effect.annotateLogs({
        hint: "Set LINEAR_API_KEY in env or tracker.api_key in WORKFLOW.md",
      }),
    )
    process.exit(1)
  }

  const fileLog = FileLoggerLive({
    filePath: args.logFile,
    suppressStderr: args.ui,
  })

  const layer = OrchestratorLive(settings, workflow.promptTemplate).pipe(
    Layer.provide(LinearClientLive({
      endpoint: settings.tracker.endpoint,
      apiKey: settings.tracker.apiKey,
      projectSlug: settings.tracker.projectSlug,
    })),
    Layer.provide(WorkspaceManagerLive(settings)),
    Layer.provide(AgentRunnerLive(settings)),
    Layer.provide(BunContext.layer),
    Layer.provide(fileLog),
  )

  yield* Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator
      const orchestratorFiber = yield* Effect.forkDaemon(orchestrator.start)

      if (args.ui) {
        yield* runWithUi(orchestrator, {
          projectSlug: settings.tracker.projectSlug,
          maxConcurrentAgents: settings.agent.maxConcurrentAgents,
          pollIntervalMs: settings.polling.intervalMs,
        })
      } else {
        yield* runHeadless(orchestrator)
      }

      yield* Fiber.interrupt(orchestratorFiber)
    }),
  ).pipe(Effect.provide(layer))
}).pipe(
  Logger.withMinimumLogLevel(LogLevel.Info),
)

interface UiOptions {
  readonly projectSlug: string
  readonly maxConcurrentAgents: number
  readonly pollIntervalMs: number
}

const runWithUi = (
  orchestrator: { snapshot: Effect.Effect<DispatchSnapshot>; events: Stream.Stream<OrchestratorEvent> },
  ui: UiOptions,
) =>
  Effect.async<void>((resume) => {
    let snapshotInterval: ReturnType<typeof setInterval> | null = null
    let eventFiber: Fiber.RuntimeFiber<void, never> | null = null
    let inkInstance: ReturnType<typeof render> | null = null

    const subscribe = (
      onSnapshot: (s: DispatchSnapshot) => void,
      onEvent: (e: OrchestratorEvent) => void,
    ): (() => void) => {
      snapshotInterval = setInterval(() => {
        Effect.runPromise(orchestrator.snapshot).then(onSnapshot).catch(() => {})
      }, 500)

      eventFiber = Effect.runFork(
        orchestrator.events.pipe(
          Stream.runForEach((e) => Effect.sync(() => onEvent(e))),
        ),
      )

      return () => {
        if (snapshotInterval) clearInterval(snapshotInterval)
        if (eventFiber) Effect.runFork(Fiber.interrupt(eventFiber))
      }
    }

    inkInstance = render(
      <Dashboard
        subscribe={subscribe}
        projectSlug={ui.projectSlug}
        maxConcurrentAgents={ui.maxConcurrentAgents}
        pollIntervalMs={ui.pollIntervalMs}
      />,
      { exitOnCtrlC: true },
    )

    inkInstance.waitUntilExit().then(
      () => resume(Effect.void),
      () => resume(Effect.void),
    )

    return Effect.sync(() => {
      if (inkInstance) inkInstance.unmount()
    })
  })

const runHeadless = (
  orchestrator: { events: Stream.Stream<OrchestratorEvent> },
) =>
  orchestrator.events.pipe(
    Stream.runForEach((event) =>
      Effect.log("orchestrator_event").pipe(
        Effect.annotateLogs({ event: event._tag, ...stripTag(event) }),
      ),
    ),
  )

function stripTag<T extends { _tag: string }>(event: T): Omit<T, "_tag"> {
  const { _tag, ...rest } = event
  void _tag
  return rest
}

Effect.runPromiseExit(program).then((exit) => {
  if (exit._tag === "Failure") {
    const failures = []
    for (const e of (exit.cause as { failures?: unknown[] }).failures ?? []) {
      failures.push(e)
    }
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "fatal",
        cause: String(exit.cause),
        pretty: JSON.stringify(exit.cause, null, 2),
      }) + "\n",
    )
    process.exit(1)
  }
})
