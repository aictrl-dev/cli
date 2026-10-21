import { appendFileSync } from "node:fs"
const record = (event: unknown) => appendFileSync(process.env.STDIN_FIXTURE_LEDGER!, JSON.stringify(event) + "\n")
record({ kind: "preload", stdinTTY: Boolean(process.stdin.isTTY) })
const original = globalThis.fetch
const spawn = Bun.spawn.bind(Bun)
Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const first: unknown = args[0]
  const command = Array.isArray(first)
    ? first
    : first && typeof first === "object" && "cmd" in first && Array.isArray(first.cmd)
      ? first.cmd
      : undefined
  if (command && /(?:^|\/)bun$/.test(String(command[0])) && ["install", "add"].includes(String(command[1]))) {
    record({ kind: "install", allowed: false })
    throw new Error("Stdin fixture forbids installation")
  }
  return spawn(...args)
}) as typeof Bun.spawn
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const allowed = url.origin === process.env.STDIN_FIXTURE_ORIGIN
    record({ kind: "fetch", origin: url.origin, path: url.pathname, allowed })
    if (!allowed) throw new Error("Stdin fixture blocked external request: " + url.origin)
    return original(input, init)
  },
  {
    preconnect: () => {
      throw new Error("Stdin fixture forbids preconnect")
    },
  },
) as typeof original
