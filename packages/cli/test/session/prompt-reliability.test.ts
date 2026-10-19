import path from "path"
import { describe, expect, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { SessionRetry } from "../../src/session/retry"
import { Instance } from "../../src/project/instance"
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
