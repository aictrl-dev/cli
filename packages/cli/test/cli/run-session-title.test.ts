import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { sessionTitle } from "../../src/cli/cmd/run"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const TITLE_PROMPT = "Generate a title for this conversation"

describe("sessionTitle (#145)", () => {
  test("--title <text> is used as given", () => {
    expect(sessionTitle({ title: "Release notes", prompt: "Summarise.", message: "Summarise." })).toBe("Release notes")
  })

  test('--title "" keeps the raw message, truncated', () => {
    const message = '"Summarise the changes."\n'
    expect(sessionTitle({ title: "", prompt: "Summarise the changes.", message })).toBe(message)
    expect(sessionTitle({ title: "", prompt: "", message: "x".repeat(60) })).toBe("x".repeat(50) + "...")
  })

  test("defaults to the prompt as typed, without the quoting added for the model", () => {
    const message = '"fix the \\"login\\" bug"\n'
    expect(sessionTitle({ prompt: 'fix the "login" bug', message })).toBe('fix the "login" bug')
    expect(sessionTitle({ prompt: "x".repeat(60), message: "x".repeat(60) })).toBe("x".repeat(50) + "...")
  })

  test("defaults to the trimmed message when the prompt only arrives on stdin", () => {
    expect(sessionTitle({ prompt: "", message: "\nReview this diff.\n" })).toBe("Review this diff.")
  })

  test("truncates by code point, never splitting a surrogate pair", () => {
    const prompt = "a" + "\u{1F600}".repeat(60)
    expect(sessionTitle({ prompt, message: prompt })).toBe("a" + "\u{1F600}".repeat(49) + "...")
  })

  test("defaults to the command and its arguments for command runs", () => {
    expect(sessionTitle({ prompt: "this input", message: '"this input"\n', command: "check" })).toBe(
      "/check this input",
    )
    expect(sessionTitle({ prompt: "", message: "\n", command: "review" })).toBe("/review")
  })
})

describe("headless run title generation (#145)", () => {
  test.each([
    ["prompt", ["Check this input."]],
    ["command", ["--command", "check", "this input"]],
  ] as const)(
    "a %s run without --title makes no title-generation request",
    async (_, input) => {
      await using tmp = await tmpdir()
      const requests: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests.push(await request.text())
          const chunk = {
            candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Done." }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
          }
          return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      // Unlike the other run fixtures, the title agent stays enabled, and small_model routes
      // any title-generation request to this fixture server so the test can observe it.
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
          small_model: "fixture/gemini-fixture",
          command: { check: { template: "Check $ARGUMENTS." } },
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
          "--model",
          "fixture/gemini-fixture",
          ...input,
        ],
        {
          cwd: tmp.path,
          env: {
            ...process.env,
            AICTRL_DISABLE_MODELS_FETCH: "true",
            AICTRL_DISABLE_AUTOCOMPACT: "true",
          },
          stdin: "ignore",
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
        expect(exit, stderr + stdout).toBe(0)
        expect(requests.filter((body) => body.includes(TITLE_PROMPT))).toHaveLength(0)
        expect(requests).toHaveLength(1)
      } finally {
        clearTimeout(timeout)
        proc.kill("SIGKILL")
        server.stop(true)
      }
    },
    20000,
  )
})
