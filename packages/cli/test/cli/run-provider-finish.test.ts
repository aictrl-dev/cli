import { describe, expect, test } from "bun:test"
import path from "path"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

describe("headless provider finish reasons (#108)", () => {
  test.each([
    ["MALFORMED_FUNCTION_CALL", "error", 1, false, false],
    ["MALFORMED_FUNCTION_CALL", "error", 1, true, true],
    ["SAFETY", "content-filter", 1, false, false],
    ["RECITATION", "content-filter", 1, false, false],
    ["BLOCKLIST", "content-filter", 1, false, false],
    ["SPII", "content-filter", 1, false, false],
    ["PROHIBITED_CONTENT", "content-filter", 1, false, false],
    ["FINISH_REASON_UNSPECIFIED", "other", 0, false, false],
    ["OTHER", "other", 0, false, false],
    ["STOP", "stop", 0, false, false],
    ["STOP", "stop", 0, true, false],
    ["MAX_TOKENS", "length", 0, false, false],
  ] as const)(
    "normal Gemini stream ending %s",
    async (reason, finish, code, tool, partial) => {
      await using tmp = await tmpdir()
      let calls = 0
      const server = Bun.serve({
        port: 0,
        fetch(): Response {
          calls++
          const chunks =
            tool && calls === 1
              ? [
                  {
                    candidates: [
                      {
                        index: 0,
                        content: {
                          role: "model",
                          parts: [
                            { functionCall: { name: "read", args: { filePath: path.join(tmp.path, "aictrl.json") } } },
                          ],
                        },
                        finishReason: "STOP",
                      },
                    ],
                    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
                  },
                ]
              : [
                  {
                    candidates: [
                      {
                        index: 0,
                        content: {
                          role: "model",
                          parts: [
                            { text: "Checking the input.", thought: true },
                            ...(partial ? [{ text: "Partial review." }] : []),
                          ],
                        },
                      },
                    ],
                  },
                  {
                    candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: reason }],
                    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
                  },
                ]
          return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      await Bun.write(
        path.join(tmp.path, "aictrl.json"),
        JSON.stringify({
          provider: {
            fixture: {
              npm: "@ai-sdk/google",
              options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}` },
              models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
            },
          },
          agent: { title: { disable: true } },
        }),
      )
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "--conditions=browser",
          entry,
          "run",
          "--format",
          "json",
          "--thinking",
          "--model",
          "fixture/gemini-fixture",
          "Check this input.",
        ],
        {
          cwd: tmp.path,
          env: {
            ...process.env,
            AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
            AICTRL_DISABLE_MODELS_FETCH: "true",
            AICTRL_DISABLE_AUTOCOMPACT: "true",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timeout = setTimeout(() => proc.kill("SIGKILL"), 15000)
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        const events = stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line))
        expect(exit, stderr + stdout).toBe(code)
        expect(calls).toBe(tool ? 2 : 1)
        const message = events.filter((event) => event.type === "message_complete")
        expect(message, stdout).toHaveLength(tool ? 2 : 1)
        if (tool) {
          expect(message[0].finish).toBe("tool-calls")
          expect(events.filter((event) => event.type === "tool_use")).toHaveLength(1)
        }
        expect(message.at(-1).finish).toBe(finish)
        expect(message.at(-1).status).toBe(code ? "error" : "completed")
        expect(message.at(-1).usageStatus).toBe("reported")
        expect(message.at(-1).tokens).toMatchObject({ input: 7, output: 3 })
        expect(events.filter((event) => event.type === "reasoning")).toHaveLength(1)
        expect(events.filter((event) => event.type === "text")).toHaveLength(partial ? 1 : 0)
        expect(events.filter((event) => event.type === "session_complete")).toHaveLength(1)
        expect(events.filter((event) => event.type === "invocation_complete")).toHaveLength(1)
        const invocation = events.find((event) => event.type === "invocation_complete")
        expect(invocation.status).toBe(code ? "error" : "completed")
        for (const event of events.filter((event) =>
          ["message_complete", "session_error", "session_complete"].includes(event.type),
        )) {
          expect(event.sessionID).toBe(invocation.sessionID)
          expect(event.invocationID).toBe(invocation.invocationID)
        }
        expect(events.filter((event) => event.type === "session_error")).toHaveLength(code ? 1 : 0)
        if (code) {
          expect(events.find((event) => event.type === "session_error").reason).toBe("provider")
          expect(events.find((event) => event.type === "session_complete").error).toBeTruthy()
          expect(events.filter((event) => event.type === "error")).toHaveLength(1)
          const failure = events.find((event) => event.type === "error")
          expect(failure.error).toMatchObject({
            name: "APIError",
            data: { isRetryable: false, metadata: { finishReason: finish } },
          })
          expect(failure.sessionID).toBe(invocation.sessionID)
          expect(failure.invocationID).toBe(invocation.invocationID)
          expect(events.findIndex((event) => event.type === "session_error")).toBeLessThan(
            events.findIndex((event) => event.type === "session_complete"),
          )
        }
      } finally {
        clearTimeout(timeout)
        proc.kill("SIGKILL")
        server.stop(true)
      }
    },
    20000,
  )
})

describe("pinned Google adapter finish mappings", () => {
  test.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "length"],
    ["IMAGE_SAFETY", "content-filter"],
    ["RECITATION", "content-filter"],
    ["SAFETY", "content-filter"],
    ["BLOCKLIST", "content-filter"],
    ["PROHIBITED_CONTENT", "content-filter"],
    ["SPII", "content-filter"],
    ["MALFORMED_FUNCTION_CALL", "error"],
    ["OTHER", "other"],
    ["FINISH_REASON_UNSPECIFIED", "other"],
    ["LANGUAGE", "unknown"],
  ])("%s → %s", async (raw, normalized) => {
    const provider = createGoogleGenerativeAI({
      apiKey: "fixture",
      fetch: Object.assign(
        async () =>
          new Response(
            `data: ${JSON.stringify({
              candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: raw }],
              usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
        { preconnect: globalThis.fetch.preconnect },
      ),
    })
    const response = await provider("gemini-fixture").doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    })
    const reader = response.stream.getReader()
    let finish: string | undefined
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === "finish") finish = value.finishReason
    }
    expect(finish).toBe(normalized)
  })
})
