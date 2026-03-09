import path from "path"
import { describe, expect, test } from "bun:test"

const PROCESSOR_SRC = path.resolve(import.meta.dir, "../../src/session/processor.ts")
const PROMPT_SRC = path.resolve(import.meta.dir, "../../src/session/prompt.ts")

describe("SessionSummary.summarize error handling (SESS-03)", () => {
  test("processor.ts summarize call has .catch() handler", async () => {
    const source = await Bun.file(PROCESSOR_SRC).text()
    // Find the summarize call and verify it has .catch()
    const summarizeIdx = source.indexOf("SessionSummary.summarize(")
    expect(summarizeIdx).toBeGreaterThan(-1)
    // Extract a window after the call to check for .catch
    const window = source.slice(summarizeIdx, summarizeIdx + 300)
    expect(window).toMatch(/\.catch\(/)
    expect(window).toMatch(/log\.error/)
  })

  test("prompt.ts summarize call has .catch() handler", async () => {
    const source = await Bun.file(PROMPT_SRC).text()
    // Find the summarize call and verify it has .catch()
    const summarizeIdx = source.indexOf("SessionSummary.summarize(")
    expect(summarizeIdx).toBeGreaterThan(-1)
    // Extract a window after the call to check for .catch
    const window = source.slice(summarizeIdx, summarizeIdx + 300)
    expect(window).toMatch(/\.catch\(/)
    expect(window).toMatch(/log\.error/)
  })

  test("no bare SessionSummary.summarize calls without error handling", async () => {
    // Check both files for any summarize call that ends with just ) and newline (no .catch)
    for (const filePath of [PROCESSOR_SRC, PROMPT_SRC]) {
      const source = await Bun.file(filePath).text()
      const lines = source.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("SessionSummary.summarize(")) {
          // Find the closing of the summarize call and check next non-whitespace content
          let j = i
          let block = ""
          while (j < lines.length && j < i + 10) {
            block += lines[j] + "\n"
            if (block.includes(".catch(")) break
            j++
          }
          expect(block).toContain(".catch(")
        }
      }
    }
  })
})
