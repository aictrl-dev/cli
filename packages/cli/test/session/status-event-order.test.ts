import path from "path"
import { describe, expect, test } from "bun:test"

const STATUS_SRC = path.resolve(import.meta.dir, "../../src/session/status.ts")

describe("SessionStatus.set() event ordering (DATA-02)", () => {
  test("state mutation appears before Bus.publish", async () => {
    const source = await Bun.file(STATUS_SRC).text()
    // Extract the set function body
    const setStart = source.indexOf("export function set(")
    expect(setStart).toBeGreaterThan(-1)
    const setEnd = source.indexOf("\n  }", setStart)
    const setBody = source.slice(setStart, setEnd)

    // State mutation (delete or assignment) must appear before Bus.publish
    const stateMutationIdx = Math.min(
      setBody.indexOf("delete state()"),
      setBody.indexOf("state()[sessionID] = status"),
    )
    const busPublishIdx = setBody.indexOf("Bus.publish")
    expect(stateMutationIdx).toBeGreaterThan(-1)
    expect(busPublishIdx).toBeGreaterThan(-1)
    expect(stateMutationIdx).toBeLessThan(busPublishIdx)
  })

  test("idle branch deletes state before publishing Idle event", async () => {
    const source = await Bun.file(STATUS_SRC).text()
    const setStart = source.indexOf("export function set(")
    const setEnd = source.indexOf("\n  }", setStart)
    const setBody = source.slice(setStart, setEnd)

    const deleteIdx = setBody.indexOf("delete state()[sessionID]")
    const idlePublishIdx = setBody.indexOf("Bus.publish(Event.Idle")
    expect(deleteIdx).toBeGreaterThan(-1)
    expect(idlePublishIdx).toBeGreaterThan(-1)
    expect(deleteIdx).toBeLessThan(idlePublishIdx)
  })
})
