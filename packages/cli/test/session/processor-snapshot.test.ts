import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Global } from "../../src/global"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { Storage } from "../../src/storage/storage"
import type { Config } from "../../src/config/config"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Snapshot.setDefault(true))

/**
 * Runs one model step that writes `out.txt` in a git worktree and returns what the
 * step persisted: its parts, the session diff and whether the shadow repo exists.
 */
async function step(config: Partial<Config.Info> = {}) {
  await using tmp = await tmpdir({
    git: true,
    config: {
      enabled_providers: ["alibaba"],
      provider: { alibaba: { options: { apiKey: "test-key" } } },
      ...config,
    },
  })

  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Snapshot fixture" })
      const agent = await Agent.get("build")
      const model = await Provider.getModel("alibaba", "qwen-plus")
      const user = (await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: model.providerID, modelID: model.id },
      })) as MessageV2.User
      const assistant = (await Session.updateMessage({
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "assistant",
        parentID: user.id,
        modelID: model.id,
        providerID: model.providerID,
        mode: agent.name,
        agent: agent.name,
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })) as MessageV2.Assistant

      const stream = spyOn(LLM, "stream").mockResolvedValue({
        fullStream: (async function* () {
          yield { type: "start-step" }
          await Bun.write(path.join(tmp.path, "out.txt"), "written during the step\n")
          yield {
            type: "finish-step",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
        })(),
      } as unknown as Awaited<ReturnType<typeof LLM.stream>>)

      try {
        await SessionProcessor.create({
          assistantMessage: assistant,
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
        }).process({
          user,
          sessionID: session.id,
          model,
          agent,
          abort: new AbortController().signal,
          system: [],
          messages: [],
          tools: {},
        })
      } finally {
        stream.mockRestore()
      }
      // The processor summarizes in the background; await it so the result is settled.
      await SessionSummary.summarize({ sessionID: session.id, messageID: user.id })

      const parts = (await Session.messages({ sessionID: session.id })).flatMap((message) => message.parts)
      return {
        parts,
        diff: await Storage.read<Snapshot.FileDiff[]>(["session_diff", session.id]).catch(() => undefined),
        summary: (await Session.get(session.id)).summary,
        shadow: await fs
          .stat(path.join(Global.Path.data, "snapshot", Instance.project.id))
          .then(() => true)
          .catch(() => false),
      }
    },
  })
}

describe("headless run snapshots (#146)", () => {
  test("a headless run takes no snapshot, records no patch and writes no session diff", async () => {
    // what `aictrl run` sets before it bootstraps
    Snapshot.setDefault(false)
    const result = await step()

    expect(result.shadow).toBe(false)
    const start = result.parts.find((part) => part.type === "step-start")
    const finish = result.parts.find((part) => part.type === "step-finish")
    expect(start?.type === "step-start" ? start.snapshot : "missing").toBeUndefined()
    expect(finish?.type === "step-finish" ? finish.snapshot : "missing").toBeUndefined()
    expect(result.parts.filter((part) => part.type === "patch")).toHaveLength(0)
    expect(result.diff).toBeUndefined()
    expect(result.summary).toBeUndefined()
  })

  test("config `snapshot: true` re-enables snapshots, patches and the session diff in a headless run", async () => {
    // what `aictrl run` sets before it bootstraps
    Snapshot.setDefault(false)
    const result = await step({ snapshot: true })

    expect(result.shadow).toBe(true)
    const start = result.parts.find((part) => part.type === "step-start")
    expect(start?.type === "step-start" ? start.snapshot : undefined).toBeString()
    const patch = result.parts.find((part) => part.type === "patch")
    expect(patch?.type === "patch" ? patch.files.map((file) => path.basename(file)) : []).toEqual(["out.txt"])
    expect(result.diff?.map((item) => item.file)).toEqual(["out.txt"])
    expect(result.summary).toMatchObject({ files: 1, additions: 1 })
  })

  test("sessions outside a headless run keep snapshots by default", async () => {
    const result = await step()

    expect(result.shadow).toBe(true)
    expect(result.parts.filter((part) => part.type === "patch")).toHaveLength(1)
    expect(result.diff?.map((item) => item.file)).toEqual(["out.txt"])
  })

  test("config `snapshot: false` still disables snapshots outside a headless run", async () => {
    const result = await step({ snapshot: false })

    expect(result.shadow).toBe(false)
    expect(result.parts.filter((part) => part.type === "patch")).toHaveLength(0)
    expect(result.diff).toBeUndefined()
  })
})
