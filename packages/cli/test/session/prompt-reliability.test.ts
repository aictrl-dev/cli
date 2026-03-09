import path from "path"
import { describe, expect, test } from "bun:test"
import { Log } from "../../src/util/log"
import { SessionRetry } from "../../src/session/retry"

Log.init({ print: false })

const PROMPT_SRC = path.resolve(import.meta.dir, "../../src/session/prompt.ts")

describe("prompt.ts reliability guards", () => {
  test("cancel rejects queued callbacks before deleting state", async () => {
    const source = await Bun.file(PROMPT_SRC).text()
    // cancel() must iterate callbacks and reject before delete
    const cancelFn = source.slice(
      source.indexOf("export function cancel("),
      source.indexOf("export const LoopInput"),
    )
    expect(cancelFn).toBeTruthy()
    // Must contain a for loop that calls cb.reject or similar
    expect(cancelFn).toMatch(/for\s*\(.*\bcb\b.*\bcallbacks\b/)
    expect(cancelFn).toMatch(/cb\.reject\(/)
    // reject must come before delete
    const rejectPos = cancelFn.indexOf("cb.reject")
    const deletePos = cancelFn.indexOf("delete s[sessionID]")
    expect(rejectPos).toBeGreaterThan(-1)
    expect(deletePos).toBeGreaterThan(-1)
    expect(rejectPos).toBeLessThan(deletePos)
  })

  test("dispose handler rejects queued callbacks", async () => {
    const source = await Bun.file(PROMPT_SRC).text()
    // The dispose handler is the second argument to Instance.state()
    // It should contain callback rejection, not just item.abort.abort()
    const disposeStart = source.indexOf("async (current) => {")
    expect(disposeStart).toBeGreaterThan(-1)
    // Extract the dispose handler body (up to closing brace pattern)
    const disposeBlock = source.slice(disposeStart, disposeStart + 300)
    expect(disposeBlock).toMatch(/cb\.reject\(/)
    expect(disposeBlock).toContain("Session disposed")
  })

  test("ensureTitle has catch handler", async () => {
    const source = await Bun.file(PROMPT_SRC).text()
    // Find the ensureTitle call site (not the function definition)
    const callSite = source.indexOf("ensureTitle({")
    expect(callSite).toBeGreaterThan(-1)
    // The call must be followed by .catch() within the same expression
    const afterCall = source.slice(callSite, callSite + 300)
    expect(afterCall).toMatch(/\.catch\(/)
    expect(afterCall).toMatch(/log\.error/)
  })

  test("prune is awaited", async () => {
    const source = await Bun.file(PROMPT_SRC).text()
    expect(source).toContain("await SessionCompaction.prune")
    // Ensure there is no un-awaited prune call
    const lines = source.split("\n")
    const pruneLines = lines.filter((l) => l.includes("SessionCompaction.prune"))
    for (const line of pruneLines) {
      expect(line.trim()).toMatch(/^await\s+SessionCompaction\.prune/)
    }
  })

  test("SessionRetry exports are defined", () => {
    // Verify retry constants exist and are reasonable
    expect(typeof SessionRetry.RETRY_INITIAL_DELAY).toBe("number")
    expect(SessionRetry.RETRY_INITIAL_DELAY).toBeGreaterThan(0)
    expect(typeof SessionRetry.RETRY_BACKOFF_FACTOR).toBe("number")
    expect(SessionRetry.RETRY_BACKOFF_FACTOR).toBeGreaterThan(1)
  })
})
