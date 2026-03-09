import path from "path"
import { describe, expect, test } from "bun:test"

const RUN_SRC = path.resolve(import.meta.dir, "../../src/cli/cmd/run.ts")

describe("run.ts GlobalBus listener race (OPS-05)", () => {
  test("GlobalBus.on is registered before async generator in subscribe", async () => {
    const source = await Bun.file(RUN_SRC).text()
    // Find the subscribe method in the local SDK object
    const subscribeIdx = source.indexOf("async subscribe()")
    expect(subscribeIdx).toBeGreaterThan(-1)
    // Extract the subscribe method body
    const subscribeBody = source.slice(subscribeIdx, subscribeIdx + 600)
    // GlobalBus.on must appear BEFORE the generator definition
    const onIdx = subscribeBody.indexOf('GlobalBus.on("event"')
    const generatorIdx = subscribeBody.indexOf("(async function* ()")
    expect(onIdx).toBeGreaterThan(-1)
    expect(generatorIdx).toBeGreaterThan(-1)
    expect(onIdx).toBeLessThan(generatorIdx)
  })

  test("GlobalBus.off cleanup is still in generator finally block", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const subscribeIdx = source.indexOf("async subscribe()")
    expect(subscribeIdx).toBeGreaterThan(-1)
    const subscribeBody = source.slice(subscribeIdx, subscribeIdx + 800)
    // Generator must still have finally with GlobalBus.off
    expect(subscribeBody).toContain("finally")
    expect(subscribeBody).toMatch(/GlobalBus\.off\("event"/)
  })
})
