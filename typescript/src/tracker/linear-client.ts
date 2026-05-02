import { Context, Data, Effect, Layer } from "effect"
import type { Issue, BlockerRef } from "./issue.ts"

const ISSUE_PAGE_SIZE = 50
const RELATION_FIRST = 50

const POLL_QUERY = /* GraphQL */ `
  query BeethovenLinearPoll(
    $projectSlug: String!
    $stateNames: [String!]!
    $first: Int!
    $relationFirst: Int!
    $after: String
  ) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
      first: $first
      after: $after
    ) {
      nodes { ...IssueFields }
      pageInfo { hasNextPage endCursor }
    }
  }

  fragment IssueFields on Issue {
    id identifier title description priority
    state { name }
    branchName url
    labels { nodes { name } }
    inverseRelations(first: $relationFirst) {
      nodes {
        type
        issue { id identifier state { name } }
      }
    }
    createdAt updatedAt
  }
`

const BY_IDS_QUERY = /* GraphQL */ `
  query BeethovenLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
    issues(filter: { id: { in: $ids } }, first: $first) {
      nodes {
        id identifier title description priority
        state { name }
        branchName url
        labels { nodes { name } }
        inverseRelations(first: $relationFirst) {
          nodes { type issue { id identifier state { name } } }
        }
        createdAt updatedAt
      }
    }
  }
`

interface PollQueryResult {
  issues: {
    nodes: LinearNode[]
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }
}

interface ByIdsQueryResult {
  issues: { nodes: LinearNode[] }
}

interface LinearNode {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number | null
  state: { name: string } | null
  branchName: string | null
  url: string | null
  labels: { nodes: Array<{ name: string }> } | null
  inverseRelations: {
    nodes: Array<{
      type: string
      issue: { id: string; identifier: string; state: { name: string } | null } | null
    }>
  } | null
  createdAt: string | null
  updatedAt: string | null
}

export class LinearError extends Data.TaggedError("LinearError")<{
  readonly code: "missing_api_key" | "missing_project_slug" | "http_error" | "graphql_error"
  readonly message: string
  readonly status?: number
  readonly details?: unknown
}> {}

export interface LinearConfig {
  readonly endpoint: string
  readonly apiKey: string
  readonly projectSlug: string
}

export interface LinearClientService {
  readonly fetchIssuesByStates: (
    states: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Issue>, LinearError>
  readonly fetchIssuesByIds: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Issue>, LinearError>
}

export class LinearClient extends Context.Tag("beethoven/LinearClient")<
  LinearClient,
  LinearClientService
>() {}

export const makeLinearClient = (
  config: LinearConfig,
): LinearClientService => {
  const gql = <T>(
    query: string,
    variables: Record<string, unknown>,
  ): Effect.Effect<T, LinearError> =>
    Effect.tryPromise({
      try: async (): Promise<T> => {
        const response = await fetch(config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: config.apiKey,
          },
          body: JSON.stringify({ query, variables }),
        })

        if (!response.ok) {
          const body = await response.text().catch(() => "")
          throw new LinearError({
            code: "http_error",
            message: `Linear HTTP ${response.status} ${response.statusText}`,
            status: response.status,
            details: body.slice(0, 1000),
          })
        }

        const payload = (await response.json()) as { data?: T; errors?: unknown }
        if (payload.errors) {
          throw new LinearError({
            code: "graphql_error",
            message: "Linear returned GraphQL errors",
            details: payload.errors,
          })
        }
        if (!payload.data) {
          throw new LinearError({
            code: "graphql_error",
            message: "Linear returned empty data",
          })
        }
        return payload.data
      },
      catch: (cause) =>
        cause instanceof LinearError
          ? cause
          : new LinearError({
              code: "http_error",
              message: cause instanceof Error ? cause.message : String(cause),
              details: cause,
            }),
    })

  const fetchIssuesByStates: LinearClientService["fetchIssuesByStates"] = (
    states,
  ) =>
    Effect.gen(function* () {
      if (states.length === 0) return [] as ReadonlyArray<Issue>
      const out: Issue[] = []
      let cursor: string | null = null
      for (let page = 0; page < 50; page++) {
        const data: PollQueryResult = yield* gql<PollQueryResult>(POLL_QUERY, {
          projectSlug: config.projectSlug,
          stateNames: states,
          first: ISSUE_PAGE_SIZE,
          relationFirst: RELATION_FIRST,
          after: cursor,
        })
        out.push(...data.issues.nodes.map(normalize))
        if (!data.issues.pageInfo.hasNextPage) break
        cursor = data.issues.pageInfo.endCursor
        if (!cursor) break
      }
      return out as ReadonlyArray<Issue>
    })

  const fetchIssuesByIds: LinearClientService["fetchIssuesByIds"] = (ids) =>
    Effect.gen(function* () {
      const unique = Array.from(new Set(ids))
      if (unique.length === 0) return [] as ReadonlyArray<Issue>
      const data = yield* gql<ByIdsQueryResult>(BY_IDS_QUERY, {
        ids: unique,
        first: unique.length,
        relationFirst: RELATION_FIRST,
      })
      return data.issues.nodes.map(normalize) as ReadonlyArray<Issue>
    })

  return { fetchIssuesByStates, fetchIssuesByIds }
}

export const LinearClientLive = (config: LinearConfig) =>
  Layer.sync(LinearClient, () => {
    if (!config.apiKey) {
      throw new LinearError({
        code: "missing_api_key",
        message: "Linear api_key is required",
      })
    }
    if (!config.projectSlug) {
      throw new LinearError({
        code: "missing_project_slug",
        message: "Linear project_slug is required",
      })
    }
    return makeLinearClient(config)
  })

function normalize(node: LinearNode): Issue {
  const labels = (node.labels?.nodes ?? []).map((l) => l.name.toLowerCase())
  const blockedBy: BlockerRef[] = (node.inverseRelations?.nodes ?? [])
    .filter((rel) => rel.type === "blocks")
    .map((rel) => ({
      id: rel.issue?.id ?? null,
      identifier: rel.issue?.identifier ?? null,
      state: rel.issue?.state?.name ?? null,
    }))

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description,
    priority: node.priority,
    state: node.state?.name ?? "",
    branchName: node.branchName,
    url: node.url,
    labels,
    blockedBy,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  }
}
