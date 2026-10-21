import { describe, expect, spyOn, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { CommandArguments, CommandInput } from "../../../sdk/src/v2/index"
import { capture as templateCapture } from "./fixture/command-template-capture"

const template = "FIRST<$1>\nSECOND<$2>\nREST<$3>"
const guard = path.join(import.meta.dir, "fixture/stdin-guard.ts")
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Input = (
  | { name: string; entry: "index" | "headless"; operands: string[]; stdin?: string }
  | { name: string; raw: string }
) & { template?: string; deadlineMs?: number }
async function capture(input: Input) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-command-arguments-"))
  const evidence = process.env.COMMAND_ARGUMENTS_EVIDENCE
  const cleanup: (() => void | Promise<void>)[] = [
    async () => {
      if (!evidence) await fs.rm(cwd, { recursive: true, force: true })
    },
  ]
  let failed = false
  try {
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
    cleanup.push(() => server.stop(true))
    await fs.writeFile(
      path.join(cwd, "aictrl.json"),
      JSON.stringify({
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
    await fs.writeFile(data, JSON.stringify("raw" in input ? { arguments: input.raw } : {}))
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
    }
    const source =
      "raw" in input
        ? path.join(import.meta.dir, "fixture/command-arguments-legacy.ts")
        : path.resolve(import.meta.dir, `../../src/${input.entry}.ts`)
    const command = [
      "run",
      "--no-install",
      "--no-env-file",
      "--preload",
      guard,
      "--conditions=browser",
      source,
      ...("raw" in input
        ? []
        : ["run", "--format", "json", "--model", "fixture/fixture", "--command", "argumentprobe", ...input.operands]),
    ]
    const child = spawn(process.execPath, command, {
      cwd,
      env,
      detached: true,
      stdio: ["stdin" in input ? "pipe" : "ignore", "pipe", "pipe"],
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
    // Partial fetch/install observations only; coverage is documented in fixture/README.md.
    const network = (await fs.readFile(ledger, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((value) => JSON.parse(value))
    const events = stdout
      .split("\n")
      .filter((value) => value.startsWith("{"))
      .map((value) => JSON.parse(value))
    const result = {
      input,
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
    }
    if (evidence) {
      await fs.mkdir(evidence, { recursive: true })
      const prefix = "entry" in input ? input.entry : "legacy"
      await fs.writeFile(path.join(evidence, `${prefix}-${input.name}.json`), JSON.stringify(result, null, 2) + "\n")
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
function userText(body: Record<string, unknown>) {
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

// These controls fail during real fixture-file setup, after the real listener starts.
for (const fixture of [
  { name: "arguments", invoke: () => capture({ entry: "index", name: "setup-failure", operands: ["inert"] }) },
  { name: "template", invoke: () => templateCapture({ name: "setup-failure", arguments: "inert" }) },
]) {
  for (const secondary of [undefined, new Error("listener cleanup failed after close")]) {
    test(`${fixture.name}: setup failure cleans owned resources${secondary ? " despite a cleanup error" : ""}`, async () => {
      const primary = new Error("fixture setup write failed")
      const listener = spyOn(Bun, "serve")
      const logging = secondary ? spyOn(console, "error").mockImplementation(() => {}) : undefined
      let directory: string | undefined
      let stop: { mockRestore: () => void; mock: { calls: unknown[][] } } | undefined
      const write = spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
        directory = path.dirname(String(file))
        const server = listener.mock.results[0]?.value as ReturnType<typeof Bun.serve> | undefined
        if (!server) throw new Error("Expected real fixture listener before setup write")
        const close = server.stop.bind(server)
        const dispose = spyOn(server, "stop")
        stop = dispose
        if (secondary)
          dispose.mockImplementation(async (active) => {
            await close(active)
            throw secondary
          })
        throw primary
      })
      try {
        await expect(fixture.invoke()).rejects.toBe(primary)
        expect(stop?.mock.calls).toEqual([[true]])
        expect(directory).toBeDefined()
        if (secondary)
          expect(logging).toHaveBeenCalledWith("Fixture cleanup failed", { directory, errors: [secondary] })
        if (!process.env.COMMAND_ARGUMENTS_EVIDENCE)
          await expect(fs.stat(directory!)).rejects.toMatchObject({ code: "ENOENT" })
      } finally {
        write.mockRestore()
        stop?.mockRestore()
        listener.mockRestore()
        logging?.mockRestore()
      }
    })
  }
}

test("template fixture removes its owned directory after reading final evidence", async () => {
  const result = await templateCapture({ name: "directory-cleanup", arguments: "alpha beta rest" })
  expect(userText(result.requests[0])).toBe("FIRST<alpha>\nSECOND<beta>\nREST<rest>")
  if (!process.env.COMMAND_ARGUMENTS_EVIDENCE)
    await expect(fs.stat(result.cwd)).rejects.toMatchObject({ code: "ENOENT" })
}, 15000)

test("successful capture rejects a listener cleanup failure and still removes its directory", async () => {
  const secondary = new Error("listener cleanup failed after successful capture")
  const listener = spyOn(Bun, "serve")
  const logging = spyOn(console, "error").mockImplementation(() => {})
  const writeFile = fs.writeFile
  let directory: string | undefined
  let restore: (() => void) | undefined
  const write = spyOn(fs, "writeFile").mockImplementationOnce(async (file, data, options) => {
    directory = path.dirname(String(file))
    const server = listener.mock.results[0]?.value as ReturnType<typeof Bun.serve> | undefined
    if (!server) throw new Error("Expected real fixture listener before setup write")
    const close = server.stop.bind(server)
    const stop = spyOn(server, "stop").mockImplementation(async (active) => {
      await close(active)
      throw secondary
    })
    restore = () => stop.mockRestore()
    return writeFile(file, data, options)
  })
  try {
    await expect(templateCapture({ name: "cleanup-failure", arguments: "alpha beta rest" })).rejects.toBeInstanceOf(
      AggregateError,
    )
    expect(logging).toHaveBeenCalledWith("Fixture cleanup failed", { directory, errors: [secondary] })
    expect(directory).toBeDefined()
    if (!process.env.COMMAND_ARGUMENTS_EVIDENCE)
      await expect(fs.stat(directory!)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    write.mockRestore()
    restore?.()
    listener.mockRestore()
    logging.mockRestore()
  }
}, 15000)

test("public SDK v2 command types match the canonical structured schema", async () => {
  const { SessionPrompt } = await import("../../src/session/prompt")
  const argumentsData: CommandArguments = { argv: ["alpha beta", ""], stdin: "late λ\n" }
  const input: CommandInput = { sessionID: "ses_fixture", command: "argumentprobe", arguments: argumentsData }
  expect(SessionPrompt.CommandInput.parse(input).arguments).toEqual(argumentsData)
})

// Literal expected templates are ground truth from original operand boundaries, not a copy of the decoder.
const cases = [
  { name: "plain-control", operands: ["alpha", "beta", "rest"], expected: "FIRST<alpha>\nSECOND<beta>\nREST<rest>" },
  {
    name: "space-control",
    operands: ["alpha beta", "tail", "rest"],
    expected: "FIRST<alpha beta>\nSECOND<tail>\nREST<rest>",
  },
  {
    name: "backslash-control",
    operands: ["alpha\\ beta", "tail", "rest"],
    expected: "FIRST<alpha\\ beta>\nSECOND<tail>\nREST<rest>",
  },
  {
    name: "trailing-backslash-control",
    operands: ["trail\\", "tail", "rest"],
    expected: "FIRST<trail\\>\nSECOND<tail>\nREST<rest>",
  },
  {
    name: "quoted-operand",
    operands: ['say "hi" now', "tail", "rest"],
    expected: 'FIRST<say "hi" now>\nSECOND<tail>\nREST<rest>',
  },
  {
    name: "backslash-and-quotes",
    operands: ['path\\ "label" end', "tail", "rest"],
    expected: 'FIRST<path\\ "label" end>\nSECOND<tail>\nREST<rest>',
  },
  {
    name: "tab-operand",
    operands: ["alpha\tbeta", "tail", "rest"],
    expected: "FIRST<alpha\tbeta>\nSECOND<tail>\nREST<rest>",
  },
  {
    name: "newline-operand",
    operands: ["alpha\nbeta", "tail", "rest"],
    expected: "FIRST<alpha\nbeta>\nSECOND<tail>\nREST<rest>",
  },
  { name: "empty-first-operand", operands: ["", "tail", "rest"], expected: "FIRST<>\nSECOND<tail>\nREST<rest>" },
  { name: "empty-second-operand", operands: ["alpha", "", "rest"], expected: "FIRST<alpha>\nSECOND<>\nREST<rest>" },
  {
    name: "literal-quotes",
    operands: ['"quoted"', "tail", "rest"],
    expected: 'FIRST<"quoted">\nSECOND<tail>\nREST<rest>',
  },
  {
    name: "apostrophe",
    operands: ["alpha'bet", "tail", "rest"],
    expected: "FIRST<alpha'bet>\nSECOND<tail>\nREST<rest>",
  },
  {
    name: "unicode-numeric-control",
    operands: ["naïve λ", "0007", "1e3"],
    expected: "FIRST<naïve λ>\nSECOND<0007>\nREST<1e3>",
  },
]

describe("actual local command argument grouping", () => {
  for (const entry of ["index", "headless"] as const) {
    for (const item of cases)
      test(`${entry}: ${item.name}`, async () => {
        const result = await capture({ entry, name: item.name, operands: item.operands })
        expect(userText(result.requests[0])).toBe(item.expected)
        if (!process.env.COMMAND_ARGUMENTS_EVIDENCE)
          await expect(fs.stat(result.cwd)).rejects.toMatchObject({ code: "ENOENT" })
        const emitted = result.events.find((event) => event.type === "user_message")
        expect(
          emitted?.parts
            .filter((part: { type: string }) => part.type === "text")
            .map((part: { text: string }) => part.text),
        ).toEqual([item.expected])
      }, 15000)
  }
  for (const item of [
    { name: "quoted-space", raw: '"alpha beta" tail rest', expected: "FIRST<alpha beta>\nSECOND<tail>\nREST<rest>" },
    {
      name: "literal-backslash",
      raw: '"C:\\temp\\path" tail rest',
      expected: "FIRST<C:\\temp\\path>\nSECOND<tail>\nREST<rest>",
    },
  ])
    test(`legacy raw handler: ${item.name}`, async () => {
      const result = await capture({ name: item.name, raw: item.raw })
      expect(userText(result.requests[0])).toBe(item.expected)
    }, 15000)
})

// Inserted operand text must stay literal: substitution visits the original template only.
describe("literal placeholder data", () => {
  for (const entry of ["index", "headless"] as const) {
    for (const item of [
      {
        name: "arguments-token",
        operands: ["$ARGUMENTS", "tail", "rest"],
        expected: "FIRST<$ARGUMENTS>\nSECOND<tail>\nREST<rest>",
      },
      {
        name: "numeric-and-replacement-tokens",
        operands: ["$1 $$ $&", "$2", "$3"],
        expected: "FIRST<$1 $$ $&>\nSECOND<$2>\nREST<$3>",
      },
    ])
      test(`${entry}: literal-${item.name}`, async () => {
        const result = await capture({ entry, name: "literal-" + item.name, operands: item.operands })
        expect(userText(result.requests[0])).toBe(item.expected)
        const emitted = result.events.find((event) => event.type === "user_message")
        expect(
          emitted?.parts
            .filter((part: { type: string }) => part.type === "text")
            .map((part: { text: string }) => part.text),
        ).toEqual([item.expected])
      }, 15000)
  }
  test("legacy handler: literal arguments-token", async () => {
    const result = await capture({ name: "literal-arguments-token", raw: '"$ARGUMENTS" tail rest' })
    expect(userText(result.requests[0])).toBe("FIRST<$ARGUMENTS>\nSECOND<tail>\nREST<rest>")
  }, 15000)
})

describe("structured raw projection and selected stdin", () => {
  for (const entry of ["index", "headless"] as const) {
    for (const item of [
      {
        name: "raw-arguments",
        operands: ['say "hi"', "", "tail\\path"],
        template: "RAW<$ARGUMENTS>",
        expected: 'RAW<say "hi"  tail\\path>',
      },
      {
        name: "fallback",
        operands: ['say "hi"', "tail\\path"],
        template: "HEADER",
        expected: 'HEADER\n\nsay "hi" tail\\path',
      },
      {
        name: "literal-raw-tokens",
        operands: ["$ARGUMENTS $1 $$ $&", "tail"],
        template: "RAW<$ARGUMENTS>",
        expected: "RAW<$ARGUMENTS $1 $$ $& tail>",
      },
      {
        name: "late-stdin-position",
        operands: ["alpha", "-", "beta"],
        stdin: "late λ\nline",
        template: "A<$1> B<$2> C<$3>",
        expected: "A<alpha> B<beta> C<late λ\nline>",
      },
      {
        name: "empty-selected-stdin",
        operands: ["alpha", "-", "beta"],
        stdin: "",
        template: "A<$1> B<$2> C<$3>",
        expected: "A<alpha> B<beta> C<>",
      },
      {
        name: "late-stdin-raw",
        operands: ["alpha", "-"],
        stdin: "late λ\nline",
        template: "RAW<$ARGUMENTS>",
        expected: "RAW<alpha\nlate λ\nline>",
      },
      {
        name: "no-operand-stdin",
        operands: [],
        stdin: "late λ\nline",
        template: "A<$1> B<$2>",
        expected: "A<late λ\nline> B<>",
      },
      {
        name: "repeated-markers",
        operands: ["-", "alpha", "-", "beta", "-"],
        stdin: "late λ",
        template: "A<$1> B<$2> C<$3>",
        expected: "A<alpha> B<beta> C<late λ>",
      },
    ])
      test(`${entry}: ${item.name}`, async () => {
        const result = await capture({ entry, ...item })
        expect(userText(result.requests[0])).toBe(item.expected)
        if ("stdin" in item) {
          expect(result.firstBytesAt).toBeGreaterThan(90)
          expect(result.eofAt!).toBeGreaterThan(result.firstBytesAt!)
          expect(result.requestsBeforeEOF).toBe(0)
        }
      }, 15000)
  }
  for (const item of [
    {
      name: "UNC",
      raw: '"\\\\server\\share" tail rest',
      expected: "FIRST<\\\\server\\share>\nSECOND<tail>\nREST<rest>",
    },
    { name: "adjacent-image", raw: "[Image 12]tail end", expected: "FIRST<[Image 12]>\nSECOND<tail>\nREST<end>" },
  ])
    test(`legacy exact ${item.name}`, async () => {
      const result = await capture(item)
      expect(userText(result.requests[0])).toBe(item.expected)
    }, 15000)
})

// Schema-only contract checks: this does not claim HTTP receiver validation.
test("canonical command schema rejects malformed structured data", async () => {
  const { SessionPrompt } = await import("../../src/session/prompt")
  for (const value of [null, [], 1, {}, { argv: "text" }, { argv: [1] }, { argv: [], stdin: 1 }]) {
    expect(SessionPrompt.CommandArguments.safeParse(value).success).toBe(false)
  }
  for (const value of ["legacy", { argv: [] }, { argv: ["", 'quote"', "\\path"], stdin: "" }]) {
    expect(SessionPrompt.CommandArguments.parse(value)).toEqual(value)
  }
})

test("command fixture deadline rejects before provider work", async () => {
  await expect(
    capture({ entry: "index", name: "forced-deadline", operands: ["inert"], deadlineMs: 1 }),
  ).rejects.toThrow("Command argument fixture deadline fired")
}, 15000)
