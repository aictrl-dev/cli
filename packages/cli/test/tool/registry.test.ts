import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"

describe("tool.registry", () => {
  test("loads tools from .aictrl/tool (singular)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const aictrlDir = path.join(dir, ".aictrl")
        await fs.mkdir(aictrlDir, { recursive: true })

        const toolDir = path.join(aictrlDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test("loads tools from .aictrl/tools (plural)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const aictrlDir = path.join(dir, ".aictrl")
        await fs.mkdir(aictrlDir, { recursive: true })

        const toolsDir = path.join(aictrlDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test.skip("loads tools with external dependencies without crashing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const aictrlDir = path.join(dir, ".aictrl")
        await fs.mkdir(aictrlDir, { recursive: true })

        const toolsDir = path.join(aictrlDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(aictrlDir, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@aictrl/plugin": "0.1.0",
              cowsay: "^1.6.0",
            },
          }),
        )

        await Bun.write(
          path.join(toolsDir, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("cowsay")
      },
    })
  })

  test("rejects symlinked tool pointing outside allowed directories", async () => {
    // Create the evil tool file outside the project directory
    const evilToolPath = path.join(os.tmpdir(), `evil-tool-${Math.random().toString(36).slice(2)}.ts`)
    await Bun.write(
      evilToolPath,
      [
        "export default {",
        "  description: 'evil tool',",
        "  args: {},",
        "  execute: async () => {",
        "    return 'pwned'",
        "  },",
        "}",
        "",
      ].join("\n"),
    )

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const aictrlDir = path.join(dir, ".aictrl")
          const toolDir = path.join(aictrlDir, "tool")
          await fs.mkdir(toolDir, { recursive: true })

          // Create a legitimate (non-symlinked) tool
          await Bun.write(
            path.join(toolDir, "good.ts"),
            [
              "export default {",
              "  description: 'good tool',",
              "  args: {},",
              "  execute: async () => {",
              "    return 'hello'",
              "  },",
              "}",
              "",
            ].join("\n"),
          )

          // Create a symlink pointing to the evil tool outside the project
          await fs.symlink(evilToolPath, path.join(toolDir, "evil.ts"))
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("good")
          expect(ids).not.toContain("evil")
        },
      })
    } finally {
      await fs.unlink(evilToolPath).catch(() => {})
    }
  })
})

describe("tool.registry todo tools (#155)", () => {
  const keys = ["AICTRL_HEADLESS_RUN", "AICTRL_ENABLE_TODO_TOOL"] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })

  function setEnv(env: Partial<Record<(typeof keys)[number], string>>) {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
  }

  async function toolIDs() {
    await using tmp = await tmpdir()
    return Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("build")
        const tools = await ToolRegistry.tools({ providerID: "anthropic", modelID: "claude-sonnet-4" }, agent)
        return tools.map((tool) => tool.id)
      },
    })
  }

  test("a headless run gets neither todowrite nor todoread", async () => {
    setEnv({ AICTRL_HEADLESS_RUN: "true" })
    const ids = await toolIDs()
    expect(ids).toContain("bash")
    expect(ids).not.toContain("todowrite")
    expect(ids).not.toContain("todoread")
  })

  test("AICTRL_ENABLE_TODO_TOOL brings todowrite back to a headless run", async () => {
    setEnv({ AICTRL_HEADLESS_RUN: "true", AICTRL_ENABLE_TODO_TOOL: "1" })
    const ids = await toolIDs()
    expect(ids).toContain("todowrite")
    expect(ids).not.toContain("todoread")
  })

  test("sessions outside a headless run keep todowrite", async () => {
    setEnv({})
    expect(await toolIDs()).toContain("todowrite")
  })
})
