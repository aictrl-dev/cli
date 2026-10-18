import { describe, expect, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Identifier } from "../../src/id/id"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { SessionProcessor } from "../../src/session/processor"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"
import { alibabaProvider } from "../fixture/providers"

describe("session processor tool metadata", () => {
  test("persists provider-executed attribution from the stream", async () => {
    await using tmp = await tmpdir({
      config: {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { ...alibabaProvider, options: { apiKey: "test-key" } } },
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
            yield { type: "tool-input-start", id: "call_2", toolName: "server_tool" }
            yield {
              type: "tool-call",
              toolCallId: "call_2",
              toolName: "server_tool",
              input: { second: true },
              providerExecuted: false,
              providerMetadata: { providerExecuted: true },
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

          const parts = (await Session.messages({ sessionID: session.id })).flatMap((message) => message.parts)
          const first = parts.find((part) => part.type === "tool" && part.callID === "call_1")
          const second = parts.find((part) => part.type === "tool" && part.callID === "call_2")
          expect(first?.type === "tool" ? first.metadata?.providerExecuted : undefined).toBe(true)
          expect(second?.type === "tool" ? second.metadata?.providerExecuted : undefined).toBe(false)
        } finally {
          stream.mockRestore()
        }
      },
    })
  })
})

describe("session processor doom loop", () => {
  test("checks repeated tool calls against the agent and session rules", async () => {
    await using tmp = await tmpdir({
      config: {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test-key" } } },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const permission: PermissionNext.Ruleset = [{ permission: "doom_loop", action: "deny", pattern: "*" }]
        const session = await Session.create({ title: "Doom loop fixture", permission })
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
            for (const id of ["call_1", "call_2", "call_3"]) {
              yield { type: "tool-input-start", id, toolName: "read" }
              yield { type: "tool-call", toolCallId: id, toolName: "read", input: { filePath: "same.ts" } }
            }
            yield {
              type: "finish-step",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }
          })(),
        } as unknown as Awaited<ReturnType<typeof LLM.stream>>)
        const checks: PermissionNext.Ruleset[] = []
        const ask = spyOn(PermissionNext, "ask").mockImplementation((async (
          request: PermissionNext.Request & {
            ruleset: PermissionNext.Ruleset
          },
        ) => {
          if (request.permission === "doom_loop") checks.push(request.ruleset)
        }) as unknown as typeof PermissionNext.ask)

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
            permission,
            abort: new AbortController().signal,
            system: [],
            messages: [],
            tools: {},
          })

          expect(checks).toHaveLength(1)
          // the build agent asks on a doom loop; the session rule denies it
          expect(PermissionNext.evaluate("doom_loop", "read", checks[0]).action).toBe("deny")
        } finally {
          stream.mockRestore()
          ask.mockRestore()
        }
      },
    })
  })
})
