import path from "path"
import { describe, expect, test } from "bun:test"

const BUS_SRC = path.resolve(import.meta.dir, "../../src/bus/index.ts")

describe("Bus.publish subscriber isolation (SESS-04)", () => {
  test("each subscriber call is wrapped with .catch for error isolation", async () => {
    const source = await Bun.file(BUS_SRC).text()
    // The publish function must wrap subscriber calls with Promise.resolve().catch()
    expect(source).toMatch(/Promise\.resolve\(sub\(payload\)\)\.catch/)
    // Must log the error, not silently swallow
    expect(source).toMatch(/log\.error\("subscriber failed"/)
  })

  test("publish does not use bare Promise.all without subscriber isolation", async () => {
    const source = await Bun.file(BUS_SRC).text()
    // Extract the publish function body
    const publishStart = source.indexOf("export async function publish")
    expect(publishStart).toBeGreaterThan(-1)
    const publishEnd = source.indexOf("\n  }", publishStart)
    const publishBody = source.slice(publishStart, publishEnd)
    // Must NOT have bare push of sub(payload) without .catch
    expect(publishBody).not.toMatch(/pending\.push\(sub\(payload\)\)/)
  })
})
