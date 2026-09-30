import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { LLM } from "../../src/session/llm"
import { tmpdir } from "../fixture/fixture"

function tool(input: {
  status?: "pending" | "running" | "completed" | "error"
  providerExecuted?: boolean
  error?: string
}) {
  const status = input.status ?? "completed"
  return {
    id: "part_1",
    sessionID: "session_1",
    messageID: "message_1",
    type: "tool",
    callID: "call_1",
    tool: "read",
    metadata:
      input.providerExecuted === undefined
        ? undefined
        : { [MessageV2.PROVIDER_EXECUTED_METADATA_KEY]: input.providerExecuted },
    state:
      status === "pending"
        ? { status, input: {}, raw: "{}" }
        : status === "running"
          ? { status, input: {}, time: { start: 1 } }
          : status === "completed"
            ? {
                status,
                input: {},
                output: "ok",
                title: "read",
                metadata: {},
                time: { start: 1, end: 2 },
              }
            : {
                status,
                input: {},
                error: input.error ?? "failed",
                time: { start: 1, end: 2 },
              },
  } as MessageV2.ToolPart
}

function stream(chunks: unknown[]) {
  const body =
    chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}`)
      .concat("data: [DONE]")
      .join("\n\n") + "\n\n"
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session prompt tool-call continuation", () => {
  test("detects non-provider-executed tool calls that require another model turn", () => {
    expect(SessionPrompt.hasToolCalls([tool({ status: "pending" })])).toBe(false)
    expect(SessionPrompt.hasToolCalls([tool({ status: "running" })])).toBe(false)
    expect(SessionPrompt.hasToolCalls([tool({ status: "completed" })])).toBe(true)
    expect(SessionPrompt.hasToolCalls([tool({ status: "error" })])).toBe(true)
    expect(SessionPrompt.hasToolCalls([tool({ status: "error", error: MessageV2.TOOL_EXECUTION_ABORTED })])).toBe(false)
    expect(
      SessionPrompt.hasToolCalls([
        tool({ status: "error", error: MessageV2.TOOL_EXECUTION_ABORTED, providerExecuted: false }),
      ]),
    ).toBe(true)
  })

  test("ignores provider-executed tool calls", () => {
    expect(SessionPrompt.hasToolCalls([tool({ providerExecuted: true })])).toBe(false)
  })

  test("checks stored parts only after an error-free model finish", async () => {
    const message = { id: "message_1", finish: "tool-calls" } as MessageV2.Assistant
    const calls: string[] = []
    const load = async () => {
      calls.push("load")
      return []
    }
    expect(SessionPrompt.isModelFinished("tool-calls")).toBe(false)
    expect(SessionPrompt.isModelFinished("unknown")).toBe(false)
    expect(SessionPrompt.isModelFinished("stop")).toBe(true)
    expect(await SessionPrompt.missingStructuredOutput(message, load)).toBe(false)
    expect(
      await SessionPrompt.missingStructuredOutput(
        { ...message, finish: "stop", error: { name: "error" } } as unknown as MessageV2.Assistant,
        load,
      ),
    ).toBe(false)
    expect(calls).toHaveLength(0)
    expect(await SessionPrompt.missingStructuredOutput({ ...message, finish: "stop" }, load)).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test("stops after partial tool input when the provider reports stop", async () => {
    await using tmp = await tmpdir({
      config: {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test-key" } } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Partial tool input" })
        const calls: string[] = []
        const stream = spyOn(LLM, "stream").mockImplementation(async () => {
          calls.push("model")
          if (calls.length > 1) throw new Error("partial input caused an extra model turn")
          return {
            fullStream: (async function* () {
              yield { type: "start-step" }
              yield { type: "tool-input-start", id: "partial", toolName: "read" }
              yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: "alibaba", modelID: "qwen-plus" },
            parts: [{ type: "text", text: "Read a file" }],
          })
          expect(calls).toHaveLength(1)
          const parts = (await Session.messages({ sessionID: session.id })).flatMap((message) => message.parts)
          expect(parts.some((part) => part.type === "tool" && part.state.status === "error")).toBe(true)
        } finally {
          stream.mockRestore()
        }
      },
    })
  })

  test("continues structured output after a provider reports stop with a local tool call", async () => {
    const requests: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push((await request.json()) as Record<string, unknown>)
        const call = requests.length === 1 ? "read" : "StructuredOutput"
        const args = requests.length === 1 ? { filePath: "aictrl.json" } : { result: "follow-up reached" }
        return stream([
          {
            id: `chatcmpl-${requests.length}`,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          },
          {
            id: `chatcmpl-${requests.length}`,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${requests.length}`,
                      type: "function",
                      function: { name: call, arguments: JSON.stringify(args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: `chatcmpl-${requests.length}`,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ])
      },
    })

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "aictrl.json"),
            JSON.stringify({
              $schema: "https://aictrl.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({ title: "Tool continuation fixture" })
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: "alibaba", modelID: "qwen-plus" },
            parts: [{ type: "text", text: "Return structured output after using a tool." }],
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
              retryCount: 0,
            },
          })

          expect(requests).toHaveLength(2)
          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") throw new Error("Expected assistant result")
          expect(result.info.structured).toEqual({ result: "follow-up reached" })
          expect(result.info.error).toBeUndefined()

          const messages = await Session.messages({ sessionID: session.id })
          const first = messages.find(
            (message) =>
              message.info.role === "assistant" &&
              message.parts.some((part) => part.type === "tool" && part.tool === "read"),
          )
          expect(first?.info.role === "assistant" ? first.info.finish : undefined).toBe("stop")
          expect(first?.info.role === "assistant" ? first.info.error : undefined).toBeUndefined()
        },
      })
    } finally {
      server.stop()
    }
  }, 15_000)
})
