import { MessageV2 } from "./message-v2"

export namespace StreamIdle {
  function error(ms: number, message: string) {
    return new MessageV2.StreamIdleTimeoutError({
      message,
      timeout: ms,
    })
  }

  export function signal(input?: AbortSignal) {
    const controller = new AbortController()
    return {
      controller,
      signal: input ? AbortSignal.any([input, controller.signal]) : controller.signal,
    }
  }

  export async function* timeout<T>(
    stream: AsyncIterable<T>,
    ms: number,
    abort: () => void,
    updateSuspended: (value: T) => boolean = () => false,
    suspendedTimeout = ms,
  ) {
    if (ms === 0) {
      yield* stream
      return
    }

    const iterator = stream[Symbol.asyncIterator]()
    let suspended = false
    try {
      while (true) {
        const timer = Promise.withResolvers<never>()
        const appliedTimeout = suspended ? suspendedTimeout : ms
        const id = setTimeout(() => {
          timer.reject(
            error(
              appliedTimeout,
              suspended
                ? `Tool execution produced no result for ${appliedTimeout}ms`
                : `Model stream produced no events for ${appliedTimeout}ms`,
            ),
          )
          abort()
        }, appliedTimeout)
        const next = await Promise.race([iterator.next(), timer.promise]).finally(() => clearTimeout(id))
        if (next.done) return
        suspended = updateSuspended(next.value)
        yield next.value
      }
    } finally {
      // Do not await cleanup: an async generator queues return() behind an
      // in-flight next(), which may never settle for the stalled stream we are
      // escaping. The abort above gives cooperative providers a chance to close.
      try {
        iterator.return?.().catch(() => {})
      } catch {}
    }
  }
}
