import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { parseSettings } from "../config/schema.ts"
import type { Issue } from "../tracker/issue.ts"
import { __testing } from "./orchestrator.ts"

describe("orchestrator agent pool selection", () => {
  test("dispatch sorting drains active states closest to done before Todo", () => {
    const sorted = __testing.sortForDispatch(
      [
        issueWithState("todo-low", "Todo", 1, "2026-01-01T00:00:00.000Z"),
        issueWithState("progress-high", "In Progress", 3, "2026-01-01T00:00:00.000Z"),
        issueWithState("merge-low", "Merging", 2, "2026-01-01T00:00:00.000Z"),
        issueWithState("review-high", "AI Review", 1, "2026-01-01T00:00:00.000Z"),
        issueWithState("todo-urgent", "Todo", 0, "2026-01-01T00:00:00.000Z"),
      ],
      ["Todo", "In Progress", "AI Review", "Merging"],
    )

    expect(sorted.map((candidate) => candidate.id)).toEqual([
      "merge-low",
      "review-high",
      "progress-high",
      "todo-urgent",
      "todo-low",
    ])
  })

  test("treats primary_candidates as the top-level source of truth and ignores zero weight members", async () => {
    const settings = await settingsWithPool({
      primary_agent: "codex-zero",
      primary_candidates: [
        { id: "claude-only", weight: 1 },
        { id: "codex-zero", weight: 0 },
      ],
      primary_fallback_roles: ["maestro"],
      on_primary_unavailable: "reassign",
      members: [
        member("claude-only", "maestro", "claude", "claude-sonnet"),
        member("codex-zero", "maestro", "codex", "gpt-5.5"),
      ],
    })

    expect(settings.agentPool.primaryCandidates).toEqual([
      { id: "claude-only", weight: 1 },
      { id: "codex-zero", weight: 0 },
    ])
    expect(__testing.selectIssueAgentPoolMember(settings, issue)?.id).toBe("claude-only")
    expect(
      __testing.selectIssueAgentPoolMember(settings, issue, new Set(["claude-only"])),
    ).toBeUndefined()
    expect(
      __testing.hasAlternateAgentForIssue(
        settings,
        issue,
        currentAgent("claude-only", "claude", "claude-sonnet"),
        new Set(["claude-only"]),
      ),
    ).toBe(false)
  })

  test("reassigns only to a positive-weight alternate candidate", async () => {
    const settings = await settingsWithPool({
      primary_candidates: [
        { id: "claude-primary", weight: 1 },
        { id: "codex-alternate", weight: 1 },
      ],
      on_primary_unavailable: "reassign",
      members: [
        member("claude-primary", "maestro", "claude", "claude-sonnet"),
        member("codex-alternate", "maestro", "codex", "gpt-5.5"),
      ],
    })

    expect(
      __testing.selectIssueAgentPoolMember(settings, issue, new Set(["claude-primary"]))?.id,
    ).toBe("codex-alternate")
    expect(
      __testing.hasAlternateAgentForIssue(
        settings,
        issue,
        currentAgent("claude-primary", "claude", "claude-sonnet"),
        new Set(["claude-primary"]),
      ),
    ).toBe(true)
  })

  test("keeps legacy primary fallback roles when no weighted primary candidates are configured", async () => {
    const settings = await settingsWithPool({
      primary_agent: "claude-primary",
      primary_fallback_roles: ["maestro"],
      on_primary_unavailable: "reassign",
      members: [
        member("claude-primary", "maestro", "claude", "claude-sonnet"),
        member("codex-fallback", "maestro", "codex", "gpt-5.5"),
      ],
    })

    expect(
      __testing.selectIssueAgentPoolMember(settings, issue, new Set(["claude-primary"]))?.id,
    ).toBe("codex-fallback")
  })
})

async function settingsWithPool(agent_pool: Record<string, unknown>) {
  return Effect.runPromise(
    parseSettings(
      {
        tracker: {
          kind: "linear",
          project_slug: "beethoven",
        },
        runtime: {
          kind: "codex",
          model: "gpt-5.5",
        },
        agent_pool,
      },
      "/tmp/WORKFLOW.md",
    ),
  )
}

function member(
  id: string,
  role: "maestro" | "soloist" | "accompanist",
  kind: "claude" | "codex" | "gemini" | "opencode",
  model: string,
) {
  return {
    id,
    role,
    capabilities: ["implementation", "review"],
    kind,
    model,
  }
}

function currentAgent(
  id: string,
  kind: "claude" | "codex" | "gemini" | "opencode",
  model: string,
) {
  return {
    id,
    role: "maestro" as const,
    kind,
    model,
    effort: "default",
  }
}

const issue: Issue = {
  id: "issue-1",
  identifier: "BTV-1",
  title: "Retry rate-limited task",
  description: null,
  priority: null,
  state: "Todo",
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
}

function issueWithState(
  id: string,
  state: string,
  priority: number,
  updatedAt: string,
): Issue {
  return {
    ...issue,
    id,
    identifier: id.toUpperCase(),
    state,
    priority,
    updatedAt,
  }
}
