import { MessageV2 } from "./message-v2"

export namespace StreamIdle {
  export async function* timeout<T>(stream: AsyncIterable<T>, ms: number, abort: () => void) {
    if (ms === 0) {
      yield* stream
      return
    }

    const iterator = stream[Symbol.asyncIterator]()
    while (true) {
      const timer = Promise.withResolvers<never>()
      const id = setTimeout(() => {
        timer.reject(
          new MessageV2.StreamIdleTimeoutError({
            message: `Model stream produced no events for ${ms}ms`,
            timeout: ms,
          }),
        )
        abort()
      }, ms)
      const next = await Promise.race([iterator.next(), timer.promise]).finally(() => clearTimeout(id))
      if (next.done) return
      yield next.value
    }
  }
}
