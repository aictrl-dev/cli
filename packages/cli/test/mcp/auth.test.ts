import { describe, test, expect } from "bun:test"
import { McpAuth } from "../../src/mcp/auth"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

describe("McpAuth", () => {
  test("module imports correctly", () => {
    expect(McpAuth).toBeDefined()
    expect(typeof McpAuth.set).toBe("function")
    expect(typeof McpAuth.remove).toBe("function")
  })
})
