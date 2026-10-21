import { appendFileSync } from "node:fs"
import path from "node:path"

const record = (kind: string, detail: Record<string, unknown> = {}) =>
  appendFileSync(process.env.BASH_ENV_TEST_LEDGER!, JSON.stringify({ kind, ...detail }) + "\n")
record("preload", { legacy: process.env.AICTRL_BASH_ENV_ALLOWLIST ?? null })
const original = globalThis.fetch
// No provider or receiver request is permitted in this parser/startup unit.
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    record("network", { origin: url.origin, path: url.pathname })
    throw new Error("Owned startup fixture forbids network")
  },
  {
    preconnect: () => {
      record("network-preconnect")
      throw new Error("Owned startup fixture forbids preconnect")
    },
  },
) as typeof original
const spawn = Bun.spawn.bind(Bun)
Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  record("child")
  throw new Error("Owned startup fixture forbids child launch")
}) as unknown as typeof Bun.spawn

if (process.env.BASH_ENV_TEST_MODE === "deadline") {
  const child = spawn([process.execPath, "--no-env-file", "-e", "setInterval(() => {}, 1000)"], {
    env: { PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  record("grandchild", { pid: child.pid })
  process.on("SIGTERM", async () => {
    child.kill("SIGTERM")
    await child.exited
    record("grandchild-reaped")
    process.exit(143)
  })
  await new Promise(() => {})
}

const { Filesystem } = await import("../../../src/util/filesystem")
const readText = Filesystem.readText
Filesystem.readText = async (target: string) => {
  if (path.resolve(target) === path.join(process.cwd(), "aictrl.json")) record("project-config-access")
  return readText(target)
}
const { Config } = await import("../../../src/config/config")
const { Plugin } = await import("../../../src/plugin")
const { Provider } = await import("../../../src/provider/provider")
const { Instance } = await import("../../../src/project/instance")
const { RunCommand } = await import("../../../src/cli/cmd/run")
const { BashEnvPolicy } = await import("../../../src/util/bash-env-policy")

Config.get = async () => {
  record("config")
  throw new Error("Owned config boundary reached")
}
const read = Config.readToolSelection
Config.readToolSelection = async (...args: Parameters<typeof read>) => {
  record("config-read")
  if (process.env.BASH_ENV_TEST_MODE === "real-config") return read(...args)
  throw new Error("Owned config read boundary reached")
}
Plugin.init = async () => {
  record("plugin")
  throw new Error("Owned plugin boundary reached")
}
const model = Provider.getModel
Provider.getModel = async (...args: Parameters<typeof model>) => {
  record("provider")
  throw new Error("Owned provider boundary reached")
}
const provide = Instance.provide
Instance.provide = (async (...args: Parameters<typeof provide>) => {
  record("instance")
  return provide(...args)
}) as typeof provide
Bun.stdin.text = async () => {
  record("stdin")
  throw new Error("Owned stdin boundary reached")
}
const handler = RunCommand.handler
RunCommand.handler = async (args) => {
  record("handler", {
    policy: BashEnvPolicy.current(),
    parsed: args,
    argv: process.argv.slice(2),
    frozen: Object.isFrozen(BashEnvPolicy.current()),
    namesFrozen:
      BashEnvPolicy.current().mode === "allowlist"
        ? Object.isFrozen((BashEnvPolicy.current() as { names: readonly string[] }).names)
        : null,
  })
  // The normal CLI exits immediately after its handler; let the real asynchronous log stream flush.
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (["real", "real-config"].includes(process.env.BASH_ENV_TEST_MODE!)) return handler(args)
}
// Instrumentation positive controls use the actual installed boundary functions.
if (process.env.BASH_ENV_TEST_MODE === "controls") {
  for (const [kind, fn] of [
    ["config", () => Config.get()],
    ["plugin", () => Plugin.init()],
    ["provider", () => Provider.getModel("fixture", "fixture")],
    ["stdin", () => Bun.stdin.text()],
    ["network", () => fetch("http://127.0.0.1:9/owned")],
  ] as const) {
    try {
      await fn()
    } catch {
      record("control", { boundary: kind })
    }
  }
}
