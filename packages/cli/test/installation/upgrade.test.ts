import { expect, spyOn, test } from "bun:test"
import { Installation } from "../../src/installation"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"

test("standalone binary upgrade fails without running a remote installer", async () => {
  const error = await Installation.upgrade("curl", "9.9.9").catch((error) => error)
  expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
  expect(error.data.stderr).toContain("npm install -g @aictrl/cli@9.9.9")
})

test("only binaries outside a node_modules tree count as standalone", () => {
  expect(Installation.isStandalone("/home/u/.aictrl/bin/aictrl")).toBe(true)
  expect(Installation.isStandalone("/home/u/.local/bin/aictrl")).toBe(true)
  // pnpm with PNPM_HOME=~/.local/bin keeps global packages under that directory
  expect(Installation.isStandalone("/home/u/.local/bin/global/5/node_modules/@aictrl/cli-linux-x64/bin/aictrl")).toBe(
    false,
  )
  expect(Installation.isStandalone("/usr/lib/node_modules/@aictrl/cli-linux-x64/bin/aictrl")).toBe(false)
})

test("a standalone binary has no package manager to upgrade through", async () => {
  let probed = false
  const managed = await Installation.standaloneUpgradeMethod("/home/u/.local/bin/aictrl", async () => {
    probed = true
    return "npm"
  })
  expect(managed).toBeUndefined()
  expect(probed).toBe(false)
})

test("a curl-detected binary inside a package manager tree upgrades through that package manager", async () => {
  const execPath = "/home/u/.local/bin/global/5/node_modules/@aictrl/cli-linux-x64/bin/aictrl"
  expect(await Installation.standaloneUpgradeMethod(execPath, async () => "pnpm")).toBe("pnpm")
  expect(await Installation.standaloneUpgradeMethod(execPath, async () => "unknown")).toBeUndefined()
})

test("latest version for a standalone binary comes from the npm registry", async () => {
  const urls: string[] = []
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    urls.push(String(input instanceof Request ? input.url : input))
    return new Response(JSON.stringify({ version: "9.9.9" }))
  }) as typeof fetch)
  try {
    expect(await Installation.latest("curl")).toBe("9.9.9")
  } finally {
    fetchSpy.mockRestore()
  }
  expect(urls).toHaveLength(1)
  expect(urls[0]).toContain("/@aictrl/cli/")
  expect(urls[0]).not.toContain("github.com")
})

test("aictrl upgrade without a version stops before resolving one for a standalone binary", async () => {
  const latest = spyOn(Installation, "latest")
  const upgrade = spyOn(Installation, "upgrade")
  try {
    await UpgradeCommand.handler({ method: "curl" })
    expect(latest).not.toHaveBeenCalled()
    expect(upgrade).not.toHaveBeenCalled()
  } finally {
    latest.mockRestore()
    upgrade.mockRestore()
  }
})

test("aictrl upgrade reports a failed version lookup instead of crashing", async () => {
  const latest = spyOn(Installation, "latest").mockRejectedValue(new Error("Not Found"))
  const upgrade = spyOn(Installation, "upgrade")
  try {
    await UpgradeCommand.handler({ method: "npm" })
    expect(latest).toHaveBeenCalledWith("npm")
    expect(upgrade).not.toHaveBeenCalled()
  } finally {
    latest.mockRestore()
    upgrade.mockRestore()
  }
})
