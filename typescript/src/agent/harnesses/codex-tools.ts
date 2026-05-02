import type { ToolDefinition } from "../../tools/index.ts"

export function toCodexDynamicTools(
  tools: ReadonlyArray<ToolDefinition>,
): ReadonlyArray<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputJsonSchema,
  }))
}
