import { describe, expect, test } from "bun:test"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe("exception handler exit behavior", () => {
  test("uncaughtException handler exits with code 1", async () => {
    // Spawn a minimal script that:
    // 1. Registers the same exception handler pattern as index.ts
    // 2. Throws an uncaught exception
    // 3. Should exit with code 1 (not continue running)
    const script = `
      process.on("uncaughtException", (e) => {
        process.stderr.write(e instanceof Error ? e.stack || e.message : String(e))
        process.exit(1)
      })
      // Throw after a tick to ensure it's truly "uncaught"
      setTimeout(() => {
        throw new Error("test uncaught exception")
      }, 10)
    `
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    })

    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(1)
    expect(stderr).toContain("test uncaught exception")
    // Verify stack trace is preserved
    expect(stderr).toContain("Error:")
  }, 10_000)

  test("unhandledRejection handler exits with code 1", async () => {
    const script = `
      process.on("unhandledRejection", (e) => {
        process.stderr.write(e instanceof Error ? e.stack || e.message : String(e))
        process.exit(1)
      })
      // Create an unhandled rejection
      Promise.reject(new Error("test unhandled rejection"))
    `
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    })

    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(1)
    expect(stderr).toContain("test unhandled rejection")
  }, 10_000)

  test("index.ts exception handlers include process.exit(1)", async () => {
    // Static analysis: ensure handlers include process.exit(1)
    const indexSource = await Bun.file(path.join(__dirname, "../../src/index.ts")).text()

    // Verify both handlers exist and include process.exit(1)
    // Match the pattern: process.on("uncaughtException", ...) block containing process.exit(1)
    expect(indexSource).toContain('process.on("uncaughtException"')
    expect(indexSource).toContain('process.on("unhandledRejection"')

    // Verify process.exit(1) appears after both handlers (crude but effective)
    const uncaughtIdx = indexSource.indexOf('process.on("uncaughtException"')
    const rejectionIdx = indexSource.indexOf('process.on("unhandledRejection"')

    // Find the next process.exit(1) after each handler registration
    const exitAfterUncaught = indexSource.indexOf("process.exit(1)", uncaughtIdx)
    const exitAfterRejection = indexSource.indexOf("process.exit(1)", rejectionIdx)

    // Both should find process.exit(1) within the handler (before the next major block)
    expect(exitAfterUncaught).toBeGreaterThan(uncaughtIdx)
    expect(exitAfterRejection).toBeGreaterThan(rejectionIdx)
    // Handlers are close together, so exit should be within ~200 chars
    expect(exitAfterUncaught - uncaughtIdx).toBeLessThan(200)
    expect(exitAfterRejection - rejectionIdx).toBeLessThan(200)
  })

  test("headless.ts exception handlers include process.exit(1)", async () => {
    const headlessSource = await Bun.file(path.join(__dirname, "../../src/headless.ts")).text()

    expect(headlessSource).toContain('process.on("uncaughtException"')
    expect(headlessSource).toContain('process.on("unhandledRejection"')

    const uncaughtIdx = headlessSource.indexOf('process.on("uncaughtException"')
    const rejectionIdx = headlessSource.indexOf('process.on("unhandledRejection"')

    const exitAfterUncaught = headlessSource.indexOf("process.exit(1)", uncaughtIdx)
    const exitAfterRejection = headlessSource.indexOf("process.exit(1)", rejectionIdx)

    expect(exitAfterUncaught).toBeGreaterThan(uncaughtIdx)
    expect(exitAfterRejection).toBeGreaterThan(rejectionIdx)
    expect(exitAfterUncaught - uncaughtIdx).toBeLessThan(200)
    expect(exitAfterRejection - rejectionIdx).toBeLessThan(200)
  })

  test("exception handlers log stack traces", async () => {
    // Verify the handlers include stack trace logging
    const indexSource = await Bun.file(path.join(__dirname, "../../src/index.ts")).text()
    const headlessSource = await Bun.file(path.join(__dirname, "../../src/headless.ts")).text()

    // Both should log e.stack
    for (const source of [indexSource, headlessSource]) {
      const handlerSection = source.slice(source.indexOf('process.on("unhandledRejection"'), source.indexOf("let cli"))
      expect(handlerSection).toContain("e.stack")
    }
  })
})
