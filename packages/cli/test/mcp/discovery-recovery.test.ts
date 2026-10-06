import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

// Real SDK clients run in children so unrelated transport mocks cannot leak in.
async function run(source: string, initial = "initial") {
  await using tmp = await tmpdir()
  const lists: Record<string, number> = {}
  const rpc: Record<string, number> = {}
  const modes: Record<string, string> = { "/mcp": initial, "/replacement": "replacement" }
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  const closed: Record<string, number> = {}
  const releases: (() => void)[] = []
  let active = 0
  let maxActive = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req): Promise<Response> {
      const route = new URL(req.url).pathname
      if (route === "/inspect") return Response.json({ lists, rpc, closed, maxActive })
      if (route === "/control") {
        const body = (await req.json()) as { mode?: string; route?: string; count?: number; release?: boolean }
        if (body.release) releases.splice(0).forEach((resolve) => resolve())
        if (body.mode) {
          const target = body.route ?? "/mcp"
          modes[target] = body.mode
          const stream = streams.get(target)
          if (!stream) throw new Error(`No notification stream for ${target}`)
          for (let i = 0; i < (body.count ?? 1); i++) {
            stream.enqueue(
              new TextEncoder().encode(
                'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
              ),
            )
          }
        }
        return Response.json({ ok: true })
      }
      if (route === "/failed") return new Response(null, { status: 503 })
      if (req.method === "GET") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.set(route, controller)
            },
            cancel() {
              streams.delete(route)
              closed[route] = (closed[route] ?? 0) + 1
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      if (req.method !== "POST") return new Response(null, { status: 405 })
      const body = (await req.json()) as { id?: number; method: string; params: { protocolVersion: string } }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        })
      }
      if (body.method === "prompts/list" || body.method === "resources/list") {
        rpc[body.method] = (rpc[body.method] ?? 0) + 1
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "prompts/list"
              ? { prompts: [{ name: "review", description: "Review prompt" }] }
              : { resources: [{ name: "evidence", uri: "fixture://evidence", description: "Review evidence" }] },
        })
      }
      if (body.method === "tools/call") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: route }] } })
      }
      if (body.method !== "tools/list") return new Response(null, { status: 400 })
      lists[route] = (lists[route] ?? 0) + 1
      const mode = modes[route]
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (mode === "hold") await new Promise<void>((resolve) => releases.push(resolve))
        if (mode === "updated") await Bun.sleep(50)
        if (mode === "error")
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "refresh failure" } })
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools:
              mode === "empty"
                ? []
                : [
                    {
                      name: `record_${mode === "hold" ? "stale" : mode}`,
                      description: mode,
                      inputSchema: { type: "object" },
                    },
                  ],
          },
        })
      } finally {
        active--
      }
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  await Bun.write(
    path.join(tmp.path, "aictrl.json"),
    JSON.stringify({
      mcp: { fixture: { type: "remote", url: `${base}/mcp`, oauth: false, timeout: 1000 } },
    }),
  )
  const probe = path.join(tmp.path, "probe.ts")
  await Bun.write(
    probe,
    `
    import assert from "node:assert/strict"
    import { MCP } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/mcp/index.ts"))}
    import { Instance } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/project/instance.ts"))}
    const base = ${JSON.stringify(base)}
    const inspect = async () => (await fetch(base + "/inspect")).json()
    const extras = async (healthy, calls) => {
      const [prompts, resources] = await Promise.all([MCP.prompts(), MCP.resources()])
      const stats = await inspect()
      assert.deepEqual({
        prompts: Object.keys(prompts), resources: Object.keys(resources),
        calls: [stats.rpc["prompts/list"], stats.rpc["resources/list"]],
      }, {
        prompts: healthy ? ["fixture:review"] : [], resources: healthy ? ["fixture:evidence"] : [],
        calls: [calls, calls],
      }, "prompts and resources must follow the shared MCP health and suppress RPCs while failed")
    }
    const control = async (body) => {
      const response = await fetch(base + "/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      assert.equal(response.status, 200)
    }
    const wait = async (condition) => {
      for (let i = 0; i < 300; i++) {
        if (await condition()) return
        await Bun.sleep(10)
      }
      throw new Error("Fixture condition did not become true")
    }
    await Instance.provide({ directory: process.cwd(), fn: async () => {
      try { ${source} } finally { await Instance.dispose() }
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
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
    releases.splice(0).forEach((resolve) => resolve())
    server.stop(true)
  }
}

test("tools and catalog share startup discovery, including a valid empty catalog", async () => {
  for (const initial of ["initial", "empty"])
    await run(
      `
    for (let i = 0; i < 3; i++) {
      const [tools, entries] = await Promise.all([MCP.tools(), MCP.toolEntries()])
      assert.deepEqual(Object.keys(tools), ${JSON.stringify(initial === "empty" ? [] : ["fixture_record_initial"])})
      assert.deepEqual(entries, ${JSON.stringify(initial === "empty" ? [] : [{ toolKey: "fixture_record_initial", serverName: "fixture" }])})
      assert.equal((await MCP.status()).fixture.status, "connected")
    }
    assert.equal((await inspect()).lists["/mcp"], 1, "catalog reads must not rediscover tools")
  `,
      initial,
    )
}, 20000)

test("notifications serialize refreshes, expose new definitions and recover from discovery errors", async () => {
  await run(`
    assert.equal((await MCP.status()).fixture.status, "connected")
    await extras(true, 1)
    await control({ mode: "updated", count: 2 })
    await wait(async () => (await inspect()).lists["/mcp"] >= 2)
    assert.deepEqual(Object.keys(await MCP.tools()), ["fixture_record_updated"])
    await wait(async () => (await inspect()).lists["/mcp"] === 3)
    assert.deepEqual(await MCP.toolEntries(), [{ toolKey: "fixture_record_updated", serverName: "fixture" }])
    assert.equal((await inspect()).maxActive, 1, "refreshes must serialize")
    await control({ mode: "error" })
    await wait(async () => (await inspect()).lists["/mcp"] === 4)
    await assert.rejects(MCP.tools(), /MCP tool discovery failed for server "fixture"/)
    await assert.rejects(MCP.toolEntries(), /MCP tool discovery failed for server "fixture"/)
    assert.equal((await MCP.status()).fixture.status, "failed")
    await extras(false, 1)
    assert.match((await MCP.status()).fixture.error, /Reconnect the MCP server and retry/)
    assert.equal(Object.keys(await MCP.clients()).length, 1)
    assert.equal((await inspect()).lists["/mcp"], 4, "failed catalog reads must not silently retry")
    await control({ mode: "updated" })
    await wait(async () => (await inspect()).lists["/mcp"] === 5)
    assert.deepEqual(Object.keys(await MCP.tools()), ["fixture_record_updated"])
    assert.equal((await MCP.status()).fixture.status, "connected")
    await extras(true, 2)
    await control({ mode: "empty" })
    await wait(async () => (await inspect()).lists["/mcp"] === 6)
    assert.deepEqual(await MCP.tools(), {})
    assert.deepEqual(await MCP.toolEntries(), [])
    assert.equal((await MCP.status()).fixture.status, "connected")
    assert.equal((await inspect()).lists["/mcp"], 6)
  `)
}, 20000)

test("replacing or disconnecting a client isolates a late refresh and removes failed old connections", async () => {
  await run(`
    assert.equal((await MCP.status()).fixture.status, "connected")
    await control({ mode: "hold" })
    await wait(async () => (await inspect()).lists["/mcp"] === 2)
    const pending = MCP.tools().then(() => undefined, () => undefined)
    await MCP.add("fixture", { type: "remote", url: base + "/replacement", oauth: false, timeout: 1000 })
    await control({ release: true })
    await pending
    assert.deepEqual(Object.keys(await MCP.tools()), ["fixture_record_replacement"])
    assert.deepEqual(await MCP.toolEntries(), [{ toolKey: "fixture_record_replacement", serverName: "fixture" }])
    assert.equal((await MCP.status()).fixture.status, "connected")
    const tools = await MCP.tools()
    const called = await tools.fixture_record_replacement.execute({}, { toolCallId: "fixture", messages: [] })
    assert.equal(called.content[0].text, "/replacement", "tool bindings must use the replacement client")
    await wait(async () => (await inspect()).closed["/mcp"] === 1)
    await MCP.add("fixture", { type: "remote", url: base + "/failed", oauth: false, timeout: 1000 })
    assert.equal((await MCP.status()).fixture.status, "failed")
    assert.deepEqual(await MCP.tools(), {})
    assert.deepEqual(await MCP.toolEntries(), [])
    assert.equal(Object.keys(await MCP.clients()).length, 0)
    await wait(async () => (await inspect()).closed["/replacement"] === 1)
    await MCP.disconnect("fixture")
    assert.equal((await MCP.status()).fixture.status, "disabled")
    await MCP.add("dynamic", { type: "remote", url: base + "/replacement", oauth: false, timeout: 1000 })
    assert.deepEqual(Object.keys(await MCP.prompts()), ["dynamic:review"], "programmatic clients need not appear in config")
    assert.deepEqual(Object.keys(await MCP.resources()), ["dynamic:evidence"])
    await MCP.disconnect("dynamic")
  `)
}, 20000)

test("transport closure fails catalog reads and reconnect installs a fresh client", async () => {
  await run(`
    assert.deepEqual(Object.keys(await MCP.tools()), ["fixture_record_initial"])
    await extras(true, 1)
    const client = (await MCP.clients()).fixture
    await client.close()
    assert.equal((await MCP.status()).fixture.status, "failed")
    await extras(false, 1)
    assert.match((await MCP.status()).fixture.error, /Reconnect the MCP server and retry/)
    await assert.rejects(MCP.tools(), /MCP connection closed for server "fixture"/)
    await assert.rejects(MCP.toolEntries(), /MCP connection closed for server "fixture"/)
    await MCP.connect("fixture")
    assert.notEqual((await MCP.clients()).fixture, client)
    assert.equal((await MCP.status()).fixture.status, "connected")
    await extras(true, 2)
    assert.deepEqual(Object.keys(await MCP.tools()), ["fixture_record_initial"])
    assert.equal((await inspect()).lists["/mcp"], 2)
    await MCP.disconnect("fixture")
    assert.deepEqual(await MCP.tools(), {})
    assert.deepEqual(await MCP.toolEntries(), [])
    assert.equal(Object.keys(await MCP.clients()).length, 0)
  `)
}, 20000)
