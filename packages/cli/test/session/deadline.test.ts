import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test"
import { Deadline } from "../../src/session/deadline"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { parseDeadline } from "../../src/cli/cmd/run.deadline"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { tmpdir } from "../fixture/fixture"
import { schema } from "../fixture/output-schema"
import { SessionCompaction } from "../../src/session/compaction"
import { OutputSchema } from "../../src/session/output-schema"

const MINUTE = 60_000
const T0 = Date.parse("2026-10-17T12:00:00Z")

afterEach(() => setSystemTime())

test("wrap-up margin is twice the slowest step, at least a minute, at most a fifth of the window", () => {
  expect(Deadline.margin(30 * MINUTE, 0)).toBe(MINUTE)
  expect(Deadline.margin(30 * MINUTE, 37_000)).toBe(74_000)
  expect(Deadline.margin(30 * MINUTE, 4 * MINUTE)).toBe(6 * MINUTE)
  // A short window caps even the floor, so most of it stays available for the task.
  expect(Deadline.margin(2 * MINUTE, 0)).toBe(24_000)
})

test("wrap-up is due once, when the time left falls within the margin", () => {
  setSystemTime(T0)
  using deadline = Deadline.watch(new AbortController().signal, T0 + 10 * MINUTE)
  setSystemTime(T0 + 8 * MINUTE + 30_000)
  expect(deadline.wrapUp()).toBe(false)
  // A 50s step raises the margin to 100s; 90s are left.
  deadline.observe(50_000)
  expect(deadline.wrapUp()).toBe(true)
  expect(deadline.wrapUp()).toBe(false)
  expect(deadline.expired).toBe(false)
})

test("a deadline moved earlier restarts the window the margin is capped by", () => {
  setSystemTime(T0)
  using deadline = Deadline.watch(new AbortController().signal, T0 + 120 * MINUTE)
  setSystemTime(T0 + 50 * MINUTE)
  deadline.observe(4 * MINUTE)
  deadline.limit(T0 + 60 * MINUTE)
  // 7 of the joiner's 10 minutes are left: a 2-minute cap (a fifth of 10), not 8 minutes.
  setSystemTime(T0 + 53 * MINUTE)
  expect(deadline.wrapUp()).toBe(false)
  setSystemTime(T0 + 58 * MINUTE + 30_000)
  expect(deadline.wrapUp()).toBe(true)
})

test("a minute floor applies before any step is observed", () => {
  setSystemTime(T0)
  using deadline = Deadline.watch(new AbortController().signal, T0 + 10 * MINUTE)
  setSystemTime(T0 + 9 * MINUTE - 1)
  expect(deadline.wrapUp()).toBe(false)
  setSystemTime(T0 + 9 * MINUTE + 1)
  expect(deadline.wrapUp()).toBe(true)
})

test("without a deadline the signal only follows the parent and nothing is due", () => {
  const parent = new AbortController()
  using deadline = Deadline.watch(parent.signal)
  deadline.observe(10 * MINUTE)
  expect(deadline.wrapUp()).toBe(false)
  expect(deadline.error).toBeUndefined()
  const reason = new Error("cancelled")
  parent.abort(reason)
  expect(deadline.signal.reason).toBe(reason)
  expect(deadline.expired).toBe(false)
})

test("limit moves the deadline earlier, never later", async () => {
  using deadline = Deadline.watch(new AbortController().signal, Date.now() + MINUTE)
  deadline.limit(Date.now() + 2 * MINUTE)
  await Bun.sleep(20)
  expect(deadline.expired).toBe(false)
  const at = Date.now() + 30
  deadline.limit(at)
  await new Promise((resolve) => deadline.signal.addEventListener("abort", resolve, { once: true }))
  expect(deadline.error).toMatchObject({ data: { deadline: at } })
})

test("limit arms a watch that started without a deadline", async () => {
  using deadline = Deadline.watch(new AbortController().signal)
  deadline.limit(Date.now() + 30)
  await new Promise((resolve) => deadline.signal.addEventListener("abort", resolve, { once: true }))
  expect(deadline.expired).toBe(true)
})

test("a disposed watch ignores later limits", async () => {
  const watch = Deadline.watch(new AbortController().signal)
  watch[Symbol.dispose]()
  watch.limit(Date.now() + 10)
  await Bun.sleep(40)
  expect(watch.expired).toBe(false)
})

test("the signal aborts with a DeadlineError when the deadline passes", async () => {
  const at = Date.now() + 30
  using deadline = Deadline.watch(new AbortController().signal, at)
  expect(deadline.signal.aborted).toBe(false)
  await new Promise((resolve) => deadline.signal.addEventListener("abort", resolve, { once: true }))
  expect(deadline.expired).toBe(true)
  expect(MessageV2.DeadlineError.isInstance(deadline.signal.reason)).toBe(true)
  expect(deadline.error).toEqual({
    name: "DeadlineExceededError",
    data: { message: "Run deadline reached before a final result", deadline: at },
  })
})

test("a cancelled parent aborts the signal without expiring the deadline", () => {
  const parent = new AbortController()
  using deadline = Deadline.watch(parent.signal, Date.now() + MINUTE)
  parent.abort()
  expect(deadline.signal.aborted).toBe(true)
  expect(deadline.expired).toBe(false)
})

test("a deadline beyond the timer range does not fire early", async () => {
  using deadline = Deadline.watch(new AbortController().signal, Date.now() + 2 ** 32)
  await Bun.sleep(20)
  expect(deadline.expired).toBe(false)
})

test("a prompt that joins a running loop brings its deadline to that loop", async () => {
  let started: () => void = () => {}
  const first = new Promise<void>((resolve) => {
    started = resolve
  })
  // The provider stream starts and never finishes, so only a deadline can end the loop.
  const server = Bun.serve({
    port: 0,
    async fetch() {
      started()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
              ),
            )
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })
  try {
    await using tmp = await tmpdir({
      config: {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
        agent: { title: { disable: true } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Deadline join fixture" })
        const errors: string[] = []
        const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
          if (event.properties.sessionID === session.id && event.properties.error)
            errors.push(event.properties.error.name)
        })
        const model = { providerID: "alibaba", modelID: "qwen-plus" }
        const owner = SessionPrompt.prompt({ sessionID: session.id, model, parts: [{ type: "text", text: "First." }] })
        await first
        const deadline = Date.now() + 300
        const joined = SessionPrompt.prompt({
          sessionID: session.id,
          model,
          deadline,
          parts: [{ type: "text", text: "Second." }],
        })
        const timeout = setTimeout(() => SessionPrompt.cancel(session.id), 10_000)
        try {
          const [a, b] = await Promise.all([owner, joined])
          expect(Date.now() - deadline).toBeLessThan(5000)
          expect(a.info.role === "assistant" && a.info.error?.name).toBe("DeadlineExceededError")
          expect(b.info.id).toBe(a.info.id)
          expect(errors).toEqual(["DeadlineExceededError"])
        } finally {
          clearTimeout(timeout)
          unsubscribe()
        }
      },
    })
  } finally {
    server.stop(true)
  }
}, 20000)

test("a deadline that passes during cleanup does not reclassify how the loop ended", async () => {
  // A non-retryable provider failure ends the schema loop as "error"; the deadline
  // then passes while the loop is still pruning.
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ error: { message: "Fixture provider failed" } }, { status: 400 }),
  })
  const deadline = { at: 0 }
  const prune = spyOn(SessionCompaction, "prune").mockImplementation(async () => {
    await Bun.sleep(Math.max(0, deadline.at - Date.now()) + 50)
  })
  try {
    await using tmp = await tmpdir({
      config: {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
        agent: { title: { disable: true } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Deadline cleanup fixture" })
        const errors: string[] = []
        const outcomes: OutputSchema.Outcome[] = []
        const unsubscribe = [
          Bus.subscribe(Session.Event.Error, (event) => {
            if (event.properties.sessionID === session.id && event.properties.error)
              errors.push(event.properties.error.name)
          }),
          Bus.subscribe(Session.Event.StructuredOutput, (event) => {
            outcomes.push(event.properties.outcome)
          }),
        ]
        try {
          deadline.at = Date.now() + 1000
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: "alibaba", modelID: "qwen-plus" },
            deadline: deadline.at,
            format: { type: "json_schema", schema, retryCount: 0 },
            parts: [{ type: "text", text: "Return a result." }],
          })
          expect(Date.now()).toBeGreaterThan(deadline.at)
          expect(outcomes).toMatchObject([{ status: "failed", reason: "error" }])
          expect(errors).not.toContain("DeadlineExceededError")
        } finally {
          unsubscribe.forEach((fn) => fn())
        }
      },
    })
  } finally {
    prune.mockRestore()
    server.stop(true)
  }
}, 20000)

test("a passed deadline is reported even when cleanup fails", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
              ),
            )
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  })
  const prune = spyOn(SessionCompaction, "prune").mockImplementation(async () => {
    throw new Error("Fixture prune failed")
  })
  try {
    await using tmp = await tmpdir({
      config: {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
        agent: { title: { disable: true } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Deadline prune fixture" })
        const errors: string[] = []
        const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
          if (event.properties.sessionID === session.id && event.properties.error)
            errors.push(event.properties.error.name)
        })
        try {
          const result = SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: "alibaba", modelID: "qwen-plus" },
            deadline: Date.now() + 300,
            parts: [{ type: "text", text: "Return a result." }],
          })
          await expect(result).rejects.toThrow("Fixture prune failed")
          expect(errors).toEqual(["DeadlineExceededError"])
        } finally {
          unsubscribe()
        }
      },
    })
  } finally {
    prune.mockRestore()
    server.stop(true)
  }
}, 20000)

test("the request schemas do not carry a deadline; only in-process callers can set one", () => {
  const sessionID = "ses_0123456789abcdefghijklmnop"
  expect(SessionPrompt.PromptInput.parse({ sessionID, parts: [], deadline: T0 })).not.toHaveProperty("deadline")
  expect(SessionPrompt.CommandInput.parse({ sessionID, arguments: "", command: "c", deadline: T0 })).not.toHaveProperty(
    "deadline",
  )
  expect(Deadline.Input.parse(T0)).toBe(T0)
  expect(Deadline.Input.safeParse(-1).success).toBe(false)
  expect(Deadline.Input.safeParse(1.5).success).toBe(false)
})

test("--deadline accepts ISO-8601 with an offset or epoch milliseconds", () => {
  expect(parseDeadline(undefined, T0)).toBeUndefined()
  expect(parseDeadline(String(T0 + 1), T0)).toBe(T0 + 1)
  expect(parseDeadline("2026-10-17T12:30:00Z", T0)).toBe(T0 + 30 * MINUTE)
  expect(parseDeadline("2026-10-17T13:30:00.500+01:00", T0)).toBe(T0 + 30 * MINUTE + 500)
  expect(parseDeadline("2026-10-17T12:01Z", T0)).toBe(T0 + MINUTE)
})

for (const value of [
  "2026-10-17T12:30:00",
  "2026-10-17",
  "2026-13-01T00:00:00Z",
  "2026-02-30T00:00:00Z",
  "Sat, 17 Oct 2026 13:00:00 GMT",
  "1e15",
  "99999999999999999999",
  "",
  ["2026-10-17T12:30:00Z", "2026-10-17T12:40:00Z"],
]) {
  test(`--deadline rejects ${JSON.stringify(value)}`, () => {
    expect(() => parseDeadline(value, T0)).toThrow("--deadline must be an ISO-8601 date-time")
  })
}

test("--deadline names the unit when an epoch looks like seconds", () => {
  expect(() => parseDeadline(String(Math.floor(T0 / 1000) + 3600), T0)).toThrow(
    "--deadline must be in the future (epoch values are milliseconds, not seconds)",
  )
})

test("--deadline rejects an instant that is not in the future", () => {
  expect(() => parseDeadline(String(T0), T0)).toThrow("--deadline must be in the future")
  expect(() => parseDeadline("2026-10-17T11:59:59Z", T0)).toThrow("--deadline must be in the future")
})
