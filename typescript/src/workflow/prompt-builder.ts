import { Data, Effect } from "effect"
import { Liquid } from "liquidjs"
import type { Issue } from "../tracker/issue.ts"
import type { AgentPoolRole, HarnessKind } from "../agent/harness.ts"

export class TemplateRenderError extends Data.TaggedError("TemplateRenderError")<{
  readonly code: "template_parse_error" | "template_render_error"
  readonly message: string
  readonly cause?: unknown
}> {}

const FALLBACK_PROMPT = "You are working on an issue from Linear."

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  cache: false,
})

export interface PromptAgentContext {
  readonly id: string
  readonly role: AgentPoolRole | null
  readonly kind: HarnessKind
  readonly model: string
  readonly effort: string
}

export const buildPrompt = (opts: {
  template: string
  issue: Issue
  attempt: number | null
  agent: PromptAgentContext
}): Effect.Effect<string, TemplateRenderError> =>
  Effect.gen(function* () {
    const { template, issue, attempt, agent } = opts
    if (!template.trim()) return FALLBACK_PROMPT

    const parsed = yield* Effect.try({
      try: () => engine.parse(template),
      catch: (cause) =>
        new TemplateRenderError({
          code: "template_parse_error",
          message: "Failed to parse workflow prompt template",
          cause,
        }),
    })

    return yield* Effect.tryPromise({
      try: () => engine.render(parsed, { issue, attempt, agent }),
      catch: (cause) =>
        new TemplateRenderError({
          code: "template_render_error",
          message: `Failed to render workflow prompt template: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    })
  })
