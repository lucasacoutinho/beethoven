# Project Status

Bethoveen is an engineering preview. It is suitable for trusted local runs and
for iterating on harness behavior, but it should not be treated as production
or unattended infrastructure without additional operational hardening.

## Harness Support

| Harness | Runtime | Status | Notes |
|---|---|---|---|
| Claude | `runtime.kind: claude` | Working | Uses `@anthropic-ai/claude-agent-sdk`; Bethoveen tools are exposed through an in-process SDK MCP server and are not always loaded. |
| Codex | `runtime.kind: codex` | Working | Uses `codex app-server` JSON-RPC; Bethoveen tools are exposed as Codex dynamic tools. |
| Gemini | `runtime.kind: gemini` | Stub | Adapter boundary exists, execution is not implemented. |
| opencode | `runtime.kind: opencode` | Stub | Adapter boundary exists, execution is not implemented. |

## Current Guarantees

- Linear polling and per-issue workspace orchestration are implemented.
- Claude and Codex event streams normalize into the shared harness event model.
- Claude and Codex rate/session-limit events are surfaced to the orchestrator.
- Shared Bethoveen tools live in `typescript/src/tools/` and are adapted per harness.
- Typecheck, tests, and binary build run in GitHub Actions.

## Known Gaps

- No durable external scheduler or workflow store.
- Terminal dashboard only; no web UI.
- Gemini and opencode are placeholders.
- Operational security depends on the selected harness permission mode and
  workspace hooks. Review `WORKFLOW.md` carefully before running on private
  repositories.
