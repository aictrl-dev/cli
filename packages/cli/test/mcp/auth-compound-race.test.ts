import { describe, test, expect } from "bun:test"
import { McpAuth } from "../../src/mcp/auth"

// These tests use the real McpAuth functions (which write to the real
// Global.Path.data directory) because `filepath` is a module-level const
// computed at import time. We use unique test keys and clean up afterward.

const TEST_PREFIX = "__test_compound_race_"

describe("McpAuth compound operation serialization", () => {
  test("concurrent updateTokens and updateOAuthState do not lose fields", async () => {
    const key = TEST_PREFIX + "tokens_and_oauth"

    // Set up initial entry with both tokens and oauthState
    await McpAuth.set(key, {
      tokens: { accessToken: "initial-token" },
      oauthState: "initial-state",
    })

    // Verify setup
    const before = await McpAuth.get(key)
    expect(before?.tokens?.accessToken).toBe("initial-token")
    expect(before?.oauthState).toBe("initial-state")

    // Fire concurrent compound updates — these both read the entry outside
    // the lock, mutate their respective field, then write inside the lock.
    // The race: both read the same snapshot, then the second write overwrites
    // the first's changes.
    await Promise.all([
      McpAuth.updateTokens(key, { accessToken: "new-token" }),
      McpAuth.updateOAuthState(key, "new-state"),
    ])

    // Read back the final entry
    const after = await McpAuth.get(key)

    // BOTH fields must be present — if the race exists, one will be lost
    expect(after?.tokens?.accessToken).toBe("new-token")
    expect(after?.oauthState).toBe("new-state")

    // Cleanup
    await McpAuth.remove(key)
  })

  test("concurrent updateTokens and updateClientInfo do not lose fields", async () => {
    const key = TEST_PREFIX + "tokens_and_client"

    // Set up initial entry with both fields
    await McpAuth.set(key, {
      tokens: { accessToken: "initial-token" },
      clientInfo: { clientId: "initial-client" },
    })

    // Fire concurrent compound updates
    await Promise.all([
      McpAuth.updateTokens(key, { accessToken: "new-token" }),
      McpAuth.updateClientInfo(key, { clientId: "new-client" }),
    ])

    const after = await McpAuth.get(key)

    // Both fields must survive
    expect(after?.tokens?.accessToken).toBe("new-token")
    expect(after?.clientInfo?.clientId).toBe("new-client")

    // Cleanup
    await McpAuth.remove(key)
  })

  test("concurrent updateCodeVerifier and updateOAuthState do not lose fields", async () => {
    const key = TEST_PREFIX + "verifier_and_oauth"

    // Set up initial entry
    await McpAuth.set(key, {
      codeVerifier: "initial-verifier",
      oauthState: "initial-state",
    })

    // Fire concurrent compound updates
    await Promise.all([
      McpAuth.updateCodeVerifier(key, "new-verifier"),
      McpAuth.updateOAuthState(key, "new-state"),
    ])

    const after = await McpAuth.get(key)

    expect(after?.codeVerifier).toBe("new-verifier")
    expect(after?.oauthState).toBe("new-state")

    // Cleanup
    await McpAuth.remove(key)
  })

  test("concurrent clearCodeVerifier and updateTokens do not conflict", async () => {
    const key = TEST_PREFIX + "clear_and_update"

    // Set up initial entry with codeVerifier and tokens
    await McpAuth.set(key, {
      tokens: { accessToken: "initial-token" },
      codeVerifier: "verifier-to-clear",
    })

    // Concurrently clear codeVerifier and update tokens
    await Promise.all([
      McpAuth.clearCodeVerifier(key),
      McpAuth.updateTokens(key, { accessToken: "final-token" }),
    ])

    const after = await McpAuth.get(key)

    // tokens should be updated, codeVerifier should be cleared
    expect(after?.tokens?.accessToken).toBe("final-token")
    expect(after?.codeVerifier).toBeUndefined()

    // Cleanup
    await McpAuth.remove(key)
  })
})
