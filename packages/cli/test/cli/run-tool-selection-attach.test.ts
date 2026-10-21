import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { Database as SQLite } from "bun:sqlite"
import { existsSync } from "node:fs"

const root = path.resolve(import.meta.dir, "../../src")
type Input = {
  label: string
  args?: string[]
  mode?: "readonly" | "normal" | "deadline-hang"
  inline?: Record<string, unknown>
  remote?: Record<string, unknown>
  authKey?: string
  authValue?: string
  env?: Record<string, string>
  files?: Record<string, string | Record<string, unknown>>
  legacy?: boolean
  control?: boolean
  deadlineMs?: number
}
const guard = `import { appendFileSync } from "node:fs"
const fetch_ = globalThis.fetch
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const allowed = url.origin === process.env.SELECTOR_ATTACH_ORIGIN
  appendFileSync(process.env.SELECTOR_ATTACH_NETWORK, JSON.stringify({origin:url.origin,path:url.pathname,allowed}) + "\\n")
  if (!allowed) throw new Error("Nonlocal fixture fetch blocked: " + url.origin)
  return fetch_(input, init)
}, {preconnect: () => {throw new Error("No preconnect in fixture")}})
const spawn_ = Bun.spawn
Bun.spawn = function(...args) {
  const cmd = Array.isArray(args[0]) ? args[0] : args[0].cmd
  if (cmd?.includes("install")) {
    appendFileSync(process.env.SELECTOR_ATTACH_INSTALL, JSON.stringify(cmd) + "\\n")
    throw new Error("Fixture forbids dependency installation")
  }
  return spawn_.apply(Bun, args)
}
`
const program = `if (process.env.SELECTOR_ATTACH_MODE === "deadline-hang") await Bun.sleep(10000)
const root = process.env.SELECTOR_RUNTIME_ROOT
const [{Instance},{Config}] = await Promise.all([import(root + "/project/instance.ts"),import(root + "/config/config.ts")])
const before = {content:process.env.AICTRL_CONFIG_CONTENT,dir:process.env.AICTRL_CONFIG_DIR,disable:process.env.AICTRL_DISABLE_PROJECT_CONFIG,token:process.env.AICTRL_FIXTURE_TOKEN}
try {
  if (process.env.SELECTOR_ATTACH_CONTROL === "true") {
    const [{Database},{ControlAccountTable}]=await Promise.all([import(root+"/storage/db.ts"),import(root+"/control/control.sql.ts")])
    Database.use(db=>db.insert(ControlAccountTable).values({email:"fixture@example.invalid",url:process.env.SELECTOR_ATTACH_ORIGIN,access_token:"inert-old",refresh_token:"inert-refresh",token_expiry:1,active:true}).run())
  }
  const selection = process.env.SELECTOR_ATTACH_MODE === "normal" ? await Instance.provide({directory:process.cwd(),fn:async () => (await Config.get()).tool_allowlist}) : await Config.readToolSelection(process.cwd())
  const after = {content:process.env.AICTRL_CONFIG_CONTENT,dir:process.env.AICTRL_CONFIG_DIR,disable:process.env.AICTRL_DISABLE_PROJECT_CONFIG,token:process.env.AICTRL_FIXTURE_TOKEN}
  console.log(JSON.stringify({selection:selection ?? null,before,after}))
} catch (error) { console.error(String(error)); process.exitCode = 1 }
await Instance.disposeAll()
`

async function run(input: Input) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-selector-attach-"))
  const requests: { path: string; method: string; body: unknown }[] = []
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json().catch(() => null) : null
      requests.push({ path: url.pathname, method: request.method, body })
      if (url.pathname === "/.well-known/aictrl") return Response.json({ config: input.remote ?? {} })
      if (url.pathname === "/oauth/token")
        return Response.json({ access_token: "inert-new", refresh_token: "inert-refreshed", expires_in: 3600 })
      if (url.pathname === "/event")
        return new Response(
          new ReadableStream({
            start(controller) {
              stream = controller
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      if (url.pathname === "/session") return Response.json({ id: "ses_attachfixture" })
      if (url.pathname.endsWith("/message") || url.pathname.endsWith("/command")) {
        stream?.enqueue(
          new TextEncoder().encode(
            'data: {"type":"session.status","properties":{"sessionID":"ses_attachfixture","status":{"type":"idle"}}}\n\n',
          ),
        )
        return Response.json({})
      }
      return Response.json({ fixtureUnexpectedPath: url.pathname }, { status: 404 })
    },
  })
  const write = async (name: string, value: string | object) => {
    const destination = path.join(directory, name)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, typeof value === "string" ? value : JSON.stringify(value))
  }
  for (const [name, value] of Object.entries(input.files ?? {})) await write(name, value)
  if (input.authKey)
    await write("data/aictrl/auth.json", {
      [server.url.origin]: {
        type: "wellknown",
        key: input.authKey,
        token: (input.authValue ?? "fixture-token").replaceAll("$FIXTURE", directory),
      },
    })
  await write("guard.ts", guard)
  await write("record.ts", program)
  await write("network.jsonl", "")
  await write("installs.jsonl", "")
  await write("cache/aictrl/version", "21")
  await write("cache/aictrl/preserve-sentinel", "unchanged-cache")
  const before: Record<string, string> = {}
  for (const name of Object.keys(input.files ?? {})) before[name] = await Bun.file(path.join(directory, name)).text()
  const env = {
    PATH: [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter),
    SHELL: "/bin/bash",
    HOME: path.join(directory, "home"),
    AICTRL_TEST_HOME: path.join(directory, "home"),
    AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
    XDG_DATA_HOME: path.join(directory, "data"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_STATE_HOME: path.join(directory, "state"),
    XDG_CACHE_HOME: path.join(directory, "cache"),
    AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
    SELECTOR_ATTACH_ORIGIN: server.url.origin,
    SELECTOR_ATTACH_NETWORK: path.join(directory, "network.jsonl"),
    SELECTOR_ATTACH_INSTALL: path.join(directory, "installs.jsonl"),
    SELECTOR_RUNTIME_ROOT: root,
    SELECTOR_ATTACH_MODE: input.mode ?? "cli",
    SELECTOR_ATTACH_CONTROL: String(!!input.control),
    ...(input.inline ? { AICTRL_CONFIG_CONTENT: JSON.stringify(input.inline) } : {}),
    ...Object.fromEntries(
      Object.entries(input.env ?? {}).map(([key, value]) => [key, value.replaceAll("$FIXTURE", directory)]),
    ),
  }
  await fs.mkdir(env.HOME, { recursive: true })
  if (input.legacy) {
    const gitEnv = { PATH: env.PATH, HOME: env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
    for (const args of [
      ["init"],
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
    ]) {
      const git = Bun.spawnSync(["git", ...args], {
        cwd: directory,
        env: gitEnv,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(git.exitCode, git.stderr.toString()).toBe(0)
    }
    await write(
      "seed.ts",
      `const root=process.env.SELECTOR_RUNTIME_ROOT
const [{Database},{ProjectTable},{SessionTable}]=await Promise.all([import(root+"/storage/db.ts"),import(root+"/project/project.sql.ts"),import(root+"/session/session.sql.ts")])
Database.use(db=>db.insert(ProjectTable).values({id:"global",worktree:"/",sandboxes:[],time_created:100,time_updated:100}).run())
Database.use(db=>db.insert(SessionTable).values({id:"ses_legacyfixture",project_id:"global",slug:"legacy",directory:process.cwd(),title:"Keep legacy",version:"fixture",time_created:100,time_updated:100}).run())
Database.close()
`,
    )
    const seed = Bun.spawn(
      [
        process.execPath,
        "run",
        "--preload",
        path.join(directory, "guard.ts"),
        "--conditions=browser",
        path.join(directory, "seed.ts"),
      ],
      { cwd: directory, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const stderr = await new Response(seed.stderr).text()
    expect(await seed.exited, stderr).toBe(0)
  }
  const database = () => {
    const file = path.join(directory, "data/aictrl/aictrl.db")
    if (!existsSync(file)) return null
    const db = new SQLite(file, { readonly: true })
    try {
      return {
        projects: db.query("SELECT * FROM project ORDER BY id").all(),
        sessions: db.query("SELECT * FROM session ORDER BY id").all(),
      }
    } finally {
      db.close()
    }
  }
  const databaseBefore = database()
  const command = [
    process.execPath,
    "run",
    "--preload",
    path.join(directory, "guard.ts"),
    "--conditions=browser",
    ...(input.mode
      ? [path.join(directory, "record.ts")]
      : [
          path.join(root, "index.ts"),
          "run",
          "--attach",
          server.url.origin,
          ...(input.args ?? []),
          "Fixture attach prompt.",
        ]),
  ]
  const child = Bun.spawn(command, { cwd: directory, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const deadlineMs = input.deadlineMs ?? 10000
  let deadlineFired = false
  const timeout = setTimeout(() => {
    deadlineFired = true
    child.kill("SIGKILL")
  }, deadlineMs)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(timeout)
    const after: Record<string, string | null> = {}
    for (const name of Object.keys(before))
      after[name] = await Bun.file(path.join(directory, name))
        .text()
        .catch(() => null)
    const network = (await Bun.file(env.SELECTOR_ATTACH_NETWORK).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const installs = (await Bun.file(env.SELECTOR_ATTACH_INSTALL).text()).split("\n").filter(Boolean)
    const markers: Record<string, boolean> = {}
    for (const name of [
      "plugin-marker",
      ".aictrl/.gitignore",
      ".aictrl/node_modules",
      "config/aictrl/config.json",
      ".git/aictrl",
    ])
      markers[name] = existsSync(path.join(directory, name))
    const cache = await Bun.file(path.join(directory, "cache/aictrl/preserve-sentinel"))
      .text()
      .catch(() => null)
    const databaseAfter = database()
    const result = {
      deadlineFired,
      deadlineMs,
      input,
      exit,
      stdout,
      stderr,
      requests,
      network,
      installs,
      before,
      after,
      markers,
      cache,
      databaseBefore,
      databaseAfter,
    }
    if (process.env.SELECTOR_CAPTURE_DIR)
      await Bun.write(
        path.join(process.env.SELECTOR_CAPTURE_DIR, input.label + ".json"),
        JSON.stringify(result, null, 2),
      )
    if (deadlineFired)
      throw new Error(
        `${input.label}: child deadline exceeded after ${deadlineMs}ms; receiverRequests=${requests.length}; exit=${exit}; stdout=${stdout.slice(-2000)}; stderr=${stderr.slice(-2000)}`,
      )
    expect(network.filter((request) => !request.allowed)).toEqual([])
    expect(installs).toEqual([])
    return result
  } finally {
    clearTimeout(timeout)
    child.kill("SIGKILL")
    server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}
function selection(result: Awaited<ReturnType<typeof run>>) {
  expect(result.exit, result.stderr + result.stdout).toBe(0)
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!)
}

describe("read-only attach canonical config resolution (#246)", () => {
  for (const value of ["read", ""])
    test(`explicit CLI selector ${JSON.stringify(value)} rejects before configuration discovery`, async () => {
      const result = await run({
        label: value ? "attach-cli-read" : "attach-cli-empty",
        args: ["--tools", value],
        authKey: "AICTRL_FIXTURE_TOKEN",
        files: { "aictrl.json": "{invalid-json" },
      })
      expect(result.exit, result.stderr + result.stdout).not.toBe(0)
      expect(result.stderr + result.stdout).toContain("cannot verify server-side enforcement")
      expect(result.requests).toEqual([])
      expect(result.network).toEqual([])
      expect(result.databaseAfter).toBe(null)
    })
  for (const values of [["read"], []])
    test(`inline config selector ${JSON.stringify(values)} rejects before receiver work`, async () => {
      const result = await run({
        label: values.length ? "attach-config-read" : "attach-config-empty",
        inline: { tool_allowlist: values },
        args: ["--session", "ses_original", "--fork"],
      })
      expect(result.exit, result.stderr + result.stdout).not.toBe(0)
      expect(result.stderr + result.stdout).toContain("cannot verify server-side enforcement")
      expect(result.requests).toEqual([])
      expect(result.databaseAfter).toBe(null)
    })
  test("valid omitted selector preserves receiver payload and never initializes local plugin or dependencies", async () => {
    const result = await run({
      label: "attach-omitted-local-effects",
      inline: { plugin: ["./marker.ts"] },
      files: {
        "marker.ts":
          'import {writeFileSync} from "node:fs"; writeFileSync("plugin-marker","loaded"); export default async()=>{writeFileSync("plugin-marker","initialized");return {}}',
        ".aictrl/package.json": { dependencies: { "@aictrl/plugin": "fixture-never-install" } },
        ".aictrl/command/broken.md": "---\nthis: [not valid yaml\n---\n",
        "aictrl.json": { instructions: [] },
      },
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests.map((request) => [request.method, request.path])).toEqual([
      ["POST", "/session"],
      ["GET", "/event"],
      ["POST", "/session/ses_attachfixture/message"],
    ])
    expect(result.requests[0].body).toEqual({ title: "Fixture attach prompt." })
    expect(result.requests[2].body).toEqual({ parts: [{ type: "text", text: "Fixture attach prompt." }] })
    expect(result.markers["plugin-marker"]).toBe(false)
    expect(result.markers[".aictrl/.gitignore"]).toBe(false)
    expect(result.markers[".aictrl/node_modules"]).toBe(false)
    expect(result.after).toEqual(result.before)
    expect(result.databaseAfter).toBe(null)
  })
  test("invalid local config fails strictly without receiver calls", async () => {
    const result = await run({
      label: "attach-invalid-config",
      files: { "aictrl.json": { unknown_fixture_key: true } },
    })
    expect(result.exit, result.stderr + result.stdout).not.toBe(0)
    expect(result.requests).toEqual([])
    expect(result.after).toEqual(result.before)
    expect(result.databaseAfter).toBe(null)
  })
  const sources: (Input & { expected: string[] })[] = [
    { label: "global", files: { "config/aictrl/aictrl.json": { tool_allowlist: ["global"] } }, expected: ["global"] },
    {
      label: "custom-path",
      files: {
        "config/aictrl/aictrl.json": { tool_allowlist: ["global"] },
        "custom.json": { tool_allowlist: ["custom"] },
      },
      env: { AICTRL_CONFIG: "$FIXTURE/custom.json" },
      expected: ["custom"],
    },
    {
      label: "project",
      files: { "custom.json": { tool_allowlist: ["custom"] }, "aictrl.json": { tool_allowlist: ["project"] } },
      env: { AICTRL_CONFIG: "$FIXTURE/custom.json" },
      expected: ["project"],
    },
    {
      label: "dot-project",
      files: {
        "aictrl.json": { tool_allowlist: ["project"] },
        ".aictrl/aictrl.json": { tool_allowlist: ["dot-project"] },
      },
      expected: ["dot-project"],
    },
    {
      label: "config-dir",
      files: {
        ".aictrl/aictrl.json": { tool_allowlist: ["dot-project"] },
        "extra/aictrl.json": { tool_allowlist: ["config-dir"] },
      },
      env: { AICTRL_CONFIG_DIR: "$FIXTURE/extra" },
      expected: ["config-dir"],
    },
    {
      label: "inline",
      files: { "aictrl.json": { tool_allowlist: ["project"] } },
      inline: { tool_allowlist: ["inline"] },
      expected: ["inline"],
    },
    {
      label: "managed-empty",
      files: { "managed/aictrl.json": { tool_allowlist: [] } },
      inline: { tool_allowlist: ["inline"] },
      expected: [],
    },
    {
      label: "project-disabled",
      files: {
        "aictrl.json": { tool_allowlist: ["project"] },
        ".aictrl/aictrl.json": { tool_allowlist: ["dot-project"] },
        "config/aictrl/aictrl.json": { tool_allowlist: ["global"] },
      },
      env: { AICTRL_DISABLE_PROJECT_CONFIG: "true" },
      expected: ["global"],
    },
  ]
  for (const item of sources)
    test(`canonical source precedence: ${item.label} and unchanged config bytes`, async () => {
      const result = await run({ ...item, label: "precedence-" + item.label, mode: "readonly" })
      const data = selection(result)
      expect(data.selection).toEqual(item.expected)
      expect(data.after).toEqual(data.before)
      expect(result.after).toEqual(result.before)
      expect(result.databaseAfter).toBe(null)
    })
  test("legacy TOML is read without migration rewrite or unlink", async () => {
    const result = await run({
      label: "readonly-toml",
      mode: "readonly",
      files: { "config/aictrl/config": "tool_allowlist = []\n" },
    })
    expect(selection(result).selection).toEqual([])
    expect(result.after).toEqual(result.before)
    expect(result.markers["config/aictrl/config.json"]).toBe(false)
  })
  test("well-known substitution uses local overlay without changing process environment", async () => {
    const result = await run({
      label: "overlay-substitution",
      mode: "readonly",
      authKey: "AICTRL_FIXTURE_TOKEN",
      authValue: "read",
      remote: { tool_allowlist: ["{env:AICTRL_FIXTURE_TOKEN}"] },
    })
    const data = selection(result)
    expect(data.selection).toEqual(["read"])
    expect(data.after).toEqual(data.before)
    expect(result.requests.map((request) => request.path)).toEqual(["/.well-known/aictrl"])
  })
  for (const mode of ["normal", "readonly"] as const)
    test(`dynamic well-known configuration directory: ${mode}`, async () => {
      const result = await run({
        label: "overlay-dir-" + mode,
        mode,
        authKey: "AICTRL_CONFIG_DIR",
        authValue: "$FIXTURE/extra",
        files: { "extra/aictrl.json": { tool_allowlist: [] } },
      })
      const data = selection(result)
      expect(data.selection).toEqual([])
      if (mode === "readonly") expect(data.after).toEqual(data.before)
    })
  for (const mode of ["normal", "readonly"] as const)
    test(`dynamic well-known project disable: ${mode}`, async () => {
      const result = await run({
        label: "overlay-disable-" + mode,
        mode,
        authKey: "AICTRL_DISABLE_PROJECT_CONFIG",
        authValue: "true",
        files: { "aictrl.json": { tool_allowlist: [] } },
      })
      const data = selection(result)
      expect(data.selection).toBe(null)
      if (mode === "readonly") expect(data.after).toEqual(data.before)
    })
  for (const mode of ["normal", "readonly"] as const)
    test(`expired inert Control credentials refresh only during ordinary setup: ${mode}`, async () => {
      const result = await run({ label: "control-refresh-" + mode, mode, control: true })
      expect(selection(result).selection).toBe(null)
      expect(result.requests.map((request) => request.path)).toEqual(mode === "normal" ? ["/oauth/token"] : [])
    })
  test("config selector rejection leaves local projects legacy sessions and git cache untouched", async () => {
    const result = await run({ label: "readonly-local-state", inline: { tool_allowlist: [] }, legacy: true })
    expect(result.exit, result.stderr + result.stdout).not.toBe(0)
    expect(result.requests).toEqual([])
    expect(result.databaseAfter).toEqual(result.databaseBefore)
    expect(result.markers[".git/aictrl"]).toBe(false)
    expect(result.cache).toBe("unchanged-cache")
  })
  test("normal canonical resolution applies well-known inline environment override", async () => {
    const result = await run({
      label: "overlay-inline-normal",
      mode: "normal",
      authKey: "AICTRL_CONFIG_CONTENT",
      authValue: '{"tool_allowlist":[]}',
    })
    expect(selection(result).selection).toEqual([])
  })
  test("read-only resolution applies well-known inline override without changing process environment", async () => {
    const result = await run({
      label: "overlay-inline-readonly",
      mode: "readonly",
      authKey: "AICTRL_CONFIG_CONTENT",
      authValue: '{"tool_allowlist":[]}',
    })
    const data = selection(result)
    expect(data.selection).toEqual([])
    expect(data.after).toEqual(data.before)
  })
  test("config-derived well-known inline empty selection rejects attach before receiver", async () => {
    const result = await run({
      label: "overlay-inline-attach",
      authKey: "AICTRL_CONFIG_CONTENT",
      authValue: '{"tool_allowlist":[]}',
    })
    expect(result.exit, result.stderr + result.stdout).not.toBe(0)
    expect(result.requests.map((request) => request.path)).toEqual(["/.well-known/aictrl"])
  })
})

test("forced attach fixture deadline cannot pass as an expected negative exit", async () => {
  await expect(run({ label: "forced-attach-deadline", mode: "deadline-hang", deadlineMs: 20 })).rejects.toThrow(
    /child deadline exceeded after 20ms; receiverRequests=0/,
  )
}, 20000)
