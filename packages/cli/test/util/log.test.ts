import { describe, test, expect } from "bun:test"
import { Log } from "../../src/util/log"

describe("Log", () => {
  test("Default logger is available", () => {
    expect(Log.Default).toBeDefined()
    expect(typeof Log.Default.info).toBe("function")
    expect(typeof Log.Default.error).toBe("function")
  })
})
