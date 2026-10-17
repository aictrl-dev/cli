import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"

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

describe("legacy todo config keys (#182)", () => {
  const legacyConfig = {
    tools: { todowrite: false, todoread: false },
    permission: { todowrite: "deny", todoread: "deny" },
    agent: { build: { tools: { todowrite: true }, permission: { todoread: "allow" } } },
  } as Partial<Config.Info>

  /** Tool IDs the build agent is offered, after its permissions drop disabled tools. */
  async function offered(config?: Partial<Config.Info>) {
    await using tmp = await tmpdir({ config })
    return Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("build")
        const tools = await ToolRegistry.tools({ providerID: "anthropic", modelID: "claude-sonnet-4" }, agent)
        const ids = tools.map((tool) => tool.id)
        const disabled = PermissionNext.disabled(ids, agent.permission)
        return { config: await Config.get(), tools: ids.filter((id) => !disabled.has(id)) }
      },
    })
  }

  test("todowrite/todoread keys still load and change no offered tool", async () => {
    const baseline = await offered()
    const legacy = await offered(legacyConfig)

    expect(legacy.config.tools).toEqual({ todowrite: false, todoread: false })
    expect(legacy.config.permission).toMatchObject({ todowrite: "deny", todoread: "deny" })
    expect(legacy.config.agent?.build?.tools).toEqual({ todowrite: true })
    expect(legacy.tools).toEqual(baseline.tools)
    expect(legacy.tools).toContain("bash")
    expect(legacy.tools).not.toContain("todowrite")
    expect(legacy.tools).not.toContain("todoread")
  })
})
