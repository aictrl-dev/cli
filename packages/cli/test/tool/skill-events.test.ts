import { describe, expect, test } from "bun:test"
import path from "path"
import type { PermissionNext } from "../../src/permission/next"
import type { Tool } from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { ReadTool } from "../../src/tool/read"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: "test-session",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

const noopCtx: Tool.Context = {
  ...baseCtx,
  ask: async () => {},
}

describe("skill events", () => {
  test("SkillDiscovered emitted per skill on init with sessionID", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir1 = path.join(dir, ".aictrl", "skill", "alpha")
        const skillDir2 = path.join(dir, ".aictrl", "skill", "beta")
        await Bun.write(
          path.join(skillDir1, "SKILL.md"),
          `---
name: alpha
description: First skill.
---

# Alpha
`,
        )
        await Bun.write(
          path.join(skillDir2, "SKILL.md"),
          `---
name: beta
description: Second skill.
---

# Beta
`,
        )
      },
    })

    const home = process.env.AICTRL_TEST_HOME
    process.env.AICTRL_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const events: Array<{ name: string; description: string; location: string; sessionID: string }> = []
          const unsub = Bus.subscribe(Session.Event.SkillDiscovered, (evt) => {
            events.push(evt.properties)
          })

          await SkillTool.init({ sessionID: "test-session" })

          unsub()

          expect(events.length).toBe(2)
          const names = events.map((e) => e.name).sort()
          expect(names).toEqual(["alpha", "beta"])
          expect(events.every((e) => e.sessionID === "test-session")).toBe(true)
          expect(events.find((e) => e.name === "alpha")!.description).toBe("First skill.")
          expect(events.find((e) => e.name === "beta")!.description).toBe("Second skill.")
        },
      })
    } finally {
      process.env.AICTRL_TEST_HOME = home
    }
  })

  test("SkillDiscovered not emitted when no sessionID provided", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".aictrl", "skill", "gamma")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: gamma
description: A skill.
---

# Gamma
`,
        )
      },
    })

    const home = process.env.AICTRL_TEST_HOME
    process.env.AICTRL_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const events: any[] = []
          const unsub = Bus.subscribe(Session.Event.SkillDiscovered, (evt) => {
            events.push(evt.properties)
          })

          // init without sessionID
          await SkillTool.init()

          unsub()

          expect(events.length).toBe(0)
        },
      })
    } finally {
      process.env.AICTRL_TEST_HOME = home
    }
  })

  test("SkillLoaded emitted when skill tool is executed", { timeout: 15_000 }, async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".aictrl", "skill", "delta")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: delta
description: Loadable skill.
---

# Delta

Instructions here.
`,
        )
      },
    })

    const home = process.env.AICTRL_TEST_HOME
    process.env.AICTRL_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const events: Array<{ name: string; location: string; sessionID: string }> = []
          const unsub = Bus.subscribe(Session.Event.SkillLoaded, (evt) => {
            events.push(evt.properties)
          })

          const tool = await SkillTool.init({ sessionID: "test-session" })
          await tool.execute({ name: "delta" }, noopCtx)

          unsub()

          expect(events.length).toBe(1)
          expect(events[0].name).toBe("delta")
          expect(events[0].sessionID).toBe("test-session")
          expect(events[0].location).toContain(path.join("skill", "delta", "SKILL.md"))
        },
      })
    } finally {
      process.env.AICTRL_TEST_HOME = home
    }
  })

  test("SkillResourceLoaded emitted when reading a file inside a skill directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".aictrl", "skill", "epsilon")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: epsilon
description: Skill with resources.
---

# Epsilon
`,
        )
        await Bun.write(path.join(skillDir, "templates", "example.txt"), "template content")
      },
    })

    const home = process.env.AICTRL_TEST_HOME
    process.env.AICTRL_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const events: Array<{ skillName: string; filePath: string; sessionID: string }> = []
          const unsub = Bus.subscribe(Session.Event.SkillResourceLoaded, (evt) => {
            events.push(evt.properties)
          })

          const readTool = await ReadTool.init()
          const resourcePath = path.join(tmp.path, ".aictrl", "skill", "epsilon", "templates", "example.txt")
          await readTool.execute({ filePath: resourcePath }, noopCtx)

          unsub()

          expect(events.length).toBe(1)
          expect(events[0].skillName).toBe("epsilon")
          expect(events[0].filePath).toBe(resourcePath)
          expect(events[0].sessionID).toBe("test-session")
        },
      })
    } finally {
      process.env.AICTRL_TEST_HOME = home
    }
  })

  test("SkillResourceLoaded not emitted for files outside skill directories", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "src", "index.ts"), "console.log('hello')")
      },
    })

    const home = process.env.AICTRL_TEST_HOME
    process.env.AICTRL_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const events: any[] = []
          const unsub = Bus.subscribe(Session.Event.SkillResourceLoaded, (evt) => {
            events.push(evt.properties)
          })

          const readTool = await ReadTool.init()
          const filePath = path.join(tmp.path, "src", "index.ts")
          await readTool.execute({ filePath }, noopCtx)

          unsub()

          expect(events.length).toBe(0)
        },
      })
    } finally {
      process.env.AICTRL_TEST_HOME = home
    }
  })

  test("no skill events emitted when no skills exist", async () => {
    await using tmp = await tmpdir({ git: true })

    const home = process.env.AICTRL_TEST_HOME
    process.env.AICTRL_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const discovered: any[] = []
          const unsub = Bus.subscribe(Session.Event.SkillDiscovered, (evt) => {
            discovered.push(evt.properties)
          })

          await SkillTool.init({ sessionID: "test-session" })

          unsub()

          expect(discovered.length).toBe(0)
        },
      })
    } finally {
      process.env.AICTRL_TEST_HOME = home
    }
  })
})
