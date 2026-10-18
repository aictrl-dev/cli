import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ProviderAuth } from "../../src/provider/auth"

describe("plugin.auth-override", () => {
  test("user plugin overrides built-in openai auth", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const pluginDir = path.join(dir, ".aictrl", "plugin")
        await fs.mkdir(pluginDir, { recursive: true })

        await Bun.write(
          path.join(pluginDir, "custom-openai-auth.ts"),
          [
            "export default async () => ({",
            "  auth: {",
            '    provider: "openai",',
            "    methods: [",
            '      { type: "api", label: "Test Override Auth" },',
            "    ],",
            "    loader: async () => ({ access: 'test-token' }),",
            "  },",
            "})",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const methods = await ProviderAuth.methods()
        const openai = methods["openai"]
        expect(openai).toBeDefined()
        expect(openai.length).toBe(1)
        expect(openai[0].label).toBe("Test Override Auth")
      },
    })
  }, 30000) // Increased timeout for plugin installation
})
