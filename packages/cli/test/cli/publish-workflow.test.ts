import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const workflow = Bun.YAML.parse(
  await Bun.file(path.resolve(import.meta.dir, "../../../../.github/workflows/publish.yml")).text(),
) as {
  jobs: Record<
    string,
    { steps: { name?: string; run?: string }[]; needs?: string; permissions?: Record<string, string> }
  >
}
const steps = workflow.jobs.publish.steps
const guard = steps.find((step) => step.name === "Verify release version before building")!
const smoke = workflow.jobs.smoke.steps.find(
  (step) => step.name === "Smoke test - verify @aictrl/cli installs cleanly via npm",
)!

describe("release version gate", () => {
  test.each([
    { tag: "v0.4.5", code: 0, message: "matches packages/cli/package.json" },
    { tag: "v0.4.4", code: 1, message: "does not match" },
    { tag: "", code: 1, message: "AICTRL_VERSION is empty" },
  ])("tag '$tag'", async ({ tag, code, message }) => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "packages/cli"), { recursive: true })
    await Bun.write(path.join(tmp.path, "packages/cli/package.json"), JSON.stringify({ version: "0.4.5" }))
    const env = path.join(tmp.path, "github-env")
    const proc = Bun.spawn(["bash", "-c", guard.run!], {
      cwd: tmp.path,
      env: { PATH: process.env.PATH, RELEASE_TAG: tag, GITHUB_ENV: env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(exit, stdout).toBe(code)
    expect(stdout).toContain(message)
    expect(steps.indexOf(guard)).toBeLessThan(steps.findIndex((step) => step.name === "Build Packages"))
    if (!code) expect(await Bun.file(env).text()).toBe("AICTRL_VERSION=0.4.5\n")
    else expect(await Bun.file(env).exists()).toBe(false)
  })
})

describe("release install smoke gate", () => {
  test("published package execution has no publishing permissions", () => {
    expect(workflow.jobs.smoke.needs).toBe("publish")
    expect(workflow.jobs.smoke.permissions).toEqual({})
  })
  test.each([
    { name: "immediate availability", failures: 0, error: "ETARGET", version: "0.4.5", code: 0, attempts: 1 },
    { name: "delayed beyond old window", failures: 6, error: "ETARGET", version: "0.4.5", code: 0, attempts: 7 },
    { name: "propagation window expires", failures: 10, error: "ETARGET", version: "0.4.5", code: 1, attempts: 10 },
    {
      name: "invalid package protocols",
      failures: 10,
      error: "EUNSUPPORTEDPROTOCOL",
      version: "0.4.5",
      code: 1,
      attempts: 1,
    },
    { name: "wrong binary installed", failures: 0, error: "ETARGET", version: "0.4.4", code: 1, attempts: 1 },
    { name: "missing binary", failures: 0, error: "ETARGET", version: "missing", code: 1, attempts: 1 },
  ])("$name", async ({ failures, error, version, code, attempts }) => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    await Bun.write(
      path.join(bin, "npm"),
      `#!/bin/bash
set -euo pipefail
if [ "$1" = init ]; then exit 0; fi
count=0
if [ -f "$FIXTURE_ROOT/count" ]; then count=$(cat "$FIXTURE_ROOT/count"); fi
count=$((count + 1))
echo "$count" > "$FIXTURE_ROOT/count"
if [ "$count" -le "$FIXTURE_FAILURES" ]; then echo "$FIXTURE_ERROR"; exit 1; fi
mkdir -p node_modules/.bin
if [ "$FIXTURE_VERSION" = missing ]; then exit 0; fi
cat > node_modules/.bin/aictrl <<'BIN'
#!/bin/sh
printf '%s' "$FIXTURE_VERSION"
BIN
chmod +x node_modules/.bin/aictrl
`,
    )
    await Bun.write(
      path.join(bin, "sleep"),
      `#!/bin/sh
echo "$1" >> "$FIXTURE_ROOT/sleeps"
`,
    )
    await Promise.all([fs.chmod(path.join(bin, "npm"), 0o755), fs.chmod(path.join(bin, "sleep"), 0o755)])
    const proc = Bun.spawn(["bash", "-c", smoke.run!], {
      cwd: tmp.path,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: tmp.path,
        RELEASE_TAG: "v0.4.5",
        FIXTURE_ROOT: tmp.path,
        FIXTURE_FAILURES: String(failures),
        FIXTURE_ERROR: error,
        FIXTURE_VERSION: version,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(exit, stdout).toBe(code)
    if (version === "missing") expect(stdout).toContain("::error::Installed CLI binary could not run")
    expect(await Bun.file(path.join(tmp.path, "count")).text()).toBe(`${attempts}\n`)
    const sleeps = Bun.file(path.join(tmp.path, "sleeps"))
    if (attempts === 1) expect(await sleeps.exists()).toBe(false)
    else {
      const delays = (await sleeps.text()).trim().split("\n").map(Number)
      expect(delays).toEqual([30, ...Array(attempts - 2).fill(60)])
      if (attempts === 10) expect(delays.reduce((sum, value) => sum + value, 0)).toBe(510)
    }
  })
})
