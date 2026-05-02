import { Data, Effect } from "effect"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { parse as parseYaml } from "yaml"

export interface WorkflowDefinition {
  readonly config: Record<string, unknown>
  readonly promptTemplate: string
  readonly sourcePath: string
}

export class WorkflowLoadError extends Data.TaggedError("WorkflowLoadError")<{
  readonly code:
    | "missing_workflow_file"
    | "workflow_parse_error"
    | "workflow_front_matter_not_a_map"
  readonly message: string
  readonly cause?: unknown
}> {}

export const loadWorkflow = (
  filePath: string,
): Effect.Effect<WorkflowDefinition, WorkflowLoadError> =>
  Effect.gen(function* () {
    const absolutePath = path.resolve(filePath)

    const raw = yield* Effect.tryPromise({
      try: () => readFile(absolutePath, "utf8"),
      catch: (cause) =>
        new WorkflowLoadError({
          code: "missing_workflow_file",
          message: `Could not read workflow file at ${absolutePath}`,
          cause,
        }),
    })

    const { frontMatter, body } = splitFrontMatter(raw)

    let config: Record<string, unknown> = {}
    if (frontMatter !== null) {
      const parsed = yield* Effect.try({
        try: () => parseYaml(frontMatter),
        catch: (cause) =>
          new WorkflowLoadError({
            code: "workflow_parse_error",
            message: `Could not parse YAML front matter in ${absolutePath}`,
            cause,
          }),
      })

      if (parsed === null || parsed === undefined) {
        config = {}
      } else if (typeof parsed !== "object" || Array.isArray(parsed)) {
        return yield* Effect.fail(
          new WorkflowLoadError({
            code: "workflow_front_matter_not_a_map",
            message: `Workflow front matter must decode to a map/object, got ${describe(parsed)}`,
          }),
        )
      } else {
        config = parsed as Record<string, unknown>
      }
    }

    return {
      config,
      promptTemplate: body.trim(),
      sourcePath: absolutePath,
    }
  })

function splitFrontMatter(raw: string): {
  frontMatter: string | null
  body: string
} {
  const text = raw.replace(/\r\n/g, "\n")

  if (!text.startsWith("---\n") && text !== "---" && !text.startsWith("---\r")) {
    return { frontMatter: null, body: text }
  }

  const afterOpen = text.slice(4)
  const closeIdx = afterOpen.indexOf("\n---")
  if (closeIdx === -1) {
    return { frontMatter: null, body: text }
  }

  const frontMatter = afterOpen.slice(0, closeIdx)
  let body = afterOpen.slice(closeIdx + 4)
  if (body.startsWith("\n")) body = body.slice(1)

  return { frontMatter, body }
}

function describe(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  return typeof v
}
