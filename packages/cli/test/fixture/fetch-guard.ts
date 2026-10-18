// Preloaded into a spawned CLI process: fails every fetch and reports the attempted URLs on exit,
// so tests can assert that a command touched no network.
const attempts: string[] = []

globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL) => {
    attempts.push(input instanceof Request ? input.url : String(input))
    throw new Error("network access is disabled in this test")
  },
  { preconnect: () => {} },
) as typeof fetch

process.on("exit", () => {
  process.stderr.write(`FETCH_ATTEMPTS=${JSON.stringify(attempts)}\n`)
})
