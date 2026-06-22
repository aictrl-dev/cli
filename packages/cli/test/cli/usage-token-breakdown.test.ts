import path from "path"
import { describe, expect, test } from "bun:test"

const RUN_SRC = path.resolve(import.meta.dir, "../../src/cli/cmd/run.ts")
const EVENTS_MD = path.resolve(import.meta.dir, "../../../../EVENTS.md")

/**
 * Tests for issue #86 — 5-way token breakdown + context-window utilization
 * in message_complete events.
 */
describe("message_complete token breakdown (#86)", () => {
  test("message_complete emit block passes tokens with reasoning and cache read/write", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const emitIdx = source.indexOf('emit("message_complete"')
    expect(emitIdx).toBeGreaterThan(-1)
    // Look back up to 1500 chars before the emit call to capture variable setup,
    // and up to 200 chars after.
    const blockStart = Math.max(0, emitIdx - 1500)
    const block = source.slice(blockStart, emitIdx + 200)

    // The tokens object must surface all 5 fields from MessageV2.Assistant.tokens
    expect(block).toContain("tokens")
    // reasoning must be present (not dropped)
    expect(block).toContain("reasoning")
    // cache read and write must both be present
    expect(block).toContain("cache")
    expect(block).toContain("read")
    expect(block).toContain("write")
  })

  test("message_complete emit block includes context with used, limit, ratio", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const emitIdx = source.indexOf('emit("message_complete"')
    expect(emitIdx).toBeGreaterThan(-1)
    const blockStart = Math.max(0, emitIdx - 1500)
    const block = source.slice(blockStart, emitIdx + 200)

    expect(block).toContain("context")
    expect(block).toContain("used")
    expect(block).toContain("limit")
    expect(block).toContain("ratio")
  })

  test("context.used is computed as input + cache.read", async () => {
    const source = await Bun.file(RUN_SRC).text()
    // Should have a computation that adds input and cache.read
    // Accept either inline or extracted variable form
    expect(source).toMatch(/input\s*\+\s*.*cache.*read|cache.*read.*\+\s*input/)
  })

  test("context.limit is sourced from Provider.getModel context limit", async () => {
    const source = await Bun.file(RUN_SRC).text()
    // Must call Provider.getModel (or equivalent) to get the model's context limit
    expect(source).toMatch(/Provider\.getModel|limit\.context|contextLimit/)
  })

  test("context.ratio is used / limit", async () => {
    const source = await Bun.file(RUN_SRC).text()
    // ratio must be a division of used by limit
    expect(source).toMatch(/ratio.*\/|\/.*ratio|used\s*\/\s*limit|contextLimit/)
  })

  test("cost is still emitted in message_complete (not regressed)", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const idx = source.indexOf('emit("message_complete"')
    expect(idx).toBeGreaterThan(-1)
    const block = source.slice(idx, idx + 800)
    // cost must remain — sourced from info.cost (real per-step accumulation)
    expect(block).toContain("cost:")
  })
})

describe("EVENTS.md documents token breakdown and context (#86)", () => {
  test("EVENTS.md message_complete section includes reasoning token field", async () => {
    const doc = await Bun.file(EVENTS_MD).text()
    // Find the message_complete section
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
})
