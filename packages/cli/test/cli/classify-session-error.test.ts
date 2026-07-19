import { describe, expect, test } from "bun:test"
import { classifySessionError } from "../../src/cli/cmd/run.errors"

describe("classifySessionError (#63)", () => {
  test("model stream idle timeout has a stable timeout code", () => {
    expect(
      classifySessionError({
        name: "StreamIdleTimeoutError",
        data: { message: "Model stream produced no events for 300000ms", timeout: 300000 },
      }),
    ).toEqual({
      reason: "timeout",
      code: "MODEL_STREAM_IDLE_TIMEOUT",
      message: "Model stream produced no events for 300000ms",
    })
  })

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

  test("stored ProviderAuthError → auth", () => {
    const res = classifySessionError({
      name: "ProviderAuthError",
      data: {
        providerID: "openai",
        message: "Invalid API key",
      },
    })
    expect(res.reason).toBe("auth")
    expect(res.message).toBe("Invalid API key")
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

  test("stored APIError statusCode → provider", () => {
    const res = classifySessionError({
      name: "APIError",
      data: {
        message: "internal",
        statusCode: 500,
        isRetryable: true,
      },
    })
    expect(res.reason).toBe("provider")
    expect(res.code).toBe("500")
    expect(res.message).toBe("internal")
  })
})
