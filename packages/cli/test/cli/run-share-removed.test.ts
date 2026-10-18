import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

type Fixture = { worktree: string; home: string; modelRequests: string[]; shareRequests: string[] }

/**
 * Serves a fixture Gemini model that answers "Done." and a stand-in share service that
 * records every request it receives. The worktree's `aictrl.json` points the model at
 * the fixture.
 */
async function fixture(body: (input: Fixture & { shareURL: string }) => Promise<void>) {
  await using worktree = await tmpdir({ git: true })
  await using home = await tmpdir()
  const modelRequests: string[] = []
  const shareRequests: string[] = []
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      modelRequests.push(await req.text())
      const chunk = {
        candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Done." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const share = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      shareRequests.push(`${req.method} ${new URL(req.url).pathname}`)
      return Response.json({ id: "share_fixture", url: "https://share.example.com/share_fixture", secret: "secret" })
    },
  })
  try {
    await Bun.write(
      path.join(worktree.path, "aictrl.json"),
      JSON.stringify({
        provider: {
          fixture: {
            npm: "@ai-sdk/google",
            options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${model.port}` },
            models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
          },
        },
        agent: { title: { disable: true } },
      }),
    )
    await body({
      worktree: worktree.path,
      home: home.path,
      modelRequests,
      shareRequests,
      shareURL: `http://127.0.0.1:${share.port}`,
    })
  } finally {
    model.stop(true)
    share.stop(true)
  }
}

/** Runs `aictrl run --format json --print-logs` with its own home and XDG dirs, so no outside config or data applies. */
async function run(input: Fixture, args: string[]) {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--conditions=browser",
      entry,
      "--print-logs",
      "run",
      "--format",
      "json",
      "--model",
      "fixture/gemini-fixture",
      ...args,
    ],
    {
      cwd: input.worktree,
      env: {
        ...process.env,
        HOME: input.home,
        XDG_CONFIG_HOME: path.join(input.home, ".config"),
        XDG_DATA_HOME: path.join(input.home, ".local/share"),
        XDG_CACHE_HOME: path.join(input.home, ".cache"),
        AICTRL_TEST_HOME: input.home,
        AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
        AICTRL_DISABLE_AUTOCOMPACT: "true",
      },
      stdin: "ignore",
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
    const events = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
    return { exit, stderr, output: stderr + stdout, events }
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
  }
}

/**
 * Adds the removed sharing keys to the worktree config, pointing the share service at the
 * fixture, so any share request the run still made would be recorded.
 */
async function addShareConfig(input: Fixture & { shareURL: string }) {
  const file = path.join(input.worktree, "aictrl.json")
  const config = await Bun.file(file).json()
  await Bun.write(file, JSON.stringify({ ...config, share: "auto", autoshare: true, enterprise: { url: input.shareURL } }))
}

function sessionStart(events: { type: string; sessionID?: string }[]) {
  return events.find((event) => event.type === "session_start")?.sessionID
}

/** Writes share metadata into a stored session the way versions before #189 left it. */
function addLegacyShareData(input: Fixture, sessionID: string) {
  const db = new Database(path.join(input.home, ".local/share", "aictrl", "aictrl.db"))
  try {
    db.run("UPDATE session SET share_url = ? WHERE id = ?", ["https://opncd.ai/share/legacy", sessionID])
    db.run(
      "INSERT INTO session_share (session_id, id, secret, url, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
      [sessionID, "legacy", "secret", "https://opncd.ai/share/legacy", Date.now(), Date.now()],
    )
  } finally {
    db.close()
  }
}

describe("session sharing removed (#189)", () => {
  test("`run --share` fails with an invocation error before any model request", async () => {
    await fixture(async (input) => {
      const result = await run(input, ["--share", "Say done."])

      expect(result.exit, result.output).not.toBe(0)
      expect(result.stderr).toContain("--share was removed: session sharing is no longer supported")
      const error = result.events.find((event) => event.type === "invocation_error")
      expect(error, result.output).toMatchObject({ code: "INVOCATION_INVALID_ARGUMENTS" })
      expect(result.events.filter((event) => event.type === "session_start")).toEqual([])
      expect(input.modelRequests).toEqual([])
    })
  }, 20000)

  test("`run --no-share` still runs, since it asks for what is now the only behaviour", async () => {
    await fixture(async (input) => {
      const result = await run(input, ["--no-share", "Say done."])

      expect(result.exit, result.output).toBe(0)
      expect(result.events.filter((event) => event.type === "session_complete"), result.output).toHaveLength(1)
      expect(input.shareRequests).toEqual([])
    })
  }, 20000)

  test("config `share`, `autoshare` and `enterprise` load as no-ops with one warning and send nothing", async () => {
    await fixture(async (input) => {
      await addShareConfig(input)
      const result = await run(input, ["Say done."])

      expect(result.exit, result.output).toBe(0)
      expect(result.events.filter((event) => event.type === "session_complete"), result.output).toHaveLength(1)
      expect(result.stderr.split("deprecated config is ignored, its subsystem was removed: share, autoshare, enterprise").length - 1, result.output).toBe(1)
      expect(input.modelRequests.length).toBeGreaterThan(0)
      expect(input.shareRequests).toEqual([])
    })
  }, 20000)

  test("a session with stored share metadata continues with --continue", async () => {
    await fixture(async (input) => {
      const first = await run(input, ["Say done."])
      expect(first.exit, first.output).toBe(0)
      const sessionID = sessionStart(first.events)!
      expect(sessionID).toBeString()
      addLegacyShareData(input, sessionID)
      await addShareConfig(input)

      const next = await run(input, ["--continue", "Say done again."])

      expect(next.exit, next.output).toBe(0)
      expect(sessionStart(next.events)).toBe(sessionID)
      expect(next.events.filter((event) => event.type === "session_complete"), next.output).toHaveLength(1)
      expect(input.shareRequests).toEqual([])
    })
  }, 30000)
})
