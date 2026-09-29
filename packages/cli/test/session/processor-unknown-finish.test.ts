import { describe, expect, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { tmpdir } from "../fixture/fixture"

describe("processor unknown finish", () => {
  test.each(["recover", "exhaust", "tool-call", "text"] as const)("%s", async (scenario) => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          fixture: {
            npm: "@ai-sdk/google",
            options: { apiKey: "fixture" },
            models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const model = await Provider.getModel("fixture", "gemini-fixture")
        const agent = await Agent.get("build")
        const abort = new AbortController().signal
        const user: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: model.providerID, modelID: model.id },
        }
        const message: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          parentID: user.id,
          role: "assistant",
          time: { created: Date.now() },
          agent: agent.name,
          mode: agent.name,
          modelID: model.id,
          providerID: model.providerID,
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        await Session.updateMessage(user)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: user.id,
          type: "text",
          text: "Continue the task.",
        })
        await Session.updateMessage(message)
        const requests: LLM.StreamInput["messages"][] = []
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          requests.push(input.messages)
          const finish = scenario === "recover" && requests.length === 2 ? "stop" : "unknown"
          return {
            fullStream: (async function* () {
              yield { type: "start-step" }
              yield { type: "reasoning-start", id: "thought" }
              yield {
                type: "reasoning-delta",
                id: "thought",
                text: scenario === "recover" && requests.length === 2 ? "Successful thought" : "Discarded thought",
              }
              yield { type: "reasoning-end", id: "thought" }
              if (scenario === "recover" || scenario === "text") {
                yield { type: "text-start" }
                if (scenario === "text" || requests.length === 2) {
                  yield { type: "text-delta", text: "Answer" }
                }
                yield { type: "text-end" }
              }
              if (scenario === "tool-call") {
                yield { type: "tool-input-start", id: "call", toolName: "read" }
                yield { type: "tool-call", toolCallId: "call", toolName: "read", input: {} }
              }
              yield { type: "finish-step", finishReason: finish, usage: { inputTokens: 1, outputTokens: 1 } }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        const sleep = spyOn(SessionRetry, "sleep").mockResolvedValue()
        try {
          const result = await SessionProcessor.create({
            assistantMessage: message,
            sessionID: session.id,
            model,
            abort,
          }).process({
            user,
            sessionID: session.id,
            model,
            agent,
            abort,
            system: [],
            messages: MessageV2.toModelMessages(await MessageV2.filterCompacted(MessageV2.stream(session.id)), model),
            tools: {},
          })
          expect(requests.every((request) => request.at(-1)?.role === "user")).toBe(true)
          expect(requests).toHaveLength(
            scenario === "recover" ? 2 : scenario === "exhaust" ? SessionRetry.MAX_RETRY_ATTEMPTS + 1 : 1,
          )
          expect(sleep).toHaveBeenCalledTimes(
            scenario === "recover" ? 1 : scenario === "exhaust" ? SessionRetry.MAX_RETRY_ATTEMPTS : 0,
          )
          expect(result).toBe(scenario === "exhaust" ? "stop" : "continue")
          if (scenario === "exhaust") {
            expect(MessageV2.APIError.isInstance(message.error)).toBe(true)
            expect(message.error?.data.message).toContain("without finishReason")
            expect(message.error?.data.message).toContain("Max retry attempts")
          } else {
            expect(message.error).toBeUndefined()
          }
          if (scenario === "recover") {
            const parts = await MessageV2.parts(message.id)
            expect(parts.map((part) => part.type)).toEqual(["step-start", "reasoning", "text", "step-finish"])
            expect(parts.find((part) => part.type === "reasoning")?.text).toBe("Successful thought")
            expect(parts.find((part) => part.type === "text")?.text).toBe("Answer")
            expect(parts.find((part) => part.type === "step-finish")?.reason).toBe("stop")
            const history = MessageV2.toModelMessages(
              await MessageV2.filterCompacted(MessageV2.stream(session.id)),
              model,
            )
            expect(JSON.stringify(history)).toContain("Successful thought")
            expect(JSON.stringify(history)).not.toContain("Discarded thought")
          }
        } finally {
          stream.mockRestore()
          sleep.mockRestore()
        }
      },
    })
  })
})
