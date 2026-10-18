import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ModelCatalog } from "../../src/provider/catalog"
import { Env } from "../../src/env"
import { Global } from "../../src/global"
import { FormatError } from "../../src/cli/error"

const BUILT_IN_PROVIDERS = [
  "amazon-bedrock",
  "anthropic",
  "azure",
  "azure-cognitive-services",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "gitlab",
  "google-vertex",
  "google-vertex-anthropic",
  "kilo",
  "openai",
  "openrouter",
  "sap-ai-core",
  "vercel",
  "zai",
  "zai-coding-plan",
  "zenmux",
]

// Providers with a native SDK resolve their own endpoint, so their models carry no base URL.
const CatalogModel = Provider.Model.extend({
  api: Provider.Model.shape.api.extend({ url: Provider.Model.shape.api.shape.url.optional() }),
})

describe("model catalog", () => {
  test("covers exactly the providers with custom loaders", () => {
    expect(Object.keys(ModelCatalog.providers()).sort()).toEqual(BUILT_IN_PROVIDERS)
  })

  test("holds valid, current, tool-calling models keyed by their IDs", () => {
    for (const [providerID, provider] of Object.entries(ModelCatalog.providers())) {
      expect(provider.id).toBe(providerID)
      expect(Object.keys(provider.models).length).toBeGreaterThan(0)
      for (const [modelID, model] of Object.entries(provider.models)) {
        const parsed = CatalogModel.safeParse(model)
        expect(parsed.error, `${providerID}/${modelID}`).toBeUndefined()
        expect(model.id).toBe(modelID)
        expect(model.providerID).toBe(providerID)
        expect(model.status).not.toBe("deprecated")
        expect(model.capabilities.toolcall).toBe(true)
        expect(model.capabilities.input.text && model.capabilities.output.text).toBe(true)
      }
    }
  })

  test("keeps the Codex and GLM Coding Plan models as first-class entries", () => {
    const providers = ModelCatalog.providers()
    const codex = providers["openai"].models["gpt-5.3-codex"]
    expect(codex.family).toBe("gpt-codex")
    expect(codex.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    for (const id of ["gpt-5.2", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(providers["openai"].models[id], id).toBeDefined()
    }
    for (const id of ["glm-5.2", "glm-5.3"]) {
      const glm = providers["zai-coding-plan"].models[id]
      expect(glm.api.url).toBe("https://api.z.ai/api/coding/paas/v4")
      expect(glm.capabilities.interleaved).toEqual({ field: "reasoning_content" })
      expect(glm.limit).toEqual({ context: 1_000_000, output: 131_072 })
    }
  })

  test("uses the bundled GitLab SDK", () => {
    const gitlab = ModelCatalog.providers()["gitlab"]
    for (const model of Object.values(gitlab.models)) expect(model.api.npm).toBe("@gitlab/gitlab-ai-provider")
    expect(ModelCatalog.sdkDefaults("gitlab").npm).toBe("@gitlab/gitlab-ai-provider")
  })

  test("returns a fresh copy on every call", () => {
    const first = ModelCatalog.providers()
    delete first["anthropic"].models["claude-haiku-4-5"]
    first["openai"].name = "changed"
    const second = ModelCatalog.providers()
    expect(second["anthropic"].models["claude-haiku-4-5"]).toBeDefined()
    expect(second["openai"].name).toBe("OpenAI")
  })

  test("exposes SDK defaults for config-added models without leaking them into provider info", () => {
    expect(ModelCatalog.sdkDefaults("openrouter")).toEqual({
      npm: "@openrouter/ai-sdk-provider",
      api: "https://openrouter.ai/api/v1",
    })
    expect(ModelCatalog.sdkDefaults("not-built-in")).toEqual({})
    expect(Object.keys(ModelCatalog.providers()["openrouter"]).sort()).toEqual([
      "env",
      "id",
      "models",
      "name",
      "options",
      "source",
    ])
  })
})

describe("provider registry", () => {
  test("ignores a stale models.json cache file from older versions", async () => {
    const stale = {
      "stale-provider": {
        id: "stale-provider",
        name: "Stale",
        env: ["STALE_PROVIDER_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://stale.example/v1",
        models: {},
      },
    }
    await Bun.write(path.join(Global.Path.cache, "models.json"), JSON.stringify(stale))
    await using tmp = await tmpdir({ config: {} })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("STALE_PROVIDER_KEY", "key")
        Env.set("ANTHROPIC_API_KEY", "key")
      },
      fn: async () => {
        const providers = await Provider.list()
        expect(providers["stale-provider"]).toBeUndefined()
        expect(providers["anthropic"].models["claude-sonnet-4-5"]).toBeDefined()
      },
    })
  })

  test("a provider that is no longer built in needs a config definition", async () => {
    await using tmp = await tmpdir({ config: {} })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("GROQ_API_KEY", "key")
      },
      fn: async () => {
        const providers = await Provider.list()
        expect(providers["groq"]).toBeUndefined()
        const error = await Provider.getModel("groq", "llama-3.3-70b-versatile").catch((e) => e)
        expect(Provider.ModelNotFoundError.isInstance(error)).toBe(true)
        expect(FormatError(error)).toContain(`must be defined under "provider" in aictrl.json`)
      },
    })
  })

  test("GLM Coding Plan models keep their forced reasoning-effort variants", async () => {
    await using tmp = await tmpdir({ config: {} })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ZHIPU_API_KEY", "key")
      },
      fn: async () => {
        const models = (await Provider.list())["zai-coding-plan"].models
        expect(models["glm-5.2"].variants).toEqual({
          low: { reasoningEffort: "high" },
          medium: { reasoningEffort: "high" },
          high: { reasoningEffort: "high" },
          xhigh: { reasoningEffort: "max" },
          max: { reasoningEffort: "max" },
        })
        expect(models["glm-5.3"].variants?.["max"]).toEqual({ reasoningEffort: "max" })
      },
    })
  })

  test("a config-only openai-compatible provider without a base URL fails with the config fix", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          groq: {
            options: { apiKey: "key" },
            models: { "llama-3.3-70b-versatile": { limit: { context: 131_072, output: 32_768 } } },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getModel("groq", "llama-3.3-70b-versatile")
        const error = await Provider.getLanguage(model).catch((e) => e)
        expect(Provider.BaseURLMissingError.isInstance(error)).toBe(true)
        expect(FormatError(error)).toBe(
          `Provider "groq" has no base URL. Set "api" or "options.baseURL" for it under "provider" in aictrl.json.`,
        )
      },
    })
  })

  test("an openai-compatible provider defined in config works without the catalog", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          groq: {
            name: "Groq",
            npm: "@ai-sdk/openai-compatible",
            api: "https://api.groq.com/openai/v1",
            env: ["GROQ_API_KEY"],
            models: {
              "llama-3.3-70b-versatile": {
                name: "Llama 3.3 70B",
                tool_call: true,
                limit: { context: 131_072, output: 32_768 },
              },
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("GROQ_API_KEY", "key")
      },
      fn: async () => {
        const model = await Provider.getModel("groq", "llama-3.3-70b-versatile")
        expect(model.api).toEqual({
          id: "llama-3.3-70b-versatile",
          npm: "@ai-sdk/openai-compatible",
          url: "https://api.groq.com/openai/v1",
        })
        expect(model.limit.context).toBe(131_072)
      },
    })
  })
})
