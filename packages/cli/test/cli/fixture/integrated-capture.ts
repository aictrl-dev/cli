import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import { Database } from "bun:sqlite"
import path from "node:path"

const guard = path.join(import.meta.dir, "stdin-guard.ts")
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type Input = {
  name: string
  entry: "index" | "headless"
  operands: string[]
  stdin?: string
  open?: boolean
  tools?: string
  configSelection?: string[]
  extraArgs?: string[]
  attach?: boolean
  read?: boolean
  profile?: boolean
  globalInstructions?: boolean
  disableProject?: boolean
  denyRead?: boolean
  deadlineMs?: number
}
export async function capture(input: Input) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-command-arguments-"))
  const evidence = process.env.COMMAND_ARGUMENTS_EVIDENCE
  const cleanup: (() => void | Promise<void>)[] = [
    async () => {
      if (!evidence) await fs.rm(cwd, { recursive: true, force: true })
    },
  ]
  let failed = false
  try {
    const files: Record<string, string> = {
      "AGENTS.md": "ROOT_AUTO_MARKER",
      ".opencode/AGENTS.md": "OPENCODE_AUTO_MARKER",
      "nested/AGENTS.md": "NESTED_AUTO_MARKER",
      "nested/fixture.txt": "READ_FIXTURE_EXACT\n",
      "config/aictrl/AGENTS.md": "TRUSTED_GLOBAL_MARKER",
      "profile/AGENTS.md": "TRUSTED_PROFILE_MARKER",
      "explicit.txt": "EXPLICIT_CALLER_MARKER",
      "project-rule.txt": "PROJECT_RULE_MARKER",
    }
    if (input.profile === false) delete files["profile/AGENTS.md"]
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd,
      env: {
        PATH: [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter),
        HOME: path.join(cwd, "home"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    })
    if (initialized.status !== 0) throw new Error("Owned fixture git init failed: " + initialized.stderr.toString())
    if (input.globalInstructions === false) delete files["config/aictrl/AGENTS.md"]
    for (const [name, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(cwd, name)), { recursive: true })
      await fs.writeFile(path.join(cwd, name), text)
    }
    await fs.writeFile(path.join(cwd, "aictrl.json"), JSON.stringify({ instructions: ["project-rule.txt"] }))
    const http: { method: string; path: string; body: unknown }[] = []
    const requests: Record<string, unknown>[] = []
    let requestArrivals = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requestArrivals++
        const route = new URL(request.url).pathname
        const arrival: (typeof http)[number] = { method: request.method, path: route, body: undefined }
        http.push(arrival)
        const body = request.method === "POST" ? await request.json() : null
        arrival.body = body
        if (route !== "/v1/chat/completions") return Response.json({ unexpected: route }, { status: 500 })
        requests.push(body as Record<string, unknown>)
        const call = input.read && requests.length === 1

        const chunks = [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  ...(call
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: "read_integrated_1",
                            type: "function",
                            function: {
                              name: "read",
                              arguments: JSON.stringify({ filePath: path.join(cwd, "nested/fixture.txt") }),
                            },
                          },
                        ],
                      }
                    : { content: "INTEGRATED_DONE" }),
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]
        return new Response(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    cleanup.push(() => server.stop(true))
    const config = {
      enabled_providers: ["fixture"],
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "fixture", baseURL: server.url.origin + "/v1" },
          models: { fixture: { name: "fixture", tool_call: true, limit: { context: 100000, output: 1000 } } },
        },
      },
      agent: { title: { disable: true } },
      permission: { "*": "allow", ...(input.denyRead ? { read: "deny" } : {}) },
      instructions: [path.join(cwd, "explicit.txt")],
      plugin: [new URL("./integrated-observer-plugin.ts", import.meta.url).href],
      command: {
        argumentprobe: { template: "STATIC<!`/usr/bin/printf INTEGRATED_STATIC`> A<$1> B<$2> C<$3> RAW<$ARGUMENTS>" },
      },
      ...(input.configSelection !== undefined ? { tool_allowlist: input.configSelection } : {}),
    }
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
      AICTRL_CONFIG_CONTENT: JSON.stringify(config),
      AICTRL_DISABLE_PROJECT_CONFIG: String(input.disableProject !== false),
      ...(input.profile === false ? {} : { AICTRL_CONFIG_DIR: path.join(cwd, "profile") }),
      COMMAND_TEMPLATE_OBSERVATIONS: path.join(cwd, "observations.jsonl"),
    }
    const source = path.resolve(import.meta.dir, `../../../src/${input.entry}.ts`)
    const command = [
      "run",
      "--no-install",
      "--no-env-file",
      "--preload",
      guard,
      "--conditions=browser",
      source,
      "run",
      "--format",
      "json",
      "--model",
      "fixture/fixture",
      ...(input.attach ? ["--attach", server.url.origin] : []),
      ...(input.tools !== undefined ? ["--tools", input.tools] : []),
      ...(input.extraArgs ?? []),
      "--command",
      "argumentprobe",
      ...input.operands,
    ]
    const child = spawn(process.execPath, command, {
      cwd,
      env,
      detached: true,
      stdio: ["stdin" in input || input.open ? "pipe" : "ignore", "pipe", "pipe"],
    })
    cleanup.push(async () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return
        throw error
      }
      await pause(150)
      try {
        process.kill(-child.pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return
        throw error
      }
      throw new Error("Fixture process group remains after final cleanup")
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
    let beforeEOF: { http: unknown[]; dbExists: boolean; projectCacheExists: boolean; observations: string } | undefined
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
                requestsBeforeEOF = requestArrivals
                beforeEOF = {
                  http: http.map((arrival) => ({ ...arrival })),
                  dbExists: existsSync(path.join(cwd, "data/aictrl/aictrl.db")),
                  projectCacheExists: existsSync(path.join(cwd, ".git/aictrl")),
                  observations: readFileSync(path.join(cwd, "observations.jsonl"), "utf8"),
                }
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
    cleanup.push(() => {
      for (const stage of stages) clearTimeout(stage)
      clearTimeout(timer)
      clearTimeout(escalation)
      child.stdin?.destroy()
    })
    let code: number | null = null
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (value) => resolve(value))
      })
    } catch (error) {
      failed = true
      throw error
    } finally {
      try {
        for (const stage of stages) clearTimeout(stage)
        child.stdin?.destroy()
        clearTimeout(timer)
        clearTimeout(escalation)
        if (exists()) {
          process.kill(-child.pid!, "SIGTERM")
          await pause(150)
          if (exists()) process.kill(-child.pid!, "SIGKILL")
        }
      } catch (error) {
        console.error("Fixture child cleanup failed", { directory: cwd, error })
        if (!failed) throw error
      }
    }
    // Partial fetch/install observations only; coverage is documented in README.md.
    const network = (await fs.readFile(ledger, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((value) => JSON.parse(value))
    const events = stdout
      .split("\n")
      .filter((value) => value.startsWith("{"))
      .map((value) => JSON.parse(value))
    const dbPath = path.join(cwd, "data/aictrl/aictrl.db")
    let sessions: { id: string; title: string }[] = [],
      messages: { data: Record<string, unknown> }[] = []
    const dbExists = await fs.stat(dbPath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    if (dbExists) {
      const db = new Database(dbPath, { readonly: true })
      try {
        sessions = db.query("SELECT id,title FROM session").all() as typeof sessions
        messages = (db.query("SELECT data FROM message").all() as { data: string }[]).map((row) => ({
          data: JSON.parse(row.data),
        }))
      } finally {
        db.close()
      }
    }
    const result = {
      input,
      config,
      http,
      dbExists,
      sessions,
      messages,
      projectCacheExists: await fs.stat(path.join(cwd, ".git/aictrl")).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false
          throw error
        },
      ),
      firstBytesAt,
      eofAt,
      requestsBeforeEOF,
      requestArrivals,
      beforeEOF,
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
    if (evidence) {
      await fs.mkdir(evidence, { recursive: true })
      const prefix = input.entry
      await fs.writeFile(path.join(evidence, `${prefix}-${input.name}.json`), JSON.stringify(result, null, 2) + "\n")
    }
    if (deadline) throw new Error("Command argument fixture deadline fired: " + JSON.stringify(result))
    if (!result.groupGone) throw new Error("Command argument fixture process group remains")
    if (network.some((row) => row.allowed === false))
      throw new Error("Command argument fixture blocked external attempt")
    return result
  } catch (error) {
    failed = true
    throw error
  } finally {
    const errors: unknown[] = []
    for (const dispose of cleanup.reverse()) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) {
      console.error("Fixture cleanup failed", { directory: cwd, errors })
      if (!failed) throw new AggregateError(errors, "Fixture cleanup failed")
    }
  }
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
