import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { tmpdir } from "../fixture/fixture"

// The npm wrapper (bin/aictrl) is plain Node JS that finds the native binary
// in an @aictrl/cli-<platform>-<arch> package. These tests build install trees
// on disk and run the real wrapper with node against them (#137).

const wrapperSource = path.resolve(import.meta.dir, "../../bin/aictrl")
const wrapperVersion = "9.9.9-wrapper-test"
const staleVersion = "0.0.1-stale-test"

// Mirrors the wrapper's platform/arch naming. The plain <platform>-<arch>
// package is a candidate on every host, whatever the musl/baseline variant.
const platformName = ({ darwin: "darwin", linux: "linux", win32: "windows" } as Record<string, string>)[os.platform()]
const platformPackage = `@aictrl/cli-${platformName ?? os.platform()}-${os.arch()}`

async function installWrapper(projectDir: string) {
  const packageDir = path.join(projectDir, "node_modules", "@aictrl", "cli")
  await fs.mkdir(path.join(packageDir, "bin"), { recursive: true })
  await fs.copyFile(wrapperSource, path.join(packageDir, "bin", "aictrl"))
  await Bun.write(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@aictrl/cli", version: wrapperVersion }),
  )
  return path.join(packageDir, "bin", "aictrl")
}

// A stub binary that prints which install it came from, so a test can tell
// which candidate the wrapper executed.
async function installPlatformBinary(modulesDir: string, version: string | undefined, label: string) {
  const packageDir = path.join(modulesDir, platformPackage)
  const binary = path.join(packageDir, "bin", "aictrl")
  await fs.mkdir(path.dirname(binary), { recursive: true })
  await Bun.write(binary, `#!/bin/sh\necho "ran ${label} $@"\n`)
  await fs.chmod(binary, 0o755)
  if (version)
    await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name: platformPackage, version }))
  return packageDir
}

async function runWrapper(wrapper: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["node", wrapper, "--version"], {
    env: { PATH: process.env.PATH, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe.skipIf(process.platform === "win32")("npm wrapper platform binary resolution", () => {
  test("refuses a stale binary in an ancestor node_modules and explains how to fix it", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"))
    const stale = await installPlatformBinary(path.join(tmp.path, "node_modules"), staleVersion, "stale-ancestor")

    const result = await runWrapper(wrapper)

    expect(result.stdout).not.toContain("ran stale-ancestor")
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`@aictrl/cli ${wrapperVersion}`)
    expect(result.stderr).toContain(`${platformPackage}@${staleVersion} at ${stale}`)
    expect(result.stderr).toContain(`npm install ${platformPackage}@${wrapperVersion}`)
  })

  test("refuses a platform package without a readable version", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"))
    const unversioned = await installPlatformBinary(path.join(tmp.path, "node_modules"), undefined, "unversioned")

    const result = await runWrapper(wrapper)

    expect(result.stdout).not.toContain("ran unversioned")
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`${platformPackage}@unknown at ${unversioned}`)
  })

  test("runs a matching binary found in an ancestor node_modules", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"))
    await installPlatformBinary(path.join(tmp.path, "node_modules"), wrapperVersion, "matching-ancestor")

    const result = await runWrapper(wrapper)

    expect(result.stdout).toBe("ran matching-ancestor --version\n")
    expect(result.exitCode).toBe(0)
  })

  test("skips a stale binary to reach a matching one higher in the tree", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"))
    await installPlatformBinary(path.join(tmp.path, "project", "node_modules"), staleVersion, "stale-own-tree")
    await installPlatformBinary(path.join(tmp.path, "node_modules"), wrapperVersion, "matching-ancestor")

    const result = await runWrapper(wrapper)

    expect(result.stdout).toBe("ran matching-ancestor --version\n")
    expect(result.exitCode).toBe(0)
  })

  test("prefers the matching binary in the wrapper's own install tree over an ancestor", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"))
    await installPlatformBinary(path.join(tmp.path, "project", "node_modules"), wrapperVersion, "own-tree")
    await installPlatformBinary(path.join(tmp.path, "node_modules"), wrapperVersion, "matching-ancestor")

    const result = await runWrapper(wrapper)

    expect(result.stdout).toBe("ran own-tree --version\n")
    expect(result.exitCode).toBe(0)
  })

  test("AICTRL_BIN_PATH runs the chosen binary without a version check", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"))
    const stale = await installPlatformBinary(path.join(tmp.path, "elsewhere"), staleVersion, "explicit")

    const result = await runWrapper(wrapper, { AICTRL_BIN_PATH: path.join(stale, "bin", "aictrl") })

    expect(result.stdout).toBe("ran explicit --version\n")
    expect(result.exitCode).toBe(0)
  })
})
