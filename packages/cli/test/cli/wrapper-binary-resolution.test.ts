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

// The package spec the error advises installing. It names the host's
// preferred variant (plain, -baseline or -musl).
function adviceSpec(stderr: string) {
  return stderr.match(/npm install "([^"]+)"/)?.[1]
}

async function installWrapper(projectDir: string, options: { versioned?: boolean; source?: boolean } = {}) {
  const packageDir = path.join(projectDir, "node_modules", "@aictrl", "cli")
  await fs.mkdir(path.join(packageDir, "bin"), { recursive: true })
  await fs.copyFile(wrapperSource, path.join(packageDir, "bin", "aictrl"))
  if (options.versioned !== false) {
    await Bun.write(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@aictrl/cli", version: wrapperVersion }),
    )
  }
  // A source checkout, which makes the wrapper fall back to running with Bun.
  if (options.source) await Bun.write(path.join(packageDir, "src", "index.ts"), "")
  return path.join(packageDir, "bin", "aictrl")
}

// A stub binary that prints which install it came from, so a test can tell
// which candidate the wrapper executed.
async function installPlatformBinary(modulesDir: string, version: unknown, label: string) {
  const packageDir = path.join(modulesDir, platformPackage)
  const binary = path.join(packageDir, "bin", "aictrl")
  await fs.mkdir(path.dirname(binary), { recursive: true })
  await Bun.write(binary, `#!/bin/sh\necho "ran ${label} $@"\n`)
  await fs.chmod(binary, 0o755)
  if (version)
    await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name: platformPackage, version }))
  return packageDir
}

// A PATH holding only node, so the wrapper's Bun fallback fails with ENOENT.
async function nodeOnlyPath(dir: string) {
  const bin = path.join(dir, "node-only-bin")
  await fs.mkdir(bin)
  await fs.symlink(Bun.which("node")!, path.join(bin, "node"))
  return bin
}

async function runWrapper(wrapper: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([Bun.which("node")!, wrapper, "--version"], {
    env: { PATH: process.env.PATH!, ...env },
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
    expect(adviceSpec(result.stderr)).toStartWith("@aictrl/cli-")
    expect(adviceSpec(result.stderr)).toEndWith(`@${wrapperVersion}`)
  })

  test("strips control, bidi and zero-width characters from a skipped package's version", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"))
    const spoofed = "0.0.1\u001b]8;;https://example.invalid\u0007‮​⁦﻿\nnpm install spoofed"
    await installPlatformBinary(path.join(tmp.path, "node_modules"), spoofed, "spoofed")

    const result = await runWrapper(wrapper)

    expect(result.exitCode).toBe(1)
    for (const hidden of ["\u001b", "\u0007", "‮", "​", "⁦", "﻿", "\nnpm install spoofed"]) {
      expect(result.stderr).not.toContain(hidden)
    }
    expect(result.stderr).toContain(`${platformPackage}@0.0.1]8;;https://example.invalidnpm install spoofed at`)
  })

  test("refuses every binary when the wrapper's own version is unreadable, without unpinned advice", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"), { versioned: false })
    await installPlatformBinary(path.join(tmp.path, "project", "node_modules"), wrapperVersion, "unverifiable")

    const result = await runWrapper(wrapper)

    expect(result.stdout).not.toContain("ran unverifiable")
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Could not read the @aictrl/cli version from")
    expect(result.stderr).not.toContain("npm install")
  })

  test("the Bun-missing hint of a source checkout pins the platform packages", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"), { source: true })

    const result = await runWrapper(wrapper, { PATH: await nodeOnlyPath(tmp.path) })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`No platform binary matching @aictrl/cli ${wrapperVersion} was found`)
    expect(result.stderr).toContain("Bun is not installed")
    expect(result.stderr).toContain(`"${platformPackage}@${wrapperVersion}"`)
    expect(result.stderr).not.toMatch(/"@aictrl\/cli-[^"@]+"/)
  })

  test("the Bun-missing hint gives no install advice when the wrapper's own version is unreadable", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"), { versioned: false, source: true })

    const result = await runWrapper(wrapper, { PATH: await nodeOnlyPath(tmp.path) })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Bun is not installed")
    expect(result.stderr).toContain("Could not read the @aictrl/cli version from")
    expect(result.stderr).not.toContain("@aictrl/cli-")
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
