# Bethoveen

A harness-agnostic port of [Symphony](https://github.com/openai/symphony),
built on **Bun**, **Effect.TS**, and **Ink**.

Bethoveen is a long-running daemon that polls an issue tracker (Linear today),
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
Bethoveen's `runtime:` block with a `kind` discriminator).

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

## Workflow front-matter (Bethoveen variant)

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
  root: ~/code/bethoveen-workspaces
agent:
  max_concurrent_agents: 5
  max_turns: 20
runtime:
  kind: claude        # claude | codex | gemini | opencode
  model: claude-opus-4-7
  effort: high        # low | medium | high | xhigh | max
  permission_mode: acceptEdits
  cwd: "."
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  # Per-harness extension blocks (only the one matching `kind` is applied):
  claude:
    thinking_mode: adaptive
  # codex:
  #   command: codex app-server
  #   approval_policy: onRequest      # never | unlessTrusted | onRequest | Codex policy object
  #   auto_approve_requests: false
  #   thread_sandbox: workspace-write
  #   sandbox_policy: workspaceWrite  # readOnly | workspaceWrite | dangerFullAccess | externalSandbox
  #   # turn_sandbox_policy accepts the raw Codex app-server sandbox policy object.
  #   # turn_sandbox_policy:
  #   #   type: workspaceWrite
  #   #   writableRoots: [/absolute/workspace/path]
  # gemini:
  #   include_directories: []
  # opencode:
  #   provider: anthropic
```

The Markdown body below the YAML is the per-issue prompt template (Liquid syntax,
same as Symphony's). See `WORKFLOW.example.md`.

### Skills layout

Install your team's skill files into `.agents/skills/` inside the workspace
(typically via the `after_create` hook). Bethoveen automatically symlinks the
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
