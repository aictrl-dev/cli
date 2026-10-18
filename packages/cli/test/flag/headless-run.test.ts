import { afterEach, describe, expect, test } from "bun:test"
import { HeadlessRun } from "../../src/flag/headless-run"

describe("HeadlessRun", () => {
  afterEach(() => {
    HeadlessRun.disable()
    delete process.env.AICTRL_HEADLESS_RUN
  })

  test("is off until the run command enables it, and off again once disabled", () => {
    expect(HeadlessRun.enabled()).toBe(false)
    HeadlessRun.enable()
    expect(HeadlessRun.enabled()).toBe(true)
    HeadlessRun.disable()
    expect(HeadlessRun.enabled()).toBe(false)
  })

  test("the environment cannot mark a process as a headless run", () => {
    // A run's child processes and stray shell exports must not inherit the mark.
    process.env.AICTRL_HEADLESS_RUN = "true"
    expect(HeadlessRun.enabled()).toBe(false)
  })
})
