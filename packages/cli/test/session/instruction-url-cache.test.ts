import { test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { InstructionPrompt } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

let fetchCallCount = 0
let fetchUrls: string[] = []
let fetchShouldFail = false

const originalFetch = globalThis.fetch

beforeEach(() => {
  fetchCallCount = 0
  fetchUrls = []
  fetchShouldFail = false

  // Mock global fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    fetchCallCount++
    fetchUrls.push(url)

    if (fetchShouldFail) {
      throw new Error("Network error")
    }

    return new Response("Test instruction content", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("calling system() twice with same URL config fetches URL only once", async () => {
  await using tmp = await tmpdir({
    config: {
      instructions: ["https://example.com/instructions.md"],
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // First call: should fetch the URL
      const result1 = await InstructionPrompt.system()

      // Second call: should use cached result, NOT re-fetch
      const result2 = await InstructionPrompt.system()

      // fetch should have been called exactly once for the URL
      const urlFetches = fetchUrls.filter((u) => u === "https://example.com/instructions.md")
      expect(urlFetches.length).toBe(1)

      // Both calls should return the same content
      const urlResult1 = result1.find((r) => r.includes("example.com/instructions.md"))
      const urlResult2 = result2.find((r) => r.includes("example.com/instructions.md"))
      expect(urlResult1).toBeDefined()
      expect(urlResult2).toBeDefined()
      expect(urlResult1).toBe(urlResult2)
    },
  })
})

test("fetch failures are cached and not retried", async () => {
  fetchShouldFail = true

  await using tmp = await tmpdir({
    config: {
      instructions: ["https://example.com/failing-instructions.md"],
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // First call: fetch will fail
      const result1 = await InstructionPrompt.system()

      // Second call: should use cached failure, NOT re-fetch
      const result2 = await InstructionPrompt.system()

      // fetch should have been called exactly once
      const urlFetches = fetchUrls.filter((u) => u === "https://example.com/failing-instructions.md")
      expect(urlFetches.length).toBe(1)

      // Both calls should return empty for the failed URL
      const urlResult1 = result1.find((r) => r.includes("failing-instructions.md"))
      const urlResult2 = result2.find((r) => r.includes("failing-instructions.md"))
      expect(urlResult1).toBeUndefined()
      expect(urlResult2).toBeUndefined()
    },
  })
})

test("different URLs are cached independently", async () => {
  await using tmp = await tmpdir({
    config: {
      instructions: [
        "https://example.com/instructions-a.md",
        "https://example.com/instructions-b.md",
      ],
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // First call: should fetch both URLs
      await InstructionPrompt.system()

      // Second call: neither URL should be re-fetched
      await InstructionPrompt.system()

      // Each URL should be fetched exactly once
      const fetchesA = fetchUrls.filter((u) => u === "https://example.com/instructions-a.md")
      const fetchesB = fetchUrls.filter((u) => u === "https://example.com/instructions-b.md")
      expect(fetchesA.length).toBe(1)
      expect(fetchesB.length).toBe(1)
    },
  })
})
