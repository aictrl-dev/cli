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
  // Exponential backoff, used when the provider gives no retry hint, stops here.
  export const RETRY_MAX_BACKOFF = 30_000 // 30 seconds
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

  function requestedWait(error: MessageV2.APIError | undefined) {
    const headers = error?.data.responseHeaders
    return headers ? retryAfter(headers) : undefined
  }

  // The wait before the next attempt: the provider's requested wait, at most
  // USAGE_LIMIT_MAX_WAIT, or else exponential backoff up to RETRY_MAX_BACKOFF.
  export function delay(attempt: number, error?: MessageV2.APIError) {
    const wait = requestedWait(error)
    if (wait !== undefined) return Math.min(wait, USAGE_LIMIT_MAX_WAIT)
    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_BACKOFF)
  }

  // The longest single wait a provider can ask for and still be retried: every
  // attempt at the backoff cap (5 minutes). Any status asking for longer is not
  // retried, and a 429 asking for longer is a usage limit, not a rate limit.
  export const USAGE_LIMIT_MAX_WAIT = MAX_RETRY_ATTEMPTS * RETRY_MAX_BACKOFF
  export const USAGE_LIMIT_CODE = "PROVIDER_USAGE_LIMIT"

  export type UsageLimit = {
    // When the limit resets, in Unix milliseconds, if the provider said.
    resetAt?: number
  }

  // Recognises a provider usage or quota limit that will not reset soon: a 429
  // asking for a wait over USAGE_LIMIT_MAX_WAIT, or a known quota shape.
  export function usageLimit(error: ReturnType<NamedError["toObject"]>): UsageLimit | undefined {
    if (!MessageV2.APIError.isInstance(error)) return undefined
    if (error.data.statusCode !== 429) return undefined
    const wait = requestedWait(error)
    if (wait !== undefined && wait > USAGE_LIMIT_MAX_WAIT) return { resetAt: resetTime(wait) }
    const quota = zaiUsageLimit(error)
    if (!quota) return undefined
    // A quota that resets within the bound is retried like a short rate limit.
    if (quota.resetAt !== undefined && quota.resetAt - Date.now() <= USAGE_LIMIT_MAX_WAIT) return undefined
    return quota
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
  // is only in the message, as "reset at YYYY-MM-DD HH:MM:SS" with no time
  // zone. Production telemetry across four incidents is consistent only with
  // UTC+8 (China has no DST), so it is read with a fixed +08:00 offset.
  const ZAI_USAGE_LIMIT_CODES = ["1308", "1310"]
  const ZAI_RESET_AT = /reset at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/i

  function zaiUsageLimit(error: MessageV2.APIError): UsageLimit | undefined {
    if (!isZaiQuota(error)) return undefined
    return { resetAt: zaiResetTime(error.data.message) }
  }

  function isZaiQuota(error: MessageV2.APIError) {
    const code = responseErrorCode(error.data.responseBody)
    if (code && ZAI_USAGE_LIMIT_CODES.includes(code)) return true
    return /usage limit reached for \d+ hour/i.test(error.data.message)
  }

  const UTC_PLUS_8 = 8 * 60 * 60 * 1000

  function zaiResetTime(message: string) {
    const match = message.match(ZAI_RESET_AT)
    if (!match) return undefined
    const local = `${match[1]}T${match[2]}`
    const resetAt = Date.parse(`${local}+08:00`)
    if (Number.isNaN(resetAt)) return undefined
    // Date.parse rolls impossible dates over (Feb 30 becomes Mar 2); reject them.
    return new Date(resetAt + UTC_PLUS_8).toISOString().startsWith(local) ? resetAt : undefined
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
    // a usage limit will not reset soon enough to retry
    if (usageLimit(error)) return undefined
    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      // nor will any other error whose provider asks to wait longer than a retry may
      const wait = requestedWait(error)
      if (wait !== undefined && wait > USAGE_LIMIT_MAX_WAIT) return undefined
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
