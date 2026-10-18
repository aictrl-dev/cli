import { describe, expect, test } from "bun:test"
import path from "path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

// Provider config keeps the field names users already have in their aictrl.json files.
const REPRESENTATIVE = {
  "my-gateway": {
    name: "My Gateway",
    npm: "@ai-sdk/openai-compatible",
    api: "https://gateway.example/v1",
    env: ["MY_GATEWAY_KEY"],
    whitelist: ["fast"],
    blacklist: ["slow"],
    options: { apiKey: "{env:MY_GATEWAY_KEY}", baseURL: "https://gateway.example/v1", timeout: false, custom: 1 },
    models: {
      fast: {
        id: "vendor/fast-1",
        name: "Fast",
        family: "fast",
        release_date: "2026-01-01",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        interleaved: { field: "reasoning_content" },
        cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25, context_over_200k: { input: 2, output: 4 } },
        limit: { context: 200_000, input: 150_000, output: 32_000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        experimental: true,
        status: "beta",
        options: { reasoningEffort: "high" },
        headers: { "X-Model": "fast" },
        provider: { npm: "@ai-sdk/openai", api: "https://other.example/v1" },
        variants: { high: { reasoningEffort: "high" }, low: { disabled: true } },
      },
    },
  },
  anthropic: {
    options: { headers: { "X-Custom": "1" } },
    models: {
      "claude-sonnet-4-5": { limit: { context: 100_000, output: 8_000 }, variants: { high: { disabled: true } } },
    },
  },
}

describe("provider config schema", () => {
  test("accepts every field of existing provider configs", () => {
    for (const [id, provider] of Object.entries(REPRESENTATIVE)) {
      const parsed = Config.Provider.safeParse(provider)
      expect(parsed.error, id).toBeUndefined()
      expect(parsed.data).toEqual(provider as any)
    }
  })

  test("still rejects unknown provider keys and invalid model values", () => {
    expect(Config.Provider.safeParse({ unknown: true }).success).toBe(false)
    expect(Config.Provider.safeParse({ models: { m: { status: "retired" } } }).success).toBe(false)
    expect(Config.Provider.safeParse({ models: { m: { limit: { context: 1 } } } }).success).toBe(false)
    expect(Config.Provider.safeParse({ models: { m: { interleaved: false } } }).success).toBe(false)
  })

  test("loads a representative config file end to end", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "aictrl.json"), JSON.stringify({ provider: REPRESENTATIVE }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.provider?.["my-gateway"]?.models?.["fast"]?.cost?.context_over_200k).toEqual({
          input: 2,
          output: 4,
        })
        expect(config.provider?.["anthropic"]?.models?.["claude-sonnet-4-5"]?.variants?.["high"]?.disabled).toBe(true)
      },
    })
  })
})
