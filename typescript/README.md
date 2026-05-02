# Beethoven

A harness-agnostic port of [Symphony](https://github.com/openai/symphony),
built on **Bun**, **Effect.TS**, and **Ink**.

Beethoven is a long-running daemon that polls an issue tracker (Linear today),
creates an isolated per-issue workspace, runs a coding-agent session in that
workspace via one of four supported harnesses, and renders a live terminal
dashboard so you can see what's happening without a web UI.

V1 supported harnesses (selected via `runtime.kind` in `WORKFLOW.md`):

| `runtime.kind` | Driver | Status |
|---|---|---|
| `claude` | [`@anthropic-ai/claude-agent-sdk`](https://docs.anthropic.com/en/api/agent-sdk) | Working |
| `codex` | `codex app-server` JSON-RPC over stdio | Working |
| `gemini` | Gemini CLI headless mode | Stub (experimental) |
| `opencode` | `opencode run --format json` | Stub |

It follows the layered spec at [`../SPEC.md`](../SPEC.md) — **Policy
(`WORKFLOW.md`) → Config → Coordination → Execution → Integration → Observability** —
which itself is a port of Symphony's SPEC with the execution layer
generalized to multiple harnesses (Symphony's `codex:` block becomes
Beethoven's `runtime:` block with a `kind` discriminator).

> **Status:** scaffold / engineering preview. Not production-ready.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Bun** | Native TS, no build step, fast install, `Bun.env` instead of `process.env` |
| Effects | **Effect.TS** | Typed error channel, `Fiber` for concurrent runs, `Schedule` for retries, `Stream` for the SDK event feed, `Layer`/`Context.Tag` for service wiring |
| UI | **Ink** | React-driven terminal dashboard — replaces Symphony's Phoenix LiveView surface |
| Validation | **Effect Schema** | Replaces zod; integrates with Effect's typed error channel |
| Templating | **liquidjs** | Same template syntax as Symphony's `WORKFLOW.md` so existing prompts port unchanged |

## What's intentionally different from Symphony

- **No web UI.** Ink renders a live dashboard in the terminal. No Phoenix
  LiveView, no separate observability service.
- **No durable workflow store.** Symphony's spec mandates restart recovery
  via "re-read tracker + workspace dirs," and we honor that. (See open
  question on Temporal below.)
- **One service per concern, wired via `Layer`.** `LinearClient`,
  `WorkspaceManager`, `AgentRunner` are `Context.Tag`s — easy to swap for
  in-memory fakes in tests.

## Layout

```
src/
  workflow/                       # WORKFLOW.md loader + Liquid prompt builder
  config/                         # Effect Schema + typed Settings view
  tracker/                        # Linear GraphQL client (Effect service)
  workspace/                      # Per-issue workspace lifecycle + hooks
  agent/                          # Harness interface + per-kind adapters
    harness.ts                    #   shared Harness + AgentEvent shapes
    harnesses/{claude,codex,gemini,opencode}.ts
    runner.ts                     #   thin factory keyed on runtime.kind
  tools/                          # Harness-agnostic dynamic tool implementations
  orchestrator/                   # Poll loop + Fiber-per-issue + Schedule retries
  cli/
    main.tsx                      # Bun entry; Ink dashboard mounted here
    ui/Dashboard.tsx              # Live terminal dashboard
```

## Quickstart

Install the runtime for the harness selected by `runtime.kind`:

- `claude`: install Claude Code and make sure `claude` is on your PATH.
- `codex`: install Codex CLI and make sure `codex app-server` works.

```bash
# install with Bun
bun install

# validate the workflow file
bun run validate

# run with the dashboard
bun run start

# run headless (logs only)
bun src/cli/main.tsx run --no-ui
```

## Workflow front-matter (Beethoven variant)

```yaml
tracker:
  kind: linear
  project_slug: "your-project-slug"
  api_key: $LINEAR_API_KEY
  active_states: [Todo, In Progress, Rework]
  terminal_states: [Done, Cancelled, Duplicate]
polling:
  interval_ms: 30000
workspace:
  root: ~/code/beethoven-workspaces
agent:
  max_concurrent_agents: 5
  max_turns: 20
runtime:
  kind: codex         # claude | codex | gemini | opencode
  model: gpt-5.5
  effort: xhigh       # low | medium | high | xhigh | max
  permission_mode: acceptEdits
  cwd: "."
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  # Per-harness extension blocks (only the one matching `kind` is applied):
  claude:
    thinking_mode: adaptive
  codex:
    # command can be omitted; Beethoven injects runtime.model and runtime.effort
    # into the default `codex app-server` command via Codex config overrides.
    approval_policy: onRequest      # never | unlessTrusted | onRequest | Codex policy object
    auto_approve_requests: false
    thread_sandbox: workspace-write
    sandbox_policy: workspaceWrite  # readOnly | workspaceWrite | dangerFullAccess | externalSandbox

agent_pool:
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
      codex:
        sandbox_policy: workspaceWrite
    - id: codex-gpt-5.4-mini-accompanist
      role: accompanist
      capabilities: [ci-triage, branch-analysis, docs]
      kind: codex
      model: gpt-5.4-mini
      effort: low
      instructions: "Use for CI failure investigation and branch analysis."
      codex:
        sandbox_policy: readOnly
    - id: codex-gpt-5.4-soloist
      role: soloist
      capabilities: [implementation, review, risk-check]
      kind: codex
      model: gpt-5.4
      effort: medium
      instructions: "Use for independent design review before handoff."
      codex:
        sandbox_policy: readOnly
  # gemini:
  #   include_directories: []
  # opencode:
  #   provider: anthropic
```

The Markdown body below the YAML is the per-issue prompt template (Liquid syntax,
same as Symphony's). See `WORKFLOW.example.md`.

When `agent_pool.members` is non-empty, Beethoven exposes a `delegate_task`
tool to the primary harness. The primary model remains responsible for the
issue, but can ask a configured pool member by `agent`, `role`, and
`capabilities` to handle substantial work packages such as CI failure
investigation, branch analysis, independent review, or implementation slices.
Delegated runs use the same workspace, have nested delegation disabled, and can
use cheaper or lower-effort models than the primary run.

### Skills layout

Install your team's skill files into `.agents/skills/` inside the workspace
(typically via the `after_create` hook). Beethoven automatically symlinks the
active harness's expected path (`.claude/skills`, `.codex/skills`,
`.gemini/skills`) to that canonical source per `runtime.kind`. opencode reads
`.agents/skills` natively, so no symlink is created for that harness.

## Decisions

- **No Temporal.** Effect's `Fiber` + `Schedule` + `Ref<HashMap>` covers
  in-process orchestration without changing Symphony's restart-recovery model
  (re-derive from tracker + workspace dirs).
- **Decorrelated jitter** (AWS classic) for retry backoff:
  `prev = min(cap, randomBetween(base, prev * 3))`. Bounded growth, friendly
  on operator dashboards.
- **Hooks via `@effect/platform` Command.** Subprocess lifecycle and stream
  capture flow through Effect, not raw `node:child_process`.
