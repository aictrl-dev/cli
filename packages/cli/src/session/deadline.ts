import z from "zod"
import { MessageV2 } from "./message-v2"

// The caller's wall-clock deadline for one prompt run (`aictrl run --deadline`, #138).
export namespace Deadline {
  export const Input = z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Epoch-ms instant by which the run must finish; schema runs get a final turn to submit before it")

  // Wrap-up margin: the time left at which a schema run must stop exploring and
  // submit. A final submission can take two steps (write the result file, then call
  // StructuredOutput), so the margin is twice the slowest step seen so far, at least
  // one minute for a slow first reply, and at most a fifth of the whole window so a
  // short deadline still leaves most of its time for the task itself.
  const FLOOR = 60_000
  const SHARE = 0.2
  export function margin(window: number, slowest: number) {
    return Math.min(Math.max(FLOOR, 2 * slowest), SHARE * window)
  }

  // setTimeout fires at once for delays above 2^31 - 1 ms (about 24.8 days).
  const MAX_TIMER = 2 ** 31 - 1

  export function error(deadline: number) {
    return new MessageV2.DeadlineError({ message: "Run deadline reached before a final result", deadline })
  }

  /**
   * Watches `deadline` for one loop. `signal` aborts with a DeadlineError when it
   * passes (and with the parent's reason when the parent aborts first). Without a
   * deadline it is the parent signal itself and nothing else changes.
   */
  export function watch(parent: AbortSignal, deadline?: number) {
    const started = Date.now()
    const reason = deadline === undefined ? undefined : error(deadline)
    const controller = new AbortController()
    let slowest = 0
    let wrapped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (deadline === undefined) return
      const left = deadline - Date.now()
      if (left <= 0) return controller.abort(reason)
      timer = setTimeout(arm, Math.min(left, MAX_TIMER))
    }
    arm()
    return {
      signal: deadline === undefined ? parent : AbortSignal.any([parent, controller.signal]),
      get expired() {
        return controller.signal.aborted
      },
      get error() {
        return reason?.toObject()
      },
      /** Records how long one model step took, tools included. */
      observe(ms: number) {
        slowest = Math.max(slowest, ms)
      },
      /** True once per run: the first time it is asked after the time left falls within the margin. */
      wrapUp() {
        if (deadline === undefined || wrapped) return false
        wrapped = deadline - Date.now() < margin(deadline - started, slowest)
        return wrapped
      },
      [Symbol.dispose]() {
        clearTimeout(timer)
      },
    }
  }
}
