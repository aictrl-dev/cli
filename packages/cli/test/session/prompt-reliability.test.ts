import path from "path"
import { describe, expect, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { SessionRetry } from "../../src/session/retry"
import { Instance } from "../../src/project/instance"
import { Bus } from "../../src/bus"
import { SessionStatus } from "../../src/session/status"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const provider = {
  fixture: {
    npm: "@ai-sdk/google",
    options: { apiKey: "fixture" },
    models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
  },
}

const PROMPT_SRC = path.resolve(import.meta.dir, "../../src/session/prompt.ts")
describe("prompt.ts reliability guards", () => {
  test("a second prompt for a busy session fails instead of queueing", async () => {
    await using tmp = await tmpdir({ git: true, config: { provider } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Busy session" })
        let streaming!: () => void
        const started = new Promise<void>((resolve) => (streaming = resolve))
        let finish!: () => void
        const finished = new Promise<void>((resolve) => (finish = resolve))
        const stream = spyOn(LLM, "stream").mockImplementation(async () => {
          streaming()
          return {
            fullStream: (async function* () {
              yield { type: "start-step" }
              await finished
              yield { type: "text-start" }
              yield { type: "text-delta", text: "Done" }
              yield { type: "text-end" }
              yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        const input = {
          sessionID: session.id,
          agent: "build",
          model: { providerID: "fixture", modelID: "gemini-fixture" },
        }
        try {
          const first = SessionPrompt.prompt({ ...input, parts: [{ type: "text", text: "First" }] })
          await started

          const second = SessionPrompt.prompt({ ...input, parts: [{ type: "text", text: "Second" }] })
          await expect(second).rejects.toBeInstanceOf(Session.BusyError)
          await expect(second).rejects.toThrow(`Session ${session.id} is busy`)
          // loop() reports a busy session as a rejection, like prompt(), not a synchronous throw.
          const loop = SessionPrompt.loop({ sessionID: session.id })
          await expect(loop).rejects.toBeInstanceOf(Session.BusyError)

          finish()
          const answer = await first
          expect(answer.info.role).toBe("assistant")
          const messages = await Session.messages({ sessionID: session.id })
          const prompts = messages.flatMap((message) =>
            message.info.role === "user" ? message.parts.filter((part) => part.type === "text") : [],
          )
          expect(prompts.map((part) => part.text)).toEqual(["First"])
          expect(stream).toHaveBeenCalledTimes(1)
        } finally {
          finish()
          stream.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  })

  test("a prompt that fails before the loop frees the session", async () => {
    await using tmp = await tmpdir({ git: true, config: { provider } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Early failure" })
        const input = {
          sessionID: session.id,
          agent: "build",
          model: { providerID: "fixture", modelID: "gemini-fixture" },
          noReply: true,
          parts: [{ type: "text" as const, text: "Hello" }],
        }
        try {
          await expect(
            SessionPrompt.prompt({
              ...input,
              format: { type: "json_schema", schema: { type: "nope" }, retryCount: 0 },
            }),
          ).rejects.toThrow('schema root must have type "object"')
          const message = await SessionPrompt.prompt(input)
          expect(message.info.role).toBe("user")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  // Holds the user-message write of the next prompt open until `resume` is called.
  function holdMessageWrite() {
    const original = Session.touch
    let reached!: () => void
    const writing = new Promise<void>((resolve) => (reached = resolve))
    let resume!: () => void
    const resumed = new Promise<void>((resolve) => (resume = resolve))
    const held = async (sessionID: string) => {
      touch.mockRestore()
      reached()
      await resumed
      return original(sessionID)
    }
    const touch = spyOn(Session, "touch").mockImplementation(Object.assign(held, original))
    return { writing, resume, restore: () => touch.mockRestore() }
  }

  function idleEvents(sessionID: string) {
    const events: string[] = []
    const unsubscribe = Bus.subscribe(SessionStatus.Event.Status, (event) => {
      if (event.properties.sessionID === sessionID) events.push(event.properties.status.type)
    })
    return { count: () => events.filter((type) => type === "idle").length, unsubscribe }
  }

  test("a prompt cancelled during its message write keeps the session until it unwinds", async () => {
    await using tmp = await tmpdir({ git: true, config: { provider } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Cancel during write" })
        const stream = spyOn(LLM, "stream").mockImplementation(
          async () =>
            ({
              fullStream: (async function* () {
                yield { type: "start-step" }
                yield { type: "text-start" }
                yield { type: "text-delta", text: "Done" }
                yield { type: "text-end" }
                yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
              })(),
            }) as unknown as Awaited<ReturnType<typeof LLM.stream>>,
        )
        const write = holdMessageWrite()
        const idle = idleEvents(session.id)
        const input = {
          sessionID: session.id,
          agent: "build",
          model: { providerID: "fixture", modelID: "gemini-fixture" },
        }
        try {
          const cancelled = SessionPrompt.prompt({ ...input, parts: [{ type: "text", text: "Cancelled" }] })
          const settled = cancelled.then(
            () => undefined,
            () => undefined,
          )
          await write.writing
          expect(SessionPrompt.cancel(session.id)).toBe(false)

          // The cancelled prompt still owns the session until it unwinds.
          const early = SessionPrompt.prompt({ ...input, parts: [{ type: "text", text: "Too early" }] })
          await expect(early).rejects.toBeInstanceOf(Session.BusyError)

          write.resume()
          await settled
          expect(idle.count()).toBe(1)
          expect(stream).not.toHaveBeenCalled()

          const answer = await SessionPrompt.prompt({ ...input, parts: [{ type: "text", text: "Newer" }] })
          expect(answer.info.role).toBe("assistant")
          if (answer.info.role !== "assistant") throw new Error("expected assistant")
          expect(answer.info.error).toBeUndefined()
          expect(answer.info.finish).toBe("stop")
          expect(stream).toHaveBeenCalledTimes(1)
        } finally {
          write.resume()
          write.restore()
          idle.unsubscribe()
          stream.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  })

  test("a noReply prompt cancelled during its message write publishes idle", async () => {
    await using tmp = await tmpdir({ git: true, config: { provider } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Cancel noReply" })
        const write = holdMessageWrite()
        const idle = idleEvents(session.id)
        const input = {
          sessionID: session.id,
          agent: "build",
          model: { providerID: "fixture", modelID: "gemini-fixture" },
          noReply: true,
          parts: [{ type: "text" as const, text: "Hello" }],
        }
        try {
          const cancelled = SessionPrompt.prompt(input)
          await write.writing
          expect(SessionPrompt.cancel(session.id)).toBe(false)
          expect(idle.count()).toBe(0)

          write.resume()
          expect((await cancelled).info.role).toBe("user")
          expect(idle.count()).toBe(1)
          expect((await SessionPrompt.prompt(input)).info.role).toBe("user")
        } finally {
          write.resume()
          write.restore()
          idle.unsubscribe()
          await Session.remove(session.id)
        }
      },
    })
  })

  test("ensureTitle has catch handler", async () => {
    const source = await Bun.file(PROMPT_SRC).text()
    // Find the ensureTitle call site (not the function definition)
    const callSite = source.indexOf("ensureTitle({")
    expect(callSite).toBeGreaterThan(-1)
    // The call must be followed by .catch() within the same expression
    const afterCall = source.slice(callSite, callSite + 300)
    expect(afterCall).toMatch(/\.catch\(/)
    expect(afterCall).toMatch(/log\.error/)
  })

  test("prune is awaited", async () => {
    const source = await Bun.file(PROMPT_SRC).text()
    expect(source).toContain("await SessionCompaction.prune")
    // Ensure there is no un-awaited prune call
    const lines = source.split("\n")
    const pruneLines = lines.filter((l) => l.includes("SessionCompaction.prune"))
    for (const line of pruneLines) {
      expect(line.trim()).toMatch(/^await\s+SessionCompaction\.prune/)
    }
  })

  test("SessionRetry exports are defined", () => {
    // Verify retry constants exist and are reasonable
    expect(typeof SessionRetry.RETRY_INITIAL_DELAY).toBe("number")
    expect(SessionRetry.RETRY_INITIAL_DELAY).toBeGreaterThan(0)
    expect(typeof SessionRetry.RETRY_BACKOFF_FACTOR).toBe("number")
    expect(SessionRetry.RETRY_BACKOFF_FACTOR).toBeGreaterThan(1)
  })
})
