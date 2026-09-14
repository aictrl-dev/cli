import { describe, expect, spyOn, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionProcessor } from "../../src/session/processor"
import { SessionStatus } from "../../src/session/status"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

describe("session processor model stream idle timeout", () => {
  test("aborts a stalled provider stream, records the timeout, and returns the session to idle", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {})
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })
    await using tmp = await tmpdir({
      git: true,
      init: (dir) =>
        Bun.write(
          path.join(dir, "aictrl.json"),
          JSON.stringify({
            provider: {
              stalled: {
                name: "Stalled",
                npm: "@ai-sdk/openai-compatible",
                env: [],
                models: {
                  test: {
                    name: "Test",
                    tool_call: true,
                    limit: { context: 128000, output: 4096 },
                  },
                },
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        ),
    })
    const original = process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
    process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "25"

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: "stalled", modelID: "test" },
            parts: [{ type: "text", text: "hello" }],
          })

          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") return
          expect(MessageV2.StreamIdleTimeoutError.isInstance(result.info.error)).toBe(true)
          expect(result.info.error?.data.message).toContain("25ms")
          expect(SessionStatus.get(session.id)).toEqual({ type: "idle" })
        },
      })
    } finally {
      if (original === undefined) delete process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
      else process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = original
    }
  })

  test.each([
    ["local", false, true],
    ["provider-executed", true, false],
  ] as const)(
    "suspends while a %s tool executes and resumes for provider events",
    async (label, providerExecuted, local) => {
      await using tmp = await tmpdir({
        config: {
          enabled_providers: ["alibaba"],
          provider: { alibaba: { options: { apiKey: "test-key" } } },
        },
      })
      const original = process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
      process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "20"

      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const session = await Session.create({ title: `Slow ${label} tool fixture` })
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
            let sideEffectCompleted = false
            const runSlowTool = async () => {
              await Bun.sleep(60)
              sideEffectCompleted = true
              return { output: "done", title: "slow", metadata: {} }
            }
            const slowTool = tool({
              inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
              execute: runSlowTool,
            })
            const stream = spyOn(LLM, "stream").mockResolvedValue({
              fullStream: (async function* () {
                yield { type: "tool-input-start", id: "call_1", toolName: "slow" }
                yield { type: "tool-call", toolCallId: "call_1", toolName: "slow", input: {}, providerExecuted }
                const output = await runSlowTool()
                yield {
                  type: "tool-result",
                  toolCallId: "call_1",
                  toolName: "slow",
                  input: {},
                  output,
                  providerExecuted,
                }
                await new Promise(() => {})
              })(),
            } as unknown as Awaited<ReturnType<typeof LLM.stream>>)

            try {
              const processor = SessionProcessor.create({
                assistantMessage: assistant,
                sessionID: session.id,
                model,
                abort: new AbortController().signal,
              })
              const result = await processor.process({
                user,
                sessionID: session.id,
                model,
                agent,
                abort: new AbortController().signal,
                system: [],
                messages: [],
                tools: local ? { slow: slowTool } : {},
              })

              expect(result).toBe("stop")
              expect(sideEffectCompleted).toBe(true)
              expect(MessageV2.StreamIdleTimeoutError.isInstance(assistant.error)).toBe(true)
              const part = (await MessageV2.parts(assistant.id)).find(
                (item) => item.type === "tool" && item.callID === "call_1",
              )
              expect(part?.type === "tool" ? part.state.status : undefined).toBe("completed")
            } finally {
              stream.mockRestore()
            }
          },
        })
      } finally {
        if (original === undefined) delete process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
        else process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = original
      }
    },
  )
})
