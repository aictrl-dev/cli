import { expect, spyOn, test } from "bun:test"
import { GoogleAuth } from "google-auth-library"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

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
