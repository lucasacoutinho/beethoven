# Bethoveen

[![TypeScript checks](https://github.com/usebeacon/bethoveen/actions/workflows/typescript-checks.yml/badge.svg)](https://github.com/usebeacon/bethoveen/actions/workflows/typescript-checks.yml)

Bethoveen turns project work into isolated, autonomous implementation runs,
allowing teams to manage work instead of supervising coding agents — and does
it across multiple coding-agent harnesses.

Bethoveen is a port of OpenAI's [Symphony](https://github.com/openai/symphony)
with one extension: the execution layer is **harness-agnostic**. V1 supports
four harnesses, selected per-workflow via `runtime.kind`:

| `runtime.kind` | Driver | Status |
|---|---|---|
| `claude` | [`@anthropic-ai/claude-agent-sdk`](https://docs.anthropic.com/en/api/agent-sdk) | Working |
| `codex` | `codex app-server` JSON-RPC over stdio | Working |
| `gemini` | Gemini CLI headless mode | Stub (experimental) |
| `opencode` | `opencode run --format json` | Stub |

> [!WARNING]
> Bethoveen is a low-key engineering preview for testing in trusted environments.
> See [`STATUS.md`](STATUS.md) for the current support matrix and known gaps.

## Running Bethoveen

### Requirements

- [Bun](https://bun.sh/) for the TypeScript implementation.
- A Linear API key with access to the configured project.
- At least one working harness runtime:
  - Claude Code + `@anthropic-ai/claude-agent-sdk`, or
  - Codex CLI with `codex app-server`.

Bethoveen works best in codebases that have adopted harness engineering. It
picks up where Symphony left off: moving from managing coding agents to
managing work that needs to get done, while letting the operator pick which
agent runtime drives the work.

### Spec

The language-neutral specification lives at [`SPEC.md`](SPEC.md). It is a port
of Symphony's SPEC with the harness layer generalized; everything else
(tracker integration, workspace lifecycle, orchestration, observability)
remains identical.

### Reference implementation

The TypeScript implementation lives under [`typescript/`](typescript/) — Bun
runtime, Effect.TS for the orchestration layer, Ink for the terminal
dashboard. See [typescript/README.md](typescript/README.md) for setup and
configuration.

Additional language ports (Elixir, Go, Python, etc.) can land sibling to
`typescript/` without touching the SPEC or the workflow contract.

### Skills layout

Bethoveen workspaces use a single canonical `.agents/skills/` directory as
the source-of-truth for skill files. The daemon automatically symlinks the
active harness's expected path (`.claude/skills`, `.codex/skills`,
`.gemini/skills`) to that source per `runtime.kind`. opencode reads
`.agents/skills` natively, so no symlink is created for that harness.

---

## License

This project is licensed under the [Apache License 2.0](LICENSE).
