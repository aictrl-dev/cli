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
})
