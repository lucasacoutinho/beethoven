import { Context, Data, Effect, Fiber, Layer, Stream } from "effect"
import { Command, CommandExecutor } from "@effect/platform"
import { mkdir, rm, stat, symlink, lstat, unlink, readlink } from "node:fs/promises"
import * as path from "node:path"
import type { Issue } from "../tracker/issue.ts"
import { workspaceKey } from "../tracker/issue.ts"
import type { Settings } from "../config/schema.ts"
import { CANONICAL_SKILLS_SOURCE } from "../agent/harness.ts"

export interface Workspace {
  readonly path: string
  readonly workspaceKey: string
  readonly createdNow: boolean
}

export interface HookResult {
  readonly hook: string
  readonly status: "ok" | "skipped" | "failed" | "timed_out"
  readonly exitCode: number | null
  readonly stdoutTail: string
  readonly stderrTail: string
}

export class HookFailure extends Data.TaggedError("HookFailure")<{
  readonly result: HookResult
}> {}

export type LinkSkillsResult =
  | { readonly status: "linked"; readonly from: string; readonly to: string }
  | { readonly status: "already_linked"; readonly from: string; readonly to: string }
  | {
      readonly status: "skipped"
      readonly reason:
        | "no_canonical_source"
        | "occupied_non_symlink"
        | "is_canonical_source"
    }
  | { readonly status: "failed"; readonly reason: string }

export interface WorkspaceManagerService {
  readonly resolvePath: (issue: Issue) => string
  readonly createForIssue: (issue: Issue) => Effect.Effect<Workspace, HookFailure>
  readonly runBeforeRun: (
    workspace: Workspace,
    issue: Issue,
  ) => Effect.Effect<HookResult, HookFailure>
  readonly runAfterRun: (
    workspace: Workspace,
    issue: Issue,
  ) => Effect.Effect<HookResult>
  readonly removeWorkspace: (issue: Issue) => Effect.Effect<HookResult>
  /**
   * Symlink the harness's expected skills directory to the canonical
   * `.agents/skills/` source-of-truth. Idempotent: a no-op if the link
   * already points at the right target. Skipped (not failed) if the
   * canonical source doesn't exist yet.
   */
  readonly linkAgentSkills: (
    workspace: Workspace,
    harnessSkillsPath: string,
  ) => Effect.Effect<LinkSkillsResult>
}

export class WorkspaceManager extends Context.Tag("bethoveen/WorkspaceManager")<
  WorkspaceManager,
  WorkspaceManagerService
>() {}

const TAIL_BYTES = 4_000

export const WorkspaceManagerLive = (settings: Settings) =>
  Layer.effect(
    WorkspaceManager,
    Effect.map(CommandExecutor.CommandExecutor, (executor) =>
      makeWorkspaceManager(settings, executor),
    ),
  )

const makeWorkspaceManager = (
  settings: Settings,
  executor: CommandExecutor.CommandExecutor,
): WorkspaceManagerService => {
  const env = filteredEnv()

  const resolvePath = (issue: Issue): string =>
    path.join(settings.workspace.root, workspaceKey(issue.identifier))

  const runHook = (
    name: string,
    script: string,
    cwd: string,
  ): Effect.Effect<HookResult> =>
    Effect.scoped(
      Effect.gen(function* () {
        const cmd = Command.make("bash", "-lc", script).pipe(
          Command.workingDirectory(cwd),
          Command.env(env),
          Command.stdout("pipe"),
          Command.stderr("pipe"),
        )

        const proc = yield* executor.start(cmd)
        const stdoutFiber = yield* Effect.fork(collectTail(proc.stdout))
        const stderrFiber = yield* Effect.fork(collectTail(proc.stderr))
        const exitCode = yield* proc.exitCode
        const stdoutTail = yield* Fiber.join(stdoutFiber)
        const stderrTail = yield* Fiber.join(stderrFiber)

        return {
          hook: name,
          status: exitCode === 0 ? ("ok" as const) : ("failed" as const),
          exitCode,
          stdoutTail,
          stderrTail,
        }
      }),
    ).pipe(
      Effect.timeoutTo({
        duration: `${settings.hooks.timeoutMs} millis`,
        onTimeout: (): HookResult => ({
          hook: name,
          status: "timed_out",
          exitCode: null,
          stdoutTail: "",
          stderrTail: "hook timed out",
        }),
        onSuccess: (r) => r,
      }),
      Effect.catchAll(() =>
        Effect.succeed<HookResult>({
          hook: name,
          status: "failed",
          exitCode: null,
          stdoutTail: "",
          stderrTail: "hook execution error",
        }),
      ),
    )

  const createForIssue: WorkspaceManagerService["createForIssue"] = (issue) =>
    Effect.gen(function* () {
      const wsPath = resolvePath(issue)
      yield* Effect.promise(() =>
        mkdir(settings.workspace.root, { recursive: true }),
      )

      const exists = yield* Effect.promise(() => pathExists(wsPath))
      if (!exists) {
        yield* Effect.promise(() => mkdir(wsPath, { recursive: true }))
      }

      const ws: Workspace = {
        path: wsPath,
        workspaceKey: workspaceKey(issue.identifier),
        createdNow: !exists,
      }

      if (ws.createdNow && settings.hooks.afterCreate) {
        const result = yield* runHook(
          "after_create",
          settings.hooks.afterCreate,
          ws.path,
        )
        if (result.status !== "ok") {
          yield* Effect.promise(() =>
            rm(ws.path, { recursive: true, force: true }).catch(() => {}),
          )
          return yield* Effect.fail(new HookFailure({ result }))
        }
      }

      return ws
    })

  const runBeforeRun: WorkspaceManagerService["runBeforeRun"] = (workspace) =>
    Effect.gen(function* () {
      if (!settings.hooks.beforeRun) return skipped("before_run")
      const result = yield* runHook(
        "before_run",
        settings.hooks.beforeRun,
        workspace.path,
      )
      if (result.status !== "ok") {
        return yield* Effect.fail(new HookFailure({ result }))
      }
      return result
    })

  const runAfterRun: WorkspaceManagerService["runAfterRun"] = (workspace) => {
    if (!settings.hooks.afterRun) return Effect.succeed(skipped("after_run"))
    return runHook("after_run", settings.hooks.afterRun, workspace.path)
  }

  const removeWorkspace: WorkspaceManagerService["removeWorkspace"] = (issue) =>
    Effect.gen(function* () {
      const wsPath = resolvePath(issue)
      const exists = yield* Effect.promise(() => pathExists(wsPath))
      if (!exists) return skipped("before_remove")

      let result = skipped("before_remove")
      if (settings.hooks.beforeRemove) {
        result = yield* runHook(
          "before_remove",
          settings.hooks.beforeRemove,
          wsPath,
        )
      }
      yield* Effect.promise(() =>
        rm(wsPath, { recursive: true, force: true }),
      )
      return result
    })

  const linkAgentSkills: WorkspaceManagerService["linkAgentSkills"] = (
    workspace,
    harnessSkillsPath,
  ) =>
    Effect.promise(() =>
      ensureSkillsSymlink(workspace.path, harnessSkillsPath),
    )

  return {
    resolvePath,
    createForIssue,
    runBeforeRun,
    runAfterRun,
    removeWorkspace,
    linkAgentSkills,
  }
}

async function ensureSkillsSymlink(
  workspaceRoot: string,
  harnessSkillsPath: string,
): Promise<LinkSkillsResult> {
  const canonicalAbs = path.resolve(workspaceRoot, CANONICAL_SKILLS_SOURCE)
  const linkAbs = path.resolve(workspaceRoot, harnessSkillsPath)

  // Some harnesses (opencode) consume `.agents/skills` natively — the link
  // path IS the canonical source. Nothing to do.
  if (linkAbs === canonicalAbs) {
    return { status: "skipped", reason: "is_canonical_source" }
  }

  if (!(await pathExists(canonicalAbs))) {
    return { status: "skipped", reason: "no_canonical_source" }
  }

  // Compute a relative target so the symlink survives the workspace being
  // moved or remounted under a different absolute prefix.
  const relativeTarget = path.relative(path.dirname(linkAbs), canonicalAbs)

  try {
    const existing = await lstat(linkAbs).catch(() => null)
    if (existing) {
      if (existing.isSymbolicLink()) {
        const current = await readlink(linkAbs).catch(() => null)
        if (current === relativeTarget) {
          return { status: "already_linked", from: linkAbs, to: relativeTarget }
        }
        await unlink(linkAbs)
      } else {
        // A real directory or file is sitting at the harness path. Don't
        // clobber — operator may have intentionally placed something there.
        return { status: "skipped", reason: "occupied_non_symlink" }
      }
    } else {
      await mkdir(path.dirname(linkAbs), { recursive: true })
    }

    await symlink(relativeTarget, linkAbs, "dir")
    return { status: "linked", from: linkAbs, to: relativeTarget }
  } catch (err) {
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

const collectTail = (
  stream: Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<string, unknown> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold("", (acc, chunk) => appendTail(acc, chunk)),
  )

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function appendTail(existing: string, addition: string): string {
  const combined = existing + addition
  if (combined.length <= TAIL_BYTES) return combined
  return combined.slice(combined.length - TAIL_BYTES)
}

function skipped(name: string): HookResult {
  return {
    hook: name,
    status: "skipped",
    exitCode: null,
    stdoutTail: "",
    stderrTail: "",
  }
}

function filteredEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(Bun.env)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}
