import { describe, test, expect } from "bun:test"

// Import the module under test
const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")

describe("McpOAuthCallback.cancelPending", () => {
  test("cancelPending(mcpName) cancels a pending auth registered with waitForCallback(oauthState, mcpName)", async () => {
    const oauthState = "test-oauth-state-abc123"
    const mcpName = "my-mcp-server"

    // Register a pending auth keyed by oauthState, associated with mcpName
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState, mcpName)

    // Cancel by mcpName — this is how removeAuth() in mcp/index.ts calls it
    McpOAuthCallback.cancelPending(mcpName)

    // The promise should reject with "Authorization cancelled"
    let rejected = false
    let rejectionError: Error | undefined
    try {
      await callbackPromise
    } catch (error) {
      rejected = true
      rejectionError = error as Error
    }

    expect(rejected).toBe(true)
    expect(rejectionError?.message).toBe("Authorization cancelled")
  })

  test("cancelPending with unknown mcpName does nothing", () => {
    // Should not throw when no matching entry exists
    expect(() => McpOAuthCallback.cancelPending("nonexistent-server")).not.toThrow()
  })

  test("cancelPending only cancels the entry matching the given mcpName", async () => {
    const oauthState1 = "state-aaa"
    const mcpName1 = "server-one"
    const oauthState2 = "state-bbb"
    const mcpName2 = "server-two"

    const promise1 = McpOAuthCallback.waitForCallback(oauthState1, mcpName1)
    const promise2 = McpOAuthCallback.waitForCallback(oauthState2, mcpName2)

    // Cancel only server-one
    McpOAuthCallback.cancelPending(mcpName1)

    // promise1 should reject
    let rejected1 = false
    try {
      await promise1
    } catch {
      rejected1 = true
    }
    expect(rejected1).toBe(true)

    // promise2 should still be pending — race against a short timer
    const result = await Promise.race([
      promise2.then(() => "resolved").catch(() => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 200)),
    ])
    expect(result).toBe("still-pending")

    // Cleanup: cancel server-two
    McpOAuthCallback.cancelPending(mcpName2)

    let rejected2 = false
    try {
      await promise2
    } catch {
      rejected2 = true
    }
    expect(rejected2).toBe(true)
  })
})
