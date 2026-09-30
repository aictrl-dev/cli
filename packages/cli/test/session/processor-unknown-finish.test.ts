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
import path from "path"
import { Bus } from "../../src/bus"
import { PermissionNext } from "../../src/permission/next"

describe("processor unknown finish", () => {
  test.each([
    "recover",
    "exhaust",
    "tool-call",
    "text",
    "text-and-tool",
    "midstream",
    "provider-exhaust",
    "pending",
    "provider-terminal",
    "doom",
  ] as const)("%s", async (scenario) => {
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
        const patches: string[] = []
        const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
          const part = event.properties.part
          if (part.messageID === message.id && part.type === "patch") patches.push(part.id)
        })
        const requests: LLM.StreamInput["messages"][] = []
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          requests.push(input.messages)
          const finish =
            ((scenario === "recover" || scenario === "midstream" || scenario === "pending") && requests.length === 2) ||
            (scenario === "doom" && requests.length === 4)
              ? "stop"
              : "unknown"
          return {
            fullStream: (async function* () {
              yield { type: "start-step" }
              yield { type: "reasoning-start", id: "thought" }
              yield {
                type: "reasoning-delta",
                id: "thought",
                text:
                  ((scenario === "recover" || scenario === "midstream" || scenario === "pending") &&
                    requests.length === 2) ||
                  (scenario === "doom" && requests.length === 4)
                    ? "Successful thought"
                    : "Discarded thought",
              }
              yield { type: "reasoning-end", id: "thought" }
              if (scenario === "midstream" || scenario === "provider-exhaust" || scenario === "provider-terminal") {
                if (scenario !== "midstream" || requests.length === 1) {
                  await Bun.write(path.join(tmp.path, "attempt.txt"), "created")
                  throw new MessageV2.APIError({
                    message:
                      scenario === "provider-terminal"
                        ? "Provider rejected request"
                        : "Provider failed with fake-token-123",
                    statusCode: scenario === "provider-terminal" ? 400 : 500,
                    isRetryable: scenario !== "provider-terminal",
                    responseHeaders: { authorization: "fake-token-123" },
                    responseBody: "fake-token-123",
                  })
                }
              }
              if (
                scenario === "recover" ||
                scenario === "midstream" ||
                scenario === "pending" ||
                (scenario === "doom" && requests.length === 4) ||
                scenario === "text" ||
                scenario === "text-and-tool"
              ) {
                yield { type: "text-start" }
                if (
                  scenario === "text" ||
                  scenario === "text-and-tool" ||
                  requests.length === 2 ||
                  (scenario === "doom" && requests.length === 4)
                ) {
                  yield { type: "text-delta", text: "Answer" }
                }
                yield { type: "text-end" }
              }
              if (scenario === "tool-call" || scenario === "text-and-tool") {
                yield { type: "tool-input-start", id: "call", toolName: "read" }
                yield { type: "tool-call", toolCallId: "call", toolName: "read", input: {} }
              }
              if (scenario === "doom" && requests.length <= 3) {
                yield { type: "tool-input-start", id: `call-${requests.length}`, toolName: "read" }
                yield {
                  type: "tool-call",
                  toolCallId: `call-${requests.length}`,
                  toolName: "read",
                  input: { path: "same" },
                }
                yield {
                  type: "tool-result",
                  toolCallId: `call-${requests.length}`,
                  input: { path: "same" },
                  output: { output: "done", title: "read", metadata: {} },
                }
                throw new MessageV2.APIError({ message: "Transient error", statusCode: 500, isRetryable: true })
              }
              if (scenario === "pending" && requests.length === 1) {
                yield { type: "tool-input-start", id: "partial", toolName: "read" }
              }
              yield { type: "finish-step", finishReason: finish, usage: { inputTokens: 1, outputTokens: 1 } }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        const rollbacks: { parts: number; finish?: string; cost: number; tokens: MessageV2.Assistant["tokens"] }[] = []
        const sleep = spyOn(SessionRetry, "sleep").mockImplementation(async () => {
          const stored = await MessageV2.get({ sessionID: session.id, messageID: message.id })
          if (stored.info.role !== "assistant") return
          rollbacks.push({
            parts: stored.parts.length,
            finish: stored.info.finish,
            cost: stored.info.cost,
            tokens: stored.info.tokens,
          })
        })
        const ask = spyOn(PermissionNext, "ask").mockResolvedValue()
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
            scenario === "recover" || scenario === "midstream" || scenario === "pending" || scenario === "doom"
              ? scenario === "doom"
                ? 4
                : 2
              : scenario === "exhaust" || scenario === "provider-exhaust"
                ? SessionRetry.MAX_RETRY_ATTEMPTS + 1
                : 1,
          )
          expect(sleep).toHaveBeenCalledTimes(
            scenario === "recover" || scenario === "midstream" || scenario === "pending" || scenario === "doom"
              ? scenario === "doom"
                ? 3
                : 1
              : scenario === "exhaust" || scenario === "provider-exhaust"
                ? SessionRetry.MAX_RETRY_ATTEMPTS
                : 0,
          )
          expect(rollbacks).toHaveLength(sleep.mock.calls.length)
          expect(
            rollbacks.every(
              (item) =>
                item.parts === (scenario === "midstream" || scenario === "provider-exhaust" ? 1 : 0) &&
                item.finish === undefined &&
                item.cost === 0 &&
                JSON.stringify(item.tokens) ===
                  JSON.stringify({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
            ),
          ).toBe(true)
          expect(ask).toHaveBeenCalledTimes(scenario === "doom" ? 1 : 0)
          if (scenario === "doom") expect(ask.mock.calls[0]?.[0]).toMatchObject({ permission: "doom_loop" })
          expect(result).toBe(
            scenario === "exhaust" || scenario === "provider-exhaust" || scenario === "provider-terminal"
              ? "stop"
              : "continue",
          )
          if (scenario === "exhaust" || scenario === "provider-exhaust" || scenario === "provider-terminal") {
            const error = message.error
            if (!MessageV2.APIError.isInstance(error)) throw new Error("Expected APIError")
            if (scenario !== "provider-terminal") expect(error.data.message).toContain("Max retry attempts")
            if (scenario === "exhaust") expect(await MessageV2.parts(message.id)).toEqual([])
            expect(message.cost).toBe(0)
            expect(message.finish).toBeUndefined()
            if (scenario === "exhaust") {
              expect(error.data.metadata).toEqual({ finishReason: "unknown" })
            } else {
              expect(JSON.stringify(error)).not.toContain("fake-token-123")
              expect(error.data.statusCode).toBe(scenario === "provider-terminal" ? 400 : 500)
              expect(error.data.responseHeaders).toBeUndefined()
              expect(error.data.responseBody).toBeUndefined()
            }
          } else {
            expect(message.error).toBeUndefined()
          }
          if (scenario === "text" || scenario === "text-and-tool") {
            expect(message.finish).toBe("stop")
            expect((await MessageV2.parts(message.id)).find((part) => part.type === "text")?.text).toBe("Answer")
          }
          if (scenario === "recover" || scenario === "midstream" || scenario === "pending" || scenario === "doom") {
            const parts = await MessageV2.parts(message.id)
            if (scenario === "midstream") {
              expect(patches.length).toBeGreaterThan(0)
              expect(parts.some((part) => patches.includes(part.id))).toBe(true)
            }
            expect(parts.map((part) => part.type)).toEqual(
              scenario === "midstream"
                ? ["patch", "step-start", "reasoning", "text", "step-finish"]
                : ["step-start", "reasoning", "text", "step-finish"],
            )
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
          ask.mockRestore()
          unsub()
        }
      },
    })
  })
})
