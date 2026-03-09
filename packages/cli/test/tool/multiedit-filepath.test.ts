import path from "path"
import { describe, expect, test } from "bun:test"

const MULTIEDIT_SRC = path.resolve(import.meta.dir, "../../src/tool/multiedit.ts")

describe("MultiEdit filePath routing (DATA-01)", () => {
  test("execute loop passes edit.filePath, not params.filePath", async () => {
    const source = await Bun.file(MULTIEDIT_SRC).text()
    // The execute call inside the for-loop must use edit.filePath
    expect(source).toMatch(/filePath:\s*edit\.filePath/)
  })

  test("params.filePath is not used as the filePath argument in EditTool.execute", async () => {
    const source = await Bun.file(MULTIEDIT_SRC).text()
    // Extract the for-loop body where EditTool.execute is called
    const loopStart = source.indexOf("for (const")
    expect(loopStart).toBeGreaterThan(-1)
    const loopBody = source.slice(loopStart, source.indexOf("return {", loopStart))
    // params.filePath must NOT appear as the filePath arg in the execute call
    expect(loopBody).not.toMatch(/filePath:\s*params\.filePath/)
  })
})
