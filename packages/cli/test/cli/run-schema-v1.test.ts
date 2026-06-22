import path from "path"
import { describe, expect, test } from "bun:test"

const RUN_SRC = path.resolve(import.meta.dir, "../../src/cli/cmd/run.ts")

describe("run.ts v1 schema emissions (#63)", () => {
  test("permission_rejected includes tool, input, callID fields", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const idx = source.indexOf('emit("permission_rejected"')
    expect(idx).toBeGreaterThan(-1)
    const block = source.slice(idx, idx + 500)
    expect(block).toContain("tool:")
    expect(block).toContain("input:")
    expect(block).toContain("callID:")
    expect(block).toContain("permission.permission")
    expect(block).toContain("permission.patterns")
  })

  test("permission_granted is emitted with matching shape", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const idx = source.indexOf('emit("permission_granted"')
    expect(idx).toBeGreaterThan(-1)
    const block = source.slice(idx, idx + 400)
    expect(block).toContain("tool:")
    expect(block).toContain("input:")
    expect(block).toContain("callID:")
  })

  test("session_start emits schemaVersion and permissions", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const idx = source.indexOf('emit("session_start"')
    expect(idx).toBeGreaterThan(-1)
    const block = source.slice(idx, idx + 400)
    expect(block).toContain("schemaVersion: SCHEMA_VERSION")
    expect(block).toContain("permissions:")
  })

  test("session_error is emitted before session_complete on failure", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const errIdx = source.indexOf('emit("session_error"')
    expect(errIdx).toBeGreaterThan(-1)
    expect(errIdx).toBeLessThan(source.lastIndexOf('emit("session_complete"'))
  })

  test("primary session.error events are surfaced as session_error", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const idx = source.indexOf('if (event.type === "session.error")')
    expect(idx).toBeGreaterThan(-1)
    // Bound the window to the *next* event handler so the assertions don't
    // depend on a magic character count that must be bumped as the block grows.
    const after = source.slice(idx + 1)
    const nextHandlerOffset = after.indexOf('if (event.type === "')
    const block = nextHandlerOffset === -1 ? after : after.slice(0, nextHandlerOffset)
    expect(block).toContain("classifySessionError(props.error)")
    expect(block).toContain('emit("session_error"')
    expect(block).toContain('emit("error"')
  })

  test("text / reasoning / tool_use include sequenceNum", async () => {
    const source = await Bun.file(RUN_SRC).text()
    expect(source).toContain("sequenceNum")
    expect(source).toMatch(/Map<string,\s*number>/)
  })
})
