import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

test("discovery failure retains the client, reports failure and retries successfully", async () => {
  await using tmp = await tmpdir()
  let lists = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      if (new URL(req.url).pathname === "/failed") return new Response(null, { status: 503 })
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
      lists++
      if (lists === 2)
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "one-time failure" } })
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [{ name: "record_finding", description: "Record", inputSchema: { type: "object" } }],
        },
      })
    },
  })
  await Bun.write(
    path.join(tmp.path, "aictrl.json"),
    JSON.stringify({
      mcp: { fixture: { type: "remote", url: `http://127.0.0.1:${server.port}/mcp`, oauth: false, timeout: 1000 } },
    }),
  )
  // Isolate this real SDK client from unrelated MCP test modules' mocks.
  const probe = path.join(tmp.path, "probe.ts")
  await Bun.write(
    probe,
    `
    import assert from "node:assert/strict"
    import { MCP } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/mcp/index.ts"))}
    import { Instance } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/project/instance.ts"))}
    await Instance.provide({ directory: process.cwd(), fn: async () => {
      try {
        await assert.rejects(MCP.tools(), /MCP tool discovery failed for server "fixture"/)
        assert.equal((await MCP.status()).fixture.status, "failed")
        assert.equal(Object.keys(await MCP.clients()).length, 1)
        assert.deepEqual(Object.keys(await MCP.tools()), ["fixture_record_finding"])
        assert.equal((await MCP.status()).fixture.status, "connected")
        await MCP.add("fixture", { type: "remote", url: ${JSON.stringify(`http://127.0.0.1:${server.port}/failed`)}, oauth: false, timeout: 1000 })
        assert.equal((await MCP.status()).fixture.status, "failed")
        assert.deepEqual(Object.keys(await MCP.tools()), [])
        await MCP.disconnect("fixture")
        assert.equal((await MCP.status()).fixture.status, "disabled")
        assert.equal(Object.keys(await MCP.clients()).length, 0)
      } finally { await Instance.dispose() }
    } })
  `,
  )
  const proc = Bun.spawn(["bun", "run", probe], {
    cwd: tmp.path,
    env: {
      ...process.env,
      AICTRL_CONFIG_CONTENT: "{}",
      AICTRL_DISABLE_PROJECT_CONFIG: "false",
      AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
      AICTRL_DISABLE_MODELS_FETCH: "true",
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
    const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(exit, stderr).toBe(0)
    expect(lists).toBe(3)
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
    server.stop(true)
  }
}, 20000)
