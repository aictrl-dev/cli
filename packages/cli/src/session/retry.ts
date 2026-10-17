import type { NamedError } from "@aictrl/util/error"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export namespace SessionRetry {
  export const Reason = [
    "no_finish_reason",
    "rate_limited",
    "overloaded",
    "server_error",
    "network",
    "unknown",
  ] as const
  export type Reason = (typeof Reason)[number]

  export function reason(error: ReturnType<NamedError["toObject"]>): Reason {
    if (MessageV2.APIError.isInstance(error)) {
      if (error.data.metadata?.finishReason === "unknown") return "no_finish_reason"
      if (error.data.statusCode === 429) return "rate_limited"
      if (error.data.statusCode === 503 || /overload|unavailable/i.test(error.data.message)) return "overloaded"
      if (error.data.statusCode && error.data.statusCode >= 500) return "server_error"
      if (/network|connect|socket|fetch failed/i.test(error.data.message)) return "network"
      return "unknown"
    }
    const message = typeof error.data?.message === "string" ? error.data.message : ""
    if (/rate.limit|too.many.requests|exhausted/i.test(message)) return "rate_limited"
    if (/overload|unavailable/i.test(message)) return "overloaded"
    if (/network|connect|socket|fetch failed/i.test(message)) return "network"
    return "unknown"
  }

  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
  export const MAX_RETRY_ATTEMPTS = 10

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  // The provider's requested wait in milliseconds, from the standard
  // Retry-After header or its millisecond variant.
  function retryAfter(headers: Record<string, string>): number | undefined {
    const retryAfterMs = headers["retry-after-ms"]
    if (retryAfterMs) {
      const parsedMs = Number.parseFloat(retryAfterMs)
      if (!Number.isNaN(parsedMs)) {
        return parsedMs
      }
    }

    const retryAfter = headers["retry-after"]
    if (retryAfter) {
      const parsedSeconds = Number.parseFloat(retryAfter)
      if (!Number.isNaN(parsedSeconds)) {
        // convert seconds to milliseconds
        return Math.ceil(parsedSeconds * 1000)
      }
      // Try parsing as HTTP date format
      const parsed = Date.parse(retryAfter) - Date.now()
      if (!Number.isNaN(parsed) && parsed > 0) {
        return Math.ceil(parsed)
      }
    }
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        return retryAfter(headers) ?? RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  // A usage limit that resets later than the whole retry budget would wait at
  // the header-less delay cap (5 minutes) cannot be retried within the run.
  export const USAGE_LIMIT_MAX_WAIT = MAX_RETRY_ATTEMPTS * RETRY_MAX_DELAY_NO_HEADERS
  export const USAGE_LIMIT_CODE = "PROVIDER_USAGE_LIMIT"

  export type UsageLimit = {
    // When the limit resets, in Unix milliseconds, if the provider said.
    resetAt?: number
  }

  // Recognises a provider usage or quota limit that will not reset within the
  // retry budget: a 429 asking for a longer wait, or a known quota shape.
  export function usageLimit(error: ReturnType<NamedError["toObject"]>): UsageLimit | undefined {
    if (!MessageV2.APIError.isInstance(error)) return undefined
    if (error.data.statusCode !== 429) return undefined
    const wait = error.data.responseHeaders ? retryAfter(error.data.responseHeaders) : undefined
    const resetAt = resetTime(wait)
    if (wait !== undefined && wait > USAGE_LIMIT_MAX_WAIT) return { resetAt }
    if (zaiUsageLimit(error)) return { resetAt }
    return undefined
  }

  // The reset time for a provider-requested wait, unless the wait is too large
  // to be a valid date (for example `retry-after-ms: Infinity`).
  function resetTime(wait: number | undefined) {
    if (wait === undefined) return undefined
    const resetAt = Date.now() + wait
    return Number.isNaN(new Date(resetAt).getTime()) ? undefined : resetAt
  }

  // Z.ai GLM Coding Plan reports its rolling five-hour (1308) and
  // weekly/monthly (1310) quotas as a 429 without Retry-After. The reset time
  // is only in the message, in an unstated time zone, so it is not parsed.
  const ZAI_USAGE_LIMIT_CODES = ["1308", "1310"]

  function zaiUsageLimit(error: MessageV2.APIError) {
    const code = responseErrorCode(error.data.responseBody)
    if (code && ZAI_USAGE_LIMIT_CODES.includes(code)) return true
    return /usage limit reached for \d+ hour/i.test(error.data.message)
  }

  function responseErrorCode(body: string | undefined) {
    if (!body) return undefined
    try {
      const code = JSON.parse(body)?.error?.code
      return typeof code === "string" || typeof code === "number" ? String(code) : undefined
    } catch {
      return undefined
    }
  }

  // The terminal error for a usage limit, or undefined for any other error.
  // It keeps the provider's message, which may name its own reset time.
  export function usageLimitError(error: ReturnType<NamedError["toObject"]>) {
    const limit = usageLimit(error)
    if (!limit || !MessageV2.APIError.isInstance(error)) return undefined
    const resets = limit.resetAt === undefined ? "" : `, resets at ${new Date(limit.resetAt).toISOString()}`
    return new MessageV2.APIError({
      message: `Provider usage limit reached${resets}: ${error.data.message}`,
      statusCode: error.data.statusCode,
      isRetryable: false,
      metadata: {
        code: USAGE_LIMIT_CODE,
        ...(limit.resetAt === undefined ? {} : { resetAt: String(limit.resetAt) }),
      },
    }).toObject()
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    // context overflow errors should not be retried
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    // a usage limit cannot reset within the retry budget
    if (usageLimit(error)) return undefined
    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      if (error.data.responseBody?.includes("FreeUsageLimitError"))
        return `Free usage exceeded, add credits https://aictrl.ai/zen`
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    const json = iife(() => {
      try {
        if (typeof error.data?.message === "string") {
          const parsed = JSON.parse(error.data.message)
          return parsed
        }

        return JSON.parse(error.data.message)
      } catch {
        return undefined
      }
    })
    try {
      if (!json || typeof json !== "object") return undefined
      const code = typeof json.code === "string" ? json.code : ""

      if (json.type === "error" && json.error?.type === "too_many_requests") {
        return "Too Many Requests"
      }
      if (code.includes("exhausted") || code.includes("unavailable")) {
        return "Provider is overloaded"
      }
      if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
        return "Rate Limited"
      }
      return JSON.stringify(json)
    } catch {
      return undefined
    }
  }
}
