import path from "path"
import { describe, expect, test } from "bun:test"

const EVENTS_CMD_SRC = path.resolve(import.meta.dir, "../../src/cli/cmd/events.ts")

describe("aictrl events (#63)", () => {
  test("EventsCommand module exists", async () => {
    const source = await Bun.file(EVENTS_CMD_SRC).text()
    expect(source).toContain("export const EventsCommand")
    expect(source).toContain("schema-version")
    expect(source).toContain('"1"')
  })
})
