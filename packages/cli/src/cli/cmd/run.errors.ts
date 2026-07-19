export const SCHEMA_VERSION = "1"

export type SessionErrorReason =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "oom"
  | "provider"
  | "interrupted"
  | "terminated"
  | "unknown"

export type ClassifiedSessionError = {
  reason: SessionErrorReason
  code?: string
  message: string
}

export function classifySessionError(err: unknown): ClassifiedSessionError {
  const message = extractMessage(err)
  const status = extractStatus(err)
  const name = extractName(err)

  if (status === 429) return { reason: "rate_limit", code: "429", message }
  if (status === 401 || status === 403) return { reason: "auth", code: String(status), message }
  if (name === "ProviderAuthError") return { reason: "auth", code: status ? String(status) : undefined, message }
  if (name === "AbortError" || /timeout/i.test(message)) {
    return { reason: "timeout", code: status ? String(status) : undefined, message }
  }
  if (/heap out of memory|ENOMEM/i.test(message)) {
    return { reason: "oom", message }
  }
  if (status && status >= 500 && status < 600) {
    return { reason: "provider", code: String(status), message }
  }
  return { reason: "unknown", code: status ? String(status) : undefined, message }
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message)
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data: unknown }).data
    if (data && typeof data === "object" && "message" in data) return String((data as { message: unknown }).message)
  }
  return String(err)
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown }; data?: unknown }
    const data = e.data && typeof e.data === "object" ? (e.data as { status?: unknown; statusCode?: unknown }) : undefined
    const raw = e.status ?? e.statusCode ?? e.response?.status ?? data?.status ?? data?.statusCode
    if (typeof raw === "number") return raw
    if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw)
  }
  return undefined
}

function extractName(err: unknown): string | undefined {
  if (err instanceof Error) return err.name
  if (err && typeof err === "object" && "name" in err) return String((err as { name: unknown }).name)
  return undefined
}
