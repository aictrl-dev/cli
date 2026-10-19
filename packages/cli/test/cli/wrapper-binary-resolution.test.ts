import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

// The npm wrapper (bin/aictrl) is plain Node JS that finds the native binary
// in an @aictrl/cli-<platform>-<arch> package. These tests build install trees
// on disk and run the real wrapper with node against them (#137).

const wrapperSource = path.resolve(import.meta.dir, "../../bin/aictrl")
const wrapperVersion = "9.9.9-wrapper-test"
const staleVersion = "0.0.1-stale-test"

// Calls one of the helpers the wrapper exports when it is required instead of
// run, in the same Node that runs it for users.
async function callWrapper(expression: string) {
  await using tmp = await tmpdir()
  const wrapper = path.join(tmp.path, "aictrl")
  await fs.copyFile(wrapperSource, wrapper)
  const script = `const wrapper = require(process.env.WRAPPER); console.log(JSON.stringify(${expression}) ?? "undefined")`
  const proc = Bun.spawn([Bun.which("node")!, "-e", script], {
    env: { PATH: process.env.PATH!, WRAPPER: wrapper },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  return stdout.trim() === "undefined" ? undefined : JSON.parse(stdout)
}

// The host's platform packages, preferred first, as the wrapper picks them.
// The table tests below pin the mapping itself.
const hostPackages: string[] = await callWrapper(
  `wrapper.platformPackageNames(process.platform, process.arch, process.platform === "linux" ? wrapper.linuxLibc() : undefined)`,
)
const platformPackage = hostPackages[0]

// The package spec the error advises installing: the host's preferred
// package.
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
  // A source checkout. The wrapper never runs it: it needs a platform binary.
  if (options.source) await Bun.write(path.join(packageDir, "src", "index.ts"), "")
  return path.join(packageDir, "bin", "aictrl")
}

// A stub binary that prints which install it came from, so a test can tell
// which candidate the wrapper executed.
async function installPlatformBinary(modulesDir: string, version: unknown, label: string, name = platformPackage) {
  const packageDir = path.join(modulesDir, name)
  const binary = path.join(packageDir, "bin", "aictrl")
  await fs.mkdir(path.dirname(binary), { recursive: true })
  await Bun.write(binary, `#!/bin/sh\necho "ran ${label} $@"\n`)
  await fs.chmod(binary, 0o755)
  if (version)
    await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ name, version }))
  return packageDir
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

  test("names the expected platform package when no binary is installed", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"))

    const result = await runWrapper(wrapper)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`@aictrl/cli ${wrapperVersion} found no aictrl binary of the same version`)
    expect(result.stderr).toContain(`platform package ${platformPackage}@${wrapperVersion}`)
    expect(adviceSpec(result.stderr)).toBe(`${platformPackage}@${wrapperVersion}`)
  })

  test("does not run a source checkout with Bun when no binary is installed", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"), { source: true })

    const result = await runWrapper(wrapper)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`platform package ${platformPackage}@${wrapperVersion}`)
    expect(result.stderr).not.toContain("Cannot find package")
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

  test.skipIf(process.platform !== "linux")("prefers the package for the host's libc when both are installed", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"))
    const modules = path.join(tmp.path, "project", "node_modules")
    await installPlatformBinary(modules, wrapperVersion, "other-libc", hostPackages[1])
    await installPlatformBinary(modules, wrapperVersion, "host-libc", hostPackages[0])

    const result = await runWrapper(wrapper)

    expect(result.stdout).toBe("ran host-libc --version\n")
    expect(result.exitCode).toBe(0)
  })

  test.skipIf(process.platform !== "linux")("runs the other libc package when it is the only one installed", async () => {
    await using tmp = await tmpdir()
    const wrapper = await installWrapper(path.join(tmp.path, "project"))
    await installPlatformBinary(path.join(tmp.path, "project", "node_modules"), wrapperVersion, "other-libc", hostPackages[1])

    const result = await runWrapper(wrapper)

    expect(result.stdout).toBe("ran other-libc --version\n")
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

describe("npm wrapper platform package selection", () => {
  test.each([
    { platform: "linux", arch: "x64", libc: "glibc", names: ["linux-x64-baseline", "linux-x64-baseline-musl"] },
    { platform: "linux", arch: "x64", libc: "musl", names: ["linux-x64-baseline-musl", "linux-x64-baseline"] },
    { platform: "linux", arch: "x64", libc: undefined, names: ["linux-x64-baseline", "linux-x64-baseline-musl"] },
    { platform: "linux", arch: "arm64", libc: "glibc", names: ["linux-arm64", "linux-arm64-musl"] },
    { platform: "linux", arch: "arm64", libc: "musl", names: ["linux-arm64-musl", "linux-arm64"] },
    { platform: "darwin", arch: "x64", libc: undefined, names: ["darwin-x64-baseline"] },
    { platform: "darwin", arch: "arm64", libc: undefined, names: ["darwin-arm64"] },
    { platform: "win32", arch: "x64", libc: undefined, names: ["windows-x64-baseline"] },
  ])("$platform $arch $libc", async ({ platform, arch, libc, names }) => {
    const args = [platform, arch, libc].map((value) => JSON.stringify(value) ?? "undefined").join(", ")

    expect(await callWrapper(`wrapper.platformPackageNames(${args})`)).toEqual(
      names.map((name) => `@aictrl/cli-${name}`),
    )
  })
})

describe("npm wrapper libc detection", () => {
  test.each([
    { name: "Alpine ldd", ldd: "#!/bin/sh\nexec /lib/ld-musl-x86_64.so.1 --list \"$@\"\n", libc: "musl" },
    { name: "glibc ldd", ldd: "#! /bin/bash\n# This file is part of the GNU C Library.\nTEXTDOMAIN=libc\n", libc: "glibc" },
  ])("reads the libc from $name", async ({ ldd, libc }) => {
    await using tmp = await tmpdir()
    const lddPath = path.join(tmp.path, "ldd")
    await Bun.write(lddPath, ldd)

    expect(await callWrapper(`wrapper.linuxLibc(${JSON.stringify(lddPath)})`)).toBe(libc)
  })

  test.skipIf(process.platform !== "linux")("falls back to Node's diagnostic report without ldd", async () => {
    await using tmp = await tmpdir()
    const missing = JSON.stringify(path.join(tmp.path, "no-ldd"))

    const detected = await callWrapper(`wrapper.linuxLibc(${missing})`)

    expect(detected).toBe(await callWrapper("wrapper.libcFromReport(process.report.getReport())"))
    expect(["glibc", "musl"]).toContain(detected)
  })

  test.each([
    { name: "glibc runtime", report: { header: { glibcVersionRuntime: "2.36" }, sharedObjects: [] }, libc: "glibc" },
    {
      name: "musl loader",
      report: { header: {}, sharedObjects: ["/usr/local/bin/node", "/lib/ld-musl-x86_64.so.1"] },
      libc: "musl",
    },
    { name: "neither", report: { header: {}, sharedObjects: ["/usr/local/bin/node"] }, libc: undefined },
    { name: "no report", report: undefined, libc: undefined },
  ])("reads $name from a diagnostic report", async ({ report, libc }) => {
    expect(await callWrapper(`wrapper.libcFromReport(${JSON.stringify(report) ?? "undefined"})`)).toBe(libc)
  })
})
