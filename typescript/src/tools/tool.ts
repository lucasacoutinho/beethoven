import type { Settings } from "../config/schema.ts"
import type { AgentTaskDelegate } from "../agent/harness.ts"
import type { Issue } from "../tracker/issue.ts"
import type { Workspace } from "../workspace/workspace.ts"

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputJsonSchema: Record<string, unknown>
}

export interface ToolContentItem {
  readonly type: "inputText"
  readonly text: string
}

export interface ToolExecutionResult {
  readonly success: boolean
  readonly output: string
  readonly contentItems: ReadonlyArray<ToolContentItem>
}

export interface ToolExecutionContext {
  readonly workspace?: Workspace
  readonly issue?: Issue
  readonly prompt?: string
  readonly delegateTask?: AgentTaskDelegate
}

export interface ToolImplementation {
  readonly definition: ToolDefinition
  readonly isEnabled?: (settings: Settings) => boolean
  readonly execute: (
    settings: Settings,
    argumentsValue: unknown,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionResult>
}

export function toolResponse(
  success: boolean,
  output: string,
): ToolExecutionResult {
  return {
    success,
    output,
    contentItems: [{ type: "inputText", text: output }],
  }
}

export function failureToolResponse(payload: unknown): ToolExecutionResult {
  return toolResponse(false, encodeToolPayload(payload))
}

export function encodeToolPayload(payload: unknown): string {
  if (typeof payload === "string") return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}
