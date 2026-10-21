import { appendFileSync } from "node:fs"
const record = (value: unknown) => appendFileSync(process.env.BASH_ENV_NETWORK_LEDGER!, JSON.stringify(value) + "\n")
const fetch = globalThis.fetch
const spawn = Bun.spawn.bind(Bun)
Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const first: unknown = args[0]
  const cmd = Array.isArray(first)
    ? first
    : first && typeof first === "object" && "cmd" in first
      ? first.cmd
      : undefined
  if (Array.isArray(cmd) && /(?:^|\/)bun$/.test(String(cmd[0])) && ["install", "add"].includes(String(cmd[1]))) {
    record({ kind: "install", allowed: false })
    throw new Error("Owned forwarding fixture forbids install")
  }
  return spawn(...args)
}) as typeof Bun.spawn
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const allowed =
      process.env.BASH_ENV_PROVIDER_ORIGIN !== undefined && url.origin === process.env.BASH_ENV_PROVIDER_ORIGIN
    record({
      kind: "fetch",
      origin: url.origin,
      path: url.pathname,
      allowed,
      parentKey: process.env.CUSTOM_GATEWAY_KEY,
      parentGh: process.env.GH_TOKEN,
      parentProviderKey: process.env.AICTRL_TEST_PROVIDER_KEY,
    })
    if (!allowed) throw new Error("Owned forwarding fixture denied network")
    return fetch(input, init)
  },
  {
    preconnect: () => {
      record({ kind: "preconnect", allowed: false })
      throw new Error("Owned forwarding fixture forbids preconnect")
    },
  },
) as typeof fetch
