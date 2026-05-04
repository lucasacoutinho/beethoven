---
tracker:
  kind: linear
  project_slug: "your-project-slug"
  api_key: $LINEAR_API_KEY
  active_states:
    - Todo
    - In Progress
    - AI Review
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
  # Disable delegate_task in high-cost runs unless you explicitly want nested agents.
  # disallowed_tools:
  #   - mcp__beethoven__delegate_task

  # Per-harness extensions:
  claude:
    thinking_mode: adaptive   # adaptive | enabled | disabled
    # thinking_budget_tokens: 8000  # only needed when thinking_mode = enabled
    # executable: $CLAUDE_BIN       # override Bun.which("claude") auto-detect

  codex:
    # When command is omitted, Beethoven starts:
    # codex -c 'model="<runtime.model>"' -c 'model_reasoning_effort="<runtime.effort>"' app-server
    approval_policy: on-request     # never | on-failure | on-request | granular
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
  # Optional weighted top-level assignment. When present, Beethoven picks one
  # candidate per issue dispatch. Use this to exercise secondary maestros
  # before the primary is unavailable.
  primary_candidates:
    - id: codex-gpt-5.5-maestro
      weight: 80
    - id: codex-gpt-5.4-soloist
      weight: 20
  primary_fallback_roles: [maestro]
  on_primary_unavailable: reassign # reassign | pause | fail
  ai_review_state: AI Review
  ai_review_capabilities: [review]
  ai_review_prefer_different_harness: true
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

Issue: {{ issue.title }}
State: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}
Agent: {{ agent.id }} / {{ agent.model }}

{% if issue.description %}
Description:
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

{% if attempt %}
Continuation attempt #{{ attempt }}. Resume from the current workspace and workpad; do not repeat completed investigation unless new changes require it.
{% endif %}

## Operating Contract

- Work only inside the provided workspace.
- Use `linear_graphql` only when tracker state or the workpad must be read or updated. Keep GraphQL selections narrow; do not fetch full comment bodies, PR feedback, or large histories unless needed.
- Keep one persistent Linear comment headed `## Beethoven Workpad`. Update it in place with a compact plan, acceptance criteria, validation, and short notes.
- Keep Linear/GitHub labels current when possible: `beethoven`, `agent:{{ agent.id }}`, `model:{{ agent.model }}`. Record label failures in the workpad without blocking.
- Use `delegate_task` only when explicitly needed for a substantial parallel work package. Keep delegated handoffs short.
- Be token-frugal: summarize large outputs, avoid pasting logs into Linear, prefer targeted file reads/tests, and keep workpad updates concise.
- Do not add filler comments that restate identifiers, branches, function names, types, or obvious control flow. Add comments only for non-obvious domain invariants, safety/security constraints, concurrency concerns, migration rationale, or cross-module contracts.

## State Routing

- `Backlog`: do not modify; stop.
- `Todo`: move to `In Progress`, create or refresh the workpad, then execute.
- `In Progress`: continue from the existing workpad.
- `AI Review`: review adversarially from the diff, workpad, PR comments, and checks; route to `Merging`, `Rework`, or `Human Review`.
- `Rework`: gather feedback, update the workpad, implement, validate, and return to `AI Review`.
- `Merging`: follow `.agents/skills/land/SKILL.md`; do not merge directly unless that skill instructs it.
- `Human Review`: only for human-only product, legal, secret, permission, or business decisions.
- Terminal states: do nothing.

## Execution Checklist

1. Read issue state and route using the state map.
2. Find or create `## Beethoven Workpad`; keep it compact and current.
3. Record environment stamp `<host>:<abs-workdir>@<short-sha>`.
4. Reproduce or capture a baseline signal before behavior changes.
5. Sync from `origin/main` before edits and record the result.
6. Make focused changes only for this issue.
7. Run required validation from the issue plus targeted tests for changed behavior.
8. Before handoff, ensure acceptance criteria are checked, validation is green, PR feedback is addressed, and the PR is linked.
9. Move to the next state only when its bar is met.

## Quality Bars

- Before `AI Review`: implementation complete, workpad accurate, validation green, PR linked, branch pushed, and actionable PR feedback addressed.
- Before `Merging`: AI review passed or a human-only decision explicitly approved it.
- Before `Done`: merge/land flow completed.

## Workpad Shape

```md
## Beethoven Workpad

```text
<host>:<abs-workdir>@<short-sha>
```

### Labels
- Linear: `beethoven`, `agent:{{ agent.id }}`, `model:{{ agent.model }}`
- GitHub PR: `beethoven`, `agent:{{ agent.id }}`, `model:{{ agent.model }}`

### Plan
- [ ] ...

### Acceptance Criteria
- [ ] ...

### Validation
- [ ] `<command>`

### Notes
- <timestamped, short, decision-grade notes only>

### Confusions
- <only if relevant>
```
