import { describe, expect, test } from "bun:test"
import path from "path"

const ENTRY = path.resolve(import.meta.dir, "../../src/index.ts")
const HEADLESS_ENTRY = path.resolve(import.meta.dir, "../../src/headless.ts")

function invoke(...args: string[]) {
  return invokeEntry(ENTRY, ...args)
}

async function invokeEntry(entry: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", "run", "--conditions=browser", entry, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exit }
}

describe("removed commands (#188)", () => {
  test.each([
    ["github", ["github", "install"]],
    ["github", ["github", "run", "--event", "issue_comment", "--token=abc"]],
    ["pr", ["pr", "123"]],
    ["pr", ["pr"]],
    ["github", ["github", "--help"]],
    ["pr", ["pr", "--version"]],
    ["github", ["github", "-h"]],
    ["pr", ["pr", "-v"]],
  ])("aictrl %s fails with a pointer to aictrl run", async (name, args) => {
    const { stderr, exit } = await invoke(...args)
    expect(exit).toBe(1)
    expect(stderr).toContain(`\`aictrl ${name}\` was removed. Run \`aictrl run\` in your own workflow instead.`)
  })

  test("help no longer lists them", async () => {
    const { stdout } = await invoke("--help")
    expect(stdout).toContain("aictrl run")
    expect(stdout).not.toMatch(/aictrl (github|pr)\b/)
  })
})

describe("removed acp command (#190)", () => {
  const MESSAGE = "`aictrl acp` was removed. aictrl is headless-only; drive it with `aictrl run` instead."

  test.each([
    ["index", ENTRY, ["acp"]],
    ["index", ENTRY, ["acp", "--cwd", "/tmp"]],
    ["index", ENTRY, ["acp", "--help"]],
    ["headless", HEADLESS_ENTRY, ["acp"]],
    ["headless", HEADLESS_ENTRY, ["acp", "--cwd", "/tmp"]],
    ["headless", HEADLESS_ENTRY, ["acp", "--help"]],
  ])("%s entry: aictrl %p fails with a removal message", async (_name, entry, args) => {
    const { stderr, exit } = await invokeEntry(entry, ...args)
    expect(exit).toBe(1)
    expect(stderr).toContain(MESSAGE)
  })

  test.each([
    ["index", ENTRY],
    ["headless", HEADLESS_ENTRY],
  ])("%s entry: help no longer lists acp", async (_name, entry) => {
    const { stdout } = await invokeEntry(entry, "--help")
    expect(stdout).toContain("aictrl run")
    expect(stdout).not.toMatch(/aictrl acp\b/)
  })
})
