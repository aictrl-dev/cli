import { describe, expect, test } from "bun:test"
import { StreamIdle } from "../../src/session/idle"
import { MessageV2 } from "../../src/session/message-v2"
import { Flag } from "../../src/flag/flag"

describe("model stream idle timeout", () => {
  test("missing configuration lets a quiet stream complete", async () => {
    const original = process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
    delete process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
    try {
      async function* stream() {
        await Bun.sleep(20)
        yield "ready"
      }
      const values = []
      for await (const value of StreamIdle.timeout(stream(), Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS, () => {
        throw new Error("default timeout should not abort")
      })) {
        values.push(value)
      }
      expect(values).toEqual(["ready"])
    } finally {
      if (original === undefined) delete process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
      else process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = original
    }
  })

  test("disabled setup timeout waits for provider preparation", async () => {
    const result = await StreamIdle.wait(
      Bun.sleep(20).then(() => "ready"),
      0,
      () => {
        throw new Error("disabled timeout should not abort")
      },
    )
    expect(result).toBe("ready")
  })

  test("enabled setup timeout aborts stalled provider preparation", async () => {
    const pending = Promise.withResolvers<string>()
    let aborted = false
    const error = await StreamIdle.wait(pending.promise, 10, () => {
      aborted = true
    }).catch((error) => error)
    expect(aborted).toBe(true)
    expect(MessageV2.StreamIdleTimeoutError.isInstance(error)).toBe(true)
    expect(error.data).toEqual({ message: "Model stream setup produced no result for 10ms", timeout: 10 })
  })

  test("uses its own abort signal when the caller signal is undefined", () => {
    const idle = StreamIdle.signal()

    expect(idle.signal.aborted).toBe(false)
    idle.controller.abort()
    expect(idle.signal.aborted).toBe(true)
  })

  test("combines a supplied caller signal with its timeout controller", () => {
    const caller = new AbortController()
    const idle = StreamIdle.signal(caller.signal)

    caller.abort()
    expect(idle.signal.aborted).toBe(true)
  })

  test("fails and aborts a stream whose next event stalls", async () => {
    const pending = Promise.withResolvers<IteratorResult<string>>()
    let aborted = false
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next: () => pending.promise,
        }
      },
    }

    const result = StreamIdle.timeout(stream, 10, () => {
      aborted = true
    })
    const error = await result.next().catch((error) => error)

    expect(aborted).toBe(true)
    expect(MessageV2.StreamIdleTimeoutError.isInstance(error)).toBe(true)
    expect(error.data).toEqual({
      message: "Model stream produced no events for 10ms",
      timeout: 10,
    })
  })

  test("calls return on the inner iterator after an idle timeout", async () => {
    const pending = Promise.withResolvers<IteratorResult<string>>()
    let called = false
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next: () => pending.promise,
          async return() {
            called = true
            return { done: true as const, value: undefined }
          },
        }
      },
    }

    await StreamIdle.timeout(stream, 10, () => {})
      .next()
      .catch(() => {})
    expect(called).toBe(true)
  })

  test("releases the inner iterator when the consumer stops early", async () => {
    let released = false
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          value: 0,
          async next() {
            return { done: false as const, value: ++this.value }
          },
          async return() {
            released = true
            return { done: true as const, value: undefined }
          },
        }
      },
    }

    for await (const _ of StreamIdle.timeout(stream, 100, () => {})) break
    expect(released).toBe(true)
  })

  test("resets after each event instead of limiting total stream duration", async () => {
    async function* stream() {
      yield 1
      await Bun.sleep(8)
      yield 2
      await Bun.sleep(8)
      yield 3
    }

    const values: number[] = []
    for await (const value of StreamIdle.timeout(stream(), 20, () => {
      throw new Error("active stream should not abort")
    })) {
      values.push(value)
    }

    expect(values).toEqual([1, 2, 3])
  })

  test("bounds a suspended local tool wait", async () => {
    async function* stream() {
      yield "tool-call"
      await new Promise(() => {})
    }
    let aborted = false
    const result = StreamIdle.timeout(
      stream(),
      10,
      () => {
        aborted = true
      },
      (value) => value === "tool-call",
      30,
    )

    expect(await result.next()).toEqual({ done: false, value: "tool-call" })
    const error = await result.next().catch((value) => value)
    expect(aborted).toBe(true)
    expect(MessageV2.StreamIdleTimeoutError.isInstance(error)).toBe(true)
    expect(error.data).toEqual({
      message: "Tool execution produced no result for 30ms",
      timeout: 30,
    })
  })

  test("zero disables the timeout", async () => {
    async function* stream() {
      await Bun.sleep(15)
      yield "done"
    }

    const values = []
    for await (const value of StreamIdle.timeout(stream(), 0, () => {
      throw new Error("disabled timeout should not abort")
    })) {
      values.push(value)
    }

    expect(values).toEqual(["done"])
  })
})
