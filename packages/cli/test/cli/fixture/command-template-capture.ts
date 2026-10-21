import { expect } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const template = "FIRST<$1>\nSECOND<$2>\nREST<$3>"
const guard = path.join(import.meta.dir, "stdin-guard.ts")
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type Input = (
  | { name: string; entry: "index" | "headless"; operands: string[]; stdin?: string }
  | { name: string; arguments: string | { argv: string[]; stdin?: string } }
) & { template?: string; deadlineMs?: number; ownedRedirect?: boolean }
export async function capture(input: Input) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-command-arguments-"))
  const ownedFile = input.ownedRedirect ? path.join(cwd, "target; /usr/bin/printf INERT_REDIRECT") : undefined
  if (ownedFile) await fs.mkdir(path.dirname(ownedFile), { recursive: true })
  const requests: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") throw new Error("Unexpected provider path")
      requests.push((await request.json()) as Record<string, unknown>)
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
      return new Response(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  await fs.writeFile(
    path.join(cwd, "aictrl.json"),
    JSON.stringify({
      plugin: [new URL("./command-template-plugin.ts", import.meta.url).href],
      enabled_providers: ["fixture"],
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "fixture", baseURL: server.url.origin + "/v1" },
          models: { fixture: { name: "fixture", tool_call: true, limit: { context: 100000, output: 1000 } } },
        },
      },
      agent: { title: { disable: true } },
      command: { argumentprobe: { template: input.template ?? template } },
    }),
  )
  const data = path.join(cwd, "arguments.json")
  await fs.writeFile(data, JSON.stringify("arguments" in input ? { arguments: input.arguments } : {}))
  await fs.writeFile(path.join(cwd, "observations.jsonl"), "")
  const ledger = path.join(cwd, "network.jsonl")
  await fs.writeFile(ledger, "")
  const env = {
    PATH: [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter),
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
    TZ: "UTC",
    AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
    AICTRL_DISABLE_AUTOCOMPACT: "true",
    STDIN_FIXTURE_ORIGIN: server.url.origin,
    STDIN_FIXTURE_LEDGER: ledger,
    COMMAND_ARGUMENTS_DATA: data,
    COMMAND_TEMPLATE_OBSERVATIONS: path.join(cwd, "observations.jsonl"),
  }
  const source =
    "arguments" in input
      ? path.join(import.meta.dir, "command-template-handler.ts")
      : path.resolve(import.meta.dir, `../../../src/${input.entry}.ts`)
  const command = [
    "run",
    "--no-install",
    "--no-env-file",
    "--preload",
    guard,
    "--conditions=browser",
    source,
    ...("arguments" in input
      ? []
      : [
          "run",
          "--format",
          "json",
          "--model",
          "fixture/fixture",
          "--command",
          "argumentprobe",
          ...input.operands.map((value) => (ownedFile && value === "OWNED_REDIRECT_TARGET" ? ownedFile : value)),
        ]),
  ]
  const child = spawn(process.execPath, command, {
    cwd,
    env,
    detached: true,
    stdio: ["stdin" in input ? "pipe" : "ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = "",
    deadline = false
  const exists = () => {
    try {
      process.kill(-child.pid!, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw error
    }
  }
  let staged = false
  let firstBytesAt: number | undefined
  let eofAt: number | undefined
  let requestsBeforeEOF: number | undefined
  const started = performance.now()
  const stages: ReturnType<typeof setTimeout>[] = []
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") stderr += String(error)
  })
  child.stdout!.on("data", (value) => {
    stdout += value.toString()
    if ("stdin" in input && !staged && stdout.includes('"type":"invocation_start"')) {
      staged = true
      stages.push(
        setTimeout(() => {
          firstBytesAt = performance.now() - started
          child.stdin!.write(input.stdin ?? "")
          stages.push(
            setTimeout(() => {
              eofAt = performance.now() - started
              requestsBeforeEOF = requests.length
              child.stdin!.end()
            }, 100),
          )
        }, 100),
      )
    }
  })
  child.stderr!.on("data", (value) => {
    stderr += value.toString()
  })
  const timer = setTimeout(() => {
    deadline = true
    if (exists()) process.kill(-child.pid!, "SIGTERM")
  }, input.deadlineMs ?? 12000)
  const escalation = setTimeout(
    () => {
      if (deadline && exists()) process.kill(-child.pid!, "SIGKILL")
    },
    (input.deadlineMs ?? 12000) + 200,
  )
  let code: number | null = null
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (value) => resolve(value))
    })
  } finally {
    for (const stage of stages) clearTimeout(stage)
    child.stdin?.destroy()
    clearTimeout(timer)
    clearTimeout(escalation)
    if (exists()) {
      process.kill(-child.pid!, "SIGTERM")
      await pause(150)
      if (exists()) process.kill(-child.pid!, "SIGKILL")
    }
    server.stop(true)
  }
  const network = (await fs.readFile(ledger, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((value) => JSON.parse(value))
  const events = stdout
    .split("\n")
    .filter((value) => value.startsWith("{"))
    .map((value) => JSON.parse(value))
  let redirected: { path: string; text?: string; removed: boolean } | undefined
  if (ownedFile) {
    const text = await fs.readFile(ownedFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (text !== undefined) await fs.unlink(ownedFile)
    const removed = await fs.stat(ownedFile).then(
      () => false,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return true
        throw error
      },
    )
    redirected = { path: ownedFile, text, removed }
  }
  const result = {
    input,
    redirected,
    template: input.template ?? template,
    firstBytesAt,
    eofAt,
    requestsBeforeEOF,
    command,
    cwd,
    code,
    deadline,
    groupGone: !exists(),
    stdout,
    stderr,
    requests,
    events,
    network,
    observations: (await fs.readFile(path.join(cwd, "observations.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row)),
  }
  if (process.env.COMMAND_ARGUMENTS_EVIDENCE) {
    await fs.mkdir(process.env.COMMAND_ARGUMENTS_EVIDENCE, { recursive: true })
    const prefix = "entry" in input ? input.entry : "legacy"
    await fs.writeFile(
      path.join(process.env.COMMAND_ARGUMENTS_EVIDENCE, `${prefix}-${input.name}.json`),
      JSON.stringify(result, null, 2) + "\n",
    )
  }
  if (deadline) throw new Error("Command argument fixture deadline fired: " + JSON.stringify(result))
  if (!result.groupGone) throw new Error("Command argument fixture process group remains")
  const denied = network
    .filter((row: { allowed?: boolean }) => row.allowed === false)
    .map((row: { kind: string; origin?: string; path?: string }) => ({
      kind: row.kind,
      origin: row.origin,
      path: row.path,
    }))
  if (denied.length)
    throw new Error(
      "Command argument fixture blocked external attempt: " +
        JSON.stringify({ code, requestCount: requests.length, denied }),
    )
  expect(code, stderr + stdout).toBe(0)
  expect(requests).toHaveLength(1)
  return result
}
export function userText(body: Record<string, unknown>) {
  const messages = body.messages as { role: string; content: string | { type: string; text?: string }[] }[]
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join(""),
    )
    .join("\n")
}
