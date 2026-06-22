import path from "path"
import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "url"

// Behavioral regression test for aictrl-dev/cli#81:
//   Verify that `session_error` is actually emitted as a JSON event when the
//   session fails, not just that the source text contains the right substrings.
//   The source-text assertions in run-schema-v1.test.ts cannot catch a mistyped
//   event key, a missing import, or broken control flow — this test drives a
//   real session failure and observes the emitted payload.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = path.resolve(__dirname, "../../src/index.ts")

describe("run --format json session_error emission (#81)", () => {
  test("session_error event is emitted with a classified reason on session failure", async () => {
    // Run with a nonexistent model to trigger a session failure.
    // The CLI must emit a { type: "session_error", reason: string } JSON line
    // to stdout before exiting non-zero.
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "--conditions=browser",
        CLI_ENTRY,
        "run",
        "--format",
        "json",
        "test prompt",
        "--model",
        "nonexistent-provider/nonexistent-model",
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

    // Parse JSON lines from stdout, skip non-JSON lines defensively
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

    // At least one session_error event must have been emitted
    const sessionErrorEvents = events.filter((e) => e.type === "session_error")
    expect(sessionErrorEvents.length).toBeGreaterThan(0)

    // The emitted event must carry a classified reason (one of the known values)
    const VALID_REASONS = ["rate_limit", "auth", "timeout", "oom", "provider", "unknown"]
    for (const ev of sessionErrorEvents) {
      expect(typeof ev.reason).toBe("string")
      expect(VALID_REASONS).toContain(ev.reason as string)
      // message must be present and non-empty
      expect(typeof ev.message).toBe("string")
      expect((ev.message as string).length).toBeGreaterThan(0)
    }

    // Process must have exited non-zero (the session failed)
    expect(await proc.exited).not.toBe(0)
  }, 20_000)
})
