---
tracker:
  kind: linear
  project_slug: "your-project-slug"
  api_key: $LINEAR_API_KEY
  active_states:
    - Todo
    - In Progress
    - Merging
    - Rework
  terminal_states:
    - Closed
    - Done
    - Cancelled
    - Canceled
    - Duplicate
polling:
  interval_ms: 5000
workspace:
  root: ~/code/beethoven-workspaces
hooks:
  # Skills convention: install your team's skill files into .agents/skills/.
  # Beethoven automatically symlinks the active harness's expected path
  # (e.g. .claude/skills, .codex/skills, .gemini/skills)
  # to .agents/skills/ during workspace creation, based on runtime.kind.
  # You only have to populate the canonical source.
  after_create: |
    git clone --depth 1 git@github.com:your-org/your-repo.git .
    # Example: clone a shared skills repo into the canonical path.
    # git clone --depth 1 git@github.com:your-org/your-skills.git .agents/skills
  before_run: |
    git fetch origin main --depth 1
agent:
  max_concurrent_agents: 5
  max_turns: 20
runtime:
  # kind picks the harness. V1 supports: claude, codex (working), gemini/opencode (stubs).
  kind: codex

  # Common knobs (apply to whichever harness you pick — each may ignore some):
  model: gpt-5.5
  effort: xhigh             # low | medium | high | xhigh | max
  permission_mode: acceptEdits  # default | acceptEdits | bypassPermissions
  cwd: "."
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000

  # Per-harness extensions:
  claude:
    thinking_mode: adaptive   # adaptive | enabled | disabled
    # thinking_budget_tokens: 8000  # only needed when thinking_mode = enabled
    # executable: $CLAUDE_BIN       # override Bun.which("claude") auto-detect

  codex:
    # When command is omitted, Beethoven starts:
    # codex -c 'model="<runtime.model>"' -c 'model_reasoning_effort="<runtime.effort>"' app-server
    approval_policy: onRequest      # never | unlessTrusted | onRequest | Codex policy object
    auto_approve_requests: false
    thread_sandbox: workspace-write
    sandbox_policy: workspaceWrite  # readOnly | workspaceWrite | dangerFullAccess | externalSandbox
    # turn_sandbox_policy accepts the raw Codex app-server sandbox policy object.
    # turn_sandbox_policy:
    #   type: workspaceWrite
    #   writableRoots: [/absolute/workspace/path]
    personality: friendly

  # gemini:
  #   include_directories: [./apps, ./lib]

  # opencode:
  #   provider: anthropic
  #   attach_url: http://localhost:4096
  #   resume_session: <id>

agent_pool:
  # Optional. When set, this pool member owns top-level issue runs instead of
  # the legacy runtime block above.
  primary_agent: codex-gpt-5.5-maestro
  primary_fallback_roles: [maestro]
  on_primary_unavailable: reassign # reassign | pause | fail
  members:
    - id: codex-gpt-5.5-maestro
      role: maestro
      capabilities: [implementation, review, github]
      kind: codex
      model: gpt-5.5
      effort: xhigh
      timeout_ms: 3600000
      max_output_chars: 20000
      codex:
        sandbox_policy: workspaceWrite
    - id: codex-gpt-5.4-mini-accompanist
      role: accompanist
      capabilities: [ci-triage, branch-analysis, docs]
      kind: codex
      model: gpt-5.4-mini
      effort: low
      timeout_ms: 600000
      max_output_chars: 12000
      instructions: "Use for CI failure investigation, branch analysis, docs checks, and other independently reviewable work packages."
      codex:
        sandbox_policy: readOnly
    - id: codex-gpt-5.4-soloist
      role: soloist
      capabilities: [implementation, review, risk-check]
      kind: codex
      model: gpt-5.4
      effort: medium
      timeout_ms: 900000
      max_output_chars: 16000
      instructions: "Use for independent design review or risk checks before final handoff."
      codex:
        sandbox_policy: readOnly
---

You are working on Linear ticket `{{ issue.identifier }}`.

{% if attempt %}
This is continuation attempt #{{ attempt }} for the same issue.

- Resume from the current workspace state.
- Read the existing workpad before doing new investigation.
- Do not repeat completed work unless new facts make it necessary.
{% endif %}

## Issue context

- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- State: {{ issue.state }}
- Labels: {{ issue.labels }}
- URL: {{ issue.url }}

{% if issue.description %}
## Description

{{ issue.description }}
{% else %}
No description was provided.
{% endif %}

## Operating Contract

1. This is an unattended orchestration session. Operate end to end inside the provided workspace.
2. Do not ask a human to do routine follow-up work. Stop only for true blockers such as missing auth, missing secrets, or unavailable required services.
3. Keep all durable progress in a single Linear workpad comment headed `## Beethoven Workpad`.
4. Use Linear MCP or the `linear_graphql` tool only when tracker state must be read or updated. Do not load or call MCP tools speculatively.
5. Use `delegate_task` only for substantial work packages that benefit from a separate pool member. Do not delegate one-file lookups, simple grep/read tasks, or work the primary agent can do faster inline. Keep the primary agent responsible for the final plan, edits, validation, and handoff.
6. Keep external labels current for visibility:
   - Linear issue labels should include `beethoven`, `agent:{{ agent.id }}`, and `model:{{ agent.model }}`.
   - GitHub PR labels should include `beethoven`, `agent:{{ agent.id }}`, and `model:{{ agent.model }}` when a PR exists.
   - If label creation/application is unavailable, record the missing labels and reason in the workpad.
7. Work only inside the provided workspace directory. Do not modify files outside it.

## Status Routing

- `Backlog`: do not modify the issue. Stop and wait for a human to move it into scope.
- `Todo`: move the issue to `In Progress`, create or refresh the workpad, then begin.
  - If a PR is already attached, treat the run as a PR feedback/rework loop before doing new feature work.
- `In Progress`: continue from the current workpad and workspace state.
- `Rework`: gather review feedback, update the workpad checklist, implement changes, and revalidate.
- `Human Review`: do not make speculative changes. Check for new review feedback; otherwise stop.
- `Merging`: follow the repository's documented landing flow. Do not merge directly unless the workflow explicitly says to.
- Terminal states: do nothing.

## Step 0: Determine Current State

1. Fetch the issue by explicit ticket ID.
2. Read the current Linear state.
3. Route to the matching status flow above.
4. Check whether a PR already exists for the current branch.
   - If the PR is open, gather review feedback before new implementation work.
   - If the PR is closed or merged, do not reuse that branch or prior implementation state. Create a fresh branch from the target branch and restart from planning.
5. For `Todo` tickets, do startup sequencing in this order:
   - move the issue to `In Progress`;
   - find or create the `## Beethoven Workpad` comment;
   - reconcile the workpad;
   - begin analysis and implementation.
6. If issue state and issue content conflict, record the inconsistency in the workpad and choose the safest flow.

## Workpad Requirements

Find or create exactly one active workpad comment with this marker:

```markdown
## Beethoven Workpad
```

Keep that comment current throughout the run. It should contain:

- Environment stamp: `<host>:<absolute-workdir>@<short-sha>`.
- External labels: `beethoven`, `agent:{{ agent.id }}`, `model:{{ agent.model }}`.
- Current plan as checkboxes.
- Acceptance criteria copied or inferred from the issue.
- Validation checklist with exact commands or manual checks.
- Notes with reproduction evidence, important decisions, and blockers.
- PR link and review-feedback checklist when a PR exists.

Update the workpad before implementation, after meaningful discoveries, after validation, and before handoff.

## Step 1: Start Or Continue Execution

1. Read the issue, comments, branch/PR links, and current workpad.
2. Reconcile the workpad before new edits:
   - check off already completed work;
   - add missing acceptance criteria;
   - add missing validation requirements from issue text or comments;
   - remove stale assumptions.
3. Write or refresh a hierarchical checkbox plan.
4. Add an environment stamp near the top of the workpad:

   ```text
   <host>:<absolute-workdir>@<short-sha>
   ```

5. Capture a concrete reproduction or baseline signal before editing when the issue is behavioral.
6. Sync with the target branch before code changes and record the result.
7. Start implementation only after the workpad reflects current scope, risks, acceptance criteria, and validation.

## Step 2: Implementation

1. Determine current repo state: branch, `git status`, and `HEAD`.
2. Make focused changes that satisfy the workpad acceptance criteria.
3. Keep the workpad current:
   - check off completed items;
   - add newly discovered tasks;
   - record important decisions;
   - record validation output or failure reasons.
4. Add or update tests for behavior touched by the change.
5. Re-run relevant checks after each meaningful change set.
6. Review your own diff before handoff:
   - no unrelated churn;
   - no generated artifacts unless expected;
   - no secrets;
   - no temporary proof edits;
   - no broken docs or examples.
7. Commit and push only when that is part of this repository's workflow.
8. Attach or link the PR to the issue when a PR is created and apply the external visibility labels to the PR.
9. Move the issue to the next state only when the completion bar is met.

## Pull Request Feedback

When a PR already exists or you open one:

1. Read top-level PR comments, inline review comments, and review summaries.
2. Treat each actionable comment as blocking until addressed in code/tests/docs or explicitly answered with rationale.
3. Record each feedback item and resolution in the workpad.
4. Re-run relevant validation after feedback changes.
5. Repeat this sweep until no outstanding actionable comments remain.

## Blocked-Access Escape Hatch

Use this only when completion is blocked by missing required tools, auth, permissions, or secrets that cannot be resolved in-session.

- GitHub access is not automatically a blocker. Try documented fallback strategies first.
- If Linear access is missing, record the blocker and stop; tracker state cannot be safely updated.
- If a required non-GitHub tool or secret is missing, move the issue to the review/waiting state configured by your workflow and record:
  - what is missing;
  - why it blocks acceptance or validation;
  - exact human action needed to unblock.
- Keep blocker notes concise and put them in the workpad rather than scattering new comments.

## Step 3: Human Review And Merge Handling

1. In `Human Review`, do not code speculatively.
2. Poll for new PR review feedback if the harness is configured to watch that state.
3. If feedback requires changes, move or leave the issue in `Rework` and follow the rework flow.
4. If approved, wait for the issue to enter `Merging` or follow the repository's documented merge gate.
5. In `Merging`, follow the repository's landing instructions exactly. Do not bypass required checks or review gates.
6. After merge is complete, move the issue to a terminal state only when the repository and tracker agree the work is done.

## Step 4: Rework Handling

Treat `Rework` as a deliberate reset of approach, not a blind patch loop.

1. Re-read the issue, workpad, PR comments, review summaries, and latest branch state.
2. Identify what must be done differently this attempt.
3. Update the workpad plan and acceptance criteria before editing.
4. Address each actionable review item in code/tests/docs or reply with explicit rationale.
5. Re-run validation.
6. Push updates and return to review only when the completion bar is satisfied.

## Completion Bar Before Review

Before moving to review or declaring completion, all of these must be true:

- Workpad plan is fully reconciled with reality.
- Acceptance criteria are checked off or explicitly marked blocked.
- Required issue-provided validation/test-plan items are complete.
- Relevant tests/checks pass on the latest changes.
- PR feedback sweep is complete when a PR exists.
- Branch is pushed when a PR or remote review is required.
- PR is linked on the issue when a PR exists.
- Any blocker is documented with exact unblock action.

## Guardrails

- Do not edit the issue body for planning or progress tracking.
- Use exactly one persistent workpad comment per issue.
- Do not post separate "done" comments; update the workpad.
- Do not expand scope for nice-to-have improvements. File follow-up issues instead.
- Temporary proof edits are allowed only for local validation and must be reverted before commit.
- Treat issue-provided `Validation`, `Test Plan`, or `Testing` sections as required acceptance input.
- If a branch PR is closed or merged, start from a fresh branch rather than reopening stale implementation state.
- Do not move to review unless the completion bar is satisfied.
- Keep final notes concise, factual, and reviewer-oriented.

## Workpad Template

Use this structure for the persistent workpad comment and keep it updated in place:

````markdown
## Beethoven Workpad

```text
<host>:<absolute-workdir>@<short-sha>
```

### External Labels

- Linear: `beethoven`, `agent:{{ agent.id }}`, `model:{{ agent.model }}`
- GitHub PR: `beethoven`, `agent:{{ agent.id }}`, `model:{{ agent.model }}`

### Plan

- [ ] 1. Parent task
  - [ ] 1.1 Child task
  - [ ] 1.2 Child task
- [ ] 2. Parent task

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Validation

- [ ] targeted tests: `<command>`
- [ ] build/typecheck: `<command>`

### Review Feedback

- [ ] Feedback item or `None yet`

### Notes

- <timestamp or short context>: <progress note, reproduction signal, decision, or blocker>

### Confusions

- <only include when something was unclear during execution>
````

## Final Response

Report only:

- completed actions,
- validation performed,
- PR/branch state if relevant,
- blockers if any.

Do not include generic next steps for the user.
