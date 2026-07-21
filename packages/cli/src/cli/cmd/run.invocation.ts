import { EOL } from "os"
import { Stdout } from "../stdout"
import { SCHEMA_VERSION } from "./run.errors"

export type RunInvocationPhase = "validation" | "stdin" | "bootstrap" | "session"

export function createRunInvocation(enabled: boolean) {
  const id = enabled ? crypto.randomUUID() : undefined
  const started = Date.now()
  let phase: RunInvocationPhase = "validation"
  let sessionID: string | undefined
  let failed = false
  let completed = false
  let writes = Promise.resolve()

  function emit(type: string, data: Record<string, unknown> = {}) {
    if (!id) return
    const line =
      JSON.stringify({
        type,
        timestamp: Date.now(),
        schemaVersion: SCHEMA_VERSION,
        invocationID: id,
        ...data,
      }) + EOL
    writes = writes.then(() => Stdout.write(line))
  }

  emit("invocation_start")

  function error(_error: unknown, code = `INVOCATION_${phase.toUpperCase()}_FAILED`) {
    if (!id || failed || completed) return
    failed = true
    if (sessionID) return
    emit("invocation_error", {
      phase,
      code,
      message: `Invocation failed during ${phase}`,
    })
  }

  function complete() {
    if (!id || completed) return
    completed = true
    emit("invocation_complete", {
      status: failed ? "error" : "completed",
      durationMs: Date.now() - started,
      ...(sessionID ? { sessionID } : {}),
    })
  }

  return {
    id,
    phase(next: RunInvocationPhase) {
      phase = next
    },
    link(id: string) {
      sessionID = id
    },
    error,
    async abort(cause: unknown, code?: string) {
      error(cause, code)
      complete()
      await writes
    },
    async run<T>(execution: Promise<T>) {
      try {
        return await execution
      } catch (cause) {
        error(cause)
        throw cause
      } finally {
        await writes
        complete()
        await writes
      }
    },
  }
}
