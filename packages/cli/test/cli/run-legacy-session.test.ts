import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

type Fixture = { worktree: string; home: string; requests: string[] }

/**
 * Serves a fixture Gemini model whose first turn writes `out.txt` and whose later turns
 * answer "Done.". The worktree is a git repo with an `aictrl.json` that sets `extra`.
 */
async function fixture(extra: Record<string, unknown>, body: (input: Fixture & { port: number }) => Promise<void>) {
  await using worktree = await tmpdir({ git: true })
  // Outside the worktree, so the data dir is never part of it.
  await using home = await tmpdir()
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      requests.push(await req.text())
      const parts =
        requests.length === 1
          ? [
              {
                functionCall: {
                  name: "write",
                  args: { filePath: path.join(worktree.path, "out.txt"), content: "out\n" },
                },
              },
            ]
          : [{ text: "Done." }]
      const chunk = {
        candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    await Bun.write(
      path.join(worktree.path, "aictrl.json"),
      JSON.stringify({
        provider: {
          fixture: {
            npm: "@ai-sdk/google",
            options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}` },
            models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
          },
        },
        agent: { title: { disable: true } },
        ...extra,
      }),
    )
    await body({ worktree: worktree.path, home: home.path, requests, port: server.port! })
  } finally {
    server.stop(true)
  }
}

/** Runs `aictrl run --format json` with its own home and XDG dirs, so no outside config or data applies. */
async function run(input: Fixture, args: string[]) {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--conditions=browser",
      entry,
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
        AICTRL_DISABLE_MODELS_FETCH: "true",
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
    return { exit, output: stderr + stdout, events }
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
  }
}

const dataDir = (input: Fixture) => path.join(input.home, ".local/share", "aictrl")

/** Whether the removed subsystem's shadow repo dir exists; any error other than ENOENT fails the test. */
async function shadowRepoExists(input: Fixture) {
  return fs.stat(path.join(dataDir(input), "snapshot")).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
}

const legacyDiff = { file: "out.txt", before: "", after: "out\n", additions: 1, deletions: 0, status: "added" }

/**
 * Rewrites a stored session the way versions before #181 left it: a diff summary and
 * revert state on the session, diffs on the user message, snapshot hashes on step parts,
 * and `patch` / `snapshot` parts.
 */
function addLegacySnapshotData(input: Fixture, sessionID: string) {
  const db = new Database(path.join(dataDir(input), "aictrl.db"))
  try {
    const messages = db
      .query<{ id: string; data: string }, [string]>("SELECT id, data FROM message WHERE session_id = ? ORDER BY id")
      .all(sessionID)
    const user = messages.find((row) => JSON.parse(row.data).role === "user")!
    const assistant = messages.find((row) => JSON.parse(row.data).role === "assistant")!
    db.run(
      "UPDATE session SET summary_additions = 1, summary_deletions = 0, summary_files = 1, summary_diffs = ?, revert = ? WHERE id = ?",
      [JSON.stringify([legacyDiff]), JSON.stringify({ messageID: assistant.id, snapshot: "0".repeat(40) }), sessionID],
    )
    db.run("UPDATE message SET data = ? WHERE id = ?", [
      JSON.stringify({ ...JSON.parse(user.data), summary: { diffs: [legacyDiff] } }),
      user.id,
    ])
    const steps = db
      .query<
        { id: string; data: string },
        [string]
      >("SELECT id, data FROM part WHERE session_id = ? AND json_extract(data, '$.type') IN ('step-start', 'step-finish')")
      .all(sessionID)
    for (const step of steps) {
      db.run("UPDATE part SET data = ? WHERE id = ?", [
        JSON.stringify({ ...JSON.parse(step.data), snapshot: "1".repeat(40) }),
        step.id,
      ])
    }
    const insert = db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    )
    const now = Date.now()
    insert.run(
      "prt_legacypatch",
      assistant.id,
      sessionID,
      now,
      now,
      JSON.stringify({ type: "patch", hash: "1".repeat(40), files: [path.join(input.worktree, "out.txt")] }),
    )
    insert.run(
      "prt_legacysnapshot",
      assistant.id,
      sessionID,
      now,
      now,
      JSON.stringify({ type: "snapshot", snapshot: "1".repeat(40) }),
    )
    return steps.length
  } finally {
    db.close()
  }
}

describe("snapshot removal (#181)", () => {
  test("a headless run in a git repo creates no shadow repo, even with the deprecated `snapshot: true`", async () => {
    await fixture({ snapshot: true }, async (input) => {
      const result = await run(input, ["Write out.txt."])

      expect(result.exit, result.output).toBe(0)
      expect(input.requests).toHaveLength(2)
      expect(await Bun.file(path.join(input.worktree, "out.txt")).exists()).toBe(true)
      expect(await shadowRepoExists(input)).toBe(false)
      const steps = result.events.filter((event) => event.type === "step_finish")
      expect(steps, result.output).toHaveLength(2)
      expect(steps.map((event) => event.part.snapshot)).toEqual([undefined, undefined])
      expect(result.events.filter((event) => event.type === "session_complete")).toHaveLength(1)
    })
  }, 30000)

  test("--continue and --session run another turn on a session stored with legacy snapshot data", async () => {
    await fixture({}, async (input) => {
      const first = await run(input, ["Write out.txt."])
      expect(first.exit, first.output).toBe(0)
      const sessionID = first.events.find((event) => event.type === "session_complete")?.sessionID
      expect(sessionID, first.output).toBeString()
      expect(addLegacySnapshotData(input, sessionID)).toBeGreaterThan(0)

      for (const args of [["--continue"], ["--session", sessionID]]) {
        const before = input.requests.length
        const next = await run(input, [...args, "Say done."])

        expect(next.exit, next.output).toBe(0)
        expect(next.events.find((event) => event.type === "session_complete")?.sessionID).toBe(sessionID)
        expect(input.requests.length).toBe(before + 1)
        // The earlier turns are still sent: the legacy revert marker no longer trims history.
        const request = input.requests.at(-1)!
        expect(request).toContain("Write out.txt.")
        expect(request).toContain("Say done.")
        // Legacy hashes live only in the injected parts and fields, so they must never reach the model.
        expect(request).not.toContain("1".repeat(40))
        expect(request).not.toContain("0".repeat(40))
      }
      expect(await shadowRepoExists(input)).toBe(false)
    })
  }, 60000)
})
