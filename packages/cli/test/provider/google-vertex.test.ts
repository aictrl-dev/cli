import { expect, mock, test } from "bun:test"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

const options: unknown[] = []
const methods: string[] = []

mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    constructor(input: unknown) {
      options.push(input)
    }

    async getClient() {
      methods.push("getClient")
      throw new Error("stop after resolving auth client")
    }

    async getApplicationDefault() {
      methods.push("getApplicationDefault")
      throw new Error("stop after resolving application default")
    }
  },
}))

test.each([
  ["global", "aiplatform.googleapis.com"],
  ["us", "aiplatform.us.rep.googleapis.com"],
  ["eu", "aiplatform.eu.rep.googleapis.com"],
  ["europe-west1", "europe-west1-aiplatform.googleapis.com"],
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
      const language = (await Provider.getLanguage(model)) as unknown as {
        config: { url(input: { path: string }): string }
      }

      expect(language.config.url({ path: "/chat/completions" })).toBe(
        `https://${endpoint}/v1/projects/test-project/locations/${location}/chat/completions`,
      )
    },
  })
})

test("Google Vertex requests the cloud-platform OAuth scope", async () => {
  options.length = 0
  methods.length = 0

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

      await expect(provider.options.fetch("https://example.test")).rejects.toThrow("stop after resolving auth client")
      expect(options).toEqual([{ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }])
      expect(methods).toEqual(["getClient"])
    },
  })
})
