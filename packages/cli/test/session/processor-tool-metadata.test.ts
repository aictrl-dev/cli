import { describe, expect, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

describe("session processor tool metadata", () => {
  test("persists provider-executed attribution from the stream", async () => {
    await using tmp = await tmpdir({
      config: {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test-key" } } },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Provider tool metadata fixture" })
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
            yield { type: "tool-input-start", id: "call_1", toolName: "server_tool" }
            yield {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "server_tool",
              input: {},
              providerExecuted: true,
            }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
          })(),
        } as unknown as Awaited<ReturnType<typeof LLM.stream>>)

        try {
          const processor = SessionProcessor.create({
            assistantMessage: assistant,
            sessionID: session.id,
            model,
            abort: new AbortController().signal,
          })
          await processor.process({
            user,
            sessionID: session.id,
            model,
            agent,
            abort: new AbortController().signal,
            system: [],
            messages: [],
            tools: {},
          })

          const part = (await Session.messages({ sessionID: session.id }))
            .flatMap((message) => message.parts)
            .find((item) => item.type === "tool" && item.callID === "call_1")
          expect(part?.type === "tool" ? part.metadata?.providerExecuted : undefined).toBe(true)
        } finally {
          stream.mockRestore()
        }
      },
    })
  })
})
