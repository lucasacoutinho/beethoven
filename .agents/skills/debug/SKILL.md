---
name: debug
description:
  Investigate stuck runs and execution failures by tracing Bethoveen and
  agent-harness logs with issue/session identifiers; use when runs stall,
  retry repeatedly, or fail unexpectedly.
---

# Debug

## Goals

- Find why a run is stuck, retrying, or failing.
- Correlate Linear issue identity to an agent session quickly.
- Read the right logs in the right order to isolate root cause.

## Log Sources

- Primary runtime log: `log/bethoveen.log`
  - Default produced by Bethoveen's file logger (JSON-line format).
  - Includes orchestrator, workspace lifecycle, agent runner, and harness
    lifecycle events.
- Rotated runtime logs: `log/bethoveen.log*`
  - Check these when the relevant run is older.

## Correlation Keys

- `issue_identifier`: human ticket key (example: `MT-625`)
- `issue_id`: Linear UUID (stable internal ID)
- `session_id`: harness session identifier (each harness reports its own
  shape: Claude session UUID, Codex `<thread_id>-<turn_id>`, etc.)
- `harness`: which runtime is driving the dispatch (`claude`, `codex`,
  `gemini`, `opencode`)

Use these as join keys during debugging.

## Quick Triage (Stuck Run)

1. Confirm scheduler/worker symptoms for the ticket.
2. Find recent lines for the ticket (`issue_identifier` first).
3. Extract `session_id` from matching lines.
4. Trace that `session_id` across start, stream, completion/failure, and stall
   handling logs.
5. Decide class of failure: timeout/stall, harness startup failure, turn
   failure, or orchestrator retry loop.

## Commands

```bash
# 1) Narrow by ticket key (fastest entry point)
rg -n '"issue_identifier":"MT-625"' log/bethoveen.log*

# 2) If needed, narrow by Linear UUID
rg -n '"issue_id":"<linear-uuid>"' log/bethoveen.log*

# 3) Pull session IDs seen for that ticket
rg -o '"session_id":"[^"]+"' log/bethoveen.log* | sort -u

# 4) Trace one session end-to-end
rg -n '"session_id":"<id>"' log/bethoveen.log*

# 5) Focus on stuck/retry signals
rg -n '"event":"agent_run_errored"|"event":"retry_scheduled"|"event":"max_turns_reached"|"event":"failed"|"event":"stalled"' log/bethoveen.log*
```

## Investigation Flow

1. Locate the ticket slice:
    - Search by `issue_identifier=<KEY>`.
    - If noise is high, add `issue_id=<UUID>`.
2. Establish timeline:
    - Identify first `session_started` event with the harness's `session_id`.
    - Follow with `dispatched`, agent events (`agent_tool`,
      `agent_message`, `tokens_updated`), then a terminal orchestrator
      event (`completed`, `handed_off`, `failed`, `max_turns_reached`).
3. Classify the problem:
    - Stall loop: repeated `retry_scheduled` events with growing backoff.
    - Harness startup: `agent_run_errored` before any `agent_tool` event.
    - Turn execution failure: `agent_run_errored` mid-stream.
    - Worker crash: `dispatch_failed` with a stringified cause.
4. Validate scope:
    - Check whether failures are isolated to one issue/session or repeating
      across multiple tickets/harnesses.
5. Capture evidence:
    - Save key log lines with timestamps, `issue_identifier`, `issue_id`,
      `session_id`, and `harness`.
    - Record probable root cause and the exact failing stage.

## Reading Agent Session Logs

Agent session diagnostics are emitted into `log/bethoveen.log` and keyed by
`session_id` (and `harness`). Read them as a lifecycle:

1. `session_started` (carries `session_id` for the active harness).
2. Stream events for the same `session_id`: `agent_tool`,
   `agent_message`, `tokens_updated`, optional `reasoning_delta`.
3. Terminal orchestrator event:
    - `completed` — issue reached a terminal tracker state.
    - `handed_off` — issue moved to a non-active, non-terminal state
      (e.g. `Human Review`).
    - `max_turns_reached` — turn cap hit; orchestrator will re-dispatch on
      the next poll.
    - `failed` + `retry_scheduled` — agent error; backoff before retry.

For one specific session investigation, keep the trace narrow:

1. Capture one `session_id` for the ticket.
2. Build a timestamped slice for only that session.
3. Mark the exact failing stage:
    - Startup failure before stream events (`agent_run_errored` with no
      preceding `agent_tool`).
    - Turn/runtime failure after stream events (`agent_run_errored` with
      `cause` populated).
    - Stall recovery (`max_turns_reached` followed by next-tick re-dispatch).
4. Pair findings with `issue_identifier` and `issue_id` from nearby lines
   to confirm you are not mixing concurrent retries.

Always pair session findings with `issue_identifier`/`issue_id` to avoid
mixing concurrent runs across harnesses.

## Notes

- Prefer `rg` over `grep` for speed on large logs.
- Bethoveen logs are JSON-line; pipe through `jq` for pretty printing
  (e.g. `tail -f log/bethoveen.log | jq .`).
- Check rotated logs (`log/bethoveen.log*`) before concluding data is
  missing.
