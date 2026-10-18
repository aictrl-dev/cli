import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ModelCatalog } from "../../src/provider/catalog"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"

const KEY_ENV = ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]

// A fake Gemini API endpoint that records the API key each request carries.
let server: ReturnType<typeof Bun.serve>
let keys: (string | null)[]

beforeEach(() => {
  keys = []
  server = Bun.serve({
    port: 0,
    fetch(request) {
      keys.push(request.headers.get("x-goog-api-key"))
      return Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      })
    },
  })
})

afterEach(async () => {
  server.stop(true)
  await Auth.remove("google")
})

function withGoogle(input: { env: Record<string, string>; options?: Record<string, string> }, fn: () => Promise<void>) {
  return (async () => {
    await using tmp = await tmpdir({
      config: { provider: { google: { options: { baseURL: `${server.url.origin}/v1beta`, ...input.options } } } },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        for (const name of KEY_ENV) Env.remove(name)
        for (const [name, value] of Object.entries(input.env)) Env.set(name, value)
      },
      fn,
    })
  })()
}

async function sentKey() {
  const model = await Provider.getModel("google", "gemini-3.8-flash")
  const language = await Provider.getLanguage(model)
  await language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Say done." }] }] })
  return keys.at(-1)
}

describe("google provider", () => {
  test("is built in with the Google AI Studio SDK and current Gemini models", () => {
    const google = ModelCatalog.providers()["google"]
    expect(google.name).toBe("Google")
    expect([...google.env].sort()).toEqual([...KEY_ENV].sort())
    expect([...Provider.GOOGLE_AI_STUDIO_KEY_ENV].sort()).toEqual([...KEY_ENV].sort())
    expect(ModelCatalog.sdkDefaults("google")).toEqual({ npm: "@ai-sdk/google", api: undefined })

    for (const id of ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview"]) {
      const model = google.models[id]
      expect(model, id).toBeDefined()
      expect(model.api.id).toBe(id)
      expect(model.api.npm).toBe("@ai-sdk/google")
      // The SDK knows its own endpoint, so the catalog carries no base URL.
      expect(model.api.url).toBeUndefined()
      expect(model.limit).toEqual({ context: 1_048_576, output: 65_536 })
    }
  })

  test.each(KEY_ENV)("resolves models and sends the key with only %s set", async (name) => {
    await withGoogle({ env: { [name]: `key-from-${name}` } }, async () => {
      const providers = await Provider.list()
      expect(providers["google"].models["gemini-3.8-flash"]).toBeDefined()
      expect(await sentKey()).toBe(`key-from-${name}`)
    })
  })

  test("prefers the SDK's own env var, then GEMINI_API_KEY, over GOOGLE_API_KEY", async () => {
    await withGoogle({ env: { GOOGLE_API_KEY: "generic", GEMINI_API_KEY: "gemini" } }, async () => {
      expect(await sentKey()).toBe("gemini")
    })
    await withGoogle(
      { env: { GOOGLE_API_KEY: "generic", GEMINI_API_KEY: "gemini", GOOGLE_GENERATIVE_AI_API_KEY: "sdk" } },
      async () => {
        expect(await sentKey()).toBe("sdk")
      },
    )
  })

  test("a key stored with auth login wins over env vars", async () => {
    await Auth.set("google", { type: "api", key: "stored" })
    await withGoogle({ env: { GEMINI_API_KEY: "gemini" } }, async () => {
      expect(await sentKey()).toBe("stored")
    })
  })

  test("a config apiKey wins over env vars", async () => {
    await withGoogle({ env: { GEMINI_API_KEY: "gemini" }, options: { apiKey: "configured" } }, async () => {
      expect(await sentKey()).toBe("configured")
    })
  })

  test("is not loaded without a key", async () => {
    await using tmp = await tmpdir({ config: {} })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        for (const name of KEY_ENV) Env.remove(name)
      },
      fn: async () => {
        expect((await Provider.list())["google"]).toBeUndefined()
      },
    })
  })
})
