import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"

const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  async () => {
    throw new Error("Runtime guidance unit fixture forbids network")
  },
  {
    preconnect: () => {
      throw new Error("Runtime guidance unit fixture forbids preconnect")
    },
  },
)
const [{ Truncate }, { FileTime }, { Instance }, { tmpdir }, { EditTool }, { WriteTool }, { ReadTool }] =
  await Promise.all([
    import("../../src/tool/truncation"),
    import("../../src/file/time"),
    import("../../src/project/instance"),
    import("../fixture/fixture"),
    import("../../src/tool/edit"),
    import("../../src/tool/write"),
    import("../../src/tool/read"),
  ])
afterAll(() => {
  globalThis.fetch = originalFetch
})

describe("runtime guidance correctness (#244)", () => {
  test("new truncation suffix reports facts without prescribing Task Grep Read", async () => {
    const original = "first\nsecond\nthird"
    const result = await Truncate.output(original, { maxLines: 1 }, {
      permission: [{ permission: "task", pattern: "*", action: "allow" }],
    } as any)
    expect(result.truncated).toBe(true)
    if (!result.truncated) throw new Error("Expected truncation")
    expect(await Bun.file(result.outputPath).text()).toBe(original)
    expect(result.content).toContain("...2 lines truncated...")
    expect(result.content).toContain(result.outputPath)
    expect(result.content).not.toMatch(/\b(?:Task|Grep|Read)\b/)
  })

  test("missing read record fails accurately without prescribing unavailable Read", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filepath = path.join(tmp.path, "original.txt")
        await Bun.write(filepath, "original")
        const error = await FileTime.assert("fixture-session", filepath).then(
          () => {
            throw new Error("Expected missing-read failure")
          },
          (error: Error) => error,
        )
        expect(error.message).toContain(filepath)
        expect(error.message).toMatch(/read/i)
        expect(error.message).not.toContain("Use the Read tool")
        expect(await Bun.file(filepath).text()).toBe("original")
      },
    })
  })
})

const context = {
  sessionID: "runtime-guidance-session",
  messageID: "fixture",
  callID: "fixture",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("factual truncation controls (#244)", () => {
  for (const direction of ["head", "tail"] as const) {
    test(`${direction} keeps preview order exact line count and saved full bytes`, async () => {
      const content = "zero\none\ntwo\nthree\nfour"
      const result = await Truncate.output(content, { maxLines: 2, direction })
      if (!result.truncated) throw new Error("Expected truncation")
      expect(await Bun.file(result.outputPath).text()).toBe(content)
      expect(result.content).toContain("...3 lines truncated...")
      expect(result.content).toContain(`Full output saved to: ${result.outputPath}`)
      expect(result.content).not.toMatch(/\b(?:Task|Grep|Read)\b/)
      if (direction === "head") {
        expect(result.content).toStartWith("zero\none\n\n...")
        expect(result.content).not.toContain("four")
      } else {
        expect(result.content).toStartWith("...3 lines truncated...")
        expect(result.content).toEndWith("three\nfour")
      }
    })
    test(`${direction} counts UTF-8 omitted bytes without corrupting full saved text`, async () => {
      const content = "éé\nzz\n你好"
      const result = await Truncate.output(content, { maxLines: 99, maxBytes: 6, direction })
      if (!result.truncated) throw new Error("Expected truncation")
      expect(Array.from(await Bun.file(result.outputPath).bytes())).toEqual(
        Array.from(new TextEncoder().encode(content)),
      )
      const kept = direction === "head" ? Buffer.byteLength("éé") : Buffer.byteLength("你好")
      expect(result.content).toContain(`...${Buffer.byteLength(content) - kept} bytes truncated...`)
      if (direction === "head") expect(result.content).toStartWith("éé\n\n...")
      else expect(result.content).toEndWith("你好")
    })
  }
  test("exact limits and small content stay verbatim without saved-output metadata", async () => {
    for (const content of ["", "abc", "a\nb"]) {
      const result = await Truncate.output(content, { maxBytes: Math.max(Buffer.byteLength(content), 1), maxLines: 2 })
      expect(result).toEqual({ content, truncated: false })
    }
  })
})

describe("actual read edit write enforcement controls (#244)", () => {
  for (const name of ["edit", "write"] as const) {
    for (const state of ["unread", "stale"] as const) {
      test(`${name} ${state} attempt rejects before mutating any original bytes`, async () => {
        await using tmp = await tmpdir()
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const filepath = path.join(tmp.path, "protected.txt")
            const original = new Uint8Array([111, 114, 105, 103, 105, 110, 97, 108, 10])
            await Bun.write(filepath, original)
            let read: Date | undefined
            let modified: Date | undefined
            if (state === "stale") {
              FileTime.read(context.sessionID, filepath)
              read = FileTime.get(context.sessionID, filepath)!
              await fs.utimes(filepath, read, new Date(read.getTime() + 1000))
              modified = (await fs.stat(filepath)).mtime
            }
            const tool = name === "edit" ? await EditTool.init() : await WriteTool.init()
            const args =
              name === "edit"
                ? { filePath: filepath, oldString: "original", newString: "changed" }
                : { filePath: filepath, content: "changed" }
            let error: Error | undefined
            try {
              await tool.execute(args as any, context)
            } catch (e) {
              error = e as Error
            }
            expect(error).toBeInstanceOf(Error)
            expect(error!.message).toContain(filepath)
            expect(error!.message).not.toContain("Use the Read tool")
            expect(error!.message).toMatch(/read/i)
            if (state === "stale") {
              expect(error!.message).toContain("modified since it was last read")
              expect(error!.message).toContain(`Last modification: ${modified!.toISOString()}`)
              expect(error!.message).toContain(`Last read: ${read!.toISOString()}`)
            }
            expect(await Bun.file(filepath).bytes()).toEqual(original)
          },
        })
      })
    }
    test(`${name} valid actual Read allows the existing-file update`, async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filepath = path.join(tmp.path, "valid.txt")
          await Bun.write(filepath, "original\n")
          const read = await ReadTool.init()
          await read.execute({ filePath: filepath }, context)
          if (name === "edit")
            await (
              await EditTool.init()
            ).execute({ filePath: filepath, oldString: "original", newString: "changed" }, context)
          else await (await WriteTool.init()).execute({ filePath: filepath, content: "changed\n" }, context)
          expect(await Bun.file(filepath).text()).toBe("changed\n")
        },
      })
    })
    test(`${name} new-file exception still works without a read record`, async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filepath = path.join(tmp.path, "new.txt")
          expect(FileTime.get(context.sessionID, filepath)).toBeUndefined()
          if (name === "edit")
            await (
              await EditTool.init()
            ).execute({ filePath: filepath, oldString: "", newString: "new bytes" }, context)
          else await (await WriteTool.init()).execute({ filePath: filepath, content: "new bytes" }, context)
          expect(await Bun.file(filepath).text()).toBe("new bytes")
        },
      })
    })
  }
  test("empty-oldString direct overwrite retains its existing read exemption", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filepath = path.join(tmp.path, "direct.txt")
        await Bun.write(filepath, "original")
        expect(FileTime.get(context.sessionID, filepath)).toBeUndefined()
        await (
          await EditTool.init()
        ).execute({ filePath: filepath, oldString: "", newString: "direct overwrite" }, context)
        expect(await Bun.file(filepath).text()).toBe("direct overwrite")
      },
    })
  })
})
