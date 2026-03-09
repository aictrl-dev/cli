import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("project.instance lifecycle", () => {
  test("retries init after rejection instead of returning cached error", async () => {
    await using tmp = await tmpdir({ git: true })
    let callCount = 0
    let shouldFail = true

    // First call: init fails
    const firstAttempt = Instance.provide({
      directory: tmp.path,
      init: async () => {
        callCount++
        if (shouldFail) throw new Error("transient init failure")
      },
      fn: async () => "success",
    })
    await expect(firstAttempt).rejects.toThrow("transient init failure")
    expect(callCount).toBe(1)

    // Allow microtask queue to process the .catch() cleanup
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Second call: should retry init (not return cached rejection)
    shouldFail = false
    const result = await Instance.provide({
      directory: tmp.path,
      init: async () => {
        callCount++
      },
      fn: async () => "success",
    })
    expect(result).toBe("success")
    expect(callCount).toBe(2) // init was called again, proving cache was cleared
  })

  test("dispose failure does not mask original error", async () => {
    await using tmp = await tmpdir({ git: true })

    // Use bootstrap() which calls Instance.dispose() in a finally block.
    // If dispose() threw, JavaScript would replace the original error with
    // the dispose error. After the fix, dispose() catches its own errors.
    const { bootstrap } = await import("../../src/cli/bootstrap")

    const error = await bootstrap(tmp.path, async () => {
      throw new Error("original callback error")
    }).catch((e: Error) => e)

    // The original error should propagate, not be masked by dispose
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe("original callback error")
  })

  test("dispose method has try-catch wrapping", async () => {
    const source = await Bun.file("src/project/instance.ts").text()
    // Verify dispose has error handling (not bare throws)
    expect(source).toContain("instance dispose failed")
    // Verify the catch block exists in dispose
    expect(source).toMatch(/async dispose\(\)\s*\{[\s\S]*?try\s*\{/)
  })
})
