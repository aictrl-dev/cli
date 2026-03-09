import path from "path"
import { describe, expect, test } from "bun:test"

const PROCESSOR_SRC = path.resolve(import.meta.dir, "../../src/session/processor.ts")

describe("Processor text-end timestamp preservation (DATA-04)", () => {
  test("text-end case uses spread to preserve start timestamp", async () => {
    const source = await Bun.file(PROCESSOR_SRC).text()
    // Extract the text-end case block
    const textEndStart = source.indexOf('case "text-end"')
    expect(textEndStart).toBeGreaterThan(-1)
    const textEndEnd = source.indexOf("currentText = undefined", textEndStart)
    const textEndBlock = source.slice(textEndStart, textEndEnd)

    // Must preserve original start time (either via spread or conditional)
    const preservesStart =
      textEndBlock.includes("...currentText.time") ||
      textEndBlock.includes("currentText.time?.start")
    expect(preservesStart).toBe(true)
  })

  test("text-end case does not overwrite start with Date.now()", async () => {
    const source = await Bun.file(PROCESSOR_SRC).text()
    // Extract the text-end case block
    const textEndStart = source.indexOf('case "text-end"')
    const textEndEnd = source.indexOf("currentText = undefined", textEndStart)
    const textEndBlock = source.slice(textEndStart, textEndEnd)

    // Must NOT contain a bare `start: Date.now()` which would destroy the original start.
    // `start: currentText.time?.start ?? Date.now()` is acceptable (fallback only).
    expect(textEndBlock).not.toMatch(/start:\s*Date\.now\(\)\s*,/)
  })
})
