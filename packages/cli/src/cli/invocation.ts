import { EOL } from "os"
import { SCHEMA_VERSION } from "./cmd/run.errors"

export type InvocationPhase = "parse" | "validation" | "stdin" | "bootstrap" | "session"

function create(argv: string[]) {
  const run = argv.indexOf("run")
  const json =
    run !== -1 &&
    argv.slice(run + 1).some((arg, index, args) => {
      if (arg === "--format=json") return true
      return arg === "--format" && args[index + 1] === "json"
    })
  const invocationID = json ? crypto.randomUUID() : undefined
  const started = Date.now()
  let phase: InvocationPhase = "parse"
  let sessionID: string | undefined
  let failed = false
  let completed = false

  function emit(type: string, data: Record<string, unknown> = {}) {
    if (!invocationID) return
    process.stdout.write(
      JSON.stringify({
        type,
        timestamp: Date.now(),
        schemaVersion: SCHEMA_VERSION,
        invocationID,
        ...data,
      }) + EOL,
    )
  }

  if (invocationID) emit("invocation_start")

  return {
    get id() {
      return invocationID
    },
    phase(next: InvocationPhase) {
      phase = next
    },
    link(id: string) {
      sessionID = id
    },
    error(error: unknown, code = "INVOCATION_FAILED") {
      if (!invocationID || sessionID || failed || completed) return
      failed = true
      emit("invocation_error", {
        phase,
        code,
        message:
          error instanceof Error
            ? error.message
            : error && typeof error === "object" && "message" in error
              ? String(error.message)
              : String(error),
      })
    },
    complete() {
      if (!invocationID || completed) return
      completed = true
      emit("invocation_complete", {
        status: failed ? "error" : "completed",
        durationMs: Date.now() - started,
        ...(sessionID ? { sessionID } : {}),
      })
    },
  }
}

let current = create([])

export const Invocation = {
  get id() {
    return current.id
  },
  phase(next: InvocationPhase) {
    current.phase(next)
  },
  link(id: string) {
    current.link(id)
  },
  error(error: unknown, code?: string) {
    current.error(error, code)
  },
  abort(error: unknown, code?: string) {
    current.error(error, code)
    current.complete()
  },
  complete() {
    current.complete()
  },
}

export function startInvocation(argv = process.argv.slice(2)) {
  current = create(argv)
}
