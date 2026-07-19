import { describe, expect, test } from "bun:test"
import path from "path"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const sessionID = "ses_signal_test"

async function server() {
  const state: {
    stream?: ReadableStreamDefaultController<Uint8Array>
    prompted: boolean
  } = { prompted: false }
  const encoder = new TextEncoder()
  const app = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({ id: sessionID })
      }
      if (request.method === "GET" && url.pathname === "/config") {
        return Response.json({})
      }
      if (request.method === "GET" && url.pathname === "/event") {
        return new Response(
          new ReadableStream({
            start(controller) {
              state.stream = controller
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      if (request.method === "POST" && url.pathname.endsWith("/message")) {
        state.prompted = true
        return Response.json({})
      }
      if (request.method === "POST" && url.pathname.endsWith("/abort")) {
        state.stream?.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "session.status",
              properties: {
                sessionID,
                status: { type: "idle" },
              },
            })}\n\n`,
          ),
        )
        return Response.json(true)
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  return {
    app,
    state,
    url: `http://localhost:${app.port}`,
  }
}

function events(stdout: string) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

describe("run --format json graceful signal cancellation", () => {
  test.each([
    ["SIGINT", "interrupted", 130],
    ["SIGTERM", "terminated", 143],
  ] as const)(
    "%s cancels the active session before completing",
    async (name, reason, code) => {
      const mock = await server()
      const proc = Bun.spawn(
        ["bun", "run", "--conditions=browser", entry, "run", "--format", "json", "--attach", mock.url, "test"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timeout = setTimeout(() => proc.kill("SIGKILL"), 15_000)

      try {
        for (let tries = 0; !mock.state.prompted && tries < 300; tries++) {
          await Bun.sleep(25)
        }
        expect(mock.state.prompted).toBe(true)

        proc.kill(name)

        const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
        expect(exit).toBe(code)
        const output = events(stdout)
        const error = output.findIndex((event) => event.type === "session_error")
        const complete = output.findIndex((event) => event.type === "session_complete")
        expect(output.filter((event) => event.type === "session_error")).toHaveLength(1)
        expect(output.filter((event) => event.type === "session_complete")).toHaveLength(1)
        expect(error).toBeGreaterThan(-1)
        expect(complete).toBeGreaterThan(error)
        expect(output[error]).toMatchObject({
          reason,
          code: String(code),
        })
        expect(output[error].reason).not.toBe("timeout")
      } finally {
        clearTimeout(timeout)
        proc.kill("SIGKILL")
        mock.app.stop(true)
      }
    },
    20_000,
  )
})
