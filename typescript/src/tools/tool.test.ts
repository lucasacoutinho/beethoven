import { describe, expect, test } from "bun:test"

import { toolResponse } from "./tool.ts"

describe("toolResponse", () => {
  test("caps large tool outputs before they enter model context", () => {
    const result = toolResponse(true, "x".repeat(8_050))

    expect(result.output.length).toBeLessThan(8_200)
    expect(result.output).toContain("[truncated 50 chars by Beethoven tool output cap]")
    expect(result.contentItems[0]?.text).toBe(result.output)
  })
})
