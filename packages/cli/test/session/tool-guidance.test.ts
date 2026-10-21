import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import path from "node:path"

// Install before runtime imports: every model request is local or an intercepted
// Codex request carrying inert auth. Never fall through to an external origin.
const originalFetch = globalThis.fetch
const transport = { origin: "", codex: false, captures: [] as Wire[] }
type WireTool = { name?: string; description?: string; parameters?: unknown; function?: WireTool }
type Wire = {
  messages?: { role: string; content: unknown }[]
  input?: unknown
  instructions?: string
  tools?: WireTool[]
}
function chat() {
  const chunks = [
    {
      id: "fixture",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "done" } }],
    },
    { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
  return sse(chunks)
}
function responses() {
  return sse([
    { type: "response.created", response: { id: "resp-fixture", created_at: 1, model: "gpt-5.2", service_tier: null } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "item-fixture" } },
    { type: "response.output_text.delta", item_id: "item-fixture", delta: "done", logprobs: null },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "item-fixture" } },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null },
        service_tier: null,
      },
    },
  ])
}
function sse(chunks: unknown[]) {
  return new Response(
    chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}`)
      .concat("data: [DONE]")
      .join("\n\n") + "\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
}
globalThis.fetch = (async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (transport.codex && url.origin === "https://chatgpt.com" && url.pathname.endsWith("/responses")) {
    transport.captures.push(JSON.parse(String(init?.body)) as Wire)
    return responses()
  }
  if (url.origin !== transport.origin) throw new Error(`Blocked unexpected model transport: ${url.origin}`)
  return originalFetch(input, init)
}) as typeof fetch

const [
  { Tool },
  { default: z },
  { tool, jsonSchema },
  { Instance },
  { Session },
  { SessionPrompt },
  { LLM },
  { ToolRegistry },
  { Plugin },
  { MCP },
  { Auth },
  { HeadlessRun },
  { tmpdir },
] = await Promise.all([
  import("../../src/tool/tool"),
  import("zod"),
  import("ai"),
  import("../../src/project/instance"),
  import("../../src/session"),
  import("../../src/session/prompt"),
  import("../../src/session/llm"),
  import("../../src/tool/registry"),
  import("../../src/plugin"),
  import("../../src/mcp"),
  import("../../src/auth"),
  import("../../src/flag/headless-run"),
  import("../fixture/fixture"),
])

type StreamInput = Parameters<typeof LLM.stream>[0]
type PromptInput = Parameters<typeof SessionPrompt.prompt>[0]
type Fixture = {
  prompt(input?: Partial<PromptInput>): Promise<Wire>
  direct(input: StreamInput): Promise<Wire>
  input(): StreamInput
}

function definitions(body: Wire) {
  return (body.tools ?? []).map((item) => item.function ?? item)
}
function names(body: Wire) {
  return definitions(body)
    .map((item) => item.name)
    .sort()
}
function description(body: Wire, name: string) {
  const result = definitions(body).find((item) => item.name === name)
  if (!result) throw new Error(`Expected declared tool ${name}`)
  return result.description ?? ""
}
function system(body: Wire) {
  return (body.messages ?? [])
    .filter((item) => item.role === "system")
    .map((item) => (typeof item.content === "string" ? item.content : JSON.stringify(item.content)))
    .join("\n")
}
const full = ["bash", "edit", "glob", "grep", "read", "skill", "task", "webfetch", "write"]
const reduced = ["bash", "edit", "read", "write"]
const off = ["glob", "grep", "task", "webfetch", "skill"]
const denied = Object.fromEntries(off.map((name) => [name, "deny" as const]))

async function fixture(
  label: string,
  options: {
    permission?: Record<string, "allow" | "deny">
    session?: StreamInput["permission"]
    gpt?: boolean
    codex?: boolean
    buildPrompt?: string
  } = {},
  fn: (context: Fixture) => Promise<void>,
) {
  transport.captures = []
  transport.codex = options.codex ?? false
  const providerID = options.gpt || options.codex ? "openai" : "fixture"
  const modelID = providerID === "openai" ? "gpt-5.2" : "fixture"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      transport.captures.push((await request.json()) as Wire)
      return providerID === "openai" ? responses() : chat()
    },
  })
  transport.origin = server.url.origin
  const previousAuth = options.codex ? await Auth.get("openai") : undefined
  if (options.codex)
    await Auth.set("openai", {
      type: "oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: Date.now() + 60_000,
    })
  const original = LLM.stream
  let last: StreamInput | undefined
  const spy = spyOn(LLM, "stream").mockImplementation(async (input) => {
    last = input
    return original(input)
  })
  try {
    await using tmp = await tmpdir({
      config: {
        permission: { "*": "allow", ...options.permission },
        enabled_providers: [providerID],
        provider: {
          [providerID]: {
            npm: providerID === "openai" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
            options: { apiKey: "fixture", baseURL: `${server.url.origin}/v1` },
            ...(providerID === "fixture"
              ? { models: { fixture: { name: "fixture", tool_call: true, limit: { context: 200_000, output: 1000 } } } }
              : {}),
          },
        },
        ...(options.buildPrompt ? { agent: { build: { prompt: options.buildPrompt } } } : {}),
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "Tool guidance fixture", permission: options.session })
        const context: Fixture = {
          async prompt(input = {}) {
            const before = transport.captures.length
            const result = await SessionPrompt.prompt({
              sessionID: session.id,
              model: { providerID, modelID },
              parts: [{ type: "text", text: "Say done without calling tools." }],
              ...input,
            })
            if (result.info.role !== "assistant" || result.info.error) throw new Error(JSON.stringify(result.info))
            expect(transport.captures.length - before).toBe(1)
            return transport.captures[before]
          },
          async direct(input) {
            const before = transport.captures.length
            const stream = await LLM.stream(input)
            for await (const _ of stream.fullStream) {
              /* consume actual SDK serialization */
            }
            expect(transport.captures.length - before).toBe(1)
            return transport.captures[before]
          },
          input() {
            if (!last) throw new Error("Prompt must capture production-built tools first")
            return last
          },
        }
        await fn(context)
      },
    })
  } finally {
    const output = process.env.GUIDANCE_CAPTURE_DIR
    if (output)
      await Bun.write(
        path.join(output, `${label}.json`),
        JSON.stringify({ label, codex: options.codex ?? false, requests: transport.captures }, null, 2),
      )
    spy.mockRestore()
    server.stop(true)
    transport.origin = ""
    transport.codex = false
    if (options.codex) {
      if (previousAuth) await Auth.set("openai", previousAuth)
      else await Auth.remove("openai")
    }
  }
}

beforeAll(() => HeadlessRun.enable())
afterAll(() => {
  HeadlessRun.disable()
  globalThis.fetch = originalFetch
})

describe("actual request tool guidance (#244)", () => {
  test("full built-in catalog retains useful peer guidance", async () => {
    await fixture("full", {}, async (context) => {
      const body = await context.prompt()
      expect(names(body)).toEqual(full)
      expect(system(body)).toContain("Use the Task tool")
      safety(body)
      const prefix =
        system(body).length +
        definitions(body).reduce(
          (sum, item) =>
            sum + (item.name?.length ?? 0) + (item.description?.length ?? 0) + JSON.stringify(item.parameters).length,
          0,
        )
      expect(prefix).toBeLessThanOrEqual(15_000)
      expect(description(body, "bash")).toContain("Glob (not find/ls)")
      expect(description(body, "bash")).toContain("Grep (not grep/rg)")
      expect(description(body, "read")).toContain("Use the grep tool")
      expect(description(body, "read")).toContain("use the glob tool")
    })
  })

  test("four-tool permission profile omits absent Task Glob Grep recommendations", async () => {
    await fixture("four-tools", { permission: denied }, async (context) => {
      const body = await context.prompt()
      expect(names(body)).toEqual(reduced)
      expect(system(body)).not.toContain("Use the Task tool")
      expect(description(body, "bash")).not.toContain("Glob (not find/ls)")
      expect(description(body, "bash")).not.toContain("Grep (not grep/rg)")
      expect(description(body, "read")).not.toContain("Use the grep tool")
      expect(description(body, "read")).not.toContain("use the glob tool")
    })
  })
})

function custom(id: string, description: string) {
  return Tool.define(id, {
    description,
    parameters: z.object({ value: z.string().optional() }),
    execute: async () => ({ title: "fixture", metadata: {}, output: "fixture" }),
  })
}

function safety(body: Wire) {
  expect(system(body)).toContain("don't retry it or work around it")
  expect(system(body)).toContain("when calls are independent")
}

describe("final request capability and ownership boundaries (#244)", () => {
  test("session-only denial removes delegation advice after agent allows Task", async () => {
    await fixture(
      "session-deny",
      { session: [{ permission: "task", pattern: "*", action: "deny" }] },
      async (context) => {
        const body = await context.prompt()
        expect(names(body)).toEqual(full.filter((name) => name !== "task"))
        expect(system(body)).not.toContain("Use the Task tool")
        expect(description(body, "glob")).not.toContain("use the Task tool")
        expect(description(body, "grep")).not.toContain("use the Task tool")
        safety(body)
      },
    )
  })

  test("legacy prompt tools-false applies before rendering guidance", async () => {
    await fixture("legacy-tools-false", {}, async (context) => {
      const body = await context.prompt({ tools: Object.fromEntries(off.map((name) => [name, false])) })
      expect(names(body)).toEqual(reduced)
      expect(system(body)).not.toContain("Use the Task tool")
      expect(description(body, "bash")).not.toContain("Glob (not find/ls)")
      expect(description(body, "read")).not.toContain("Use the grep tool")
      safety(body)
    })
  })

  for (const absent of ["glob", "grep"] as const) {
    test(`search capability ${absent} renders independently`, async () => {
      await fixture(`mixed-search-${absent}`, { permission: { [absent]: "deny" } }, async (context) => {
        const body = await context.prompt()
        expect(names(body)).toEqual(full.filter((name) => name !== absent))
        const present = absent === "glob" ? "grep" : "glob"
        expect(description(body, "bash")).not.toContain(absent === "glob" ? "Glob (not find/ls)" : "Grep (not grep/rg)")
        expect(description(body, "bash")).toContain(present === "glob" ? "Glob (not find/ls)" : "Grep (not grep/rg)")
        expect(description(body, "read")).not.toContain(absent === "glob" ? "use the glob tool" : "Use the grep tool")
      })
    })
  }

  test("Grep does not recommend unavailable Bash for counts", async () => {
    await fixture("no-bash", { permission: { bash: "deny" } }, async (context) => {
      const body = await context.prompt()
      expect(names(body)).not.toContain("bash")
      expect(description(body, "grep")).not.toContain("Bash tool with `rg`")
      expect(system(body)).not.toContain("with bash if they were provided")
    })
  })

  test("full reduced full reuses original tools without mutation or guidance leakage", async () => {
    await fixture("full-reduced-full", {}, async (context) => {
      const first = await context.prompt()
      const input = context.input()
      const originalTools = input.tools
      const before = Object.fromEntries(Object.entries(originalTools).map(([name, value]) => [name, value.description]))
      const middle = await context.direct({
        ...input,
        permission: off.map((permission) => ({ permission, pattern: "*", action: "deny" })),
      })
      expect(names(middle)).toEqual(reduced)
      expect(system(middle)).not.toContain("Use the Task tool")
      expect(
        Object.fromEntries(Object.entries(originalTools).map(([name, value]) => [name, value.description])),
      ).toEqual(before)
      const last = await context.direct({ ...input, permission: [] })
      expect(names(first)).toEqual(full)
      expect(names(last)).toEqual(full)
      expect(description(last, "bash")).toEqual(description(first, "bash"))
      expect(system(last)).toContain("Use the Task tool")
    })
  })

  test("same-name custom Task does not enable built-in delegation recommendations", async () => {
    const text = "Custom Task is a ticket lookup. Literal use the Task tool stays verbatim."
    await fixture("custom-task", {}, async (context) => {
      await ToolRegistry.register(custom("task", text))
      const body = await context.prompt()
      expect(names(body)).toEqual(full)
      expect(description(body, "task")).toBe(text)
      expect(system(body)).not.toContain("Use the Task tool")
      expect(description(body, "glob")).not.toContain("use the Task tool")
      expect(description(body, "grep")).not.toContain("use the Task tool")
    })
  })

  test("same-name custom Read preserves text but cannot enable built-in reading advice", async () => {
    const text = "Custom Read queries tickets, not files. Read this exact text."
    await fixture("custom-read", {}, async (context) => {
      await ToolRegistry.register(custom("read", text))
      const body = await context.prompt()
      expect(description(body, "read")).toBe(text)
      expect(description(body, "bash")).not.toContain("Read (not cat/head/tail)")
      expect(description(body, "edit")).not.toContain("use your `Read` tool")
      expect(description(body, "edit")).toContain("oldString")
      expect(description(body, "write")).not.toContain("use your `Read` tool")
    })
  })

  test("missing Read preserves truthful conditional Edit Write prerequisites", async () => {
    await fixture("no-read-prerequisites", { permission: { read: "deny" } }, async (context) => {
      const body = await context.prompt()
      expect(names(body)).not.toContain("read")
      expect(description(body, "edit")).not.toContain("use your `Read` tool")
      expect(description(body, "edit")).toContain("oldString")
      expect(description(body, "edit")).toContain("empty")
      expect(description(body, "edit")).toContain("missing or stale")
      expect(description(body, "edit")).toContain("session")
      expect(description(body, "write")).not.toContain("use your `Read` tool")
      expect(description(body, "write")).toContain("session")
      expect(description(body, "write")).toContain("existing")
      expect(description(body, "write")).toContain("new file")
      expect(description(body, "write")).toContain("missing or stale")
    })
  })

  for (const mode of ["replace", "append", "parameters"] as const) {
    test(`plugin ${mode} respects description ownership`, async () => {
      const original = Plugin.trigger
      let expected = ""
      const spy = spyOn(Plugin, "trigger").mockImplementation((async (name, input, output) => {
        await original(name, input, output)
        if (name === "tool.definition" && (input as { toolID: string }).toolID === "bash") {
          const definition = output as { description: string; parameters: import("zod").ZodType }
          if (mode === "replace") definition.description = "Plugin replacement: use Glob and Task literally."
          if (mode === "append") definition.description += "\nPlugin appendix: use Glob and Task literally."
          if (mode === "parameters") definition.parameters = definition.parameters.describe("plugin parameters")
          expected = definition.description
        }
        return output
      }) as typeof Plugin.trigger)
      try {
        await fixture(`plugin-${mode}`, { permission: denied }, async (context) => {
          const body = await context.prompt()
          expect(names(body)).toEqual(reduced)
          if (mode === "parameters") {
            expect(description(body, "bash")).not.toContain("Glob (not find/ls)")
            expect(description(body, "bash")).not.toBe(expected)
          } else expect(description(body, "bash")).toBe(expected)
        })
      } finally {
        spy.mockRestore()
      }
    })
  }

  test("custom agent caller and MCP text remains verbatim", async () => {
    const agent = "Custom agent explicitly mentions Task, Glob and Grep. Preserve this literal sentence."
    const caller = "Caller text: use the Task tool even when absent. Preserve literally."
    const mcpText = "MCP text: use the Task tool, Glob and Grep literally."
    const spy = spyOn(MCP, "tools").mockResolvedValue({
      fixture_external: tool({
        description: mcpText,
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }),
      }),
    })
    try {
      await fixture("custom-text", { permission: denied, buildPrompt: agent }, async (context) => {
        const body = await context.prompt({ system: caller })
        expect(names(body)).toEqual([...reduced, "fixture_external"].sort())
        expect(system(body)).toContain(agent)
        expect(system(body)).toContain(caller)
        expect(description(body, "fixture_external")).toBe(mcpText)
      })
    } finally {
      spy.mockRestore()
    }
  })

  test("GPT catalog uses apply_patch and omits unavailable built-in Bash peers", async () => {
    await fixture("gpt-api", { gpt: true }, async (context) => {
      const body = await context.prompt()
      expect(names(body)).toEqual(["apply_patch", ...full.filter((name) => name !== "edit" && name !== "write")].sort())
      expect(description(body, "bash")).not.toContain("Edit (not sed/awk/perl)")
      expect(description(body, "bash")).not.toContain("Write (not echo/heredoc redirection)")
    })
  })

  test("Codex full GPT catalog retains surviving capabilities and omits Edit Write", async () => {
    await fixture("codex-full", { codex: true }, async (context) => {
      const body = await context.prompt()
      expect(names(body)).toEqual(["apply_patch", ...full.filter((name) => name !== "edit" && name !== "write")].sort())
      expect(body.instructions).toContain("Try to use apply_patch")
      expect(body.instructions).toContain("Use Read")
      expect(body.instructions).toContain("Use Glob")
      expect(body.instructions).toContain("Grep to search")
      expect(body.instructions).not.toContain("Edit to modify")
      expect(body.instructions).not.toContain("Write only when needed")
    })
  })

  test("Codex no-Bash instructions preserve safety without terminal recommendations", async () => {
    await fixture("codex-no-bash", { codex: true, permission: { bash: "deny" } }, async (context) => {
      const body = await context.prompt()
      expect(names(body)).not.toContain("bash")
      expect(body.instructions).not.toContain("Use Bash for terminal")
      expect(body.instructions).toContain("Run tool calls in parallel")
      expect(body.instructions).toContain("NEVER revert existing changes")
    })
  })

  test("Codex OAuth instructions use final surviving tools", async () => {
    await fixture("codex-reduced", { codex: true, permission: { ...denied, apply_patch: "deny" } }, async (context) => {
      const body = await context.prompt()
      expect(names(body)).toEqual(["bash", "read"])
      expect(body.instructions).toBeString()
      expect(body.instructions).not.toContain("Try to use apply_patch")
      expect(body.instructions).not.toContain("Use Glob")
      expect(body.instructions).not.toContain("Grep to search")
      expect(body.instructions).not.toContain("Edit to modify")
      expect(body.instructions).toContain("Use Read")
      expect(body.instructions).toContain("Run tool calls in parallel")
      expect(body.instructions).toContain("NEVER revert existing changes")
    })
  })
})
