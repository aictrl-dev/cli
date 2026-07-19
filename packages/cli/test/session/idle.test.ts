import { describe, expect, test } from "bun:test"
import { StreamIdle } from "../../src/session/idle"
import { MessageV2 } from "../../src/session/message-v2"
import { Flag } from "../../src/flag/flag"

describe("model stream idle timeout", () => {
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

describe("AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS", () => {
  test("supports default, override, disable, and invalid fallback", () => {
    const original = process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS

    try {
      delete process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
      expect(Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(300_000)
      process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "1234"
      expect(Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(1234)
      process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "0"
      expect(Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(0)
      process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "invalid"
      expect(Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(300_000)
    } finally {
      if (original === undefined) delete process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
      else process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = original
    }
  })
})
