import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

describe("headless provider finish reasons (#108)", () => {
  test.each([
    ["MALFORMED_FUNCTION_CALL", "error", 1, false, false],
    ["MALFORMED_FUNCTION_CALL", "error", 1, true, true],
    ["SAFETY", "content-filter", 1, false, false],
    ["STOP", "stop", 0, false, false],
    ["STOP", "stop", 0, true, false],
    ["MAX_TOKENS", "length", 0, false, false],
  ] as const)(
    "normal Gemini stream ending %s",
    async (reason, finish, code, tool, partial) => {
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
      await using tmp = await tmpdir({
        config: {
          provider: {
            fixture: {
              npm: "@ai-sdk/google",
              options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}` },
              models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
            },
          },
          agent: { title: { disable: true } },
        },
      })
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
