import { expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { schema, pathArgs } from "../fixture/output-schema"
import { outputResult } from "../../src/cli/cmd/run.output"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

async function run(
  options: {
    flags?: string[]
    json?: boolean
    inputs?: readonly string[]
    content?: string
    existing?: string
    steps?: number
    timeout?: boolean
    abort?: boolean
    failure?: boolean
    queued?: boolean
    attach?: boolean
    locked?: boolean
    denied?: boolean
  } = {},
) {
  await using tmp = await tmpdir()
  const requests: Record<string, unknown>[] = []
  let notify: () => void = () => {}
  const called = new Promise<void>((resolve) => {
    notify = resolve
  })
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>)
      notify()
      if (options.failure)
        return new Response(JSON.stringify({ error: { message: "Fixture provider failed" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      if (options.abort || options.timeout)
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
      const args = (options.inputs ?? ['{"result":"accepted"}'])[
        Math.min(requests.length - 1, (options.inputs?.length ?? 1) - 1)
      ]
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta:
                args === "prose"
                  ? { content: "Plain response" }
                  : {
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${requests.length}`,
                          type: "function",
                          function: options.denied
                            ? { name: "read", arguments: JSON.stringify({ filePath: "/outside-fixture.txt" }) }
                            : {
                                name: "StructuredOutput",
                                arguments: pathArgs(tmp.path, args, `so_${requests.length}.json`),
                              },
                        },
                      ],
                    },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: options.denied ? "tool-calls" : "stop" }],
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
      agent: { title: { disable: true }, ...(options.steps ? { build: { steps: options.steps } } : {}) },
    }),
  )
  await Bun.write(path.join(tmp.path, "schema.json"), options.content ?? JSON.stringify(schema))
  if (options.locked) await fs.mkdir(path.join(tmp.path, "locked"), { mode: 0o555 })
  if (options.existing) await Bun.write(path.join(tmp.path, "result.json"), options.existing)
  const home = path.join(tmp.path, "home")
  await fs.mkdir(home)
  if (options.queued) {
    // Inject a synchronous provider failure after a burst of real bus events so
    // the local subscription still has a rejection queued when it is aborted.
    await Bun.write(
      path.join(tmp.path, "failure.ts"),
      `import { SessionPrompt } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/session/prompt.ts"))}
import { GlobalBus } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/bus/global.ts"))}
import { MessageV2 } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/session/message-v2.ts"))}
SessionPrompt.prompt = async (input) => {
  for (let n = 0; n < 32; n++) GlobalBus.emit("event", { payload: { type: "fixture.queued", properties: {} } })
  GlobalBus.emit("event", { payload: {
    type: "session.structured_output_rejected",
    properties: { sessionID: input.sessionID, attempt: 1, maxAttempts: 3,
      errors: [{ path: "", keyword: "required", message: "must have required property 'result'" }] }
  } })
  throw new MessageV2.APIError({ message: "Fixture provider failed", statusCode: 400, isRetryable: false })
}
`,
    )
  }
  const attached: { url: string; body: Record<string, unknown> }[] = []
  // The headless package has no HTTP server; bridge its real session APIs rather
  // than synthesizing responses or terminal events for the attach regression.
  const bridge = options.attach
    ? await (async () => {
        const { Instance } = await import("../../src/project/instance")
        const { Session } = await import("../../src/session")
        const { SessionPrompt } = await import("../../src/session/prompt")
        const { Config } = await import("../../src/config/config")
        const { GlobalBus } = await import("../../src/bus/global")
        return Bun.serve({
          port: 0,
          idleTimeout: 0,
          async fetch(request) {
            const url = new URL(request.url).pathname
            if (url === "/event") {
              const send = (event: { directory?: string; payload: unknown }) => {
                if (event.directory !== tmp.path) return
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event.payload)}\n\n`))
              }
              let controller: ReadableStreamDefaultController<Uint8Array>
              return new Response(
                new ReadableStream({
                  start(value) {
                    controller = value
                    GlobalBus.on("event", send)
                    controller.enqueue(new TextEncoder().encode(": ready\n\n"))
                  },
                  cancel() {
                    GlobalBus.off("event", send)
                  },
                }),
                { headers: { "Content-Type": "text/event-stream" } },
              )
            }
            const body =
              request.method === "POST" && request.headers.get("content-type")?.includes("json")
                ? ((await request.json()) as Record<string, unknown>)
                : {}
            attached.push({ url, body })
            return Instance.provide({
              directory: tmp.path,
              fn: async () => {
                if (url === "/config") return Response.json(await Config.get())
                if (url === "/session") return Response.json(await Session.create(Session.create.schema.parse(body)))
                const id = url.split("/")[2]
                if (url.endsWith("/abort")) {
                  SessionPrompt.cancel(id)
                  return Response.json(true)
                }
                const input = SessionPrompt.PromptInput.safeParse({ ...body, sessionID: id })
                if (!url.endsWith("/message") || !input.success) return new Response("Invalid prompt", { status: 400 })
                return Response.json(await SessionPrompt.prompt(input.data))
              },
            })
          },
        })
      })()
    : undefined
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--conditions=browser",
      ...(options.queued ? ["--preload", path.join(tmp.path, "failure.ts")] : []),
      entry,
      "run",
      ...(bridge ? ["--attach", bridge.url.origin, "--dir", tmp.path] : []),
      ...(options.json === false ? [] : ["--format", "json"]),
      "--model",
      "alibaba/qwen-plus",
      "--title",
      "Schema fixture",
      ...(options.flags ?? ["--output-schema", "schema.json"]),
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
        AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS: options.timeout ? "100" : "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20000)
  if (options.abort) void called.then(() => proc.kill("SIGTERM"))
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const result = await Bun.file(path.join(tmp.path, "result.json"))
      .text()
      .catch(() => undefined)
    const files = await fs.readdir(tmp.path)
    const events = stdout
      .split("\n")
      .filter((line) => options.json !== false && line.startsWith("{"))
      .map((line) => JSON.parse(line)) as Record<string, unknown>[]
    return { stdout, stderr, exit, requests, attached, result, events, files }
  } finally {
    clearTimeout(timer)
    proc.kill("SIGKILL")
    server.stop(true)
    bridge?.stop(true)
    if (bridge) {
      const { Instance } = await import("../../src/project/instance")
      await Instance.provide({ directory: tmp.path, fn: () => Instance.dispose() })
    }
  }
}

for (const [name, options, reason] of [
  ["unreadable", { flags: ["--output-schema", "absent.json"] }, "cannot read"],
  [
    // run changes into --dir first, so relative paths resolve there (as --file does)
    // and the error names the resolved path rather than the bare argument.
    "relative schema under --dir",
    { flags: ["--dir", "home", "--output-schema", "schema.json"] },
    `${path.sep}home${path.sep}schema.json)`,
  ],
  ["invalid JSON", { content: "{broken" }, "invalid JSON"],
  ["uncompilable", { content: '{"type":"object","unknownKeyword":true}' }, "strict mode"],
  ["non-object root", { content: '{"type":"array"}' }, 'schema root must have type "object"'],
  ["array JSON root", { content: "[]" }, "schema root must be a JSON object"],
  ["null JSON root", { content: "null" }, "schema root must be a JSON object"],
  ["scalar JSON root", { content: '"schema"' }, "schema root must be a JSON object"],
  ["oversized schema", { content: JSON.stringify({ type: "object", description: "x".repeat(64 * 1024) }) }, "64 KiB"],
  [
    // ~2,000 levels is only ~16 KB but overflows Ajv's recursive codegen.
    "deeply nested schema",
    {
      content: JSON.stringify({
        type: "object",
        properties: { a: Array.from({ length: 2000 }).reduce<object>((inner) => ({ not: inner }), { type: "string" }) },
      }),
    },
    "nesting must not exceed 64 levels",
  ],
  [
    "unknown format",
    { content: '{"type":"object","properties":{"result":{"type":"string","format":"date-time"}}}' },
    "unknown format",
  ],
  [
    "missing result parent",
    { flags: ["--output-schema", "schema.json", "--output-result", "absent/result.json"] },
    "parent directory must exist and be writable",
  ],
  [
    "file as result parent",
    { flags: ["--output-schema", "schema.json", "--output-result", "schema.json/result.json"] },
    "parent directory must exist and be writable",
  ],
  [
    "unwritable result parent",
    { locked: true, flags: ["--output-schema", "schema.json", "--output-result", "locked/result.json"] },
    "parent directory must exist and be writable",
  ],
  ["retries without schema", { flags: ["--output-schema-retries", "1"] }, "require --output-schema"],
  ["result without schema", { flags: ["--output-result", "result.json"] }, "require --output-schema"],
  [
    "excessive retries",
    { flags: ["--output-schema", "schema.json", "--output-schema-retries", "11"] },
    "integer between 0 and 10",
  ],
  [
    "negative retries",
    { flags: ["--output-schema", "schema.json", "--output-schema-retries", "-1"] },
    "integer between 0 and 10",
  ],
  [
    "fractional retries",
    { flags: ["--output-schema", "schema.json", "--output-schema-retries", "1.5"] },
    "integer between 0 and 10",
  ],
  [
    "unsupported draft",
    { content: '{"type":"object","$schema":"https://json-schema.org/draft/2019-09/schema"}' },
    "schema",
  ],
] as const) {
  // Root ignores directory mode bits, so it cannot exercise this permission failure.
  const check = name === "unwritable result parent" && process.getuid?.() === 0 ? test.skip : test
  check(
    `configuration error ${name} happens before any model request`,
    async () => {
      const result = await run({ ...options, flags: "flags" in options ? [...options.flags] : undefined })
      expect(result.exit, result.stderr).toBe(2)
      expect(result.stderr).toContain(reason)
      const event = result.events.find((event) => event.type === "invocation_error")
      expect((event!.message as string).length).toBeLessThanOrEqual(300)
      if (name === "negative retries" || name === "fractional retries" || name === "excessive retries")
        expect(event?.message).toBe("--output-schema-retries must be an integer between 0 and 10")
      expect(event).toMatchObject({ code: "OUTPUT_SCHEMA_CONFIG", message: expect.stringContaining(reason) })
      if ("content" in options) expect(result.stderr).toContain("schema.json")
      expect(result.requests).toEqual([])
      expect(result.result).toBeUndefined()
      expect(result.events.map((event) => event.type)).toEqual([
        "invocation_start",
        "invocation_error",
        "invocation_complete",
      ])
    },
    25000,
  )
}

test("repair emits bounded events and writes only validated JSON atomically", async () => {
  const result = await run({
    inputs: ["{}", '{"result":"accepted"}'],
    existing: "old result",
    flags: ["--output-schema", "schema.json", "--output-result", "result.json"],
  })
  expect(result.exit, result.stderr).toBe(0)
  expect(result.result).toBe(JSON.stringify({ result: "accepted" }, null, 2) + "\n")
  expect(result.files.filter((file) => file.endsWith(".tmp"))).toEqual([])
  expect(result.events.filter((event) => event.type === "structured_output_rejected")).toMatchObject([
    { attempt: 1, maxAttempts: 3, errors: [{ path: "", keyword: "required" }] },
  ])
  expect(result.events.filter((event) => event.type === "structured_output")).toMatchObject([
    { status: "accepted", attempts: 2, value: { result: "accepted" } },
  ])
  expect(result.events.findIndex((event) => event.type === "structured_output")).toBeLessThan(
    result.events.findIndex((event) => event.type === "session_complete"),
  )
}, 25000)

for (const json of [true, false]) {
  test(`prose finish is repaired through the CLI in ${json ? "JSON" : "formatted"} mode`, async () => {
    const result = await run({
      json,
      inputs: ["prose", '{"result":"accepted"}'],
      flags: ["--output-schema", "schema.json", "--output-result", "result.json"],
    })
    expect(result.exit, result.stderr).toBe(0)
    expect(result.requests).toHaveLength(2)
    expect(result.requests.map((request) => request.tool_choice)).toEqual([
      "required",
      { type: "function", function: { name: "StructuredOutput" } },
    ])
    expect(JSON.stringify(result.requests[1].messages)).toContain(
      "write the final result as JSON to a file in the working directory, then call StructuredOutput with its path",
    )
    expect(result.result).toBe(JSON.stringify({ result: "accepted" }, null, 2) + "\n")
    if (!json) return
    expect(result.events.filter((event) => event.type === "structured_output_rejected")).toMatchObject([
      {
        attempt: 1,
        maxAttempts: 3,
        errors: [
          {
            path: "",
            keyword: "missing",
            message:
              "write the final result as JSON to a file in the working directory, then call StructuredOutput with its path",
          },
        ],
      },
    ])
    expect(result.events.filter((event) => event.type === "structured_output")).toMatchObject([
      { status: "accepted", attempts: 2, value: { result: "accepted" } },
    ])
  }, 25000)
}

test("prose finish with zero retries fails after exactly one CLI provider request", async () => {
  const result = await run({
    inputs: ["prose"],
    flags: ["--output-schema", "schema.json", "--output-schema-retries", "0", "--output-result", "result.json"],
  })
  expect(result.exit, result.stderr).toBe(3)
  expect(result.requests).toHaveLength(1)
  expect(result.requests[0].tool_choice).toBe("required")
  expect(result.result).toBeUndefined()
  expect(result.events.filter((event) => event.type === "structured_output_rejected")).toMatchObject([
    {
      attempt: 1,
      maxAttempts: 1,
      errors: [
        {
          path: "",
          keyword: "missing",
          message:
            "write the final result as JSON to a file in the working directory, then call StructuredOutput with its path",
        },
      ],
    },
  ])
  expect(result.events.filter((event) => event.type === "structured_output")).toMatchObject([
    { status: "failed", reason: "missing", attempts: 1 },
  ])
}, 25000)

for (const existing of [undefined, "untouched"]) {
  test(`exhaustion preserves ${existing ? "existing" : "absent"} result file`, async () => {
    const result = await run({
      existing,
      inputs: ["{}"],
      flags: ["--output-schema", "schema.json", "--output-schema-retries", "0", "--output-result", "result.json"],
    })
    expect(result.exit, result.stderr).toBe(3)
    expect(result.requests).toHaveLength(1)
    expect(result.result).toBe(existing)
    expect(result.events.filter((event) => event.type === "structured_output")).toMatchObject([
      { status: "failed", reason: "exhausted", attempts: 1 },
    ])
  }, 25000)
}

for (const [name, options, code, reason] of [
  ["missing", { inputs: ["prose"] }, 3, "missing"],
  ["step limit", { inputs: ["{}"], steps: 1 }, 3, "step_limit"],
  ["provider error", { failure: true }, 1, "error"],
  ["timeout", { timeout: true }, 1, "error"],
  ["abort", { abort: true }, 143, "aborted"],
] as const) {
  test(`CLI ${name} emits one terminal failure and leaves result unchanged`, async () => {
    const result = await run({
      ...options,
      existing: "untouched",
      flags: ["--output-schema", "schema.json", "--output-result", "result.json"],
    })
    expect(result.exit, result.stderr).toBe(code)
    expect(result.result).toBe("untouched")
    expect(result.events.filter((event) => event.type === "structured_output")).toMatchObject([
      { status: "failed", reason },
    ])
    expect(result.events.filter((event) => event.type === "structured_output")).toHaveLength(1)
    expect(result.stdout).not.toContain('"status":"accepted"')
    if (name === "missing") {
      expect(result.requests).toHaveLength(3)
      expect(result.events.filter((event) => event.type === "structured_output_rejected")).toHaveLength(3)
      expect(result.events.find((event) => event.type === "structured_output")).toMatchObject({ attempts: 3 })
    }
  }, 25000)
}

test("default mode prints validated JSON at the end without a result file", async () => {
  const result = await run({ json: false })
  expect(result.exit, result.stderr).toBe(0)
  expect(result.stdout.trimEnd()).toEndWith(JSON.stringify({ result: "accepted" }, null, 2))
  expect(result.result).toBeUndefined()
}, 25000)

test("plain run pins unchanged event types and ordering", async () => {
  const result = await run({ inputs: ["prose"], flags: [] })
  expect(result.exit, result.stderr).toBe(0)
  expect(result.events.map((event) => event.type)).toEqual([
    "invocation_start",
    "session_start",
    "tool_catalog",
    "step_start",
    "text",
    "step_finish",
    "message_complete",
    "session_complete",
    "invocation_complete",
  ])
  expect(result.requests).toHaveLength(1)
  expect(result.requests[0].tool_choice).toBe("auto")
  expect(result.result).toBeUndefined()
}, 25000)

test("plain attach runs a prompt through the HTTP session boundary", async () => {
  const result = await run({ attach: true, inputs: ["prose"], flags: [] })
  expect(result.attached.find((request) => request.url === "/session")?.body.title).toBe("Schema fixture")
  expect(result.attached.find((request) => request.url === "/session")?.body.permission).toEqual([
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" },
  ])
  expect(result.attached.find((request) => request.url.endsWith("/message"))?.body).toMatchObject({
    model: { providerID: "alibaba", modelID: "qwen-plus" },
    parts: [{ type: "text", text: expect.stringContaining("Return a result.") }],
  })
  expect(result.exit, result.stderr + result.stdout).toBe(0)
  expect(result.requests).toHaveLength(1)
  expect(result.requests[0].tool_choice).toBe("auto")
  expect(result.events.filter((event) => event.type === "text")).toMatchObject([{ part: { text: "Plain response" } }])
  expect(result.events.filter((event) => event.type === "structured_output")).toEqual([])
}, 25000)

test("schema attach repairs a prose finish through the HTTP session boundary", async () => {
  const result = await run({
    attach: true,
    inputs: ["prose", '{"result":"accepted"}'],
    flags: ["--output-schema", "schema.json", "--output-result", "result.json"],
  })
  expect(result.exit, result.stderr + result.stdout).toBe(0)
  expect(result.attached.find((request) => request.url.endsWith("/message"))?.body.format).toEqual({
    type: "json_schema",
    schema,
    retryCount: 2,
  })
  expect(result.requests).toHaveLength(2)
  expect(result.requests.map((request) => request.tool_choice)).toEqual([
    "required",
    { type: "function", function: { name: "StructuredOutput" } },
  ])
  expect(result.result).toBe(JSON.stringify({ result: "accepted" }, null, 2) + "\n")
  expect(result.events.filter((event) => event.type === "structured_output_rejected")).toMatchObject([
    {
      attempt: 1,
      errors: [
        {
          path: "",
          keyword: "missing",
          message:
            "write the final result as JSON to a file in the working directory, then call StructuredOutput with its path",
        },
      ],
    },
  ])
  expect(result.events.filter((event) => event.type === "structured_output")).toMatchObject([
    { status: "accepted", attempts: 2, value: { result: "accepted" } },
  ])
}, 25000)

test("atomic output cancellation cleans temp and preserves destination", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "result.json")
  await Bun.write(file, "untouched")
  await expect(outputResult(file, { result: "accepted" }, () => true)).rejects.toThrow("cancelled")
  expect(await Bun.file(file).text()).toBe("untouched")
  expect(await fs.readdir(tmp.path)).toEqual(["result.json"])
})

for (const [name, value, failure, code] of [
  ["accepted", { result: "attached" }, false, 0],
  ["invalid remote result", {}, false, 3],
  ["late session failure", { result: "attached" }, true, 1],
  ["malformed outcome", { result: "attached" }, false, 3],
  ["structured failure followed by loop rejection", {}, false, 3],
  ["provider rejection", { result: "submitted-secret" }, false, 1],
  ["provider rejection after loop failure", { result: "submitted-secret" }, false, 1],
] as const) {
  test(`attach ${name} forwards the canonical schema and validates final acceptance`, async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "schema.json"), JSON.stringify(schema))
    const rejection = name.startsWith("provider rejection")
    const requests: { url: string; body: Record<string, unknown> }[] = []
    let ready: (value: ReadableStreamDefaultController<Uint8Array>) => void = () => {}
    const connected = new Promise<ReadableStreamDefaultController<Uint8Array>>((resolve) => {
      ready = resolve
    })
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url).pathname
        if (url === "/event")
          return new Response(
            new ReadableStream({
              start(value) {
                value.enqueue(new TextEncoder().encode(": ready\n\n"))
                ready(value)
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          )
        if (url === "/config") return Response.json({ share: "disabled" })
        if (url.endsWith("/abort")) return Response.json(true)
        const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {}
        requests.push({ url, body })
        if (url === "/session") return Response.json({ id: "ses_fixture" })
        if (url === "/session/ses_fixture/message") {
          const controller = await connected
          // Provider rejection answers before any SSE event, the ordering that
          // once let a stale exit code 3 survive a genuine provider failure.
          for (const event of rejection
            ? name === "provider rejection after loop failure"
              ? [{ type: "session.status", properties: { sessionID: "ses_fixture", status: null } }]
              : []
            : [
                {
                  type: "session.structured_output_rejected",
                  properties: {
                    sessionID: "ses_fixture",
                    attempt: 1,
                    maxAttempts: 5,
                    errors: [{ path: "", keyword: "required", message: "must have required property 'result'" }],
                  },
                },
                {
                  type: "session.structured_output",
                  properties: {
                    sessionID: "ses_fixture",
                    outcome:
                      name === "malformed outcome"
                        ? { status: "unexpected", attempts: "bad", value }
                        : { status: "accepted", attempts: 2, value },
                  },
                },
                ...(failure
                  ? [
                      {
                        type: "session.error",
                        properties: {
                          sessionID: "ses_fixture",
                          error: {
                            name: "APIError",
                            data: {
                              message: "Late provider failure",
                              isRetryable: false,
                            },
                          },
                        },
                      },
                    ]
                  : []),
                ...(name === "structured failure followed by loop rejection"
                  ? [
                      {
                        type: "session.error",
                        properties: {
                          sessionID: "ses_fixture",
                          error: { name: "StructuredOutputError", data: { message: "No valid result", retries: 1 } },
                        },
                      },
                      // A malformed later event forces the CLI event loop to reject.
                      { type: "session.status", properties: { sessionID: "ses_fixture", status: null } },
                    ]
                  : [{ type: "session.status", properties: { sessionID: "ses_fixture", status: { type: "idle" } } }]),
              ])
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
          if (rejection) {
            if (name === "provider rejection after loop failure") await Bun.sleep(25)
            return Response.json(
              { name: "APIError", data: { message: "Fixture provider failed", statusCode: 400, isRetryable: false } },
              { status: 400 },
            )
          }
          return Response.json({})
        }
        return new Response("unexpected request", { status: 400 })
      },
    })
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "--conditions=browser",
        entry,
        "run",
        "--attach",
        server.url.origin,
        "--format",
        "json",
        "--output-schema",
        "schema.json",
        "--output-schema-retries",
        "4",
        "--output-result",
        "result.json",
        "Return a result.",
      ],
      {
        cwd: tmp.path,
        env: { ...process.env, AICTRL_DISABLE_DEFAULT_PLUGINS: "true", AICTRL_DISABLE_MODELS_FETCH: "true" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20000)
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(exit, stderr + stdout).toBe(code)
      if (rejection) {
        expect(stderr.split("\n").filter((line) => line.startsWith("{") && line.includes('"reason":'))).toHaveLength(1)
        expect(stderr.split("\n").filter((line) => line.includes('"code":"400"'))).toHaveLength(1)
        expect(stderr).toContain('"reason":"unknown"')
        expect(stdout + stderr).not.toContain("submitted-secret")
      }
      expect(requests.find((request) => request.url.endsWith("/message"))?.body.format).toEqual({
        type: "json_schema",
        schema,
        retryCount: 4,
      })
      expect(await Bun.file(path.join(tmp.path, "result.json")).exists()).toBe(code === 0)
      if (code === 0) expect(await Bun.file(path.join(tmp.path, "result.json")).json()).toEqual(value)
      const events = stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
      expect(events.filter((event) => event.type === "structured_output")).toMatchObject([
        code === 0
          ? { status: "accepted", attempts: 2, value }
          : {
              status: "failed",
              reason: "error",
              attempts: name === "malformed outcome" ? 1 : rejection ? 0 : 2,
            },
      ])
      expect(events.filter((event) => event.type === "structured_output")).toHaveLength(1)
      expect(events.filter((event) => event.type === "session_complete")).toHaveLength(1)
      if (name === "malformed outcome") expect(events.filter((event) => event.type === "session_error")).toEqual([])
    } finally {
      clearTimeout(timer)
      proc.kill("SIGKILL")
      server.stop(true)
    }
  }, 25000)
}

test("JSON mode without output-result carries the accepted value only in terminal event", async () => {
  const result = await run()
  expect(result.exit, result.stderr).toBe(0)
  expect(result.result).toBeUndefined()
  expect(result.events.filter((event) => event.type === "structured_output")).toMatchObject([
    { status: "accepted", attempts: 1, value: { result: "accepted" } },
  ])
}, 25000)

test("headless permission rejection reports missing output with no session error", async () => {
  const result = await run({
    denied: true,
    existing: "untouched",
    flags: ["--output-schema", "schema.json", "--output-result", "result.json"],
  })
  expect(result.exit, result.stderr + result.stdout).toBe(3)
  expect(result.requests).toHaveLength(1)
  expect(result.result).toBe("untouched")
  expect(result.events.filter((event) => event.type === "permission_rejected")).toHaveLength(1)
  expect(result.events.filter((event) => event.type === "session_error")).toEqual([])
  expect(result.events.filter((event) => event.type === "structured_output")).toMatchObject([
    { status: "failed", reason: "missing", attempts: 0 },
  ])
}, 25000)

test("schema config NDJSON clips the specific compilation cause", async () => {
  const result = await run({ content: JSON.stringify({ type: "object", ["unknown".repeat(100)]: true }) })
  expect(result.exit).toBe(2)
  expect(result.requests).toEqual([])
  const event = result.events.find((event) => event.type === "invocation_error")
  expect(event?.code).toBe("OUTPUT_SCHEMA_CONFIG")
  // The reason leads so the 300-char clip removes path text, never the cause.
  expect(event?.message).toStartWith("strict mode: unknown keyword:")
  expect((event?.message as string).length).toBe(300)
}, 25000)

test("local abort drains rejection queued immediately before provider failure", async () => {
  const result = await run({ queued: true })
  expect(result.exit, result.stderr + result.stdout).toBe(1)
  expect(result.events.filter((event) => event.type === "structured_output_rejected")).toMatchObject([
    { attempt: 1, maxAttempts: 3, errors: [{ keyword: "required" }] },
  ])
  expect(result.events.filter((event) => event.type === "structured_output")).toMatchObject([
    { status: "failed", reason: "error", attempts: 1 },
  ])
  expect(result.events.filter((event) => event.type === "structured_output")).toHaveLength(1)
  expect(result.events.filter((event) => event.type === "session_complete")).toHaveLength(1)
  expect(result.stderr.split("\n").filter((line) => line.startsWith("{") && line.includes('"reason":'))).toHaveLength(1)
  const types = result.events.map((event) => event.type)
  expect(types.indexOf("structured_output_rejected")).toBeLessThan(types.indexOf("structured_output"))
  expect(types.indexOf("structured_output")).toBeLessThan(types.indexOf("session_complete"))
  expect(types.at(-1)).toBe("invocation_complete")
}, 25000)
