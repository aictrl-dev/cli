import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const command = process.env.AICTRL_TEST_BINARY
  ? [process.env.AICTRL_TEST_BINARY]
  : ["bun", "run", "--conditions=browser", entry]

type Event = {
  type: string
  status?: string
  reason?: string
  code?: string
  message?: string
  resetAt?: number
}

type Rejection = { status: number; headers?: Record<string, string>; body: unknown }

// Z.ai GLM Coding Plan response once its rolling five-hour quota is spent,
// resetting two hours from now. Z.ai writes the reset time in UTC+8.
const ZAI_RESET_AT = Math.floor(Date.now() / 1000) * 1000 + 2 * 60 * 60 * 1000
const ZAI_RESET = new Date(ZAI_RESET_AT + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ")
const ZAI_FIVE_HOUR_LIMIT: Rejection = {
  status: 429,
  body: {
    error: { code: "1308", message: `Usage limit reached for 5 hour. Your limit will reset at ${ZAI_RESET}` },
  },
}

function completion() {
  const chunks = [
    { delta: { role: "assistant", content: "Completed." }, finish_reason: null },
    { delta: {}, finish_reason: "stop" },
  ].map(
    (choice) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`,
  )
  return new Response(chunks.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
}

// Runs a headless invocation against a fake OpenAI-compatible provider that
// answers the first `rejections.length` requests with the given errors.
async function run(rejections: Rejection[]) {
  await using tmp = await tmpdir()
  let requests = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.text()
      const rejection = rejections[requests++]
      if (!rejection) return completion()
      return Response.json(rejection.body, { status: rejection.status, headers: rejection.headers })
    },
  })
  const config = {
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}/v1` },
        models: { fixture: { name: "fixture", limit: { context: 100000, output: 1000 } } },
      },
    },
    agent: { title: { disable: true } },
  }
  const proc = Bun.spawn([...command, "run", "--format", "json", "--model", "fixture/fixture", "Complete the task."], {
    cwd: tmp.path,
    env: {
      ...process.env,
      AICTRL_CONFIG_CONTENT: JSON.stringify(config),
      AICTRL_DISABLE_PROJECT_CONFIG: "true",
      AICTRL_DISABLE_AUTOCOMPACT: "true",
      AICTRL_TEST_HOME: tmp.path,
      AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 15000)
  try {
    const started = Date.now()
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const events: Event[] = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
    return { events, exit, requests, elapsed: Date.now() - started, output: stderr + stdout }
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
    server.stop(true)
  }
}

describe("headless provider usage limits (#112)", () => {
  test("fails fast on a rolling usage limit instead of retrying", async () => {
    const result = await run([ZAI_FIVE_HOUR_LIMIT, ZAI_FIVE_HOUR_LIMIT])
    expect(result.exit, result.output).toBe(1)
    expect(result.requests).toBe(1)
    expect(result.events.filter((event) => event.type === "retry")).toHaveLength(0)
    const errors = result.events.filter((event) => event.type === "session_error")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ reason: "usage_limit", code: "PROVIDER_USAGE_LIMIT" })
    expect(errors[0].message).toContain("Provider usage limit reached")
    expect(errors[0].message).toContain("Usage limit reached for 5 hour")
    expect(errors[0].resetAt).toBe(ZAI_RESET_AT)
    expect(result.events.find((event) => event.type === "message_complete")?.status).toBe("error")
    expect(result.events.find((event) => event.type === "invocation_complete")?.status).toBe("error")
  }, 20000)

  test("reports the reset time of a 429 whose Retry-After exceeds the usage-limit bound", async () => {
    const before = Date.now()
    const result = await run([
      { status: 429, headers: { "retry-after": "18000" }, body: { error: { message: "Too many requests" } } },
    ])
    expect(result.exit, result.output).toBe(1)
    expect(result.requests).toBe(1)
    expect(result.events.filter((event) => event.type === "retry")).toHaveLength(0)
    const error = result.events.find((event) => event.type === "session_error")
    expect(error).toMatchObject({ reason: "usage_limit", code: "PROVIDER_USAGE_LIMIT" })
    expect(error?.resetAt).toBeGreaterThanOrEqual(before + 18_000_000)
    expect(error?.resetAt).toBeLessThanOrEqual(Date.now() + 18_000_000)
    expect(error?.message).toContain(new Date(error!.resetAt!).toISOString())
  }, 20000)

  test("keeps retrying a short rate limit", async () => {
    const result = await run([
      { status: 429, headers: { "retry-after-ms": "10" }, body: { error: { message: "Rate limit exceeded" } } },
    ])
    expect(result.exit, result.output).toBe(0)
    expect(result.requests).toBe(2)
    expect(result.events.filter((event) => event.type === "retry")).toMatchObject([
      { attempt: 1, code: "rate_limited" },
    ])
    expect(result.events.filter((event) => event.type === "session_error")).toHaveLength(0)
    expect(result.events.find((event) => event.type === "invocation_complete")?.status).toBe("completed")
  }, 20000)
})

// The non-429 companion to the usage-limit cases above: a long requested wait
// on any other status fails fast too, as a plain provider error.
describe("headless long Retry-After on other statuses (#175)", () => {
  test("fails fast when an overloaded provider asks for a wait over 5 minutes", async () => {
    const result = await run([
      { status: 503, headers: { "retry-after": "18000" }, body: { error: { message: "Overloaded" } } },
    ])
    expect(result.exit, result.output).toBe(1)
    expect(result.requests).toBe(1)
    expect(result.events.filter((event) => event.type === "retry")).toHaveLength(0)
    const errors = result.events.filter((event) => event.type === "session_error")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ reason: "provider", code: "503" })
    expect(errors[0].message).toContain("Overloaded")
    expect(result.events.find((event) => event.type === "invocation_complete")?.status).toBe("error")
  }, 20000)
})
