import { describe, expect, spyOn, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const guard = path.join(import.meta.dir, "fixture/stdin-guard.ts")
const entries = ["index", "headless"] as const
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function run(input: {
  entry: (typeof entries)[number]
  name: string
  args: string[]
  stdin: "closed" | "open" | "late"
  payload?: string
  files?: Record<string, string>
  rootArgs?: string[]
  deadlineMs?: number
}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-stdin-"))
  const evidence = process.env.STDIN_TEST_EVIDENCE
  const cleanup: (() => void | Promise<void>)[] = [
    async () => {
      if (!evidence) await fs.rm(directory, { recursive: true, force: true })
    },
  ]
  let failed = false
  try {
    for (const [name, text] of Object.entries(input.files ?? {})) await fs.writeFile(path.join(directory, name), text)
    const ledger = path.join(directory, "network.jsonl")
    await fs.writeFile(ledger, "")
    const requests: { method: string; path: string; body: Record<string, unknown> | undefined }[] = []
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const sessionID = "ses_stdin_fixture"
    let requestArrivals = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requestArrivals++
        const url = new URL(request.url)
        const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : undefined
        requests.push({ method: request.method, path: url.pathname, body })
        if (url.pathname === "/event")
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller
                controller.enqueue(new TextEncoder().encode(": ready\n\n"))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        if (url.pathname === "/session") return Response.json({ id: sessionID })
        if (url.pathname === `/session/${sessionID}/message` || url.pathname === `/session/${sessionID}/command`) {
          stream?.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })}\n\n`,
            ),
          )
          return Response.json({})
        }
        return Response.json({ unexpected: url.pathname }, { status: 500 })
      },
    })
    cleanup.push(() => server.stop(true))
    const env = {
      PATH: [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter),
      SHELL: "/bin/bash",
      TZ: "UTC",
      HOME: path.join(directory, "home"),
      AICTRL_TEST_HOME: path.join(directory, "home"),
      AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_STATE_HOME: path.join(directory, "state"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(directory, "bun-cache"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      AICTRL_DISABLE_PROJECT_CONFIG: "true",
      AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
      STDIN_FIXTURE_ORIGIN: server.url.origin,
      STDIN_FIXTURE_LEDGER: ledger,
    }
    const command = [
      "run",
      "--no-install",
      "--no-env-file",
      "--preload",
      guard,
      "--conditions=browser",
      path.resolve(import.meta.dir, `../../src/${input.entry}.ts`),
      ...(input.rootArgs ?? ["run", "--format", "json", "--attach", server.url.origin, ...input.args]),
    ]
    const child = spawn(process.execPath, command, {
      cwd: directory,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    cleanup.push(async () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return
        throw error
      }
      await delay(150)
      try {
        process.kill(-child.pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return
        throw error
      }
      throw new Error("Fixture process group remains after final cleanup")
    })
    let stdout = ""
    let stderr = ""
    let deadline = false
    let kill = false
    let signal: NodeJS.Signals | null = null
    const started = performance.now()
    const exists = () => {
      try {
        process.kill(-child.pid!, 0)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
        throw error
      }
    }
    const staged: ReturnType<typeof setTimeout>[] = []
    let firstBytesAt: number | undefined
    let eofAt: number | undefined
    let requestsBeforeEOF: number | undefined
    let stagedInput = false
    child.stdout.on("data", (data) => {
      stdout += data.toString()
      if (input.stdin === "late" && !stagedInput && stdout.includes('"type":"invocation_start"')) {
        stagedInput = true
        staged.push(
          setTimeout(() => {
            firstBytesAt = performance.now() - started
            child.stdin.write(input.payload ?? "")
            staged.push(
              setTimeout(() => {
                eofAt = performance.now() - started
                requestsBeforeEOF = requestArrivals
                child.stdin.end()
              }, 150),
            )
          }, 150),
        )
      }
    })
    child.stderr.on("data", (data) => {
      stderr += data.toString()
    })
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stderr += String(error)
    })
    if (input.payload && input.stdin !== "late") child.stdin.write(input.payload)
    if (input.stdin === "closed") child.stdin.end()
    const timer = setTimeout(() => {
      deadline = true
      if (exists()) process.kill(-child.pid!, "SIGTERM")
    }, input.deadlineMs ?? 3000)
    const escalation = setTimeout(
      () => {
        if (deadline && exists()) {
          kill = true
          process.kill(-child.pid!, "SIGKILL")
        }
      },
      (input.deadlineMs ?? 3000) + 200,
    )
    cleanup.push(() => {
      for (const stage of staged) clearTimeout(stage)
      clearTimeout(timer)
      clearTimeout(escalation)
      child.stdin.destroy()
    })
    let code: number | null = null
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (status, reason) => {
          signal = reason
          resolve(status)
        })
      })
    } catch (error) {
      failed = true
      throw error
    } finally {
      try {
        for (const timer of staged) clearTimeout(timer)
        clearTimeout(timer)
        clearTimeout(escalation)
        child.stdin.destroy()
        if (exists()) {
          process.kill(-child.pid!, "SIGTERM")
          await delay(150)
          if (exists()) {
            kill = true
            process.kill(-child.pid!, "SIGKILL")
          }
        }
      } catch (error) {
        console.error("Fixture child cleanup failed", { directory, error })
        if (!failed) throw error
      }
    }
    const groupGone = !exists()
    // Partial fetch/install observations only; coverage is documented in fixture/README.md.
    const network = (await fs.readFile(ledger, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const result = {
      ...input,
      directory,
      command,
      code,
      signal,
      deadline,
      kill,
      groupGone,
      milliseconds: performance.now() - started,
      firstBytesAt,
      eofAt,
      requestsBeforeEOF,
      requestArrivals,
      stdout,
      stderr,
      requests,
      network,
    }
    if (evidence) {
      await fs.mkdir(evidence, { recursive: true })
      await fs.writeFile(
        path.join(evidence, `${input.entry}-${input.name}.json`),
        JSON.stringify(result, null, 2) + "\n",
      )
    }
    if (deadline) throw new Error(`CLI deadline fired (never a successful rejection): ${JSON.stringify(result)}`)
    if (!groupGone) throw new Error("Stdin test child process group remains")
    if (network.some((row) => row.allowed === false))
      throw new Error("Stdin test attempted forbidden network: " + JSON.stringify(network))
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
      console.error("Fixture cleanup failed", { directory, errors })
      if (!failed) throw new AggregateError(errors, "Fixture cleanup failed")
    }
  }
}

test("stdin fixture setup failure removes its owned directory before listener creation", async () => {
  const primary = new Error("stdin fixture setup write failed")
  const listener = spyOn(Bun, "serve")
  let directory: string | undefined
  const write = spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
    directory = path.dirname(String(file))
    throw primary
  })
  try {
    await expect(run({ entry: "index", name: "setup-failure", args: ["inert"], stdin: "closed" })).rejects.toBe(primary)
    expect(listener).not.toHaveBeenCalled()
    expect(directory).toBeDefined()
    if (!process.env.STDIN_TEST_EVIDENCE) await expect(fs.stat(directory!)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    write.mockRestore()
    listener.mockRestore()
  }
})

function message(result: Awaited<ReturnType<typeof run>>) {
  const body = result.requests.find((request) => request.path.endsWith("/message"))?.body
  return (body?.parts as { type: string; text?: string }[])?.find((part) => part.type === "text")?.text
}
function title(result: Awaited<ReturnType<typeof run>>) {
  return result.requests.find((request) => request.path === "/session")?.body?.title
}

describe("explicit stdin contract (#210)", () => {
  for (const entry of entries) {
    test(`${entry}: no-message EOF payload reaches actual SDK loopback`, async () => {
      const result = await run({
        entry,
        name: "payload-control",
        args: [],
        stdin: "closed",
        payload: "fixture λ\nsecond line\n",
      })
      expect(result.code, result.stderr + result.stdout).toBe(0)
      expect(message(result)).toBe("\nfixture λ\nsecond line\n")
      expect(title(result)).toBe("fixture λ\nsecond line")
    }, 6000)
    test(`${entry}: explicit prompt completes with unused open stdin`, async () => {
      const result = await run({
        entry,
        name: "explicit-open",
        args: ["probe"],
        stdin: "open",
        payload: "must not append\n",
      })
      expect(result.code, result.stderr + result.stdout).toBe(0)
      expect(message(result)).toBe("probe")
      expect(title(result)).toBe("probe")
    }, 6000)
    test(`${entry}: post-separator marker disappears from SDK text and title`, async () => {
      const result = await run({
        entry,
        name: "post-separator-marker",
        args: ["summarize this", "--", "-"],
        stdin: "closed",
        payload: "context λ\n",
      })
      expect(result.code, result.stderr + result.stdout).toBe(0)
      if (!process.env.STDIN_TEST_EVIDENCE)
        await expect(fs.stat(result.directory)).rejects.toMatchObject({ code: "ENOENT" })
      // Structured operands preserve raw decoded prompt text; quotes are not added.
      expect(message(result)).toBe("summarize this\ncontext λ\n")
      expect(title(result)).toBe("summarize this")
    }, 6000)
  }
})

function failure(result: Awaited<ReturnType<typeof run>>, code: string) {
  expect(result.code, result.stderr + result.stdout).toBe(1)
  expect(result.requests).toHaveLength(0)
  const events = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  expect(events.map((event) => event.type)).toEqual(["invocation_start", "invocation_error", "invocation_complete"])
  expect(events[1]).toMatchObject({ phase: "validation", code, invocationID: events[0].invocationID })
  expect(events[2]).toMatchObject({ status: "error", invocationID: events[0].invocationID })
}

describe("stdin operands and option ownership", () => {
  for (const entry of entries) {
    test.each([
      ["bare-marker", ["-"], "\nlate λ\n", "late λ"],
      ["marker-among-words", ["review", "-", "this"], "review this\nlate λ\n", "review this"],
      ["repeated-markers", ["-", "review", "-", "-"], "review\nlate λ\n", "review"],
      ["post-markers", ["review", "--", "-", "-"], "review\nlate λ\n", "review"],
      ["no-operands-late", [], "\nlate λ\n", "late λ"],
    ] as const)(
      `${entry}: %s reads late bytes through EOF exactly once`,
      async (name, args, text, expectedTitle) => {
        const result = await run({ entry, name, args: [...args], stdin: "late", payload: "late λ\n" })
        expect(result.code, result.stderr + result.stdout).toBe(0)
        expect(result.firstBytesAt).toBeGreaterThan(100)
        expect(result.eofAt!).toBeGreaterThan(result.firstBytesAt!)
        expect(result.requestsBeforeEOF).toBe(0)
        expect(message(result)).toBe(text)
        expect(title(result)).toBe(expectedTitle)
        expect(result.requests.map((request) => `${request.method} ${request.path}`).sort()).toEqual(
          ["GET /event", "POST /session", "POST /session/ses_stdin_fixture/message"].sort(),
        )
      },
      6000,
    )

    test.each([
      ["empty-operand", [""], "INVOCATION_EMPTY_INPUT"],
      ["no-operands-empty-eof", [], "INVOCATION_EMPTY_INPUT"],
      ["marker-empty-eof", ["-"], "INVOCATION_EMPTY_INPUT"],
    ] as const)(
      `${entry}: %s keeps empty-input classification`,
      async (name, args, code) => {
        const result = await run({
          entry,
          name,
          args: [...args],
          stdin: args.length && !(args as readonly string[]).includes("-") ? "open" : "closed",
        })
        failure(result, code)
      },
      6000,
    )

    test.each([
      ["numeric", ["0007", "1e3"], "0007 1e3", "0007 1e3"],
      ["quoted-unicode", ['say "hello" λ', "next\nline"], 'say "hello" λ next\nline', 'say "hello" λ next\nline'],
      ["literal-embedded-dash", ["literal -"], "literal -", "literal -"],
      ["post-separator-word", ["--", "--literal"], "--literal", "--literal"],
      ["empty-explicit-title", ["--title", "", "two words"], "two words", "two words"],
      ["hyphen-title-value", ["--title", "-", "probe"], "probe", "-"],
      ["hyphen-variant-value", ["--variant", "-", "probe"], "probe", "probe"],
      ["options-after-operand", ["probe", "--title", "explicit"], "probe", "explicit"],
    ] as const)(
      `${entry}: %s does not select unused stdin`,
      async (name, args, text, expectedTitle) => {
        const result = await run({ entry, name, args: [...args], stdin: "open", payload: "ignored pipe bytes\n" })
        expect(result.code, result.stderr + result.stdout).toBe(0)
        expect(message(result)).toBe(text)
        expect(title(result)).toBe(expectedTitle)
      },
      6000,
    )

    test.each(["--model", "-m"])(
      `${entry}: %s owns a hyphen value without reading stdin`,
      async (flag) => {
        const result = await run({ entry, name: `model-ownership-${flag}`, args: [flag, "-", "probe"], stdin: "open" })
        expect(result.code).toBe(1)
        expect(result.stderr).toContain('Invalid model identifier "-"')
        expect(title(result)).toBe("probe")
        expect(result.requests.some((request) => request.path.endsWith("/message"))).toBe(false)
      },
      6000,
    )

    test.each(["omitted", "marker"])(
      `${entry}: selected %s whitespace EOF is empty input`,
      async (kind) => {
        const args = kind === "marker" ? ["-"] : []
        const result = await run({ entry, name: `whitespace-EOF-${kind}`, args, stdin: "late", payload: "  \n\t" })
        failure(result, "INVOCATION_EMPTY_INPUT")
        expect(result.requestsBeforeEOF).toBe(0)
      },
      6000,
    )

    test.each([
      [
        "command-with-marker",
        ["--command", "check", "review", "-", "this"],
        "late λ\n",
        "check",
        { argv: ["review", "this"], stdin: "late λ\n" },
        "/check review this",
      ],
      ["command-hyphen-value", ["--command", "-", "probe"], undefined, "-", { argv: ["probe"] }, "/- probe"],
      [
        "command-empty-stdin",
        ["--command", "check", "alpha", "-"],
        "",
        "check",
        { argv: ["alpha"], stdin: "" },
        "/check alpha",
      ],
      [
        "command-no-operands",
        ["--command", "check"],
        "late λ\n",
        "check",
        { argv: [], stdin: "late λ\n" },
        "/check late λ",
      ],
    ] as const)(
      `${entry}: %s preserves command ownership`,
      async (name, args, payload, command, argumentsText, expectedTitle) => {
        const result = await run({
          entry,
          name,
          args: [...args],
          stdin: payload !== undefined ? "late" : "open",
          payload,
        })
        expect(result.code, result.stderr + result.stdout).toBe(0)
        const body = result.requests.find((request) => request.path.endsWith("/command"))?.body
        expect(body?.command).toBe(command)
        // This fixture proves SDK wire shape only; the local-command suite proves handler assembly.
        expect(body?.arguments).toEqual(argumentsText)
        expect(title(result)).toBe(expectedTitle)
        if (payload !== undefined) expect(result.requestsBeforeEOF).toBe(0)
      },
      6000,
    )

    test.each([
      ["file-greedy", ["-f", "a.txt", "b.txt", "--", "probe"], ["a.txt", "b.txt"]],
      ["file-hyphen-equals", ["--file=-", "--", "probe"], ["-"]],
      ["file-repeat", ["--file", "a.txt", "--file", "b.txt", "--", "probe"], ["a.txt", "b.txt"]],
    ] as const)(
      `${entry}: %s retains file option values`,
      async (name, args, names) => {
        const result = await run({
          entry,
          name,
          args: [...args],
          stdin: "open",
          files: { "a.txt": "a", "b.txt": "b", "-": "hyphen" },
        })
        expect(result.code, result.stderr + result.stdout).toBe(0)
        const body = result.requests.find((request) => request.path.endsWith("/message"))?.body
        const files = (body?.parts as { type: string; filename?: string }[]).filter((part) => part.type === "file")
        expect(files.map((part) => part.filename)).toEqual([...names])
        expect(message(result)).toBe("probe")
      },
      6000,
    )

    test.each([
      ["missing-agent", ["--agent"]],
      ["missing-session", ["--session"]],
      ["missing-session-alias", ["-s"]],
      ["missing-attach", ["--attach"]],
      ["missing-dir", ["--dir"]],
      ["missing-format", ["--format"]],
      ["missing-output-result", ["--output-result"]],
      ["missing-file-alias", ["-f"]],
      ["missing-model", ["--model"]],
      ["missing-model-alias", ["-m"]],
      ["missing-title", ["--title"]],
      ["missing-command", ["--command"]],
      ["missing-file", ["--file"]],
      ["orphan-file-hyphen", ["--file", "-", "probe"]],
      ["orphan-file-alias", ["-f", "-", "probe"]],
      ["missing-skill", ["--skill"]],
      ["missing-schema", ["--output-schema"]],
      ["missing-retries", ["--output-schema-retries"]],
      ["missing-variant", ["--variant"]],
      ["unknown-flag", ["--bogus", "probe"]],
    ] as const)(
      `${entry}: %s rejects before reading open stdin`,
      async (name, args) => {
        const result = await run({ entry, name, args: [...args], stdin: "open" })
        expect(result.code).toBe(1)
        expect(result.requests).toHaveLength(0)
        expect(result.stdout).not.toContain('"type":"invocation_start"')
      },
      6000,
    )

    test(`${entry}: optional no-value port leaves standalone marker selected`, async () => {
      const result = await run({
        entry,
        name: "port-marker",
        args: ["--port", "-", "probe"],
        stdin: "late",
        payload: "late λ\n",
      })
      expect(result.code, result.stderr + result.stdout).toBe(0)
      expect(message(result)).toBe("probe\nlate λ\n")
      expect(result.requestsBeforeEOF).toBe(0)
    }, 6000)
    test(`${entry}: skill nargs does not consume its following prompt`, async () => {
      const result = await run({ entry, name: "skill-nargs", args: ["--skill", "alpha", "probe"], stdin: "open" })
      failure(result, "INVOCATION_INVALID_ARGUMENTS")
      expect(result.stderr).toContain("--skill is not supported with --attach")
    }, 6000)
    test(`${entry}: root unknown commands remain strict`, async () => {
      const result = await run({
        entry,
        name: "root-unknown",
        args: [],
        rootArgs: ["no-such-command-210"],
        stdin: "open",
      })
      expect(result.code).toBe(1)
      expect(result.requests).toHaveLength(0)
    }, 6000)
  }
})

// A killed subprocess must reject the helper, never satisfy an expected nonzero-result assertion.
test("stdin test deadline cannot pass as a rejected invocation", async () => {
  await expect(
    run({ entry: "index", name: "deadline-negative-control", args: ["-"], stdin: "open", deadlineMs: 600 }),
  ).rejects.toThrow("CLI deadline fired (never a successful rejection)")
}, 6000)
