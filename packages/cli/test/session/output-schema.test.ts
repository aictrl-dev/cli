import { expect, spyOn, test } from "bun:test"
import { APICallError } from "ai"
import { LLM } from "../../src/session/llm"
import { PermissionNext } from "../../src/permission/next"
import Ajv from "ajv"
import Ajv2020 from "ajv/dist/2020"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Bus } from "../../src/bus"
import { MessageV2 } from "../../src/session/message-v2"
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
    compact?: boolean
    parallel?: string[]
    retry?: boolean
    queued?: boolean
    followup?: boolean
    denied?: boolean
    invalid?: boolean
  } = {},
) {
  const requests: Record<string, unknown>[] = []
  let directory = ""
  let sessionID = ""
  let notify: () => void = () => {}
  const delivered = new Promise<void>((resolve) => {
    notify = resolve
  })
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
      if (options.queued && requests.length === 1) {
        // Persist a genuine new user message while the current model turn runs.
        await Instance.provide({
          directory,
          fn: () =>
            SessionPrompt.prompt({
              sessionID,
              noReply: true,
              model: { providerID: "alibaba", modelID: "qwen-plus" },
              parts: [{ type: "text", text: "A plain follow-up." }],
            }),
        })
      }
      const args = inputs[Math.min(requests.length - 1, inputs.length - 1)]
      const calls = (options.parallel ?? [args]).map((args, index) => ({
        index,
        id: `call_${requests.length}_${index}`,
        type: "function",
        function: { name: options.invalid ? "invalid" : "StructuredOutput", arguments: args },
      }))
      if ((options.queued || options.denied) && requests.length === 1) {
        calls[0].function = {
          name: "read",
          arguments: JSON.stringify({ filePath: options.denied ? "/outside-fixture.txt" : "aictrl.json" }),
        }
      }
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta:
                args === "prose" && !((options.queued || options.denied) && requests.length === 1)
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
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason:
                (options.queued || options.denied) && requests.length === 1 ? "tool-calls" : (options.finish ?? "stop"),
            },
          ],
          usage: {
            prompt_tokens: options.compact && requests.length === 1 ? 1000000 : 1,
            completion_tokens: 1,
            total_tokens: options.compact && requests.length === 1 ? 1000001 : 2,
          },
        },
      ]
      if (options.retry && requests.length === 1) {
        return new Response(
          new ReadableStream({
            async start(controller) {
              chunks
                .slice(0, 2)
                .forEach((chunk) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)))
              await delivered
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ error: { message: JSON.stringify({ type: "error", error: { type: "too_many_requests" } }) } })}\n\ndata: [DONE]\n\n`,
                ),
              )
              controller.close()
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      }
      return new Response(
        chunks
          .map((chunk) => `data: ${JSON.stringify(chunk)}`)
          .concat("data: [DONE]")
          .join("\n\n") + "\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })
  // SSE errors are text; convert just the fixture's error into the typed
  // retryable failure a provider throws after partially delivering a stream.
  const original = LLM.stream
  const stream = options.retry
    ? spyOn(LLM, "stream").mockImplementation(async (input) => {
        const result = await original(input)
        return new Proxy(result, {
          get(target, key, receiver) {
            if (key !== "fullStream") return Reflect.get(target, key, receiver)
            return target.fullStream.pipeThrough(
              new TransformStream({
                transform(chunk, controller) {
                  controller.enqueue(
                    chunk.type === "error"
                      ? {
                          type: "error",
                          error: new APICallError({
                            message: "Fixture stream interrupted",
                            url: server.url.href,
                            requestBodyValues: {},
                            statusCode: 503,
                            isRetryable: true,
                            responseHeaders: { "retry-after-ms": "1" },
                          }),
                        }
                      : chunk,
                  )
                },
              }),
            )
          },
        })
      })
    : undefined
  try {
    await using tmp = await tmpdir({
      config: {
        ...(options.steps ? { agent: { build: { steps: options.steps } } } : {}),
        ...(options.compact ? { compaction: { auto: true } } : {}),
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
        directory = tmp.path
        const session = await Session.create({ title: "Schema boundary fixture" })
        sessionID = session.id
        const rejected: {
          sessionID: string
          attempt: number
          maxAttempts: number
          errors: OutputSchema.Diagnostic[]
        }[] = []
        const outcomes: OutputSchema.Outcome[] = []
        const permissions: string[] = []
        const unsubscribe = [
          Bus.subscribe(PermissionNext.Event.Asked, async (event) => {
            if (event.properties.sessionID !== session.id) return
            permissions.push(event.properties.permission)
            if (!options.denied && !options.invalid) return
            await PermissionNext.reply({ requestID: event.properties.id, reply: "reject" })
          }),
          Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            const part = event.properties.part
            if (
              part.sessionID === session.id &&
              part.type === "tool" &&
              (part.state.status === "completed" || part.state.status === "error")
            )
              notify()
          }),
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
          const followup = options.followup
            ? await SessionPrompt.prompt({
                sessionID: session.id,
                model: { providerID: "alibaba", modelID: "qwen-plus" },
                parts: [{ type: "text", text: "A plain follow-up." }],
              })
            : undefined
          if (result.info.role !== "assistant") throw new Error("Expected assistant")
          return {
            info: result.info,
            followup,
            requests,
            rejected,
            outcomes,
            permissions,
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
    stream?.mockRestore()
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
  const result = await run(["prose"], 0)
  expect(result.requests).toHaveLength(1)
  expect(result.requests[0].tool_choice).toBe("required")
  expect(result.rejected).toEqual([
    {
      sessionID: result.info.sessionID,
      attempt: 1,
      maxAttempts: 1,
      errors: [{ path: "", keyword: "missing", message: "call StructuredOutput with the final result" }],
    },
  ])
  expect(result.info.structured).toBeUndefined()
  expect(result.info.error).toMatchObject({ name: "StructuredOutputError", data: { retries: 0 } })
  expect(result.outcomes).toEqual([{ status: "failed", reason: "missing", attempts: 1 }])
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
  expect(result.requests[0].tool_choice).toBe("auto")
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
  expect(result.info.error).toMatchObject({ name: "StructuredOutputError", data: { retries: 2 } })
  expect(result.requests).toHaveLength(3)
  expect(result.rejected).toHaveLength(3)
  expect(result.outcomes).toEqual([{ status: "failed", reason: "missing", attempts: 3 }])
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

test("prose-only finish is a counted corrective attempt before a valid result", async () => {
  const result = await run(["prose", '{"result":"repaired"}'], 1)
  expect(result.requests).toHaveLength(2)
  expect(result.requests[0].tool_choice).toBe("required")
  expect(result.requests[1].tool_choice).toEqual({ type: "function", function: { name: "StructuredOutput" } })
  expect(result.info.structured).toEqual({ result: "repaired" })
  expect(result.info.error).toBeUndefined()
  expect(result.rejected).toEqual([
    {
      sessionID: result.info.sessionID,
      attempt: 1,
      maxAttempts: 2,
      errors: [{ path: "", keyword: "missing", message: "call StructuredOutput with the final result" }],
    },
  ])
  expect(JSON.stringify(result.requests[1].messages)).toContain("call StructuredOutput with the final result")
  expect(result.outcomes).toEqual([{ status: "accepted", attempts: 2, value: { result: "repaired" } }])
}, 15_000)

test("a final validation rejection after a missing turn reports exhausted", async () => {
  const result = await run(["prose", "{}"], 1)
  expect(result.requests).toHaveLength(2)
  expect(result.info.structured).toBeUndefined()
  expect(result.info.error).toMatchObject({ name: "StructuredOutputError", data: { retries: 1 } })
  expect(result.rejected.map((event) => event.errors[0].keyword)).toEqual(["missing", "required"])
  expect(result.outcomes).toEqual([{ status: "failed", reason: "exhausted", attempts: 2 }])
}, 15_000)

test("repeated prose-only finishes spend the configured corrective budget", async () => {
  const result = await run(["prose"], 2)
  expect(result.requests).toHaveLength(3)
  expect(result.rejected.map((event) => event.attempt)).toEqual([1, 2, 3])
  expect(result.rejected.every((event) => event.errors[0].keyword === "missing")).toBe(true)
  expect(result.info.structured).toBeUndefined()
  expect(result.info.error).toMatchObject({ name: "StructuredOutputError", data: { retries: 2 } })
  expect(result.outcomes).toEqual([{ status: "failed", reason: "missing", attempts: 3 }])
}, 15_000)

test("compaction precedes missing reminders and preserves the schema contract", async () => {
  const result = await run(["prose", "prose", '{"result":"accepted"}'], 0, { compact: true })
  expect(
    result.requests,
    JSON.stringify({ requests: result.requests, messages: result.messages, outcomes: result.outcomes }),
  ).toHaveLength(3)
  expect(result.messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(true)
  expect(result.requests[1].tools).toBeUndefined()
  expect(result.requests[2].tool_choice).toBe("required")
  expect(JSON.stringify(result.requests[2].tools)).toContain("StructuredOutput")
  expect(JSON.stringify(result.requests[2].messages)).toContain("The user has requested structured output")
  expect(result.rejected).toEqual([])
  expect(result.outcomes).toEqual([{ status: "accepted", attempts: 1, value: { result: "accepted" } }])
}, 15000)

for (const queued of [false, true]) {
  test(`plain follow-up clears the schema contract ${queued ? "during" : "after"} a run`, async () => {
    const result = await run([queued ? "prose" : '{"result":"accepted"}', "prose"], 0, { queued, followup: !queued })
    expect(result.requests, JSON.stringify(result.info)).toHaveLength(2)
    expect(result.requests[0].tool_choice).toBe("required")
    expect(result.requests[1].tool_choice).toBe("auto")
    expect(JSON.stringify(result.requests[1].tools)).not.toContain("StructuredOutput")
    // The old schema instruction can remain in history only as ordinary conversation.
    const messages = result.requests[1].messages as { role: string; content: unknown }[]
    expect(JSON.stringify(messages.filter((message) => message.role === "system"))).not.toContain(
      "The user has requested structured output",
    )
    expect(result.rejected).toEqual([])
  }, 15000)
}

for (const input of ["{}", '{"result":"discarded"}']) {
  test(`provider stream retry restores ${input === "{}" ? "rejected budget" : "captured result"}`, async () => {
    const invalid = input === "{}"
    const result = await run(
      invalid ? [input, "{}", '{"result":"accepted"}'] : [input, '{"result":"accepted"}'],
      invalid ? 1 : 0,
      { retry: true },
    )
    expect(result.requests, JSON.stringify(result.info)).toHaveLength(invalid ? 3 : 2)
    expect(result.info.error).toBeUndefined()
    expect(result.info.structured).toEqual({ result: "accepted" })
    expect(result.outcomes).toEqual([{ status: "accepted", attempts: invalid ? 2 : 1, value: { result: "accepted" } }])
    // Discarded rejections stay as telemetry, while the clean stream starts at attempt 1.
    expect(result.rejected.map((event) => event.attempt)).toEqual(invalid ? [1, 1] : [])
    expect(JSON.stringify(result.requests[1])).not.toContain("discarded")
  }, 15000)
}

for (const parallel of [
  ["{}", '{"result":"accepted"}'],
  ['{"result":"accepted"}', "{}"],
]) {
  test(`valid parallel call wins with zero retries: ${parallel[0] === "{}" ? "invalid first" : "valid first"}`, async () => {
    const result = await run(["unused"], 0, { parallel })
    expect(result.requests).toHaveLength(1)
    expect(result.info.error).toBeUndefined()
    expect(result.info.structured).toEqual({ result: "accepted" })
    expect(result.outcomes).toEqual([{ status: "accepted", attempts: 2, value: { result: "accepted" } }])
    expect(result.rejected).toMatchObject([{ attempt: parallel[0] === "{}" ? 1 : 2, maxAttempts: 1 }])
  }, 15000)
}

test("permission denial without a provider error reports missing output", async () => {
  const result = await run(["unused"], 0, { denied: true })
  expect(result.requests, JSON.stringify(result.info)).toHaveLength(1)
  expect(result.info.error).toBeUndefined()
  expect(result.info.structured).toBeUndefined()
  expect(result.outcomes).toEqual([{ status: "failed", reason: "missing", attempts: 0 }])
}, 15000)

test("diagnostic paths clip every model-chosen property segment without including values", () => {
  const validate = OutputSchema.compile({
    type: "object",
    additionalProperties: { type: "object", additionalProperties: { type: "integer" } },
  })
  const key = "k".repeat(100)
  expect(validate({ [key]: { [key]: "submitted-private-value" } })).toBe(false)
  const errors = OutputSchema.diagnostics(validate.errors)
  expect(errors[0].path.split("/").every((segment) => segment.length <= 64)).toBe(true)
  expect(errors[0].path).toStartWith("/" + "k".repeat(64) + "/")
  expect(JSON.stringify(errors)).not.toContain("submitted-private-value")
})

test("direct invalid tool calls cannot forge structured repair provenance", async () => {
  const raw = JSON.stringify({ tool: "StructuredOutput", error: "x" })
  const result = await run([raw], 0, { invalid: true, parallel: [raw, raw, raw] })
  expect(result.permissions).toEqual(["doom_loop"])
  expect(result.info.structured).toBeUndefined()
}, 15000)

test("genuine structured repairs are exempt from the doom-loop guard", async () => {
  const result = await run(["{}"], 2, { parallel: ["{}", "{}", "{}"] })
  expect(result.rejected).toHaveLength(3)
  expect(result.permissions).toEqual([])
  expect(result.outcomes).toEqual([{ status: "failed", reason: "exhausted", attempts: 3 }])
}, 15000)

test("structured error summaries preserve bounded identity without submitted data", () => {
  expect(
    OutputSchema.summary(
      new APICallError({
        message: "submitted-secret",
        url: "https://example.com",
        requestBodyValues: { input: "submitted-secret" },
        responseBody: "submitted-secret",
        statusCode: 400,
        isRetryable: false,
      }),
    ),
  ).toEqual({
    message: "Structured output stream failed",
    name: "AI_APICallError",
    statusCode: 400,
    isRetryable: false,
  })
  expect(OutputSchema.summary({ name: "x".repeat(200), statusCode: "secret", isRetryable: "secret" })).toEqual({
    message: "Structured output stream failed",
    name: "x".repeat(96),
  })
})

test("serialized schema limit counts bytes and accepts exactly 64 KiB", () => {
  const schema = { type: "object", description: "" }
  const size = Buffer.byteLength(JSON.stringify(schema))
  schema.description = "x".repeat(64 * 1024 - size)
  expect(OutputSchema.compile(schema)({})).toBe(true)
  expect(() => OutputSchema.compile({ ...schema, description: schema.description + "x" })).toThrow("64 KiB")
  expect(() => OutputSchema.compile({ ...schema, description: "é".repeat(33 * 1024) })).toThrow("64 KiB")
  expect(OutputSchema.compile(schema)).toBe(OutputSchema.compile(JSON.parse(JSON.stringify(schema))))
})

test("prompt path rejects an oversized schema before any provider request", async () => {
  await expect(run(["unused"], 0, { schema: { type: "object", description: "x".repeat(64 * 1024) } })).rejects.toThrow(
    "64 KiB",
  )
})

test("retryCount accepts the upper bound and clamps legacy values above ten", () => {
  expect(MessageV2.OutputFormatJsonSchema.parse({ type: "json_schema", schema, retryCount: 10 }).retryCount).toBe(10)
  expect(MessageV2.OutputFormatJsonSchema.parse({ type: "json_schema", schema, retryCount: 50 }).retryCount).toBe(10)
})

test("every parallel rejection is counted after the corrective budget is spent", async () => {
  const result = await run(["unused"], 0, { parallel: ["{}", "{}", "{}"] })
  expect(result.requests).toHaveLength(1)
  expect(result.rejected).toMatchObject([
    { attempt: 1, maxAttempts: 1 },
    { attempt: 2, maxAttempts: 1 },
    { attempt: 3, maxAttempts: 1 },
  ])
  expect(result.outcomes).toEqual([{ status: "failed", reason: "exhausted", attempts: 3 }])
})

test("provider tool description includes canonical pattern constraints", async () => {
  const canonical = {
    type: "object",
    properties: { result: { type: "string", pattern: "^OK-[0-9]{4}$" } },
    required: ["result"],
    additionalProperties: false,
  }
  const result = await run(['{"result":"OK-1234"}'], 0, { schema: canonical, gemini: true })
  const tools = result.requests[0].tools as { function: { name: string; description: string } }[]
  expect(tools.find((tool) => tool.function.name === "StructuredOutput")?.function.description).toContain(
    JSON.stringify(canonical),
  )
})

for (const [name, description] of [
  ["ASCII", "x".repeat(9 * 1024)],
  ["multibyte", "x" + "€".repeat(4 * 1024)],
]) {
  test(`tool description caps ${name} schema at 8 KiB and explains truncation`, () => {
    const canonical = { type: "object", description }
    const tool = SessionPrompt.createStructuredOutputTool({ schema: canonical, onSuccess() {} })
    const text = JSON.stringify(canonical)
    const expected = new TextDecoder().decode(Buffer.from(text).subarray(0, 8 * 1024))
    expect(tool.description).toContain("truncated; the validator enforces the full schema")
    expect(tool.description?.split(": ").at(-1)).toBe(expected)
    if (name === "multibyte") expect(expected).toEndWith("�")
  })
}

for (const [name, schema, reason] of [
  ["oversized", { type: "object", description: "é".repeat(33 * 1024) }, "64 KiB"],
  [
    "over-deep",
    { type: "object", properties: { a: Array.from({ length: 65 }).reduce<object>((inner) => ({ not: inner }), {}) } },
    "nesting must not exceed 64 levels",
  ],
  ["too many objects", { type: "object", examples: Array.from({ length: 10_000 }, () => ({})) }, "10000"],
] as const) {
  test(`custom validator cannot bypass ${name} schema bounds`, () => {
    expect(() =>
      SessionPrompt.createStructuredOutputTool({
        schema,
        validate: OutputSchema.compile({ type: "object" }),
        onSuccess() {},
      }),
    ).toThrow(reason)
  })
}
