import { describe, expect, spyOn, test } from "bun:test"
import { asSchema } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

describe("structured-output.OutputFormat", () => {
  test("parses text format", () => {
    const result = MessageV2.Format.safeParse({ type: "text" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe("text")
    }
  })

  test("parses json_schema format with defaults", () => {
    const result = MessageV2.Format.safeParse({
      type: "json_schema",
      schema: { type: "object", properties: { name: { type: "string" } } },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe("json_schema")
      if (result.data.type === "json_schema") {
        expect(result.data.retryCount).toBe(2) // default value
      }
    }
  })

  test("parses json_schema format with custom retryCount", () => {
    const result = MessageV2.Format.safeParse({
      type: "json_schema",
      schema: { type: "object" },
      retryCount: 5,
    })
    expect(result.success).toBe(true)
    if (result.success && result.data.type === "json_schema") {
      expect(result.data.retryCount).toBe(5)
    }
  })

  test("rejects invalid type", () => {
    const result = MessageV2.Format.safeParse({ type: "invalid" })
    expect(result.success).toBe(false)
  })

  test("rejects json_schema without schema", () => {
    const result = MessageV2.Format.safeParse({ type: "json_schema" })
    expect(result.success).toBe(false)
  })

  test("rejects negative retryCount", () => {
    const result = MessageV2.Format.safeParse({
      type: "json_schema",
      schema: { type: "object" },
      retryCount: -1,
    })
    expect(result.success).toBe(false)
  })
})

describe("structured-output.StructuredOutputError", () => {
  test("creates error with message and retries", () => {
    const error = new MessageV2.StructuredOutputError({
      message: "Failed to validate",
      retries: 3,
    })

    expect(error.name).toBe("StructuredOutputError")
    expect(error.data.message).toBe("Failed to validate")
    expect(error.data.retries).toBe(3)
  })

  test("converts to object correctly", () => {
    const error = new MessageV2.StructuredOutputError({
      message: "Test error",
      retries: 2,
    })

    const obj = error.toObject()
    expect(obj.name).toBe("StructuredOutputError")
    expect(obj.data.message).toBe("Test error")
    expect(obj.data.retries).toBe(2)
  })

  test("isInstance correctly identifies error", () => {
    const error = new MessageV2.StructuredOutputError({
      message: "Test",
      retries: 1,
    })

    expect(MessageV2.StructuredOutputError.isInstance(error)).toBe(true)
    expect(MessageV2.StructuredOutputError.isInstance({ name: "other" })).toBe(false)
  })
})

describe("structured-output.UserMessage", () => {
  test("user message accepts outputFormat", () => {
    const result = MessageV2.User.safeParse({
      id: "test-id",
      sessionID: "test-session",
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3" },
      outputFormat: {
        type: "json_schema",
        schema: { type: "object" },
      },
    })
    expect(result.success).toBe(true)
  })

  test("user message works without outputFormat (optional)", () => {
    const result = MessageV2.User.safeParse({
      id: "test-id",
      sessionID: "test-session",
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3" },
    })
    expect(result.success).toBe(true)
  })
})

describe("structured-output.AssistantMessage", () => {
  const baseAssistantMessage = {
    id: "test-id",
    sessionID: "test-session",
    role: "assistant" as const,
    parentID: "parent-id",
    modelID: "claude-3",
    providerID: "anthropic",
    mode: "default",
    agent: "default",
    path: { cwd: "/test", root: "/test" },
    cost: 0.001,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  }

  test("assistant message accepts structured", () => {
    const result = MessageV2.Assistant.safeParse({
      ...baseAssistantMessage,
      structured: { company: "Anthropic", founded: 2021 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.structured).toEqual({ company: "Anthropic", founded: 2021 })
    }
  })

  test("assistant message works without structured_output (optional)", () => {
    const result = MessageV2.Assistant.safeParse(baseAssistantMessage)
    expect(result.success).toBe(true)
  })
})

describe("structured-output.createStructuredOutputTool", () => {
  const schema = {
    type: "object",
    properties: { elements: { type: "object", additionalProperties: { type: "string" }, minProperties: 1 } },
    required: ["elements"],
  }
  const options = { toolCallId: "call", messages: [], abortSignal: undefined as any }
  const create = (root: string, input: Partial<Parameters<typeof SessionPrompt.createStructuredOutputTool>[0]> = {}) =>
    SessionPrompt.createStructuredOutputTool({
      schema,
      root,
      onReject: async (errors) => JSON.stringify(errors),
      onSuccess: () => {},
      ...input,
    })
  // Rejections report diagnostics through onReject, as the prompt loop does.
  const rejecting = (root: string, rejected: unknown[], input: { schema?: Record<string, unknown> } = {}) =>
    create(root, {
      ...input,
      onReject: async (errors) => {
        rejected.push(errors)
        return `StructuredOutput rejected: ${JSON.stringify(errors)}`
      },
      onSuccess: () => {
        throw new Error("rejected file captured")
      },
    })

  test("creates tool with correct id", async () => {
    await using tmp = await tmpdir()
    // AI SDK tool type doesn't expose id, but we set it internally
    expect((create(tmp.path) as any).id).toBe("StructuredOutput")
  })

  test("only {path} is the tool input schema; the canonical schema is description text", async () => {
    await using tmp = await tmpdir()
    const tool = create(tmp.path, { schema: { $schema: "http://json-schema.org/draft-07/schema#", ...schema } })
    const input = (tool.inputSchema as any).jsonSchema
    expect(Object.keys(input.properties)).toEqual(["path"])
    expect(input.required).toEqual(["path"])
    expect(input.additionalProperties).toBe(false)
    expect(input.properties.path.description).toContain("relative, or absolute inside it")
    expect(tool.description).toContain("write the final result as JSON to a file")
    expect(tool.description).toContain(`Canonical JSON Schema: ${JSON.stringify(schema)}`)
    expect(tool.description).not.toContain("$schema")
  })

  test("AI SDK boundary accepts only a bounded {path}", async () => {
    await using tmp = await tmpdir()
    const validate = asSchema(create(tmp.path).inputSchema).validate!
    expect(await validate({ path: "result.json" })).toMatchObject({ success: true })
    for (const value of [{}, { path: 1 }, { path: "result.json", elements: {} }, { path: "a".repeat(1025) }])
      expect(await validate(value)).toMatchObject({ success: false })
  })

  test("publishes the validated file contents", async () => {
    await using tmp = await tmpdir()
    const value = { elements: { "queued->running": "dispatch", "TASKS.org_id": "fk", "1": "first" } }
    await Bun.write(path.join(tmp.path, "out", "result.json"), JSON.stringify(value))
    const captured: unknown[] = []
    const tool = create(tmp.path, { onSuccess: (output) => void captured.push(output) })
    for (const file of ["out/result.json", path.join(tmp.path, "out", "result.json")]) {
      const result = await tool.execute!({ path: file }, options)
      expect(result.output).toBe("Structured output captured successfully.")
      expect(result.metadata.valid).toBe(true)
    }
    expect(captured).toEqual([value, value])
  })

  test("rejects paths that escape the working directory, directly or through a symlink", async () => {
    await using outside = await tmpdir()
    await using tmp = await tmpdir()
    await Bun.write(path.join(outside.path, "result.json"), JSON.stringify({ elements: { a: "b" } }))
    await fs.symlink(path.join(outside.path, "result.json"), path.join(tmp.path, "link.json"))
    const rejected: unknown[] = []
    const tool = rejecting(tmp.path, rejected)
    for (const file of [
      path.join(outside.path, "result.json"),
      "../" + path.basename(outside.path) + "/result.json",
      "link.json",
    ])
      await expect(tool.execute!({ path: file }, options)).rejects.toThrow("Fix the file at")
    expect(rejected).toEqual(
      Array(3).fill([{ path: "", keyword: "file", message: "path must stay inside the working directory" }]),
    )
  })

  test("rejects missing, non-regular, oversized and unparseable files", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "dir"))
    await Bun.write(path.join(tmp.path, "big.json"), JSON.stringify({ elements: { a: "x".repeat(2 * 1024 * 1024) } }))
    await Bun.write(path.join(tmp.path, "truncated.json"), '{"elements": {"a": "submitted-secret-')
    const rejected: unknown[] = []
    const tool = rejecting(tmp.path, rejected)
    for (const file of ["missing.json", "dir", "big.json", "truncated.json"])
      await expect(tool.execute!({ path: file }, options)).rejects.toThrow(`Fix the file at ${JSON.stringify(file)}`)
    expect(rejected).toEqual([
      [{ path: "", keyword: "file", message: "file not found" }],
      [{ path: "", keyword: "file", message: "path must be a regular file" }],
      [{ path: "", keyword: "file", message: `file must not exceed ${2 * 1024 * 1024} bytes` }],
      // JSON parser errors can echo the file contents, so the diagnostic is fixed.
      [{ path: "", keyword: "parse", message: "file must contain complete, valid JSON" }],
    ])
  })

  test("invalid file content is a counted rejection with a fix-the-file corrective message", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "result.json"), JSON.stringify({ elements: {} }))
    const rejected: unknown[] = []
    const error = await rejecting(tmp.path, rejected).execute!({ path: "result.json" }, options).catch(
      (error: Error) => error,
    )
    expect((error as Error).message).toBe(
      'Fix the file at "result.json", then call StructuredOutput again with its path. StructuredOutput rejected: [{"path":"/elements","keyword":"minProperties","message":"must NOT have fewer than 1 properties"}]',
    )
    expect(rejected).toHaveLength(1)
  })

  test("file content is validated against nested objects, arrays and scalar types", async () => {
    await using tmp = await tmpdir()
    const nested = {
      type: "object",
      properties: {
        user: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        tags: { type: "array", items: { type: "string" } },
        count: { type: "number" },
      },
      required: ["user", "tags", "count"],
    }
    const value = { user: { name: "John" }, tags: ["a", "b"], count: 1 }
    await Bun.write(path.join(tmp.path, "valid.json"), JSON.stringify(value))
    await Bun.write(path.join(tmp.path, "invalid.json"), JSON.stringify({ user: {}, tags: [1], count: "1" }))
    const captured: unknown[] = []
    await create(tmp.path, { schema: nested, onSuccess: (output) => void captured.push(output) }).execute!(
      { path: "valid.json" },
      options,
    )
    expect(captured).toEqual([value])
    const rejected: unknown[] = []
    await expect(
      rejecting(tmp.path, rejected, { schema: nested }).execute!({ path: "invalid.json" }, options),
    ).rejects.toThrow('Fix the file at "invalid.json"')
    expect(rejected).toEqual([
      [
        { path: "/user", keyword: "required", message: "must have required property 'name'" },
        { path: "/tags/0", keyword: "type", message: "must be string" },
        { path: "/count", keyword: "type", message: "must be number" },
      ],
    ])
  })

  test("accepts in-root names that start with two dots", async () => {
    await using tmp = await tmpdir()
    const value = { elements: { a: "b" } }
    await Bun.write(path.join(tmp.path, "..result.json"), JSON.stringify(value))
    await Bun.write(path.join(tmp.path, "..out", "result.json"), JSON.stringify(value))
    const captured: unknown[] = []
    const tool = create(tmp.path, { onSuccess: (output) => void captured.push(output) })
    await tool.execute!({ path: "..result.json" }, options)
    await tool.execute!({ path: "..out/result.json" }, options)
    expect(captured).toEqual([value, value])
  })

  // The swaps below run inside fs.open, after the containment check and before the open:
  // the window a background process started by the model could race.
  test("a result file swapped for an outside symlink after the check is rejected", async () => {
    await using outside = await tmpdir()
    await using tmp = await tmpdir()
    await Bun.write(path.join(outside.path, "secret.json"), JSON.stringify({ elements: { secret: "outside" } }))
    await Bun.write(path.join(tmp.path, "result.json"), JSON.stringify({ elements: { a: "b" } }))
    const open = fs.open
    const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      await fs.rm(path.join(tmp.path, "result.json"))
      await fs.symlink(path.join(outside.path, "secret.json"), path.join(tmp.path, "result.json"))
      return open(...args)
    })
    try {
      const rejected: unknown[] = []
      const tool = rejecting(tmp.path, rejected)
      await expect(tool.execute!({ path: "result.json" }, options)).rejects.toThrow("Fix the file at")
      expect(rejected).toEqual([
        [{ path: "", keyword: "file", message: "path must stay inside the working directory" }],
      ])
    } finally {
      spy.mockRestore()
    }
  })

  test("without O_NOFOLLOW (Windows), the inode re-check still rejects a swapped result file", async () => {
    await using outside = await tmpdir()
    await using tmp = await tmpdir()
    await Bun.write(path.join(outside.path, "secret.json"), JSON.stringify({ elements: { secret: "outside" } }))
    await Bun.write(path.join(tmp.path, "result.json"), JSON.stringify({ elements: { a: "b" } }))
    const open = fs.open
    // Drops the POSIX-only flags, as on win32 where fs.constants defines neither.
    const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      await fs.rm(path.join(tmp.path, "result.json"))
      await fs.symlink(path.join(outside.path, "secret.json"), path.join(tmp.path, "result.json"))
      return open(args[0], fs.constants.O_RDONLY)
    })
    try {
      const rejected: unknown[] = []
      const tool = rejecting(tmp.path, rejected)
      await expect(tool.execute!({ path: "result.json" }, options)).rejects.toThrow("Fix the file at")
      expect(rejected).toEqual([
        [{ path: "", keyword: "file", message: "path must stay inside the working directory" }],
      ])
    } finally {
      spy.mockRestore()
    }
  })

  test("a parent directory swapped for an outside symlink after the check is rejected", async () => {
    await using outside = await tmpdir()
    await using tmp = await tmpdir()
    await Bun.write(path.join(outside.path, "result.json"), JSON.stringify({ elements: { secret: "outside" } }))
    await Bun.write(path.join(tmp.path, "out", "result.json"), JSON.stringify({ elements: { a: "b" } }))
    const open = fs.open
    const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      await fs.rename(path.join(tmp.path, "out"), path.join(tmp.path, "moved"))
      await fs.symlink(outside.path, path.join(tmp.path, "out"))
      return open(...args)
    })
    try {
      const rejected: unknown[] = []
      const tool = rejecting(tmp.path, rejected)
      await expect(tool.execute!({ path: "out/result.json" }, options)).rejects.toThrow("Fix the file at")
      expect(rejected).toEqual([
        [{ path: "", keyword: "file", message: "path must stay inside the working directory" }],
      ])
    } finally {
      spy.mockRestore()
    }
  })

  test("a FIFO is rejected without blocking", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    await Bun.$`mkfifo ${path.join(tmp.path, "result.json")}`.quiet()
    const rejected: unknown[] = []
    const tool = rejecting(tmp.path, rejected)
    const outcome = await Promise.race([
      tool.execute!({ path: "result.json" }, options).catch((error: Error) => error.message),
      Bun.sleep(2_000).then(() => "blocked"),
    ])
    expect(outcome).toContain("Fix the file at")
    expect(rejected).toEqual([[{ path: "", keyword: "file", message: "path must be a regular file" }]])
  })

  test("a file that grows past the cap after stat is rejected without reading it all", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "result.json")
    await Bun.write(target, JSON.stringify({ elements: { a: "b" } }))
    const open = fs.open
    const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      const stat = handle.stat.bind(handle)
      handle.stat = (async (...options: Parameters<typeof handle.stat>) => {
        const result = await stat(...options)
        await fs.appendFile(target, " ".repeat(3 * 1024 * 1024))
        return result
      }) as typeof handle.stat
      return handle
    })
    try {
      const rejected: unknown[] = []
      const tool = rejecting(tmp.path, rejected)
      await expect(tool.execute!({ path: "result.json" }, options)).rejects.toThrow("Fix the file at")
      expect(rejected).toEqual([
        [{ path: "", keyword: "file", message: `file must not exceed ${2 * 1024 * 1024} bytes` }],
      ])
    } finally {
      spy.mockRestore()
    }
  })

  test("an unavailable working directory is a counted rejection, not a raw OS error", async () => {
    await using tmp = await tmpdir()
    const rejected: unknown[] = []
    const tool = rejecting(path.join(tmp.path, "removed"), rejected)
    await expect(tool.execute!({ path: "result.json" }, options)).rejects.toThrow("Fix the file at")
    expect(rejected).toEqual([[{ path: "", keyword: "file", message: "working directory unavailable" }]])
  })

  test("the corrective message JSON-encodes the submitted path", async () => {
    await using tmp = await tmpdir()
    const rejected: unknown[] = []
    const error = await rejecting(tmp.path, rejected).execute!({ path: "a\nb\u001b[31m.json" }, options).catch(
      (error: Error) => error.message,
    )
    expect(error).toStartWith(
      'Fix the file at "a\\nb\\u001b[31m.json", then call StructuredOutput again with its path.',
    )
  })

  test("toModelOutput returns text value", async () => {
    await using tmp = await tmpdir()
    const tool = create(tmp.path)
    expect(tool.toModelOutput).toBeDefined()
    const modelOutput = tool.toModelOutput!({
      output: "Test output",
      title: "Test",
      metadata: { valid: true },
    })

    expect(modelOutput.type).toBe("text")
    expect(modelOutput.value).toBe("Test output")
  })

  // The prompt loop owns the corrective attempt budget; this tool enforces the
  // canonical validator on the file before capture, including direct execute() calls.
})
