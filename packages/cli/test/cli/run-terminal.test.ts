import { describe, expect, test } from "bun:test"
import { terminal } from "../../src/cli/cmd/run.terminal"

describe("run terminal events", () => {
  test("error precedes completion and each event is emitted once", () => {
    const events: string[] = []
    const output = terminal((type) => events.push(type))

    output.error({})
    output.error({})
    output.complete({})
    output.complete({})

    expect(events).toEqual(["session_error", "session_complete"])
  })

  test("error cannot be emitted after completion", () => {
    const events: string[] = []
    const output = terminal((type) => events.push(type))

    output.complete({})
    output.error({})

    expect(events).toEqual(["session_complete"])
  })
})
