import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

function tool(input: { status?: "pending" | "running" | "completed" | "error"; providerExecuted?: boolean }) {
  const status = input.status ?? "completed"
  return {
    id: "part_1",
    sessionID: "session_1",
    messageID: "message_1",
    type: "tool",
    callID: "call_1",
    tool: "read",
    metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
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
                error: "failed",
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
    expect(SessionPrompt.hasToolCalls([tool({ status: "pending" })])).toBe(true)
    expect(SessionPrompt.hasToolCalls([tool({ status: "completed" })])).toBe(true)
    expect(SessionPrompt.hasToolCalls([tool({ status: "error" })])).toBe(true)
  })

  test("ignores provider-executed tool calls", () => {
    expect(SessionPrompt.hasToolCalls([tool({ providerExecuted: true })])).toBe(false)
  })

  test("continues structured output after a provider reports stop with a local tool call", async () => {
    const requests: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push((await request.json()) as Record<string, unknown>)
        const call = requests.length === 1 ? "invalid" : "StructuredOutput"
        const args =
          requests.length === 1 ? { tool: "missing", error: "fixture tool call" } : { result: "follow-up reached" }
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
              message.parts.some((part) => part.type === "tool" && part.tool === "invalid"),
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
