import { describe, expect, test } from "bun:test"
import path from "path"

const ENTRY = path.resolve(import.meta.dir, "../../src/index.ts")

async function invoke(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", "--conditions=browser", ENTRY, ...args], { stdout: "pipe", stderr: "pipe" })
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
