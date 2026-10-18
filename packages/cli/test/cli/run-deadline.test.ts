import { expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { schema, pathArgs } from "../fixture/output-schema"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

const WRAP_UP =
  "Time is nearly up. Using what you already have, write the final result as JSON to a file in the working directory, then call StructuredOutput with its path now"

// Fake OpenAI-compatible provider turns, in request order (the last one repeats):
// - "slow": a bash call that sleeps until `left` ms before the deadline (200ms without `left`)
// - "valid": a StructuredOutput call with a valid result file
// - "hang": a stream that starts and never finishes
type Turn = "slow" | "valid" | "hang"

async function run(options: {
  turns: Turn[]
  deadline?: (now: number) => string
  schema?: boolean
  left?: number
  flags?: string[]
}) {
  await using tmp = await tmpdir()
  const requests: Record<string, unknown>[] = []
  const flag = options.deadline?.(Date.now())
  const deadline = flag && /^\d+$/.test(flag) ? Number(flag) : flag ? Date.parse(flag) : undefined
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>)
      const turn = options.turns[Math.min(requests.length, options.turns.length) - 1]
      if (turn === "hang")
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
      const seconds =
        options.left === undefined || deadline === undefined
          ? "0.2"
          : Math.max(0, (deadline - options.left - Date.now()) / 1000).toFixed(2)
      const call =
        turn === "slow"
          ? { name: "bash", arguments: JSON.stringify({ command: `sleep ${seconds}`, description: "Wait" }) }
          : {
              name: "StructuredOutput",
              arguments: pathArgs(tmp.path, '{"result":"accepted"}', `so_${requests.length}.json`),
            }
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: call }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
      return new Response(
        chunks
          .map((chunk) => `data: ${JSON.stringify(chunk)}`)
          .concat("data: [DONE]")
          .join("\n\n") + "\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })
  await Bun.write(
    path.join(tmp.path, "aictrl.json"),
    JSON.stringify({
      enabled_providers: ["alibaba"],
      provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
      agent: { title: { disable: true } },
    }),
  )
  await Bun.write(path.join(tmp.path, "schema.json"), JSON.stringify(schema))
  const home = path.join(tmp.path, "home")
  await fs.mkdir(home)
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
      "alibaba/qwen-plus",
      "--title",
      "Deadline fixture",
      ...(options.schema === false ? [] : ["--output-schema", "schema.json"]),
      ...(flag ? ["--deadline", flag] : []),
      ...(options.flags ?? []),
      "Return a result.",
    ],
    {
      cwd: tmp.path,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        AICTRL_TEST_HOME: home,
        AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
        AICTRL_DISABLE_MODELS_FETCH: "true",
        AICTRL_DISABLE_AUTOCOMPACT: "true",
        AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => proc.kill("SIGKILL"), 40000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const events = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line)) as Record<string, unknown>[]
    return { stderr, exit, exited: Date.now(), deadline, requests, events }
  } finally {
    clearTimeout(timer)
    proc.kill("SIGKILL")
    server.stop(true)
  }
}

const of = (events: Record<string, unknown>[], type: string) => events.filter((event) => event.type === type)

test("a slow tool step near the deadline forces one StructuredOutput turn that is accepted in time", async () => {
  // The bash step ends 2s before a deadline 16s out: inside the wrap-up margin
  // (a fifth of the window, at least ~2.4s here) yet with time left to submit.
  const result = await run({
    turns: ["slow", "valid"],
    left: 2000,
    deadline: (now) => new Date(now + 16000).toISOString(),
  })
  expect(result.exit, result.stderr).toBe(0)
  expect(result.exited).toBeLessThan(result.deadline!)
  expect(result.requests.map((request) => request.tool_choice)).toEqual([
    "required",
    { type: "function", function: { name: "StructuredOutput" } },
  ])
  expect(JSON.stringify(result.requests[0].messages)).not.toContain("Time is nearly up")
  expect(JSON.stringify(result.requests[1].messages)).toContain(WRAP_UP)
  // The running tool finished; it was not cut short by the wrap-up.
  expect(of(result.events, "tool_use")).toMatchObject([
    { part: { tool: "bash", state: { status: "completed" } } },
    { part: { tool: "StructuredOutput", state: { status: "completed" } } },
  ])
  expect(of(result.events, "structured_output_rejected")).toEqual([])
  expect(of(result.events, "structured_output")).toMatchObject([
    { status: "accepted", attempts: 1, value: { result: "accepted" } },
  ])
  expect(of(result.events, "session_error")).toEqual([])
}, 45000)

test("a deadline that passes mid-stream ends a schema run as failed/deadline with exit 3", async () => {
  const result = await run({ turns: ["hang"], deadline: (now) => String(now + 8000) })
  expect(result.exit, result.stderr).toBe(3)
  // Stopped by the CLI at the deadline, not by an external kill.
  expect(result.exited - result.deadline!).toBeLessThan(5000)
  expect(result.requests).toHaveLength(1)
  expect(of(result.events, "structured_output")).toEqual([
    expect.objectContaining({ status: "failed", reason: "deadline", attempts: 0 }),
  ])
  expect(of(result.events, "session_error")).toMatchObject([{ reason: "deadline", code: "RUN_DEADLINE_EXCEEDED" }])
  // Reported once, by the loop, although the aborted stream also records it on the message.
  expect(of(result.events, "error")).toMatchObject([{ error: { name: "DeadlineExceededError" } }])
  expect(of(result.events, "message_complete")).toMatchObject([{ status: "error" }])
  expect(of(result.events, "invocation_complete")).toMatchObject([{ status: "error" }])
}, 45000)

test("a deadline that passes while a tool runs stops the step promptly", async () => {
  // The bash call would sleep 20s past the deadline.
  const result = await run({ turns: ["slow"], left: -20000, deadline: (now) => String(now + 8000) })
  expect(result.exit, result.stderr).toBe(3)
  expect(result.exited - result.deadline!).toBeLessThan(5000)
  expect(result.requests).toHaveLength(1)
  expect(of(result.events, "structured_output")).toEqual([
    expect.objectContaining({ status: "failed", reason: "deadline", attempts: 0 }),
  ])
  expect(of(result.events, "session_error")).toMatchObject([{ reason: "deadline" }])
}, 45000)

test("without --output-schema the deadline stops the run with a deadline session_error and exit 1", async () => {
  const result = await run({ turns: ["hang"], schema: false, deadline: (now) => String(now + 8000) })
  expect(result.exit, result.stderr).toBe(1)
  expect(result.exited - result.deadline!).toBeLessThan(5000)
  expect(result.requests).toHaveLength(1)
  expect(result.requests[0].tool_choice).toBe("auto")
  expect(of(result.events, "session_error")).toMatchObject([{ reason: "deadline", code: "RUN_DEADLINE_EXCEEDED" }])
  expect(of(result.events, "error")).toMatchObject([{ error: { name: "DeadlineExceededError" } }])
  expect(of(result.events, "structured_output")).toEqual([])
  expect(of(result.events, "invocation_complete")).toMatchObject([{ status: "error" }])
}, 45000)

test("a distant deadline leaves a schema run unchanged", async () => {
  const result = await run({ turns: ["slow", "valid"], deadline: (now) => new Date(now + 3600_000).toISOString() })
  expect(result.exit, result.stderr).toBe(0)
  expect(result.requests.map((request) => request.tool_choice)).toEqual(["required", "required"])
  expect(JSON.stringify(result.requests)).not.toContain("Time is nearly up")
  expect(of(result.events, "structured_output")).toMatchObject([{ status: "accepted", attempts: 1 }])
}, 45000)

for (const [name, deadline] of [
  ["past epoch", (now: number) => String(now - 1000)],
  ["past ISO", (now: number) => new Date(now - 1000).toISOString()],
  ["ISO without offset", () => "2999-01-01T00:00:00"],
  ["date only", () => "2999-01-01"],
  ["free text", () => "tomorrow"],
] as const) {
  test(`--deadline ${name} is rejected before any model request`, async () => {
    const result = await run({ turns: ["valid"], deadline })
    expect(result.exit, result.stderr).toBe(1)
    expect(result.requests).toEqual([])
    expect(result.stderr).toContain("--deadline must be")
    expect(of(result.events, "invocation_error")).toMatchObject([
      { phase: "validation", code: "INVOCATION_INVALID_ARGUMENTS" },
    ])
  }, 25000)
}

test("--deadline with --attach is rejected before connecting", async () => {
  // Nothing listens on port 1: validation must fail before any connection attempt.
  const result = await run({
    turns: ["valid"],
    flags: ["--attach", "http://127.0.0.1:1"],
    deadline: (now) => String(now + 3600_000),
  })
  expect(result.exit, result.stderr).toBe(1)
  expect(result.stderr).toContain("--deadline is not supported with --attach")
  expect(result.requests).toEqual([])
  expect(of(result.events, "invocation_error")).toMatchObject([
    { phase: "validation", code: "INVOCATION_INVALID_ARGUMENTS" },
  ])
}, 25000)
