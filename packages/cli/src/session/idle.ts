import { MessageV2 } from "./message-v2"

export namespace StreamIdle {
  function error(ms: number) {
    return new MessageV2.StreamIdleTimeoutError({
      message: `Model stream produced no events for ${ms}ms`,
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
  ) {
    if (ms === 0) {
      yield* stream
      return
    }

    const iterator = stream[Symbol.asyncIterator]()
    let suspended = false
    try {
      while (true) {
        if (suspended) {
          const next = await iterator.next()
          if (next.done) return
          suspended = updateSuspended(next.value)
          yield next.value
          continue
        }
        const timer = Promise.withResolvers<never>()
        const id = setTimeout(() => {
          timer.reject(error(ms))
          abort()
        }, ms)
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
