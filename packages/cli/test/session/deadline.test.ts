import { afterEach, expect, setSystemTime, test } from "bun:test"
import { Deadline } from "../../src/session/deadline"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { parseDeadline } from "../../src/cli/cmd/run.deadline"

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

test("a minute floor applies before any step is observed", () => {
  setSystemTime(T0)
  using deadline = Deadline.watch(new AbortController().signal, T0 + 10 * MINUTE)
  setSystemTime(T0 + 9 * MINUTE - 1)
  expect(deadline.wrapUp()).toBe(false)
  setSystemTime(T0 + 9 * MINUTE + 1)
  expect(deadline.wrapUp()).toBe(true)
})

test("without a deadline the parent signal is used unchanged and nothing is due", () => {
  const parent = new AbortController()
  using deadline = Deadline.watch(parent.signal)
  expect(deadline.signal).toBe(parent.signal)
  deadline.observe(10 * MINUTE)
  expect(deadline.wrapUp()).toBe(false)
  expect(deadline.expired).toBe(false)
  expect(deadline.error).toBeUndefined()
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

test("the prompt and command inputs carry the deadline to the loop", () => {
  const sessionID = "ses_0123456789abcdefghijklmnop"
  expect(SessionPrompt.PromptInput.parse({ sessionID, parts: [], deadline: T0 }).deadline).toBe(T0)
  expect(SessionPrompt.CommandInput.parse({ sessionID, arguments: "", command: "c", deadline: T0 }).deadline).toBe(T0)
  expect(SessionPrompt.PromptInput.safeParse({ sessionID, parts: [], deadline: -1 }).success).toBe(false)
  expect(SessionPrompt.PromptInput.safeParse({ sessionID, parts: [], deadline: 1.5 }).success).toBe(false)
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

test("--deadline rejects an instant that is not in the future", () => {
  expect(() => parseDeadline(String(T0), T0)).toThrow("--deadline must be in the future")
  expect(() => parseDeadline("2026-10-17T11:59:59Z", T0)).toThrow("--deadline must be in the future")
})
