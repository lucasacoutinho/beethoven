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
      }),
    )

    expect(settings.runtime.kind).toBe("claude")
    expect(settings.tracker.projectSlug).toBe("your-project-slug")
    expect(prompt).toContain("Linear ticket `BLE-123`")
    expect(prompt).toContain("This is continuation attempt #2")
    expect(prompt).toContain("## Bethoveen Workpad")
    expect(prompt).toContain("Use Linear MCP or the `linear_graphql` tool only when tracker state must be read or updated")
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
