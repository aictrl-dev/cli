import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const guard = path.resolve(import.meta.dir, "../fixture/fetch-guard.ts")
const entries = {
  full: path.resolve(import.meta.dir, "../../src/index.ts"),
  lite: path.resolve(import.meta.dir, "../../src/headless.ts"),
}

async function runGuarded(entry: string, args: string[], env: Record<string, string> = {}) {
  await using tmp = await tmpdir()
  const proc = Bun.spawn(["bun", "--preload", guard, "--conditions=browser", entry, ...args], {
    cwd: tmp.path,
    // Config, auth, cache and state live under the fresh tmpdir, so nothing shared can change what loads.
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      AICTRL_TEST_HOME: tmp.path,
      AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000)
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  const report = stderr.match(/FETCH_ATTEMPTS=(.*)/)
  expect(report, stderr).not.toBeNull()
  return { stdout, stderr, exit, attempts: JSON.parse(report![1]) as string[] }
}

describe("startup makes no network requests (#40)", () => {
  test.each(Object.entries(entries))("%s build: --version", async (_, entry) => {
    const result = await runGuarded(entry, ["--version"])
    expect(result.exit, result.stderr).toBe(0)
    expect(result.attempts).toEqual([])
  })

  test("models lists the built-in catalog offline", async () => {
    const result = await runGuarded(entries.full, ["models", "anthropic"], { ANTHROPIC_API_KEY: "test-key" })
    expect(result.exit, result.stderr).toBe(0)
    expect(result.stdout).toContain("anthropic/claude-sonnet-4-5")
    expect(result.attempts).toEqual([])
  }, 30_000)
})
