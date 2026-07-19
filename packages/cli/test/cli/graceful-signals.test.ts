import { describe, expect, test } from "bun:test"
import path from "path"
import { cancel } from "../../src/cli/signals"

const signal = path.resolve(import.meta.dir, "../../src/cli/signals.ts")

function child(grace = 1_000, complete = true) {
  return Bun.spawn(
    [
      "bun",
      "--eval",
      `
        import { signals } from ${JSON.stringify(signal)}

        const emit = (type, data = {}) =>
          process.stdout.write(JSON.stringify({ type, ...data }) + "\\n")
        const control = signals(
          (info) => {
            emit("session_error", {
              reason: info.reason,
              code: String(info.code),
              message: info.message,
            })
          },
          ${grace},
          () => new Promise((resolve) => {
            process.stdout.write(JSON.stringify({ type: "session_complete" }) + "\\n", resolve)
          }),
        )

        emit("ready")
        await control.received
        ${
          complete
            ? `
        emit("session_complete")
        control.dispose()
        emit("disposed", {
          sigint: process.listenerCount("SIGINT"),
          sigterm: process.listenerCount("SIGTERM"),
        })
        `
            : "await Bun.sleep(30_000)"
        }
      `,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
}

async function ready(proc: ReturnType<typeof child>) {
  const reader = proc.stdout.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe('{"type":"ready"}\n')
  return reader
}

async function output(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: Uint8Array[] = []
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    chunks.push(chunk.value)
  }
  return new TextDecoder()
    .decode(Buffer.concat(chunks))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("graceful headless signals", () => {
  test.each(["sync", "async"])("cancel contains %s failures", async (mode) => {
    const failure = Promise.withResolvers<string>()

    cancel(
      () => {
        if (mode === "sync") throw new Error("private abort detail")
        return Promise.reject(new Error("private abort detail"))
      },
      () => failure.resolve("abort failed"),
    )

    expect(await failure.promise).toBe("abort failed")
  })

  test.each([
    ["SIGINT", "interrupted", 130],
    ["SIGTERM", "terminated", 143],
  ] as const)("%s emits a structured terminal sequence and exits %i", async (name, reason, code) => {
    const proc = child()
    const reader = await ready(proc)

    proc.kill(name)

    expect(await proc.exited).toBe(code)
    const events = await output(reader)
    expect(events.map((event) => event.type)).toEqual(["session_error", "session_complete", "disposed"])
    expect(events[0]).toMatchObject({
      reason,
      code: String(code),
      message: name === "SIGINT" ? "Session interrupted by SIGINT" : "Session terminated by SIGTERM",
    })
    expect(events[0].reason).not.toBe("timeout")
    expect(events[2]).toMatchObject({ sigint: 0, sigterm: 0 })
  })

  test("a second signal causes immediate hard termination", async () => {
    const proc = child(10_000, false)
    const reader = await ready(proc)

    proc.kill("SIGTERM")
    await Bun.sleep(50)
    proc.kill("SIGINT")

    expect(await proc.exited).toBe(143)
    expect((await output(reader)).map((event) => event.type)).toEqual(["session_error"])
  })

  test("an expired grace period causes hard termination", async () => {
    const proc = child(50, false)
    const reader = await ready(proc)

    proc.kill("SIGINT")

    expect(await proc.exited).toBe(130)
    expect((await output(reader)).map((event) => event.type)).toEqual(["session_error", "session_complete"])
  })
})
