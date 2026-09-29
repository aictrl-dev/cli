import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

describe("headless retry after missing finish reason", () => {
  test("retries a thought-only stream and records the retry", async () => {
    await using tmp = await tmpdir()
    const roles: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { contents?: { role: string }[] }
        roles.push(body.contents?.at(-1)?.role ?? "empty")
        if (roles.at(-1) !== "user") return new Response("trailing model turn", { status: 400 })
        const chunks =
          roles.length === 1
            ? [
                ...["Checking", " the", " task"].map((text) => ({
                  candidates: [{ index: 0, content: { role: "model", parts: [{ text, thought: true }] } }],
                })),
                { error: { code: 500, status: "INTERNAL" } },
              ]
            : [
                {
                  candidates: [
                    { index: 0, content: { role: "model", parts: [{ text: "Completed." }] }, finishReason: "STOP" },
                  ],
                  usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
                },
              ]
        const bodyText =
          roles.length === 1
            ? chunks
                .slice(0, -1)
                .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                .join("") +
              JSON.stringify(chunks.at(-1)) +
              "\n"
            : chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
        return new Response(bodyText, { headers: { "content-type": "text/event-stream" } })
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
    const home = path.join(tmp.path, "home")
    await Bun.write(path.join(home, ".keep"), "")
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
        "Complete the task.",
      ],
      {
        cwd: tmp.path,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local/share"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
          AICTRL_DISABLE_MODELS_FETCH: "true",
          AICTRL_DISABLE_AUTOCOMPACT: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timeout = setTimeout(() => proc.kill("SIGKILL"), 20000)
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
      expect(exit, stderr + stdout).toBe(0)
      expect(roles).toEqual(["user", "user"])
      expect(events.filter((event) => event.type === "retry")).toMatchObject([
        { attempt: 1, reason: expect.stringContaining("without finishReason") },
      ])
      expect(events.filter((event) => event.type === "step_finish").map((event) => event.part.reason)).toContain(
        "unknown",
      )
      expect(events.find((event) => event.type === "message_complete")).toMatchObject({
        finish: "stop",
        status: "completed",
      })
      expect(events.find((event) => event.type === "invocation_complete")).toMatchObject({ status: "completed" })
      expect(events.filter((event) => event.type === "session_error")).toHaveLength(0)
    } finally {
      clearTimeout(timeout)
      proc.kill("SIGKILL")
      server.stop(true)
    }
  }, 25000)
})
