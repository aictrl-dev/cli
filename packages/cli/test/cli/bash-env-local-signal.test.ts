import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

type Input = {
  entry: "index" | "headless"
  signal?: "SIGINT" | "SIGTERM"
  policy: "inherit" | "empty" | "selected"
  control?: boolean
}
async function state(pid: number) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8")
    const parts = raw.slice(raw.lastIndexOf(")") + 2).split(" ")
    return { pid, exists: true, state: parts[0], ppid: Number(parts[1]), pgid: Number(parts[2]) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { pid, exists: false }
    throw e
  }
}
async function run(input: Input) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-local-signal-"))
  const ledger = path.join(cwd, "effects.jsonl"),
    network = path.join(cwd, "network.jsonl"),
    ready = path.join(cwd, "grand.ready")
  await fs.writeFile(ledger, "")
  await fs.writeFile(network, "")
  const helper = path.join(cwd, "lifecycle.ts")
  const grand = `import fs from"node:fs";fs.writeFileSync(${JSON.stringify(ready)},"ready");setInterval(()=>{},1000)`
  await fs.writeFile(
    helper,
    `import fs from"node:fs";const record=v=>fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify(v)+"\\n");const child=Bun.spawn([${JSON.stringify(process.execPath)},"--no-env-file","-e",${JSON.stringify(grand)}],{env:{PATH:"/usr/bin:/bin",HOME:${JSON.stringify(path.join(cwd, "grand-home"))}},stdin:"ignore",stdout:"ignore",stderr:"ignore"});record({kind:"start",pid:process.pid,grandchild:child.pid});process.on("SIGTERM",async()=>{child.kill("SIGTERM");await child.exited;record({kind:"reaped"});process.exit(0)});while(!fs.existsSync(${JSON.stringify(ready)}))await Bun.sleep(5);record({kind:"ready",pid:process.pid,grandchild:child.pid,grandReady:true});console.log("OWNED_READY");setInterval(()=>{},1000)`,
  )
  const command = input.control
    ? "printf completed"
    : `exec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(helper)}`
  const requests: { auth: string | null; body: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions")
        return new Response("unexpected owned path", { status: 400 })
      requests.push({ auth: request.headers.get("authorization"), body: await request.json() })
      if (request.headers.get("authorization") !== "Bearer fake-local-model")
        return new Response("owned unauthorized", { status: 401 })
      const delta =
        requests.length === 1
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_owned",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command, description: "Owned local signal probe" }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "Done" }
      return new Response(
        [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]
          .map((x) => `data: ${JSON.stringify(x)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  await fs.writeFile(
    path.join(cwd, "aictrl.json"),
    JSON.stringify({
      enabled_providers: ["fixture"],
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "{env:AICTRL_LOCAL_SIGNAL_KEY}", baseURL: server.url.origin + "/v1" },
          models: { fixture: { name: "fixture", tool_call: true, limit: { context: 100000, output: 1000 } } },
        },
      },
      agent: { title: { disable: true } },
    }),
  )
  const env = {
    PATH: [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: path.join(cwd, "home"),
    AICTRL_TEST_HOME: path.join(cwd, "home"),
    AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(cwd, "managed"),
    XDG_DATA_HOME: path.join(cwd, "data"),
    XDG_CONFIG_HOME: path.join(cwd, "config"),
    XDG_CACHE_HOME: path.join(cwd, "cache"),
    XDG_STATE_HOME: path.join(cwd, "state"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(cwd, "bun-cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    SHELL: "/bin/bash",
    AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
    AICTRL_DISABLE_AUTOCOMPACT: "true",
    AICTRL_LOCAL_SIGNAL_KEY: "fake-local-model",
    GH_TOKEN: "fake-gh",
    BASH_ENV_NETWORK_LEDGER: network,
    BASH_ENV_PROVIDER_ORIGIN: server.url.origin,
    TZ: "UTC",
  }
  const args = [
    "run",
    "--no-install",
    "--no-env-file",
    "--preload",
    path.join(import.meta.dir, "fixture/bash-env-forwarding-guard.ts"),
    "--conditions=browser",
    path.resolve(import.meta.dir, `../../src/${input.entry}.ts`),
    "run",
    ...(input.policy === "inherit" ? [] : ["--bash-env-allowlist", input.policy === "empty" ? "[]" : '["PATH"]']),
    "--tools",
    "bash",
    "--format",
    "json",
    "--model",
    "fixture/fixture",
    "Run the owned Bash probe once, then finish.",
  ]
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "",
    stderr = "",
    deadline = false,
    sentAt: number | undefined,
    signalReceipt: unknown
  child.stdout!.on("data", (v) => (stdout += v))
  child.stderr!.on("data", (v) => (stderr += v))
  const effects = async () =>
    (await fs.readFile(ledger, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((v) => JSON.parse(v))
  const groupExists = () => {
    try {
      process.kill(-child.pid!, 0)
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return false
      throw e
    }
  }
  const poll = setInterval(async () => {
    const rows = await effects()
    if (!input.control && sentAt === undefined && rows.some((e) => e.kind === "ready" && e.grandReady)) {
      sentAt = Date.now()
      signalReceipt = { at: sentAt, pid: child.pid, signal: input.signal, readiness: rows }
      child.kill(input.signal!)
    }
  }, 10)
  const timer = setTimeout(() => {
    deadline = true
    if (groupExists()) process.kill(-child.pid!, "SIGTERM")
  }, 8500)
  const escalation = setTimeout(() => {
    if (groupExists()) process.kill(-child.pid!, "SIGKILL")
  }, 8800)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  }).finally(() => {
    clearInterval(poll)
    clearTimeout(timer)
    clearTimeout(escalation)
    server.stop(true)
  })
  const exitAt = Date.now(),
    rows = await effects(),
    begin = rows.find((e) => e.kind === "ready")
  const before = begin ? await Promise.all([state(begin.pid), state(begin.grandchild)]) : []
  const cleanupSignals: unknown[] = []
  if (begin && before[0].exists && before[0].state !== "Z") {
    try {
      process.kill(begin.pid, "SIGTERM")
      cleanupSignals.push({ pid: begin.pid, signal: "SIGTERM", at: Date.now() })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e
    }
    await Bun.sleep(250)
  }
  const after = begin ? await Promise.all([state(begin.pid), state(begin.grandchild)]) : []
  const logs: string[] = []
  for (const name of await fs.readdir(path.join(cwd, "data/aictrl/log")).catch(() => []))
    logs.push(await fs.readFile(path.join(cwd, "data/aictrl/log", name), "utf8"))
  const attempts = (await fs.readFile(network, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((v) => JSON.parse(v))
  const events = stdout
    .split("\n")
    .filter((v) => v.startsWith("{"))
    .map((v) => JSON.parse(v))
  const result = {
    input,
    launch: { executable: process.execPath, args, env, cwd },
    code,
    deadline,
    groupGone: !groupExists(),
    sentAt,
    exitAt,
    signalToExitMs: sentAt === undefined ? undefined : exitAt - sentAt,
    signalReceipt,
    stdout,
    stderr,
    logs,
    requests,
    attempts,
    effects: rows,
    beforeManualCleanup: before,
    cleanupSignals,
    afterManualCleanup: after,
    events,
  }
  if (process.env.BASH_ENV_SIGNAL_EVIDENCE) {
    await fs.mkdir(process.env.BASH_ENV_SIGNAL_EVIDENCE, { recursive: true })
    await fs.writeFile(
      path.join(
        process.env.BASH_ENV_SIGNAL_EVIDENCE,
        `${input.entry}-${input.signal ?? "completed"}-${input.policy}.json`,
      ),
      JSON.stringify(result, null, 2) + "\n",
    )
  }
  expect(deadline, JSON.stringify(result)).toBe(false)
  expect(result.groupGone).toBe(true)
  expect(attempts.some((e) => !e.allowed)).toBe(false)
  if (input.control) {
    expect(code, stderr + stdout).toBe(0)
    expect(requests).toHaveLength(2)
    expect(events.at(-1)?.type).toBe("invocation_complete")
    return
  }
  expect(signalReceipt, JSON.stringify(result)).toBeDefined()
  expect(code, stderr + stdout).toBe(input.signal === "SIGINT" ? 130 : 143)
  expect(result.signalToExitMs!, JSON.stringify(result)).toBeLessThan(3000)
  expect(
    rows.some((e) => e.kind === "reaped"),
    JSON.stringify(result),
  ).toBe(true)
  expect(
    before.every((e) => !e.exists),
    JSON.stringify(result),
  ).toBe(true)
  expect(cleanupSignals).toEqual([])
  expect(logs.join("\n")).not.toContain("session abort failed")
  const terminal = events.filter((e) => e.type === "session_complete" || e.type === "invocation_complete")
  expect(terminal.map((e) => e.type)).toEqual(["session_complete", "invocation_complete"])
  expect(events.at(-1)?.type).toBe("invocation_complete")
  expect(
    events
      .filter((e) => e.type === "session_error")
      .some((e) => e.reason === (input.signal === "SIGINT" ? "interrupted" : "terminated")),
  ).toBe(true)
}
for (const entry of ["index", "headless"] as const) {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    for (const policy of ["inherit", "empty", "selected"] as const)
      test(`${entry} ${signal} ${policy} local running Bash reaps before CLI completion`, async () =>
        run({ entry, signal, policy }))
  test(`${entry} completed local control`, async () => run({ entry, policy: "inherit", control: true }))
}
