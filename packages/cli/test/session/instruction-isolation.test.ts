import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { InstructionPrompt } from "../../src/session/instruction"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { HeadlessRun } from "../../src/flag/headless-run"
import { ReadTool } from "../../src/tool/read"
import { tmpdir } from "../fixture/fixture"

describe("project instruction isolation (#250)", () => {
  const keys = ["AICTRL_DISABLE_PROJECT_CONFIG", "AICTRL_CONFIG_DIR", "AICTRL_CONFIG_CONTENT"] as const
  let env: (string | undefined)[]
  let config: string
  let headless: boolean

  beforeEach(() => {
    env = keys.map((key) => process.env[key])
    config = Global.Path.config
    headless = HeadlessRun.enabled()
    for (const key of keys) delete process.env[key]
  })

  afterEach(() => {
    keys.forEach((key, index) => {
      if (env[index] === undefined) delete process.env[key]
      else process.env[key] = env[index]
    })
    Global.Path.config = config
    if (headless) HeadlessRun.enable()
    else HeadlessRun.disable()
  })

  test.each([false, true])("disabled=%s controls root and .opencode automatic instructions", async (disabled) => {
    await using global = await tmpdir()
    Global.Path.config = global.path
    if (disabled) process.env.AICTRL_DISABLE_PROJECT_CONFIG = "true"
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "ROOT_ISOLATION_MARKER")
        await Bun.write(path.join(dir, ".opencode", "AGENTS.md"), "OPENCODE_ISOLATION_MARKER")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const paths = await InstructionPrompt.systemPaths()
        expect(paths.has(path.join(tmp.path, "AGENTS.md"))).toBe(!disabled)
        expect(paths.has(path.join(tmp.path, ".opencode", "AGENTS.md"))).toBe(!disabled)
        const instructions = (await InstructionPrompt.system()).join("\n")
        expect(instructions.includes("ROOT_ISOLATION_MARKER")).toBe(!disabled)
        expect(instructions.includes("OPENCODE_ISOLATION_MARKER")).toBe(!disabled)
      },
    })
  })

  test.each([
    [false, "resolve"],
    [true, "resolve"],
    [false, "read"],
    [true, "read"],
  ] as const)("disabled=%s controls nested %s instructions", async (disabled, mode) => {
    await using global = await tmpdir()
    Global.Path.config = global.path
    if (disabled) process.env.AICTRL_DISABLE_PROJECT_CONFIG = "true"
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "nested", "AGENTS.md"), "NESTED_ISOLATION_MARKER")
        await Bun.write(path.join(dir, "nested", "file.txt"), "ordinary file content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filepath = path.join(tmp.path, "nested", "file.txt")
        if (mode === "resolve") {
          const results = await InstructionPrompt.resolve([], filepath, "resolve-isolation")
          expect(
            results
              .map((item) => item.content)
              .join("\n")
              .includes("NESTED_ISOLATION_MARKER"),
          ).toBe(!disabled)
          return
        }
        const read = await ReadTool.init()
        const result = await read.execute(
          { filePath: filepath },
          {
            sessionID: "isolation-test",
            messageID: "read-isolation",
            callID: "read-isolation",
            agent: "build",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )
        expect(result.output).toContain("ordinary file content")
        expect(result.output.includes("NESTED_ISOLATION_MARKER")).toBe(!disabled)
        expect(result.output.includes("<system-reminder>")).toBe(!disabled)
        expect(result.metadata.loaded).toEqual(disabled ? [] : [path.join(tmp.path, "nested", "AGENTS.md")])
      },
    })
  })

  test.each([false, true])(
    "headless=%s retains trusted and explicit caller instructions when disabled",
    async (active) => {
      if (active) HeadlessRun.enable()
      else HeadlessRun.disable()
      process.env.AICTRL_DISABLE_PROJECT_CONFIG = "true"
      await using global = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "AGENTS.md"), "GLOBAL_ISOLATION_MARKER")
        },
      })
      Global.Path.config = global.path
      await using profile = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "AGENTS.md"), "PROFILE_ISOLATION_MARKER")
          await Bun.write(path.join(dir, "relative.md"), "RELATIVE_ISOLATION_MARKER")
        },
      })
      await using caller = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "caller.md"), "CALLER_ISOLATION_MARKER")
        },
      })
      process.env.AICTRL_CONFIG_CONTENT = JSON.stringify({ instructions: [path.join(caller.path, "caller.md")] })
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const instructions = (await InstructionPrompt.system()).join("\n")
          expect(instructions).toContain("GLOBAL_ISOLATION_MARKER")
          expect(instructions).toContain("CALLER_ISOLATION_MARKER")
        },
      })
      process.env.AICTRL_CONFIG_DIR = profile.path
      process.env.AICTRL_CONFIG_CONTENT = JSON.stringify({
        instructions: ["relative.md", path.join(caller.path, "caller.md")],
      })
      await using other = await tmpdir()
      await Instance.provide({
        directory: other.path,
        fn: async () => {
          const instructions = (await InstructionPrompt.system()).join("\n")
          expect(instructions).toContain("PROFILE_ISOLATION_MARKER")
          expect(instructions).not.toContain("GLOBAL_ISOLATION_MARKER")
          expect(instructions).toContain("RELATIVE_ISOLATION_MARKER")
          expect(instructions).toContain("CALLER_ISOLATION_MARKER")
        },
      })
    },
  )
})
