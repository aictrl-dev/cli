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
  message?: string
  tools?: { name: string; source: string }[]
}

describe("headless MCP discovery", () => {
  test.each([
    { name: "healthy", failure: 0, hang: false, turns: 3, code: 0 },
    { name: "failure before first model turn", failure: 3, hang: false, turns: 0, code: 1 },
    { name: "failure after successful model turn", failure: 4, hang: false, turns: 1, code: 1 },
    { name: "hung discovery after successful model turn", failure: 4, hang: true, turns: 1, code: 1 },
  ])(
    "$name",
    async ({ failure, hang, turns, code }) => {
      await using tmp = await tmpdir()
      let lists = 0
      let records = 0
      const requests: string[][] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        async fetch(req): Promise<Response> {
          if (new URL(req.url).pathname === "/mcp") {
            if (req.method !== "POST") return new Response(null, { status: 405 })
            const body = (await req.json()) as { id?: number; method: string; params: { protocolVersion: string } }
            if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
            if (body.method === "initialize") {
              return Response.json({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  protocolVersion: body.params.protocolVersion,
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" },
                },
              })
            }
            if (body.method === "tools/list") {
              lists++
              if (lists === failure) {
                if (hang)
                  return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })
                return Response.json({
                  jsonrpc: "2.0",
                  id: body.id,
                  error: { code: -32603, message: "injected one-time discovery failure" },
                })
              }
              return Response.json({
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  tools: [{ name: "record_finding", description: "Record a finding", inputSchema: { type: "object" } }],
                },
              })
            }
            if (body.method === "tools/call") records++
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: "recorded" }] },
            })
          }
          const body = (await req.json()) as { tools?: { function: { name: string } }[] }
          const tools = body.tools?.map((tool) => tool.function.name) ?? []
          if (tools.length) requests.push(tools)
          const name = requests.length === 1 ? "bash" : "aictrl_record_finding"
          const call = tools.length && requests.length < 3
          const delta = call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `fixture_${requests.length}`,
                    type: "function",
                    function: {
                      name,
                      arguments: JSON.stringify(
                        name === "bash" ? { command: "true", description: "fixture no-op" } : {},
                      ),
                    },
                  },
                ],
              }
            : { content: "Fixture complete" }
          const chunks = [
            { delta: { role: "assistant", ...delta }, finish_reason: null },
            { delta: {}, finish_reason: call ? "tool_calls" : "stop" },
          ].map(
            (choice) =>
              `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`,
          )
          return new Response(chunks.join("") + "data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      const config = {
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}/v1` },
            models: { fixture: { name: "fixture", tool_call: true, limit: { context: 100000, output: 1000 } } },
          },
        },
        agent: { title: { disable: true } },
        mcp: { aictrl: { type: "remote", url: `http://127.0.0.1:${server.port}/mcp`, oauth: false, timeout: 1000 } },
        permission: { "*": "allow" },
      }
      const proc = Bun.spawn(
        [...command, "run", "--format", "json", "--model", "fixture/fixture", "Review this input."],
        {
          cwd: tmp.path,
          env: {
            ...process.env,
            AICTRL_CONFIG_CONTENT: JSON.stringify(config),
            AICTRL_DISABLE_PROJECT_CONFIG: "true",
            AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
            AICTRL_DISABLE_MODELS_FETCH: "true",
            AICTRL_DISABLE_AUTOCOMPACT: "true",
            AICTRL_TEST_HOME: tmp.path,
            AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
            XDG_DATA_HOME: path.join(tmp.path, "data"),
            XDG_CONFIG_HOME: path.join(tmp.path, "config"),
            XDG_STATE_HOME: path.join(tmp.path, "state"),
            XDG_CACHE_HOME: path.join(tmp.path, "cache"),
            AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS: "5000",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timeout = setTimeout(() => proc.kill("SIGKILL"), 15000)
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        const events: Event[] = stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line))
        expect(exit, stderr + stdout).toBe(code)
        expect(requests).toHaveLength(turns)
        for (const tools of requests) expect(tools).toContain("aictrl_record_finding")
        expect(events.find((event) => event.type === "tool_catalog")?.tools).toContainEqual(
          expect.objectContaining({ name: "aictrl_record_finding", source: "mcp" }),
        )
        expect(records).toBe(code ? 0 : 1)
        expect(events.filter((event) => event.type === "session_error")).toHaveLength(code ? 1 : 0)
        if (code) {
          expect(events.find((event) => event.type === "session_error")?.message).toContain(
            'MCP tool discovery failed for server "aictrl"',
          )
        }
        expect(events.filter((event) => event.type === "invocation_complete")).toHaveLength(1)
        expect(events.find((event) => event.type === "invocation_complete")?.status).toBe(code ? "error" : "completed")
      } finally {
        clearTimeout(timeout)
        proc.kill("SIGKILL")
        server.stop(true)
      }
    },
    20000,
  )
})
