import { describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const provider = {
  fixture: {
    npm: "@ai-sdk/google",
    options: { apiKey: "fixture" },
    models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
  },
}

describe("prompt finish guards", () => {
  test("Gemini receives the final-step instruction as a user turn", async () => {
    await using tmp = await tmpdir({ git: true, config: { provider, agent: { build: { steps: 1 } } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Gemini step instruction" })
        const requests: LLM.StreamInput["messages"][] = []
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          requests.push(input.messages)
          return {
            fullStream: (async function* () {
              yield { type: "start-step" }
              yield { type: "text-start" }
              yield { type: "text-delta", text: "Done" }
              yield { type: "text-end" }
              yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        try {
          const answer = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "fixture", modelID: "gemini-fixture" },
            parts: [{ type: "text", text: "Finish the task" }],
          })
          expect(answer.info.role).toBe("assistant")
          expect(requests).toHaveLength(1)
          expect(requests[0].at(-1)).toMatchObject({ role: "user" })
          expect(requests[0].at(-1)?.content).toContain("MAXIMUM STEPS REACHED")
        } finally {
          stream.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  })

  test("stops at the hard step cap when the model keeps calling tools", async () => {
    await using tmp = await tmpdir({ git: true, config: { provider, agent: { build: { steps: 2 } } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Hard step cap" })
        const requests: LLM.StreamInput["messages"][] = []
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          requests.push(input.messages)
          if (requests.length > 2) throw new Error("step cap allowed an extra model call")
          return {
            fullStream: (async function* () {
              yield { type: "start-step" }
              yield { type: "tool-input-start", id: `call-${requests.length}`, toolName: "Read" }
              yield { type: "tool-call", toolCallId: `call-${requests.length}`, toolName: "Read", input: {} }
              yield {
                type: "tool-result",
                toolCallId: `call-${requests.length}`,
                input: {},
                output: { output: "file content", title: "Read file", metadata: {} },
              }
              yield {
                type: "finish-step",
                finishReason: requests.length > 2 ? "stop" : "tool-calls",
                usage: { inputTokens: 1, outputTokens: 1 },
              }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        try {
          const answer = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "fixture", modelID: "gemini-fixture" },
            parts: [{ type: "text", text: "Keep reading" }],
          })
          expect(requests).toHaveLength(2)
          expect(answer.info.role).toBe("assistant")
          if (answer.info.role !== "assistant") throw new Error("expected assistant")
          expect(answer.info.finish).toBe("stop")
          expect(MessageV2.APIError.isInstance(answer.info.error)).toBe(true)
          if (!MessageV2.APIError.isInstance(answer.info.error)) throw new Error("expected APIError")
          expect(answer.info.error.data.message).toContain("Agent step limit (2) reached")
          const messages = await Session.messages({ sessionID: session.id })
          expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(2)
          expect(messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")).toHaveLength(2)
        } finally {
          stream.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  })

  test("keeps unknown-finish text and exits after one model call", async () => {
    await using tmp = await tmpdir({ git: true, config: { provider, agent: { build: { steps: 3 } } } })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Unknown finish text" })
        const requests: LLM.StreamInput["messages"][] = []
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          requests.push(input.messages)
          return {
            fullStream: (async function* () {
              yield { type: "start-step" }
              yield { type: "text-start" }
              yield { type: "text-delta", text: "A possibly incomplete answer" }
              yield { type: "text-end" }
              yield { type: "finish-step", finishReason: "unknown", usage: { inputTokens: 1, outputTokens: 1 } }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        try {
          const answer = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "fixture", modelID: "gemini-fixture" },
            parts: [{ type: "text", text: "Answer the question" }],
          })
          expect(requests).toHaveLength(1)
          expect(answer.info.role).toBe("assistant")
          if (answer.info.role !== "assistant") throw new Error("expected assistant")
          expect(answer.info.finish).toBe("stop")
          expect(answer.info.error).toBeUndefined()
          expect(answer.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
            "A possibly incomplete answer",
          ])
          const messages = await Session.messages({ sessionID: session.id })
          expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(1)
        } finally {
          stream.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  })
})
