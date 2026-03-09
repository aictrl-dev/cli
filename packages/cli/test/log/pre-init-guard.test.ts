import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { Log } from "../../src/util/log"

describe("Log pre-init guard", () => {
  test("default write function does not reference process.stderr", () => {
    // Static analysis: read the source file and verify the default write
    // function (before init is called) does NOT write to process.stderr.
    const src = readFileSync(path.join(import.meta.dirname, "../../src/util/log.ts"), "utf-8")

    // Find the initial `let write = ...` assignment (before any init call).
    // The default write function should be a no-op that returns 0.
    const defaultWriteMatch = src.match(/let write[\s\S]*?= \(_msg: any\) => \{[\s\S]*?\n  \}/)
    expect(defaultWriteMatch).not.toBeNull()

    const defaultWriteBody = defaultWriteMatch![0]
    // The default write body must NOT contain process.stderr
    expect(defaultWriteBody).not.toContain("process.stderr")
    // It should return 0 (silent discard)
    expect(defaultWriteBody).toContain("return 0")
  })

  test("init({ print: true }) explicitly sets up stderr writer", () => {
    // Static analysis: verify that the print path in init() explicitly
    // sets up a write function that uses process.stderr
    const src = readFileSync(path.join(import.meta.dirname, "../../src/util/log.ts"), "utf-8")

    // The init function should have a `if (options.print)` block that sets write
    const printBlock = src.match(/if \(options\.print\) \{[\s\S]*?return\n\s*\}/)
    expect(printBlock).not.toBeNull()

    const printBlockBody = printBlock![0]
    // The print block must set up a stderr writer
    expect(printBlockBody).toContain("process.stderr.write")
    expect(printBlockBody).toContain("write =")
  })

  test("Log.Default.info does not throw before or after init", () => {
    // Log.init() was already called in test preload, but Log.Default.info
    // should never throw regardless of init state. This tests runtime safety.
    expect(() => {
      Log.Default.info("test message from pre-init guard test")
    }).not.toThrow()
  })

  test("after init({ print: true }), Log.Default.info writes to stderr", async () => {
    // Re-init with print mode to verify stderr output
    await Log.init({ print: true, level: "DEBUG" })

    // Capture stderr by temporarily replacing process.stderr.write
    let captured = ""
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: any) => {
      if (typeof chunk === "string") captured += chunk
      return true
    }) as any

    try {
      Log.Default.info("stderr-capture-test")
      expect(captured).toContain("stderr-capture-test")
    } finally {
      process.stderr.write = origWrite
      // Re-init back to file mode for other tests
      await Log.init({ print: false, dev: true, level: "DEBUG" })
    }
  })
})
