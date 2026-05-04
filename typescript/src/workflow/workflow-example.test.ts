import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fileURLToPath } from "node:url"

import { parseSettings } from "../config/schema.ts"
import type { Issue } from "../tracker/issue.ts"
import { loadWorkflow } from "./loader.ts"
import { buildPrompt } from "./prompt-builder.ts"

const exampleWorkflowPath = fileURLToPath(
  new URL("../../WORKFLOW.example.md", import.meta.url),
)

describe("WORKFLOW.example.md", () => {
  test("loads, parses settings, and renders the default prompt", async () => {
    const workflow = await Effect.runPromise(loadWorkflow(exampleWorkflowPath))
    const settings = await Effect.runPromise(
      parseSettings(workflow.config, workflow.sourcePath),
    )
    const prompt = await Effect.runPromise(
      buildPrompt({
        template: workflow.promptTemplate,
        issue: exampleIssue,
        attempt: 2,
        agent: {
          id: "codex-gpt-5.5-maestro",
          role: "maestro",
          kind: "codex",
          model: "gpt-5.5",
          effort: "xhigh",
        },
      }),
    )

    expect(settings.runtime.kind).toBe("codex")
    expect(settings.runtime.common.model).toBe("gpt-5.5")
    expect(settings.runtime.common.effort).toBe("xhigh")
    expect(settings.agentPool.primaryAgent).toBe("codex-gpt-5.5-maestro")
    expect(settings.agentPool.primaryCandidates).toEqual([
      { id: "codex-gpt-5.5-maestro", weight: 80 },
      { id: "codex-gpt-5.4-soloist", weight: 20 },
    ])
    expect(settings.agentPool.aiReviewState).toBe("AI Review")
    expect(settings.agentPool.members.map((member) => member.id)).toEqual([
      "codex-gpt-5.5-maestro",
      "codex-gpt-5.4-mini-accompanist",
      "codex-gpt-5.4-soloist",
    ])
    expect(settings.tracker.projectSlug).toBe("your-project-slug")
    expect(prompt).toContain("Linear ticket `BLE-123`")
    expect(prompt).toContain("Continuation attempt #2")
    expect(prompt).toContain("## Beethoven Workpad")
    expect(prompt).toContain("Use `linear_graphql` only when tracker state or the workpad must be read or updated")
    expect(prompt).toContain("Use `delegate_task` only when explicitly needed")
    expect(prompt).toContain("Do not add filler comments")
  })
})

const exampleIssue: Issue = {
  id: "issue-123",
  identifier: "BLE-123",
  title: "Improve default workflow template",
  description: "The default prompt should be safe for unattended agent work.",
  priority: null,
  state: "In Progress",
  branchName: null,
  url: "https://linear.app/example/issue/BLE-123",
  labels: ["workflow"],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
}
