import path from "path"
import { describe, expect, test } from "bun:test"
import { buildContextWindow } from "../../src/cli/cmd/run"

const EVENTS_MD = path.resolve(import.meta.dir, "../../../../EVENTS.md")

/**
 * Tests for issue #86 — 5-way token breakdown + context-window utilization
 * in message_complete events.
 */
describe("buildContextWindow (#86)", () => {
  // 🟠 regression: limit===0 (custom model default) must return null, not {ratio:Infinity}
  test("returns null when contextLimit is 0 (custom model without registered limit)", () => {
    const result = buildContextWindow(0, 9824)
    expect(result).toBeNull()
  })

  test("returns null when contextLimit is null (Provider.getModel threw)", () => {
    const result = buildContextWindow(null, 9824)
    expect(result).toBeNull()
  })

  test("returns null when both limit and used are 0", () => {
    const result = buildContextWindow(0, 0)
    expect(result).toBeNull()
  })

  test("computes used as the value passed in (caller sets input + cache.read + cache.write)", () => {
    // Regression: cache.write must be included in contextUsed at the call site (run.ts).
    // buildContextWindow receives the pre-summed value; this test verifies the helper
    // honours it (and that the sum is documented correctly: input + cache.read + cache.write).
    const input = 1024
    const cacheRead = 8800
    const cacheWrite = 1024
    const contextUsed = input + cacheRead + cacheWrite // = 10848
    const result = buildContextWindow(200_000, contextUsed)
    expect(result).not.toBeNull()
    expect(result!.used).toBe(10848)
  })

  test("sets limit to the contextLimit value", () => {
    const result = buildContextWindow(200_000, 9824)
    expect(result).not.toBeNull()
    expect(result!.limit).toBe(200_000)
  })

  test("ratio is used / limit", () => {
    const result = buildContextWindow(200_000, 9824)
    expect(result).not.toBeNull()
    expect(result!.ratio).toBeCloseTo(9824 / 200_000, 10)
  })

  test("ratio is between 0 and 1 for realistic values", () => {
    const result = buildContextWindow(128_000, 64_000)
    expect(result).not.toBeNull()
    expect(result!.ratio).toBe(0.5)
  })

  test("ratio is exactly 1 when context is fully used", () => {
    const result = buildContextWindow(100_000, 100_000)
    expect(result).not.toBeNull()
    expect(result!.ratio).toBe(1)
  })

  test("ratio is 0 when no tokens used (empty prompt start)", () => {
    const result = buildContextWindow(200_000, 0)
    expect(result).not.toBeNull()
    expect(result!.ratio).toBe(0)
  })

  test("result is JSON-serialisable without Infinity or NaN", () => {
    const result = buildContextWindow(200_000, 9824)
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain("null")
    const parsed = JSON.parse(serialised)
    expect(parsed.ratio).toBeCloseTo(9824 / 200_000, 10)
  })

  test("top-level null serialises cleanly (not as object with null ratio)", () => {
    // The documented contract: limit unknown → top-level null, not {ratio:null}
    const result = buildContextWindow(0, 9824)
    expect(JSON.stringify(result)).toBe("null")
  })

  test("ratio may exceed 1 when usage exceeds the registered limit (unclamped)", () => {
    // EVENTS.md documents ratio as ≥0 (may exceed 1), not clamped to [0,1].
    // Stale/lowered model.limit.context can produce ratio > 1 in production.
    const result = buildContextWindow(100_000, 110_000)
    expect(result).not.toBeNull()
    expect(result!.ratio).toBeGreaterThan(1)
    expect(result!.ratio).toBeCloseTo(1.1, 10)
  })
})

describe("message_complete emit block shape (source-verified, #86)", () => {
  // These source-text checks verify structural wiring in the emit call site
  // that cannot be covered by pure unit-testing buildContextWindow.
  const RUN_SRC = path.resolve(import.meta.dir, "../../src/cli/cmd/run.ts")

  test("terminal usage helper preserves reasoning and cache read/write fields", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const start = source.indexOf("function terminalUsage(")
    const end = source.indexOf("function glob(", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = source.slice(start, end)
    expect(block).toContain("reasoning")
    expect(block).toContain("cache")
    expect(block).toContain("read")
    expect(block).toContain("write")
  })

  test("emit block calls buildContextWindow (not inline ternary)", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const emitIdx = source.indexOf('emit("message_complete"')
    expect(emitIdx).toBeGreaterThan(-1)
    const blockStart = Math.max(0, emitIdx - 1500)
    const block = source.slice(blockStart, emitIdx + 200)
    expect(block).toContain("buildContextWindow")
  })

  test("emit block includes context field", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const emitIdx = source.indexOf('emit("message_complete"')
    expect(emitIdx).toBeGreaterThan(-1)
    // emit object spans ~400 chars; search up to closing paren
    const block = source.slice(emitIdx, emitIdx + 500)
    expect(block).toContain("context")
  })

  test("cost field is still emitted (not regressed)", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const idx = source.indexOf('emit("message_complete"')
    expect(idx).toBeGreaterThan(-1)
    const block = source.slice(idx, idx + 800)
    expect(block).toContain("cost:")
  })

  test("getModel catch rethrows non-ModelNotFoundError (targeted catch, not swallow-all)", async () => {
    // Verify the catch block only silences ModelNotFoundError; unexpected errors must propagate.
    // Source check: catch body must reference ModelNotFoundError (not be an empty arrow).
    const source = await Bun.file(RUN_SRC).text()
    const getModelIdx = source.indexOf("Provider.getModel(info.providerID")
    expect(getModelIdx).toBeGreaterThan(-1)
    const catchWindow = source.slice(getModelIdx, getModelIdx + 400)
    expect(catchWindow).toContain("ModelNotFoundError")
    expect(catchWindow).toContain("throw e")
  })

  test("contextUsed includes cache.write (regression: must not omit cache.write from context sum)", async () => {
    // Regression for the bug where `contextUsed = tokens.input + tokens.cache.read`
    // omitted cache.write, undercounting first-turn utilization. The fix is:
    //   const contextUsed = tokens.input + tokens.cache.read + tokens.cache.write
    // This source-text check verifies the three-way sum is present at the call site.
    const source = await Bun.file(RUN_SRC).text()
    const contextUsedIdx = source.indexOf("const contextUsed =")
    expect(contextUsedIdx).toBeGreaterThan(-1)
    const line = source.slice(contextUsedIdx, contextUsedIdx + 160)
    expect(line).toContain("cache.write")
  })
})

describe("EVENTS.md documents token breakdown and context (#86)", () => {
  test("EVENTS.md message_complete section includes reasoning token field", async () => {
    const doc = await Bun.file(EVENTS_MD).text()
    const idx = doc.indexOf("message_complete")
    expect(idx).toBeGreaterThan(-1)
    const section = doc.slice(idx, idx + 1500)
    expect(section).toContain("reasoning")
  })

  test("EVENTS.md message_complete section documents context field", async () => {
    const doc = await Bun.file(EVENTS_MD).text()
    const idx = doc.indexOf("message_complete")
    expect(idx).toBeGreaterThan(-1)
    const section = doc.slice(idx, idx + 1500)
    expect(section).toContain("context")
    expect(section).toContain("used")
    expect(section).toContain("limit")
    expect(section).toContain("ratio")
  })

  test("EVENTS.md documents null as the unknown-limit sentinel", async () => {
    const doc = await Bun.file(EVENTS_MD).text()
    const idx = doc.indexOf("### `message_complete`")
    expect(idx).toBeGreaterThan(-1)
    const end = doc.indexOf("### `text`", idx)
    expect(end).toBeGreaterThan(idx)
    const section = doc.slice(idx, end)
    // The documented contract: null = context limit not known
    expect(section).toContain("null")
  })
})
