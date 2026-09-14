import { expect, spyOn, test } from "bun:test"
import { GoogleAuth, OAuth2Client } from "google-auth-library"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Env } from "../../src/env"

test.each([
  ["global", "aiplatform.googleapis.com"],
  ["us", "aiplatform.us.rep.googleapis.com"],
  ["eu", "aiplatform.eu.rep.googleapis.com"],
  ["europe-west1", "europe-west1-aiplatform.googleapis.com"],
  [" EU ", "aiplatform.eu.rep.googleapis.com"],
  ["US", "aiplatform.us.rep.googleapis.com"],
  [" Global\t", "aiplatform.googleapis.com"],
  [" EUROPE-WEST1 ", "europe-west1-aiplatform.googleapis.com"],
])("Google Vertex resolves the %s endpoint", async (location, endpoint) => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "aictrl.json"),
        JSON.stringify({
          $schema: "https://aictrl.ai/config.json",
          provider: {
            "google-vertex": {
              options: {
                project: "test-project",
                location,
              },
              models: {
                "test-model": {
                  name: "Test Model",
                  tool_call: true,
                  provider: {
                    npm: "@ai-sdk/openai-compatible",
                    api: "https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}",
                  },
                },
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { Provider } = await import("../../src/provider/provider")
      const model = await Provider.getModel("google-vertex", "test-model")
      expect((await Provider.getProvider("google-vertex")).options.location).toBe(location.trim().toLowerCase())
      const language = (await Provider.getLanguage(model)) as unknown as {
        config: { url(input: { path: string }): string }
      }

      expect(language.config.url({ path: "/chat/completions" })).toBe(
        `https://${endpoint}/v1/projects/test-project/locations/${location.trim().toLowerCase()}/chat/completions`,
      )
    },
  })
})

test.each([
  "attacker.com/",
  "us@attacker.com",
  "us\\attacker.com",
  "us?x=1",
  "us#fragment",
  "us%2fhost",
  "",
  123,
  "a".repeat(60) + "-west1",
])("Google Vertex rejects unsafe location %s before resolving a client or constructing an SDK", async (location) => {
  await using tmp = await tmpdir({
    config: {
      provider: { "google-vertex": { options: { project: "test-project", location } } },
    },
  })
  const client = spyOn(GoogleAuth.prototype, "getClient")
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { Provider } = await import("../../src/provider/provider")
        await expect(Provider.getProvider("google-vertex")).rejects.toThrow("Invalid Google Vertex location")
        expect(client).not.toHaveBeenCalled()
      },
    })
  } finally {
    client.mockRestore()
  }
})

test.each([
  ["GOOGLE_CLOUD_LOCATION", " EU ", "eu"],
  ["VERTEX_LOCATION", " US ", "us"],
  ["GOOGLE_CLOUD_LOCATION", "attacker.com/", undefined],
  ["VERTEX_LOCATION", "us@attacker.com", undefined],
] as const)("Google Vertex validates location from %s", async (key, value, expected) => {
  await using tmp = await tmpdir({
    config: { provider: { "google-vertex": { options: { project: "test-project" } } } },
  })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      Env.remove("GOOGLE_CLOUD_LOCATION")
      Env.remove("VERTEX_LOCATION")
      Env.set(key, value)
    },
    fn: async () => {
      const { Provider } = await import("../../src/provider/provider")
      if (expected === undefined) {
        await expect(Provider.getProvider("google-vertex")).rejects.toThrow("Invalid Google Vertex location")
        return
      }
      expect((await Provider.getProvider("google-vertex")).options.location).toBe(expected)
    },
  })
})

test("Google Vertex reuses its auth instance and cached client across requests", async () => {
  await using tmp = await tmpdir({
    config: {
      provider: { "google-vertex": { options: { project: "test-project", location: "us-central1" } } },
    },
  })
  const credential = new OAuth2Client()
  credential.setCredentials({ access_token: "synthetic-cached-token", expiry_date: Date.now() + 3600000 })
  const instances = new Set<GoogleAuth>()
  const original = GoogleAuth.prototype.getClient
  const client = spyOn(GoogleAuth.prototype, "getClient").mockImplementation(function (this: GoogleAuth) {
    instances.add(this)
    this.cachedCredential ??= credential
    return original.call(this)
  })
  const tokens = spyOn(credential, "getAccessToken")
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-cached-token")
      return new Response("ok")
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { Provider } = await import("../../src/provider/provider")
        const provider = await Provider.getProvider("google-vertex")
        expect(client).not.toHaveBeenCalled()
        const requests = await Promise.all([provider.options.fetch(server.url), provider.options.fetch(server.url)])
        expect(await Promise.all(requests.map((response: Response) => response.text()))).toEqual(["ok", "ok"])
        expect(instances.size).toBe(1)
        expect(client).toHaveBeenCalledTimes(2)
        expect(tokens).toHaveBeenCalledTimes(2)
        expect(await Promise.all(tokens.mock.results.map((result) => result.value))).toEqual([
          { token: "synthetic-cached-token" },
          { token: "synthetic-cached-token" },
        ])
      },
    })
  } finally {
    server.stop(true)
    tokens.mockRestore()
    client.mockRestore()
  }
})

test("Google Vertex requests the cloud-platform OAuth scope", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "aictrl.json"),
        JSON.stringify({
          $schema: "https://aictrl.ai/config.json",
          provider: {
            "google-vertex": {
              options: {
                project: "test-project",
                location: "us-central1",
              },
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { Provider } = await import("../../src/provider/provider")
      const provider = await Provider.getProvider("google-vertex")

      const client = spyOn(GoogleAuth.prototype, "getClient").mockImplementation(async function (this: GoogleAuth) {
        expect(Reflect.get(this, "scopes")).toEqual(["https://www.googleapis.com/auth/cloud-platform"])
        throw new Error("stop after resolving auth client")
      })
      const defaults = spyOn(GoogleAuth.prototype, "getApplicationDefault").mockImplementation(() => {
        throw new Error("unexpected application default lookup")
      })
      try {
        await expect(provider.options.fetch("https://example.test")).rejects.toThrow("stop after resolving auth client")
        expect(client).toHaveBeenCalledTimes(1)
        expect(defaults).not.toHaveBeenCalled()
      } finally {
        client.mockRestore()
        defaults.mockRestore()
      }
    },
  })
})
