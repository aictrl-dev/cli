import { EOL } from "os"
import { SCHEMA_VERSION } from "./cmd/run.errors"
import { Stdout } from "./stdout"

export type InvocationPhase = "parse" | "validation" | "stdin" | "bootstrap" | "session"

function create(argv: string[]) {
  const run = (() => {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index]
      if (arg === "--print-logs") continue
      if (arg.startsWith("--print-logs=")) continue
      if (arg === "--log-level") {
        index++
        continue
      }
      if (arg.startsWith("--log-level=")) continue
      return arg === "run" ? index : -1
    }
    return -1
  })()
  const args = argv.slice(run + 1)
  const json =
    run !== -1 &&
    args.slice(0, args.indexOf("--") === -1 ? undefined : args.indexOf("--")).some((arg, index, args) => {
      if (arg === "--format=json") return true
      return arg === "--format" && args[index + 1] === "json"
    })
  const invocationID = json ? crypto.randomUUID() : undefined
  const started = Date.now()
  let phase: InvocationPhase = "parse"
  let sessionID: string | undefined
  let failed = false
  let completed = false
  let writes = Promise.resolve()

  function emit(type: string, data: Record<string, unknown> = {}) {
    if (!invocationID) return
    const line =
      JSON.stringify({
        type,
        timestamp: Date.now(),
        schemaVersion: SCHEMA_VERSION,
        invocationID,
        ...data,
      }) + EOL
    writes = writes.then(() => Stdout.write(line)).catch(() => {})
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
    error(_error: unknown, code = "INVOCATION_FAILED") {
      if (!invocationID || failed || completed) return
      failed = true
      if (sessionID) return
      emit("invocation_error", {
        phase,
        code,
        message: `Invocation failed during ${phase}`,
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
    flush() {
      return writes
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
  flush() {
    return current.flush()
  },
  drain() {
    return current.flush().catch(() => {})
  },
}

export function startInvocation(argv = process.argv.slice(2)) {
  current = create(argv)
}
