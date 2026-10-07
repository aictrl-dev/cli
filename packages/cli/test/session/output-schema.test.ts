import { expect, test } from "bun:test"
import Ajv from "ajv"
import Ajv2020 from "ajv/dist/2020"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Bus } from "../../src/bus"
import { OutputSchema } from "../../src/session/output-schema"
import { tmpdir } from "../fixture/fixture"
import { schema, corpus } from "../fixture/output-schema"

async function run(
  inputs: string[],
  retryCount = 2,
  options: {
    schema?: Record<string, unknown>
    steps?: number
    finish?: string
    abort?: boolean
    timeout?: boolean
    failure?: boolean
    other?: boolean
    plain?: boolean
    gemini?: boolean
  } = {},
) {
  const requests: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>)
      if (
        requests.length > (inputs.length === 1 && inputs[0] === "{}" ? retryCount + 1 : retryCount + inputs.length + 1)
      )
        return Response.json({ error: { message: "Fixture request budget exceeded" } }, { status: 400 })
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
      const args = inputs[Math.min(requests.length - 1, inputs.length - 1)]
      const calls = [
        {
          index: 0,
          id: `call_${requests.length}`,
          type: "function",
          function: { name: "StructuredOutput", arguments: args },
        },
      ]
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta:
                args === "prose"
                  ? { content: "No final tool call" }
                  : {
                      tool_calls: options.other
                        ? [
                            ...calls,
                            {
                              index: 1,
                              id: `read_${requests.length}`,
                              type: "function",
                              function: { name: "read", arguments: JSON.stringify({ filePath: "aictrl.json" }) },
                            },
                          ]
                        : calls,
                    },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: options.finish ?? "stop" }],
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
  try {
    await using tmp = await tmpdir({
      config: {
        ...(options.steps ? { agent: { build: { steps: options.steps } } } : {}),
        enabled_providers: options.gemini ? ["fixture"] : ["alibaba"],
        provider: options.gemini
          ? {
              fixture: {
                npm: "@ai-sdk/openai-compatible",
                options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
                models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
              },
            }
          : { alibaba: { options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } } },
      },
    })
    return await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Schema boundary fixture" })
        const rejected: {
          sessionID: string
          attempt: number
          maxAttempts: number
          errors: OutputSchema.Diagnostic[]
        }[] = []
        const outcomes: OutputSchema.Outcome[] = []
        const unsubscribe = [
          Bus.subscribe(Session.Event.StructuredOutputRejected, (event) => {
            rejected.push(event.properties)
          }),
          Bus.subscribe(Session.Event.StructuredOutput, (event) => {
            outcomes.push(event.properties.outcome)
          }),
        ]
        const idle = process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
        if (options.timeout) process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = "50"
        const timer = options.abort ? setTimeout(() => SessionPrompt.cancel(session.id), 100) : undefined
        try {
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: options.gemini
              ? { providerID: "fixture", modelID: "gemini-fixture" }
              : { providerID: "alibaba", modelID: "qwen-plus" },
            parts: [{ type: "text", text: "Return a result." }],
            ...(options.plain
              ? {}
              : { format: { type: "json_schema" as const, schema: options.schema ?? schema, retryCount } }),
          })
          if (result.info.role !== "assistant") throw new Error("Expected assistant")
          return {
            info: result.info,
            requests,
            rejected,
            outcomes,
            messages: await Session.messages({ sessionID: session.id }),
          }
        } finally {
          unsubscribe.forEach((fn) => fn())
          if (timer) clearTimeout(timer)
          if (idle === undefined) delete process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS
          else process.env.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS = idle
        }
      },
    })
  } finally {
    server.stop(true)
  }
}

test("missing required field crosses real tool boundary and must be repaired before capture", async () => {
  const result = await run(["{}", JSON.stringify({ result: "repaired" })])
  expect(result.info.structured).toEqual({ result: "repaired" })
  expect(result.requests).toHaveLength(2)
  expect(result.info.error).toBeUndefined()
}, 15_000)

for (const [name, value] of [
  ["wrong scalar type", { result: 42 }],
  ["wrong nested type", { result: "valid", nested: { count: "42" } }],
  ["extra property is not stripped", { result: "valid", extra: "private" }],
] as const) {
  test(
    name,
    async () => {
      const result = await run([JSON.stringify(value), '{"result":"repaired"}'])
      expect(result.info.structured).toEqual({ result: "repaired" })
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0]).toMatchObject({ attempt: 1, maxAttempts: 3 })
      expect(result.outcomes).toEqual([{ status: "accepted", attempts: 2, value: { result: "repaired" } }])
      expect(result.requests).toHaveLength(2)
    },
    15_000,
  )
}

test("truncated arguments are a counted rejected attempt", async () => {
  const result = await run(['{"result":', '{"result":"repaired"}'])
  expect(result.info.structured).toEqual({ result: "repaired" })
  expect(result.rejected).toEqual([
    {
      sessionID: result.info.sessionID,
      attempt: 1,
      maxAttempts: 3,
      errors: [{ path: "", keyword: "parse", message: "arguments must be complete, valid JSON" }],
    },
  ])
}, 15_000)

for (const retries of [0, 2, 4]) {
  test(`retryCount ${retries} bounds requests and reports corrective attempts`, async () => {
    const result = await run(["{}"], retries)
    expect(result.requests).toHaveLength(retries + 1)
    expect(result.rejected).toHaveLength(retries + 1)
    expect(result.info.structured).toBeUndefined()
    expect(result.info.error).toMatchObject({ name: "StructuredOutputError", data: { retries } })
    expect(result.outcomes).toEqual([{ status: "failed", reason: "exhausted", attempts: retries + 1 }])
  }, 15_000)
}

test("repair diagnostics sent to model are bounded and never echo submitted values", async () => {
  const secret = "submitted-secret-" + "x".repeat(5000)
  const result = await run([
    JSON.stringify({
      result: secret,
      ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`extra${i}`, secret])),
    }),
    '{"result":"repaired"}',
  ])
  expect(result.rejected[0].errors).toHaveLength(10)
  const request = result.requests[1] as { messages: { role: string; content: unknown }[] }
  const feedback = request.messages
    .filter((message) => message.role === "tool")
    .map((message) => JSON.stringify(message.content))
    .join("")
  expect(Buffer.byteLength(feedback)).toBeLessThan(2048)
  const calls = (request.messages as { tool_calls?: { function: { name: string; arguments: string } }[] }[])
    .flatMap((message) => message.tool_calls ?? [])
    .filter((call) => call.function.name === "invalid")
  expect(calls.length).toBeGreaterThan(0)
  calls.forEach((call) => {
    expect(Buffer.byteLength(call.function.arguments)).toBeLessThan(2048)
  })
  expect(JSON.stringify(request)).not.toContain("submitted-secret-")
  expect(feedback).toContain("additionalProperties")
  expect(result.info.structured).toEqual({ result: "repaired" })
}, 15_000)

test("valid StructuredOutput wins when another tool is called in the same step", async () => {
  const result = await run(['{"result":"accepted"}'], 0, { other: true })
  expect(result.info.structured).toEqual({ result: "accepted" })
  expect(result.requests).toHaveLength(1)
}, 15_000)

test("model finish without StructuredOutput has an explicit missing outcome", async () => {
  const result = await run(["prose"])
  expect(result.info.structured).toBeUndefined()
  expect(result.info.error).toMatchObject({ name: "StructuredOutputError", data: { retries: 0 } })
  expect(result.outcomes).toEqual([{ status: "failed", reason: "missing", attempts: 0 }])
}, 15_000)

test("step cap without a valid result has an explicit failure", async () => {
  const result = await run(["{}"], 4, { steps: 1 })
  expect(result.info.structured).toBeUndefined()
  expect(result.info.error).toMatchObject({ name: "StructuredOutputError", data: { retries: 0 } })
  expect(result.outcomes).toEqual([{ status: "failed", reason: "step_limit", attempts: 1 }])
  expect(result.requests).toHaveLength(1)
}, 15_000)

for (const [name, options, reason] of [
  ["cancellation", { abort: true }, "aborted"],
  ["stream timeout", { timeout: true }, "error"],
  ["provider error", { failure: true }, "error"],
  ["provider failed finish after a valid tool call", { finish: "content_filter" }, "error"],
] as const) {
  test(`${name} never accepts a result`, async () => {
    const result = await run(['{"result":"must not accept"}'], 2, options)
    expect(result.info.structured).toBeUndefined()
    expect(result.info.error).toBeDefined()
    expect(result.outcomes).toEqual([{ status: "failed", reason, attempts: options.finish ? 1 : 0 }])
  }, 15_000)
}

test("plain session keeps prose and emits no structured events", async () => {
  const result = await run(["prose"], 2, { plain: true })
  expect(result.info.error).toBeUndefined()
  expect(result.info.structured).toBeUndefined()
  expect(result.outcomes).toEqual([])
  expect(result.rejected).toEqual([])
  expect(result.requests).toHaveLength(1)
}, 15_000)

test("Ajv verdict parity across hostile corpus without mutating values", () => {
  const reference = new Ajv({ allErrors: true }).compile(schema)
  const validate = OutputSchema.compile(schema)
  for (const value of corpus) {
    const original = JSON.stringify(value)
    expect(validate(value)).toBe(reference(value))
    expect(JSON.stringify(value)).toBe(original)
  }
  expect(OutputSchema.compile(JSON.parse(JSON.stringify(schema)))).toBe(validate)
})

test("draft 2020-12 uses Ajv2020 with default strict validation", () => {
  const canonical = { ...schema, $schema: "https://json-schema.org/draft/2020-12/schema", unevaluatedProperties: false }
  const reference = new Ajv2020({ allErrors: true }).compile(canonical)
  const validate = OutputSchema.compile(canonical)
  for (const value of corpus) expect(validate(value)).toBe(reference(value))
})

test("execute defence in depth rejects invalid input before capture", async () => {
  const captured: unknown[] = []
  const tool = SessionPrompt.createStructuredOutputTool({
    schema,
    onSuccess: (value) => {
      captured.push(value)
    },
  })
  await expect(tool.execute!({}, { toolCallId: "fixture", messages: [] })).rejects.toThrow("StructuredOutput rejected")
  expect(captured).toEqual([])
})

test("draft 2020-12 declaration with a fragment uses the same validator dialect", () => {
  const canonical = { ...schema, $schema: "https://json-schema.org/draft/2020-12/schema#" }
  const reference = new Ajv2020({ allErrors: true }).compile(canonical)
  const validate = OutputSchema.compile(canonical)
  for (const value of corpus) expect(validate(value)).toBe(reference(value))
})

test("missing result after rejections reports corrective attempts truthfully", async () => {
  const result = await run(["{}", "{}", "prose"])
  expect(result.info.structured).toBeUndefined()
  expect(result.info.error).toMatchObject({ name: "StructuredOutputError", data: { retries: 1 } })
  expect(result.outcomes).toEqual([{ status: "failed", reason: "missing", attempts: 2 }])
}, 15_000)

test("Gemini tool schema is transformed but canonical numeric enum remains authoritative", async () => {
  const canonical = { type: "object", properties: { result: { type: "integer", enum: [1, 2] } }, required: ["result"] }
  const result = await run(['{"result":"1"}', '{"result":1}'], 2, { schema: canonical, gemini: true })
  expect(result.info.structured).toEqual({ result: 1 })
  expect(result.rejected).toHaveLength(1)
  const tools = result.requests[0].tools as { function: { name: string; parameters: unknown } }[]
  expect(tools.find((tool) => tool.function.name === "StructuredOutput")?.function.parameters).toMatchObject({
    properties: { result: { type: "string", enum: ["1", "2"] } },
  })
  expect(canonical.properties.result).toEqual({ type: "integer", enum: [1, 2] })
}, 15_000)
