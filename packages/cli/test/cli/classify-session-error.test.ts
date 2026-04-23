import { describe, expect, test } from "bun:test"
import { classifySessionError } from "../../src/cli/cmd/run.errors"

describe("classifySessionError (#63)", () => {
  test("HTTP 429 → rate_limit", () => {
    const res = classifySessionError({ status: 429, message: "Rate limit exceeded" })
    expect(res.reason).toBe("rate_limit")
    expect(res.code).toBe("429")
    expect(res.message).toContain("Rate limit")
  })

  test("HTTP 401 → auth", () => {
    const res = classifySessionError({ status: 401, message: "Invalid API key" })
    expect(res.reason).toBe("auth")
    expect(res.code).toBe("401")
  })

  test("AbortError → timeout", () => {
    const err = new Error("aborted")
    err.name = "AbortError"
    expect(classifySessionError(err).reason).toBe("timeout")
  })

  test("heap OOM → oom", () => {
    const err = new Error("JavaScript heap out of memory")
    expect(classifySessionError(err).reason).toBe("oom")
  })

  test("generic Error → unknown", () => {
    expect(classifySessionError(new Error("boom")).reason).toBe("unknown")
  })

  test("HTTP 500 → provider", () => {
    const res = classifySessionError({ status: 500, message: "internal" })
    expect(res.reason).toBe("provider")
  })
})
