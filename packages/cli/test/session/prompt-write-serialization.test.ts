import fs from "fs"
import path from "path"
import { describe, expect, test } from "bun:test"

const promptPath = path.resolve(
  import.meta.dirname,
  "../../src/session/prompt.ts",
)
const source = fs.readFileSync(promptPath, "utf-8")

describe("DATA-03: shell stdout/stderr write serialization", () => {
  test("stdout and stderr handlers use promise chain for Session.updatePart", () => {
    // Find the stdout handler section
    const stdoutStart = source.indexOf("proc.stdout?.on")
    const stdoutEnd = source.indexOf("})", stdoutStart)
    const stdoutHandler = source.slice(stdoutStart, stdoutEnd)

    // Find the stderr handler section
    const stderrStart = source.indexOf("proc.stderr?.on")
    const stderrEnd = source.indexOf("})", stderrStart)
    const stderrHandler = source.slice(stderrStart, stderrEnd)

    expect(stdoutHandler).toContain("pending = pending.then")
    expect(stderrHandler).toContain("pending = pending.then")

    // Neither handler should have a bare Session.updatePart call (without pending chain)
    const bareUpdatePattern = /(?<!pending\.then\(\(\) => )Session\.updatePart\(part\)/
    expect(stdoutHandler).not.toMatch(bareUpdatePattern)
    expect(stderrHandler).not.toMatch(bareUpdatePattern)
  })

  test("pending promise is initialized before handlers and awaited before close", () => {
    expect(source).toContain("let pending = Promise.resolve()")

    const pendingInit = source.indexOf("let pending = Promise.resolve()")
    const stdoutHandler = source.indexOf("proc.stdout?.on")
    const awaitPending = source.indexOf("await pending")

    // Ordering: initialization < stdout handler < await
    expect(pendingInit).toBeLessThan(stdoutHandler)
    expect(stdoutHandler).toBeLessThan(awaitPending)
  })

  test("stdout and stderr share the same pending chain variable", () => {
    // Both handlers must reference the same `pending` variable
    const stdoutStart = source.indexOf("proc.stdout?.on")
    const stdoutEnd = source.indexOf("})", stdoutStart)
    const stdoutHandler = source.slice(stdoutStart, stdoutEnd)

    const stderrStart = source.indexOf("proc.stderr?.on")
    const stderrEnd = source.indexOf("})", stderrStart)
    const stderrHandler = source.slice(stderrStart, stderrEnd)

    // Both use `pending = pending.then` (same variable name)
    expect(stdoutHandler).toContain("pending = pending.then")
    expect(stderrHandler).toContain("pending = pending.then")

    // Ensure there is only ONE `let pending` declaration in the shell section
    // (between `let output = ""` and `return { info: msg`)
    const shellSection = source.slice(
      source.indexOf('let output = ""'),
      source.indexOf("return { info: msg, parts: [part] }"),
    )
    const pendingDeclarations = shellSection.match(/let pending\b/g)
    expect(pendingDeclarations).toHaveLength(1)
  })
})
