import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const workflow = Bun.YAML.parse(
  await Bun.file(path.resolve(import.meta.dir, "../../../../.github/workflows/publish.yml")).text(),
) as {
  jobs: Record<
    string,
    {
      steps: { name?: string; id?: string; run?: string; env?: Record<string, string> }[]
      needs?: string
      permissions?: Record<string, string>
      outputs?: Record<string, string>
    }
  >
}
const steps = workflow.jobs.publish.steps
const guard = steps.find((step) => step.name === "Verify release version before building")!
const smoke = workflow.jobs.smoke.steps.find(
  (step) => step.name === "Smoke test - verify @aictrl/cli installs cleanly via npm",
)!
const manifest = steps.find((step) => step.id === "manifest")!
const visibility = workflow.jobs.smoke.steps.find(
  (step) => step.name === "Wait for every platform package to be visible on npm",
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

describe("platform package manifest", () => {
  test("lists the built platform packages in optionalDependencies and the job output", async () => {
    await using tmp = await tmpdir()
    const cli = path.join(tmp.path, "packages/cli")
    await Bun.write(path.join(tmp.path, "LICENSE"), "MIT License\n")
    await Bun.write(
      path.join(cli, "package.json"),
      JSON.stringify({ name: "@aictrl/cli", version: "0.5.3", dependencies: { zod: "catalog:" } }),
    )
    const built = ["@aictrl/cli-linux-x64-baseline", "@aictrl/cli-linux-x64-baseline-musl", "@aictrl/cli-darwin-arm64"]
    for (const name of built) {
      await Bun.write(path.join(cli, "dist", name, "package.json"), JSON.stringify({ name, version: "0.5.3" }))
    }
    const output = path.join(tmp.path, "github-output")
    const proc = Bun.spawn(["bash", "-c", manifest.run!], {
      cwd: cli,
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(exit, stderr).toBe(0)

    const pkg = await Bun.file(path.join(cli, "package.json")).json()
    expect(Object.keys(pkg.optionalDependencies).sort()).toEqual([...built].sort())
    expect(pkg.dependencies).toBeUndefined()
    expect(await Bun.file(path.join(cli, "LICENSE")).text()).toBe("MIT License\n")
    const line = (await Bun.file(output).text()).trim()
    expect(line).toStartWith("platform_packages=")
    expect(line.slice("platform_packages=".length).split(" ").sort()).toEqual([...built].sort())
    expect(workflow.jobs.publish.outputs?.platform_packages).toBe("${{ steps.manifest.outputs.platform_packages }}")
  })
})

describe("platform package visibility gate", () => {
  const packages = ["@aictrl/cli-linux-x64-baseline", "@aictrl/cli-linux-x64-baseline-musl", "@aictrl/cli-darwin-arm64"]

  test("runs before the install smoke and reads the publish job's package list", () => {
    const smokeSteps = workflow.jobs.smoke.steps
    expect(smokeSteps.indexOf(visibility)).toBeGreaterThanOrEqual(0)
    expect(smokeSteps.indexOf(visibility)).toBeLessThan(smokeSteps.indexOf(smoke))
    expect(visibility.env?.PLATFORM_PACKAGES).toBe("${{ needs.publish.outputs.platform_packages }}")
  })

  test.each([
    { name: "every package visible at once", lag: {}, list: packages, code: 0, attempts: 1 },
    { name: "one package lags two attempts", lag: { "@aictrl/cli-darwin-arm64": 2 }, list: packages, code: 0, attempts: 3 },
    { name: "a package never appears", lag: { "@aictrl/cli-linux-x64-baseline-musl": 99 }, list: packages, code: 1, attempts: 10 },
    { name: "an older version is the only one visible", lag: {}, stale: true, list: packages, code: 1, attempts: 10 },
    { name: "no package list from the publish job", lag: {}, list: [], code: 1, attempts: 0 },
  ])("$name", async ({ lag, stale, list, code, attempts }) => {
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, "bin")
    await fs.mkdir(bin)
    // `npm view <name>@<version> version` prints the version once the
    // package has been asked for more times than its lag.
    await Bun.write(
      path.join(bin, "npm"),
      `#!/bin/bash
set -euo pipefail
spec="$2"
name="\${spec%@*}"
file="$FIXTURE_ROOT/calls-$(echo "$name" | tr '/@' '__')"
count=0
if [ -f "$file" ]; then count=$(cat "$file"); fi
count=$((count + 1))
echo "$count" > "$file"
echo "$spec" >> "$FIXTURE_ROOT/views"
lag=$(node -p "JSON.parse(process.env.FIXTURE_LAG)[process.argv[1]] ?? 0" "$name")
if [ "$count" -le "$lag" ]; then echo "npm error code E404" >&2; exit 1; fi
if [ -n "\${FIXTURE_STALE:-}" ]; then echo "0.5.2"; else echo "\${spec##*@}"; fi
`,
    )
    await Bun.write(path.join(bin, "sleep"), `#!/bin/sh\necho "$1" >> "$FIXTURE_ROOT/sleeps"\n`)
    await Promise.all([fs.chmod(path.join(bin, "npm"), 0o755), fs.chmod(path.join(bin, "sleep"), 0o755)])

    const proc = Bun.spawn(["bash", "-c", visibility.run!], {
      cwd: tmp.path,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RELEASE_TAG: "v0.5.3",
        PLATFORM_PACKAGES: list.join(" "),
        FIXTURE_ROOT: tmp.path,
        FIXTURE_LAG: JSON.stringify(lag),
        FIXTURE_STALE: stale ? "1" : "",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(exit, stdout).toBe(code)

    const views = Bun.file(path.join(tmp.path, "views"))
    if (attempts === 0) {
      expect(await views.exists()).toBe(false)
      expect(stdout).toContain("::error::The publish job reported no platform packages")
      return
    }
    const viewed = (await views.text()).trim().split("\n")
    expect(viewed).toHaveLength(attempts * list.length)
    expect(new Set(viewed)).toEqual(new Set(list.map((name) => `${name}@0.5.3`)))
    const sleeps = Bun.file(path.join(tmp.path, "sleeps"))
    if (attempts === 1) expect(await sleeps.exists()).toBe(false)
    else {
      const delays = (await sleeps.text()).trim().split("\n").map(Number)
      expect(delays).toEqual([30, ...Array(attempts - 2).fill(60)])
    }
    if (code === 0) expect(stdout).toContain(`All ${list.length} platform packages are visible at 0.5.3 on attempt ${attempts}`)
    else {
      const missing = stale ? list : Object.keys(lag)
      expect(stdout).toContain(`::error::Platform packages not visible at 0.5.3 after 10 attempts: ${missing.join(" ")}`)
    }
  })
})
