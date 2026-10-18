import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import type { NamedError } from "@aictrl/util/error"
import { APICallError } from "ai"
import path from "path"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return new MessageV2.APIError({
    message: "boom",
    isRetryable: true,
    responseHeaders: headers,
  }).toObject() as MessageV2.APIError
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { data: { message } } as ReturnType<NamedError["toObject"]>
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("caps backoff at 30 seconds when the response has headers but no retry hint", () => {
    const error = apiError({ "content-type": "application/json" })
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("uses retry-after values longer than the backoff cap", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)
  })

  test.each([
    ["retry-after-ms", "700000"],
    ["retry-after", "18000"],
    ["retry-after-ms", "Infinity"],
  ])("never waits longer than 5 minutes for %s: %s", (header, value) => {
    const error = apiError({ [header]: value })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.USAGE_LIMIT_MAX_WAIT)
  })

  test("sleep caps delay to max 32-bit signed integer to avoid TimeoutOverflowWarning", async () => {
    const controller = new AbortController()

    const warnings: string[] = []
    const originalWarn = process.emitWarning
    process.emitWarning = (warning: string | Error) => {
      warnings.push(typeof warning === "string" ? warning : warning.message)
    }

    const promise = SessionRetry.sleep(2_560_914_000, controller.signal)
    controller.abort()

    try {
      await promise
    } catch {}

    process.emitWarning = originalWarn
    expect(warnings.some((w) => w.includes("TimeoutOverflowWarning"))).toBe(false)
  })
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error)).toBe("Provider is overloaded")
  })

  test("handles json messages without code", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error)).toBe(`{"error":{"message":"no_kv_space"}}`)
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not retry context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject() as ReturnType<NamedError["toObject"]>

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })
})

// Z.ai GLM Coding Plan rolling-quota responses, in the exact message shape
// seen in production. The OpenAI-compatible shape is what the
// `zai-coding-plan` provider receives; the Anthropic-compatible shape is the
// same quota reported through Z.ai's Anthropic endpoint. Reset times are UTC+8.
function zaiFiveHourLimit(reset: string) {
  return JSON.stringify({
    error: { code: "1308", message: `Usage limit reached for 5 hour. Your limit will reset at ${reset}` },
  })
}
const ZAI_RESET = "2026-06-16 19:56:23"
const ZAI_RESET_AT = Date.parse("2026-06-16T11:56:23Z")
const ZAI_FIVE_HOUR_LIMIT = zaiFiveHourLimit(ZAI_RESET)
const ZAI_FIVE_HOUR_LIMIT_ANTHROPIC = JSON.stringify({
  type: "error",
  error: {
    type: "rate_limit_error",
    code: "1308",
    message: `[1308][Usage limit reached for 5 hour. Your limit will reset at ${ZAI_RESET}]`,
  },
})
const ZAI_WEEKLY_LIMIT = JSON.stringify({
  error: { code: "1310", message: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-06-20 00:00:00" },
})
const ZAI_WEEKLY_RESET_AT = Date.parse("2026-06-19T16:00:00Z")

function providerError(input: {
  statusCode: number
  body?: string
  headers?: Record<string, string>
  message?: string
}): MessageV2.APIError {
  const body = input.body ? JSON.parse(input.body) : undefined
  return MessageV2.fromError(
    new APICallError({
      message: input.message ?? body?.error?.message ?? "Too Many Requests",
      url: "https://provider.invalid/v1/chat/completions",
      requestBodyValues: {},
      statusCode: input.statusCode,
      responseHeaders: { "content-type": "application/json", ...input.headers },
      responseBody: input.body,
    }),
    { providerID: "fixture" },
  ) as MessageV2.APIError
}

describe("session.retry.usageLimit", () => {
  // Two hours before the five-hour quota fixture resets.
  beforeEach(() => setSystemTime(new Date(ZAI_RESET_AT - 2 * 60 * 60 * 1000)))
  afterEach(() => setSystemTime())

  test.each([
    ["OpenAI-compatible five-hour quota", ZAI_FIVE_HOUR_LIMIT, ZAI_RESET_AT],
    ["Anthropic-compatible five-hour quota", ZAI_FIVE_HOUR_LIMIT_ANTHROPIC, ZAI_RESET_AT],
    ["weekly quota", ZAI_WEEKLY_LIMIT, ZAI_WEEKLY_RESET_AT],
  ])("fails fast on the Z.ai %s with its UTC+8 reset time", (_, body, resetAt) => {
    const error = providerError({ statusCode: 429, body })
    expect(error.data.isRetryable).toBe(true)
    expect(SessionRetry.usageLimit(error)).toEqual({ resetAt })
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("recognises the quota message when the provider omits the code", () => {
    const error = providerError({
      statusCode: 429,
      message: `Usage limit reached for 5 hour. Your limit will reset at ${ZAI_RESET}`,
    })
    expect(SessionRetry.usageLimit(error)).toEqual({ resetAt: ZAI_RESET_AT })
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("keeps retrying a Z.ai quota that resets within the bound", () => {
    setSystemTime(new Date(ZAI_RESET_AT - 2 * 60 * 1000))
    const error = providerError({ statusCode: 429, body: ZAI_FIVE_HOUR_LIMIT })
    expect(SessionRetry.usageLimit(error)).toBeUndefined()
    expect(SessionRetry.retryable(error)).toBe(`Usage limit reached for 5 hour. Your limit will reset at ${ZAI_RESET}`)
  })

  test.each([
    ["an impossible date", "2026-13-45 99:99:99"],
    ["a rolled-over date", "2026-02-30 10:00:00"],
    ["a truncated time", "2026-06-16 19:56"],
  ])("fails fast without a reset time when the Z.ai reset is %s", (_, reset) => {
    const error = providerError({ statusCode: 429, body: zaiFiveHourLimit(reset) })
    expect(SessionRetry.usageLimit(error)).toEqual({ resetAt: undefined })
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test.each([
    ["retry-after seconds", { "retry-after": "18000" }, 18_000_000],
    ["retry-after-ms", { "retry-after-ms": "3600000" }, 3_600_000],
  ])("treats a 429 whose %s exceeds the usage-limit bound as a usage limit", (_, headers, wait) => {
    const before = Date.now()
    const limit = SessionRetry.usageLimit(providerError({ statusCode: 429, headers }))
    expect(limit?.resetAt).toBeGreaterThanOrEqual(before + wait)
    expect(limit?.resetAt).toBeLessThanOrEqual(Date.now() + wait)
    expect(SessionRetry.retryable(providerError({ statusCode: 429, headers }))).toBeUndefined()
  })

  test("treats a 429 whose http-date reset is hours away as a usage limit", () => {
    const reset = new Date(Date.now() + 3 * 60 * 60 * 1000).toUTCString()
    const limit = SessionRetry.usageLimit(providerError({ statusCode: 429, headers: { "retry-after": reset } }))
    expect(limit?.resetAt).toBeGreaterThan(Date.now() + 2 * 60 * 60 * 1000)
  })

  test.each([
    ["no reset hint", {}],
    ["a seconds-long reset", { "retry-after": "30" }],
    ["a reset at the usage-limit bound", { "retry-after-ms": String(SessionRetry.USAGE_LIMIT_MAX_WAIT) }],
  ])("keeps retrying a short rate limit with %s", (_, headers) => {
    const error = providerError({ statusCode: 429, body: '{"error":{"message":"Rate limit exceeded"}}', headers })
    expect(SessionRetry.usageLimit(error)).toBeUndefined()
    expect(SessionRetry.retryable(error)).toBe("Rate limit exceeded")
  })

  test.each([
    [503, { "retry-after": "18000" }],
    [529, { "retry-after": "18000" }],
    [500, { "retry-after-ms": String(SessionRetry.USAGE_LIMIT_MAX_WAIT + 1) }],
  ])("fails fast without a usage limit when a %d asks for a wait over 5 minutes", (statusCode, headers) => {
    const error = providerError({ statusCode, message: "Overloaded", headers })
    expect(error.data.isRetryable).toBe(true)
    expect(SessionRetry.usageLimit(error)).toBeUndefined()
    expect(SessionRetry.usageLimitError(error)).toBeUndefined()
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("keeps retrying an overloaded provider that asks for a wait of 5 minutes", () => {
    const error = providerError({ statusCode: 503, message: "Overloaded", headers: { "retry-after": "300" } })
    expect(SessionRetry.retryable(error)).toBe("Provider is overloaded")
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.USAGE_LIMIT_MAX_WAIT)
  })

  test("bounds the wait by the existing retry budget", () => {
    expect(SessionRetry.USAGE_LIMIT_MAX_WAIT).toBe(SessionRetry.MAX_RETRY_ATTEMPTS * SessionRetry.RETRY_MAX_BACKOFF)
  })

  test("builds a nonretryable terminal error that names the usage limit", () => {
    const error = providerError({ statusCode: 429, body: ZAI_FIVE_HOUR_LIMIT })
    const terminal = SessionRetry.usageLimitError(error) as MessageV2.APIError
    expect(terminal.name).toBe("APIError")
    expect(terminal.data).toEqual({
      message: `Provider usage limit reached, resets at 2026-06-16T11:56:23.000Z: Usage limit reached for 5 hour. Your limit will reset at ${ZAI_RESET}`,
      statusCode: 429,
      isRetryable: false,
      metadata: { code: SessionRetry.USAGE_LIMIT_CODE, resetAt: String(ZAI_RESET_AT) },
    })
  })

  test("builds a terminal error without a reset time when the provider gives none", () => {
    const error = providerError({ statusCode: 429, body: zaiFiveHourLimit("soon") })
    const terminal = SessionRetry.usageLimitError(error) as MessageV2.APIError
    expect(terminal.data.message).toBe(
      "Provider usage limit reached: Usage limit reached for 5 hour. Your limit will reset at soon",
    )
    expect(terminal.data.metadata).toEqual({ code: SessionRetry.USAGE_LIMIT_CODE })
  })

  test("includes the reset time in the terminal error when the provider sends one", () => {
    const error = providerError({ statusCode: 429, headers: { "retry-after": "18000" } })
    const terminal = SessionRetry.usageLimitError(error) as MessageV2.APIError
    const resetAt = Number(terminal.data.metadata?.resetAt)
    expect(resetAt).toBeGreaterThan(Date.now())
    expect(terminal.data.message).toBe(
      `Provider usage limit reached, resets at ${new Date(resetAt).toISOString()}: Too Many Requests`,
    )
  })

  test.each([[502], [503]])("keeps the status-based retry for a quota body on a %d", (statusCode) => {
    const error = providerError({ statusCode, body: ZAI_FIVE_HOUR_LIMIT })
    expect(SessionRetry.usageLimit(error)).toBeUndefined()
    expect(SessionRetry.retryable(error)).toBeDefined()
  })

  test.each(["Infinity", "1e999", "1e300"])(
    "treats an unrepresentable retry-after-ms of %s as a usage limit without a reset time",
    (wait) => {
      const error = providerError({ statusCode: 429, headers: { "retry-after-ms": wait } })
      expect(SessionRetry.usageLimit(error)).toEqual({ resetAt: undefined })
      const terminal = SessionRetry.usageLimitError(error) as MessageV2.APIError
      expect(terminal.data.message).toBe("Provider usage limit reached: Too Many Requests")
      expect(terminal.data.metadata).toEqual({ code: SessionRetry.USAGE_LIMIT_CODE })
    },
  )

  test("leaves other errors to the generic terminal path", () => {
    expect(SessionRetry.usageLimitError(providerError({ statusCode: 400, message: "Invalid request" }))).toBeUndefined()
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await Bun.sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID: "test" })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
      expect((result as MessageV2.APIError).data.message).toBe("Connection reset by server")
      expect((result as MessageV2.APIError).data.metadata?.code).toBe("ECONNRESET")
      expect((result as MessageV2.APIError).data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = new MessageV2.APIError({
      message: "Connection reset by server",
      isRetryable: true,
      metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
    }).toObject() as MessageV2.APIError

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Connection reset by server")
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: "openai" }) as MessageV2.APIError
    expect(result.data.isRetryable).toBe(true)
  })
})

describe("session.retry.max_attempts", () => {
  test("MAX_RETRY_ATTEMPTS is defined and reasonable", () => {
    expect(SessionRetry.MAX_RETRY_ATTEMPTS).toBeGreaterThanOrEqual(5)
    expect(SessionRetry.MAX_RETRY_ATTEMPTS).toBeLessThanOrEqual(20)
  })

  test("processor checks max retry attempts", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/session/processor.ts")).text()
    expect(source).toMatch(/attempt\s*>\s*SessionRetry\.MAX_RETRY_ATTEMPTS/)
  })
})

test("retry reasons match the SDK and event specification", async () => {
  const sdk = await Bun.file(path.join(import.meta.dir, "../../../sdk/src/gen/types.gen.ts")).text()
  const docs = await Bun.file(path.join(import.meta.dir, "../../../../EVENTS.md")).text()
  const union = sdk.match(/export type SessionStatus =[\s\S]*?reason: ([^\n]+)/)?.[1]
  const list = docs.match(/safe retry reason: ([^\n]+)/)?.[1]
  expect(union).toBeDefined()
  expect(list).toBeDefined()
  const values = (text: string) => [...text.matchAll(/`([^`]+)`|"([^"]+)"/g)].map((match) => match[1] ?? match[2])
  expect(values(union!)).toEqual([...SessionRetry.Reason])
  expect(values(list!)).toEqual([...SessionRetry.Reason])
})
