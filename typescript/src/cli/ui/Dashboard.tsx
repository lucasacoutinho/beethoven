import React, { useEffect, useState } from "react"
import { Box, Text } from "ink"
import Spinner from "ink-spinner"

import type {
  DispatchSnapshot,
  OrchestratorEvent,
} from "../../orchestrator/orchestrator.ts"

export interface DashboardProps {
  readonly refreshIntervalMs?: number
  readonly subscribe: (
    onSnapshot: (s: DispatchSnapshot) => void,
    onEvent: (e: OrchestratorEvent) => void,
  ) => () => void
  readonly projectSlug: string
  readonly maxConcurrentAgents: number
  readonly pollIntervalMs: number
}

const COLS = {
  id: 8,
  stage: 9,
  age: 10,
  tokens: 10,
}

export function Dashboard({
  refreshIntervalMs = 1000,
  subscribe,
  projectSlug,
  maxConcurrentAgents,
  pollIntervalMs,
}: DashboardProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DispatchSnapshot | null>(null)
  const [tps, setTps] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let lastTotal = 0
    let lastSampleAt = Date.now()
    const unsubscribe = subscribe(
      (s) => {
        const dt = (Date.now() - lastSampleAt) / 1000
        if (dt > 0 && lastTotal > 0) {
          const delta = s.tokensTotal.total - lastTotal
          if (delta > 0) setTps(delta / dt)
        }
        lastTotal = s.tokensTotal.total
        lastSampleAt = Date.now()
        setSnapshot(s)
      },
      () => {},
    )
    const tick = setInterval(() => setNow(Date.now()), refreshIntervalMs)
    return () => {
      unsubscribe()
      clearInterval(tick)
    }
  }, [subscribe, refreshIntervalMs])

  if (!snapshot) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>{" "}
          Bootstrapping orchestrator…
        </Text>
      </Box>
    )
  }

  const agentCount = snapshot.running.length
  const nextRefreshSec =
    snapshot.lastTickAt !== null
      ? Math.max(
          0,
          Math.ceil((snapshot.lastTickAt + pollIntervalMs - now) / 1000),
        )
      : null
  const liveSum = snapshot.running.reduce(
    (acc, r) => ({
      input: acc.input + r.liveTokens.input,
      output: acc.output + r.liveTokens.output,
      total: acc.total + r.liveTokens.total,
    }),
    { input: 0, output: 0, total: 0 },
  )
  const headerTokens = {
    input: snapshot.tokensTotal.input + liveSum.input,
    output: snapshot.tokensTotal.output + liveSum.output,
    total: snapshot.tokensTotal.total + liveSum.total,
  }

  return (
    <Box flexDirection="column">
      <BorderTop label="BEETHOVEN STATUS" />
      <BorderRow>
        <Text bold>Agents: </Text>
        <Text color="green">{agentCount}</Text>
        <Text dimColor>/{maxConcurrentAgents}</Text>
      </BorderRow>
      <BorderRow>
        <Text bold>Throughput: </Text>
        <Text color="cyan">{tps === null ? "—" : `${tps.toFixed(1)} tps`}</Text>
      </BorderRow>
      <BorderRow>
        <Text bold>Tokens: </Text>
        <Text color="yellow">in {formatCount(headerTokens.input)}</Text>
        <Text dimColor> | </Text>
        <Text color="yellow">out {formatCount(headerTokens.output)}</Text>
        <Text dimColor> | </Text>
        <Text color="yellow">total {formatCount(headerTokens.total)}</Text>
      </BorderRow>
      <BorderRow>
        <Text bold>Rate Limits: </Text>
        <Text color={snapshot.rateLimits?.status === "rejected" ? "red" : "cyan"}>
          {formatRateLimits(snapshot.rateLimits)}
        </Text>
      </BorderRow>
      {snapshot.dispatchPausedUntil !== null ? (
        <BorderRow>
          <Text bold>Dispatch: </Text>
          <Text color="red">
            paused for {formatDuration(snapshot.dispatchPausedUntil - now)}
          </Text>
        </BorderRow>
      ) : null}
      <BorderRow>
        <Text bold>Project: </Text>
        <Text color="cyan">{linearProjectUrl(projectSlug)}</Text>
      </BorderRow>
      <BorderRow>
        <Text bold>Next refresh: </Text>
        {nextRefreshSec === null ? (
          <Text dimColor>n/a</Text>
        ) : (
          <Text color="cyan">{nextRefreshSec}s</Text>
        )}
      </BorderRow>

      <BorderSection label="Running" />
      <RunningTable rows={snapshot.running} now={now} />

      <BorderSection label="Backoff queue" />
      <BackoffTable rows={snapshot.retries} now={now} />

      <BorderSection label="Completed" />
      <CompletedRow ids={snapshot.completed} />

      <BorderBottom />
    </Box>
  )
}

function RunningTable({
  rows,
  now,
}: {
  rows: DispatchSnapshot["running"]
  now: number
}) {
  if (rows.length === 0) {
    return (
      <BorderRow>
        <Text dimColor>(no active dispatches)</Text>
      </BorderRow>
    )
  }
  return (
    <Box flexDirection="column">
      <BorderRow>
        <ColumnHeader text="ID" width={COLS.id} />
        <ColumnHeader text="Stage" width={COLS.stage} />
        <ColumnHeader text="Age" width={COLS.age} />
        <ColumnHeader text="Tokens" width={COLS.tokens} />
        <ColumnHeader text="Agent / Latest" width={0} />
      </BorderRow>
      {rows.map((r) => {
        const latest = formatLatest(r.latestTool, r.latestMessage)
        return (
          <React.Fragment key={r.issueId}>
            <BorderRow>
              <Cell width={COLS.id}>
                <Text color="green">{pad(r.identifier, COLS.id)}</Text>
              </Cell>
              <Cell width={COLS.stage}>
                <Text>{pad(`turn ${r.turn}`, COLS.stage)}</Text>
              </Cell>
              <Cell width={COLS.age}>
                <Text dimColor>{pad(formatDuration(now - r.startedAt), COLS.age)}</Text>
              </Cell>
              <Cell width={COLS.tokens}>
                <Text color="yellow">
                  {pad(formatCount(r.liveTokens.total), COLS.tokens)}
                </Text>
              </Cell>
              <Text color="magenta">{compactAgentId(r.agent.id)}</Text>
              <Text dimColor> · </Text>
              <Text color="cyan">{r.agent.model ?? r.agent.kind}</Text>
              {r.processPid === null ? null : (
                <Text dimColor> · pid {r.processPid}</Text>
              )}
            </BorderRow>
            <BorderRow>
              <Text dimColor>  {truncate(r.title, 26)} · </Text>
              {latest.tool ? <Text color="blue">⏵ {latest.tool}</Text> : <Text dimColor>idle</Text>}
              {latest.message ? <Text dimColor> · {latest.message}</Text> : null}
            </BorderRow>
          </React.Fragment>
        )
      })}
    </Box>
  )
}

function BackoffTable({
  rows,
  now,
}: {
  rows: DispatchSnapshot["retries"]
  now: number
}) {
  if (rows.length === 0) {
    return (
      <BorderRow>
        <Text dimColor>(empty)</Text>
      </BorderRow>
    )
  }
  return (
    <Box flexDirection="column">
      {rows.map((r) => (
        <BorderRow key={r.issueId}>
          <Text color="yellow">⟳ </Text>
          <Text color="green">{r.identifier}</Text>
          <Text dimColor>
            {" "}
            attempt #{r.attempt} · in {formatDuration(r.dueAt - now)}
          </Text>
        </BorderRow>
      ))}
    </Box>
  )
}

function CompletedRow({ ids }: { ids: ReadonlyArray<string> }) {
  if (ids.length === 0) {
    return (
      <BorderRow>
        <Text dimColor>(none yet)</Text>
      </BorderRow>
    )
  }
  return (
    <BorderRow>
      <Text dimColor>
        {ids.length} issue{ids.length === 1 ? "" : "s"} reached terminal state this session
      </Text>
    </BorderRow>
  )
}

function BorderTop({ label }: { label: string }) {
  return (
    <Text bold>
      <Text color="magenta">╭─ </Text>
      {label}
    </Text>
  )
}

function BorderSection({ label }: { label: string }) {
  return (
    <Text bold>
      <Text color="magenta">├─ </Text>
      {label}
    </Text>
  )
}

function BorderBottom() {
  return (
    <Text>
      <Text color="magenta">╰────────────────────────────────────────</Text>
    </Text>
  )
}

function BorderRow({ children }: { children: React.ReactNode }) {
  return (
    <Box flexDirection="row">
      <Text color="magenta">│ </Text>
      {children}
    </Box>
  )
}

function ColumnHeader({ text, width }: { text: string; width: number }) {
  return (
    <Cell width={width}>
      <Text dimColor bold>
        {width > 0 ? pad(text, width) : text}
      </Text>
    </Cell>
  )
}

function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  return <Box width={width > 0 ? width : undefined}>{children}</Box>
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width - 1) + " "
  return s + " ".repeat(width - s.length)
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

function compactAgentId(id: string): string {
  return id
    .replace(/^claude-/, "")
    .replace(/^codex-/, "")
    .replace(/^gemini-/, "")
    .replace(/^opencode-/, "")
}

function formatLatest(
  tool: string | null,
  message: string | null,
): { readonly tool: string | null; readonly message: string | null } {
  return {
    tool: tool ? truncate(tool, 18) : null,
    message: message ? truncate(message.replace(/\s+/g, " "), 72) : null,
  }
}

function linearProjectUrl(slug: string): string {
  return `https://linear.app/project/${slug}/issues`
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatRateLimits(rateLimits: DispatchSnapshot["rateLimits"]): string {
  if (rateLimits === null) return "unavailable"

  const parts = [
    rateLimits.limitId,
    rateLimits.status ?? "unknown",
    formatRateLimitBucket("primary", rateLimits.primary),
    formatRateLimitBucket("secondary", rateLimits.secondary),
    formatCredits(rateLimits.credits),
  ].filter((x): x is string => typeof x === "string" && x.length > 0)

  return parts.join(" | ")
}

function formatRateLimitBucket(
  label: string,
  bucket: NonNullable<DispatchSnapshot["rateLimits"]>["primary"],
): string | null {
  if (!bucket) return null

  const usage =
    bucket.remaining !== undefined && bucket.limit !== undefined
      ? `${formatCount(bucket.remaining)}/${formatCount(bucket.limit)}`
      : bucket.limit !== undefined
        ? `limit ${formatCount(bucket.limit)}`
        : bucket.remaining !== undefined
          ? `${formatCount(bucket.remaining)} left`
          : bucket.utilization !== undefined
            ? `${Math.round(bucket.utilization * 100)}%`
            : bucket.status

  const reset =
    bucket.resetInSeconds !== undefined
      ? ` reset ${formatDuration(bucket.resetInSeconds * 1000)}`
      : bucket.resetAt !== undefined
        ? ` reset ${formatDuration(bucket.resetAt - Date.now())}`
        : ""

  return usage ? `${label} ${usage}${reset}` : `${label}${reset}`
}

function formatCredits(
  credits: NonNullable<DispatchSnapshot["rateLimits"]>["credits"],
): string | null {
  if (!credits) return null
  if (credits.unlimited === true) return "credits unlimited"
  if (credits.balance !== undefined && credits.balance !== null) {
    return `credits ${credits.balance}`
  }
  if (credits.reason) return `credits ${credits.reason}`
  if (credits.status) return `credits ${credits.status}`
  if (credits.hasCredits === false) return "credits none"
  return null
}

function formatDuration(ms: number): string {
  if (ms < 0) return "now"
  if (ms < 1_000) return `${ms}ms`
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
