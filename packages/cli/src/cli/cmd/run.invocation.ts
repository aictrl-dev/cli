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
    writes = writes.then(() =>
      Stdout.json({
        type,
        timestamp: Date.now(),
        schemaVersion: SCHEMA_VERSION,
        invocationID: id,
        ...data,
      }),
    )
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

  async function abort(cause: unknown, code?: string) {
    error(cause, code)
    complete()
    await writes
  }

  return {
    id,
    phase(next: RunInvocationPhase) {
      phase = next
    },
    link(session: string) {
      sessionID = session
    },
    error,
    abort,
    async guard<T>(task: () => T | Promise<T>) {
      try {
        return await task()
      } catch (cause) {
        await abort(cause)
        throw cause
      }
    },
    async run<T>(task: Promise<T> | (() => T | Promise<T>)) {
      try {
        return await (typeof task === "function" ? task() : task)
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
