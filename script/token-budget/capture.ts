import path from "node:path"
import fs from "node:fs/promises"
import { guard } from "./guard"
const out = process.env.TOKEN_BUDGET_OUTPUT
const work = process.env.TOKEN_BUDGET_WORKSPACE
const source = process.env.TOKEN_BUDGET_SOURCE
if (!out || !work || !source) throw new Error("Explicit output/workspace/source required")
const binpath = [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter)
const rg = Bun.which("rg", { PATH: binpath })
if (!rg) throw new Error("Real ripgrep prerequisite missing")
const requests: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions") throw new Error("Unexpected endpoint " + request.url)
    if (request.method !== "POST") throw new Error("Expected POST")
    requests.push(await request.text())
    const chunks = [
      {
        id: "eval",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "Fixture complete" } }],
      },
      { id: "eval", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]
    return new Response(
      chunks
        .map((chunk) => "data: " + JSON.stringify(chunk))
        .concat("data: [DONE]")
        .join("\n\n") + "\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
await fs.mkdir(out, { recursive: true })
await Bun.write(path.join(out, "guard.ts"), guard)
await Bun.write(path.join(out, "network.jsonl"), "")
const config = {
  enabled_providers: ["fixture"],
  provider: {
    fixture: {
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "fixture", baseURL: server.url.origin + "/v1" },
      models: { fixture: { name: "fixture", tool_call: true, limit: { context: 200000, output: 1000 } } },
    },
  },
  agent: { title: { disable: true } },
  permission: { "*": "allow" },
}
const command = [
  process.execPath,
  "run",
  "--no-install",
  "--no-env-file",
  "--preload",
  path.join(import.meta.dir, "clock.js"),
  "--preload",
  path.join(out, "guard.ts"),
  "--conditions=browser",
  source,
  "run",
  "--model",
  "fixture/fixture",
  "--agent",
  "build",
  "--format",
  "json",
  ...(process.env.TOKEN_BUDGET_ARM === "four" ? ["--tools", "read,bash,edit,write"] : []),
  "Say Fixture complete without tools.",
]
const env = {
  PATH: binpath,
  SHELL: "/bin/bash",
  TZ: "UTC",
  HOME: path.join(out, "home"),
  AICTRL_TEST_HOME: path.join(out, "home"),
  AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(out, "managed"),
  XDG_DATA_HOME: path.join(out, "data"),
  XDG_CONFIG_HOME: path.join(out, "config"),
  XDG_STATE_HOME: path.join(out, "state"),
  XDG_CACHE_HOME: path.join(out, "cache"),
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(out, "bun-cache"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  AICTRL_DISABLE_PROJECT_CONFIG: "true",
  AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
  AICTRL_DISABLE_AUTOCOMPACT: "true",
  AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS: "3000",
  AICTRL_CONFIG_CONTENT: JSON.stringify(config),
  SELECTOR_FIXTURE_ORIGIN: server.url.origin,
  SELECTOR_FIXTURE_GUARD_LOG: path.join(out, "network.jsonl"),
}
const child = Bun.spawn(command, { cwd: work, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
let deadline = false
const timer = setTimeout(() => {
  deadline = true
  child.kill("SIGKILL")
}, 15000)
try {
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  await Bun.write(path.join(out, "stdout.jsonl"), stdout)
  await Bun.write(path.join(out, "stderr.log"), stderr)
  for (const [index, body] of requests.entries()) await Bun.write(path.join(out, `request-${index}.json`), body)
  const network = (await Bun.file(path.join(out, "network.jsonl")).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const result = { exit, deadline, command, environment: env, rg, requests: requests.length, network }
  await Bun.write(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n")
  if (deadline || exit !== 0 || requests.length !== 1 || network.some((row) => !row.allowed))
    throw new Error(
      "Capture failed: " + JSON.stringify({ exit, deadline, requests: requests.length, network }) + stderr.slice(-2000),
    )
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  if (
    events
      .filter((event) => event.type === "text")
      .map((event) => event.part?.text)
      .join("") !== "Fixture complete"
  )
    throw new Error("Exact assistant response missing")
  if (
    events.filter((event) => event.type === "invocation_complete" && event.status === "completed").length !== 1 ||
    events.some((event) => event.type === "error" || event.type === "tool_use")
  )
    throw new Error("Unexpected invocation lifecycle")
} catch (error) {
  console.error(String(error))
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  child.kill("SIGKILL")
  server.stop(true)
}
