import path from "path"
import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "url"

// Behavioral regression test for aictrl-dev/cli#81:
//   Verify that `session_error` is emitted when a `session.error` event is
//   observed DURING the event loop (the new in-loop handler), not merely that
//   the source text contains the right substrings.
//
//   Round-1 test used --model nonexistent-provider/nonexistent-model which
//   fails BEFORE the loop (model-resolution), exercising the pre-existing
//   promptResult rejection handler at run.ts:~774 — NOT the new in-loop emit
//   added in #81.  Removing the new emit left the round-1 test green.
//
//   This test uses --attach to a controlled mock server that emits a
//   session.error event mid-stream, so the assertion fails if the new
//   in-loop emit is removed.  The test also asserts at-most-one session_error
//   per run, validating the sessionErrorEmitted guard added in round-2.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = path.resolve(__dirname, "../../src/index.ts")

const SESSION_ID = "sess-test-001"

/**
 * Minimal HTTP server that simulates an aictrl backend.
 * Returns the server URL and a stop() function.
 *
 * The SDK wraps response bodies as { data: <body> } automatically, so the
 * server returns the raw data shapes (without an extra "data" envelope).
 * Event payloads are returned in SSE format; the SDK parses the JSON lines.
 */
async function startMockServer(): Promise<{ url: string; stop: () => void }> {
  const server = Bun.serve({
    port: 0, // OS-assigned free port
    async fetch(req) {
      const url = new URL(req.url)

      // List sessions (used by --continue; we return empty)
      if (req.method === "GET" && url.pathname === "/session") {
        return new Response(JSON.stringify([]), {
          headers: { "content-type": "application/json" },
        })
      }

      // Create session
      if (req.method === "POST" && url.pathname === "/session") {
        return new Response(JSON.stringify({ id: SESSION_ID }), {
          headers: { "content-type": "application/json" },
        })
      }

      // Get config (used by share check — empty data means auto-share is off)
      if (req.method === "GET" && url.pathname === "/config") {
        return new Response(JSON.stringify({}), {
          headers: { "content-type": "application/json" },
        })
      }

      // Accept the prompt (session appears to start; any 2xx is fine)
      if (req.method === "POST" && url.pathname.endsWith("/message")) {
        return new Response(JSON.stringify({}), {
          headers: { "content-type": "application/json" },
        })
      }

      // SSE event stream: emit session.error then session.status idle.
      // session.error triggers the NEW in-loop handler added in PR #81.
      // session.status idle breaks the loop so the process exits cleanly.
      if (req.method === "GET" && url.pathname === "/event") {
        const sessionError = {
          type: "session.error",
          properties: {
            sessionID: SESSION_ID,
            error: {
              name: "ProviderAuthError",
              message: "mock auth failure injected by test server",
            },
          },
        }
        const sessionIdle = {
          type: "session.status",
          properties: {
            sessionID: SESSION_ID,
            status: { type: "idle" },
          },
        }
        const body =
          `data: ${JSON.stringify(sessionError)}\n\n` +
          `data: ${JSON.stringify(sessionIdle)}\n\n`
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        })
      }

      // Catch-all 404 (SDK surfaces as non-throwing error, not a panic)
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    },
  })

  const url = `http://localhost:${server.port}`
  const stop = () => server.stop(true)
  return { url, stop }
}

describe("run --format json session_error emission (#81 in-loop path)", () => {
  test(
    "session_error is emitted when session.error event fires during the loop (not just on pre-loop failure)",
    async () => {
      // Acceptance criterion: removing the emit("session_error", …) call inside
      // the `if (event.type === "session.error")` block in run.ts must cause
      // this test to fail.
      const { url: serverUrl, stop } = await startMockServer()

      try {
        // --attach routes through the SDK event stream; promptResult stays
        // Promise.resolve() so the promptResult rejection handler (the pre-existing
        // emit site) cannot fire here — only the in-loop handler can.
        const proc = Bun.spawn(
          [
            "bun",
            "run",
            CLI_ENTRY,
            "run",
            "--format",
            "json",
            "--attach",
            serverUrl,
            "test prompt",
          ],
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

        const timeout = setTimeout(() => {
          proc.kill()
        }, 15_000)

        const [stdout] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ])
        clearTimeout(timeout)

        // Parse JSON lines from stdout, skip non-JSON diagnostic lines
        const events: Array<Record<string, unknown>> = []
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            events.push(JSON.parse(trimmed))
          } catch {
            // ignore non-JSON diagnostic output
          }
        }

        // The in-loop session.error handler must have emitted session_error
        const sessionErrorEvents = events.filter((e) => e.type === "session_error")
        expect(sessionErrorEvents.length).toBeGreaterThan(0)

        // The event must carry a classified reason from classifySessionError
        const VALID_REASONS = ["rate_limit", "auth", "timeout", "oom", "provider", "unknown"]
        for (const ev of sessionErrorEvents) {
          expect(typeof ev.reason).toBe("string")
          expect(VALID_REASONS).toContain(ev.reason as string)
          expect(typeof ev.message).toBe("string")
          expect((ev.message as string).length).toBeGreaterThan(0)
        }

        // At most one session_error per run — validates the sessionErrorEmitted guard
        expect(sessionErrorEvents.length).toBe(1)

        // Process must have exited non-zero (the session failed)
        expect(await proc.exited).not.toBe(0)
      } finally {
        stop()
      }
    },
    20_000,
  )
})
