import { describe, expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

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
      process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "1e3"
      expect(Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(300_000)
      process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "0x10"
      expect(Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(300_000)
      process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "2147483647"
      expect(Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(2_147_483_647)
      process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "2147483648"
      expect(Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(300_000)
      process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "9007199254740992"
      expect(Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS).toBe(300_000)
    } finally {
      if (original === undefined) delete process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
      else process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = original
    }
  })
})
