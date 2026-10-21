import { describe, expect, test } from "bun:test"
import path from "path"
import { fileURLToPath } from "url"
import { EOL } from "os"
import ts from "typescript"
import { BashEnvPolicy } from "../../src/util/bash-env-policy"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Execute the source-extracted callbacks with controlled effects. This checks the
// actual handler bodies, not whole-CLI startup or global event delivery.
async function handlers(file: string) {
  const source = ts.createSourceFile(
    file,
    await Bun.file(path.join(__dirname, "../../src", file)).text(),
    ts.ScriptTarget.Latest,
    true,
  )
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    const registrations = source.statements.filter((statement): statement is ts.ExpressionStatement => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
      const call = statement.expression
      return (
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "process" &&
        call.expression.name.text === "on" &&
        !!call.arguments[0] &&
        ts.isStringLiteral(call.arguments[0]) &&
        call.arguments[0].text === event
      )
    })
    expect(registrations).toHaveLength(1)
    const call = registrations[0]?.expression
    if (!call || !ts.isCallExpression(call) || call.arguments.length !== 2) {
      throw new Error(`Expected one module-top process.on callback for ${file}: ${event}`)
    }
    const callback = call.arguments[1]
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
      throw new Error(`Expected an inline callback for ${file}: ${event}`)
    }
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`const handler = ${callback.getText(source)}`)
    const marker = "owned-sensitive-policy-marker"
    let policy: unknown
    try {
      BashEnvPolicy.parse(`["${marker}`)
    } catch (error) {
      policy = error
    }
    expect(policy).toBeInstanceOf(BashEnvPolicy.ConfigError)
    const ordinary = new Error("owned ordinary exception")
    for (const error of [ordinary, policy]) {
      const logs: { event: string; data: Record<string, unknown> }[] = []
      const stderr: string[] = []
      const exits: number[] = []
      const sentinel = new Error("controlled process.exit")
      const handler = new Function("BashEnvPolicy", "Log", "process", "EOL", compiled + "\nreturn handler")(
        BashEnvPolicy,
        { Default: { error: (event: string, data: Record<string, unknown>) => logs.push({ event, data }) } },
        {
          stderr: { write: (value: string) => stderr.push(value) },
          exit: (code: number): never => {
            exits.push(code)
            throw sentinel
          },
        },
        EOL,
      ) as (error: unknown) => void
      let thrown: unknown
      try {
        handler(error)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(sentinel)
      if (error === ordinary) {
        expect(exits).toEqual([1])
        expect(stderr).toEqual([])
        expect(logs).toEqual([
          {
            event: event === "uncaughtException" ? "exception" : "rejection",
            data: { e: ordinary.message, stack: ordinary.stack },
          },
        ])
      } else {
        expect(exits).toEqual([2])
        expect(stderr).toEqual([
          "BASH_ENV_CONFIGURATION: --bash-env-allowlist must be a JSON array of variable names." + EOL,
        ])
        expect(logs).toEqual([])
        expect(JSON.stringify({ stderr, logs })).not.toContain(marker)
      }
    }
  }
}

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
    // Writes the message on its own, as index.ts logs it: under load, Bun sometimes
    // leaves the message out of the first line of the stack of an error created
    // while the script is still being evaluated.
    const script = `
      process.on("unhandledRejection", (e) => {
        process.stderr.write(e instanceof Error ? e.message + "\\n" + e.stack : String(e))
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

  test("index.ts actual callbacks classify ordinary and policy errors", async () => {
    await handlers("index.ts")
  })

  test("headless.ts actual callbacks classify ordinary and policy errors", async () => {
    await handlers("headless.ts")
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
