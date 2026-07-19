import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
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
})
