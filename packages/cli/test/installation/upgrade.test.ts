import { expect, spyOn, test } from "bun:test"
import { Installation } from "../../src/installation"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"

// Every test pins the binary location or stubs the installation calls, so none of them can reach
// a real package-manager install or depend on where this machine's runtime lives.
const STANDALONE = "/home/u/.local/bin/aictrl"
const PNPM_MANAGED = "/home/u/.local/bin/global/5/node_modules/@aictrl/cli-linux-x64/bin/aictrl"

function stubFetch(body: unknown) {
  const urls: string[] = []
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input))
    return new Response(JSON.stringify(body))
  }) as typeof fetch)
  return { urls, spy }
}

test("standalone binary upgrade fails without running a remote installer", async () => {
  const error = await Installation.upgrade("curl", "9.9.9", STANDALONE).catch((error) => error)
  expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
  expect(error.data.stderr).toContain("npm install -g @aictrl/cli@9.9.9")
})

test("only binaries outside a node_modules tree count as standalone", () => {
  expect(Installation.isStandalone("/home/u/.aictrl/bin/aictrl")).toBe(true)
  expect(Installation.isStandalone(STANDALONE)).toBe(true)
  // pnpm with PNPM_HOME=~/.local/bin keeps global packages under that directory
  expect(Installation.isStandalone(PNPM_MANAGED)).toBe(false)
  expect(Installation.isStandalone("/usr/lib/node_modules/@aictrl/cli-linux-x64/bin/aictrl")).toBe(false)
})

test("a standalone binary has no package manager to upgrade through", async () => {
  let probed = false
  const managed = await Installation.standaloneUpgradeMethod(STANDALONE, async () => {
    probed = true
    return "npm"
  })
  expect(managed).toBeUndefined()
  expect(probed).toBe(false)
})

test("a curl-detected binary inside a package manager tree upgrades through that package manager", async () => {
  expect(await Installation.standaloneUpgradeMethod(PNPM_MANAGED, async () => "pnpm")).toBe("pnpm")
  expect(await Installation.standaloneUpgradeMethod(PNPM_MANAGED, async () => "unknown")).toBeUndefined()
})

test("latest version for a standalone binary comes from the public npm registry", async () => {
  const { urls, spy } = stubFetch({ version: "9.9.9" })
  try {
    expect(await Installation.latest("curl")).toBe("9.9.9")
  } finally {
    spy.mockRestore()
  }
  expect(urls).toHaveLength(1)
  // A fixed origin: a project .npmrc must not redirect version resolution for standalone binaries
  expect(urls[0].startsWith("https://registry.npmjs.org/@aictrl/cli/")).toBe(true)
})

test("latest rejects a registry answer without a valid version", async () => {
  for (const body of [{}, { version: "" }, { version: "1.2.3; echo" }, { version: "latest" }]) {
    const { spy } = stubFetch(body)
    try {
      await expect(Installation.latest("curl")).rejects.toThrow("returned no valid version")
    } finally {
      spy.mockRestore()
    }
  }
})

test("aictrl upgrade without a version stops before resolving one for a standalone binary", async () => {
  const standalone = spyOn(Installation, "standaloneUpgradeMethod").mockResolvedValue(undefined)
  const latest = spyOn(Installation, "latest").mockRejectedValue(new Error("must not be called"))
  const upgrade = spyOn(Installation, "upgrade").mockResolvedValue(undefined)
  try {
    await UpgradeCommand.handler({ method: "curl" })
    expect(standalone).toHaveBeenCalled()
    expect(latest).not.toHaveBeenCalled()
    expect(upgrade).not.toHaveBeenCalled()
  } finally {
    standalone.mockRestore()
    latest.mockRestore()
    upgrade.mockRestore()
  }
})

test("aictrl upgrade reports a failed version lookup instead of crashing", async () => {
  const latest = spyOn(Installation, "latest").mockRejectedValue(new Error("Not Found"))
  const upgrade = spyOn(Installation, "upgrade").mockResolvedValue(undefined)
  try {
    await UpgradeCommand.handler({ method: "npm" })
    expect(latest).toHaveBeenCalledWith("npm")
    expect(upgrade).not.toHaveBeenCalled()
  } finally {
    latest.mockRestore()
    upgrade.mockRestore()
  }
})

test("aictrl upgrade never installs an empty or missing latest version", async () => {
  for (const value of [undefined, ""]) {
    const latest = spyOn(Installation, "latest").mockResolvedValue(value as unknown as string)
    const upgrade = spyOn(Installation, "upgrade").mockResolvedValue(undefined)
    try {
      await UpgradeCommand.handler({ method: "npm" })
      expect(upgrade).not.toHaveBeenCalled()
    } finally {
      latest.mockRestore()
      upgrade.mockRestore()
    }
  }
})
