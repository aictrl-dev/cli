import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

/** A Gemini server that answers every request with "Done." and records the request bodies. */
function fixtureProvider() {
  const requests: any[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      const chunk = {
        candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Done." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  return { requests, server }
}

/**
 * Writes what an older version left behind for a session that used todowrite: a
 * completed todowrite tool part in the last assistant message, and a `todo` row.
 */
function addLegacyTodoHistory(database: string) {
  const sqlite = new Database(database, { readwrite: true })
  try {
    const found = sqlite
      .query('SELECT id, session_id FROM message WHERE data LIKE \'%"role":"assistant"%\' ORDER BY id DESC LIMIT 1')
      .get() as { id: string; session_id: string } | null
    expect(found, `no assistant message in ${database}`).toBeTruthy()
    const message = found!
    const todos = [{ content: "Check the input", status: "completed", priority: "high" }]
    const part = {
      type: "tool",
      callID: "call_legacy_todowrite",
      tool: "todowrite",
      state: {
        status: "completed",
        input: { todos },
        output: JSON.stringify(todos, null, 2),
        title: "0 todos",
        metadata: { todos },
        time: { start: 1, end: 2 },
      },
    }
    const now = Date.now()
    sqlite
      .query(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("prt_zzzzlegacytodowrite", message.id, message.session_id, now, now, JSON.stringify(part))
    // Databases from versions with the todo tool also hold its rows, while the old
    // `todo` table still exists; reconciling the schema may drop it (#185).
    const todoTable = sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todo'").get()
    if (!todoTable) return
    sqlite
      .query(
        "INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(message.session_id, "Check the input", "completed", "high", 0, now, now)
  } finally {
    sqlite.close()
  }
}

function declaredTools(request: any): string[] {
  return (request.tools ?? []).flatMap((tool: any) => tool.functionDeclarations ?? []).map((tool: any) => tool.name)
}

function calledTools(request: any): string[] {
  return (request.contents ?? [])
    .flatMap((content: any) => content.parts ?? [])
    .flatMap((part: any) => (part.functionCall ? [part.functionCall.name] : []))
}

describe("aictrl run --continue on a session with todowrite history (#182)", () => {
  test("loads the legacy history and runs another turn without a todo tool", async () => {
    await using tmp = await tmpdir({ git: true })
    const { requests, server } = fixtureProvider()
    await Bun.write(
      path.join(tmp.path, "aictrl.json"),
      JSON.stringify({
        provider: {
          fixture: {
            npm: "@ai-sdk/google",
            options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}` },
            models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
          },
        },
        agent: { title: { disable: true } },
      }),
    )
    const data = path.join(tmp.path, ".xdg")
    const environment = {
      ...process.env,
      XDG_DATA_HOME: path.join(data, "share"),
      XDG_STATE_HOME: path.join(data, "state"),
      AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
      AICTRL_DISABLE_MODELS_FETCH: "true",
      AICTRL_DISABLE_AUTOCOMPACT: "true",
    }

    async function run(...args: string[]) {
      const proc = Bun.spawn(
        ["bun", "run", "--conditions=browser", entry, "run", "--model", "fixture/gemini-fixture", ...args],
        { cwd: tmp.path, env: environment, stdout: "pipe", stderr: "pipe" },
      )
      const timeout = setTimeout(() => proc.kill("SIGKILL"), 15000)
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { exit, output: stderr + stdout }
      } finally {
        clearTimeout(timeout)
        proc.kill("SIGKILL")
      }
    }

    try {
      const first = await run("Check this input.")
      expect(first.exit, first.output).toBe(0)
      addLegacyTodoHistory(path.join(data, "share", "aictrl", "aictrl.db"))
      const before = requests.length

      const next = await run("--continue", "Continue.")

      expect(next.exit, next.output).toBe(0)
      expect(requests.length, next.output).toBeGreaterThan(before)
      const request = requests[before]
      expect(calledTools(request)).toContain("todowrite")
      expect(declaredTools(request)).toContain("bash")
      expect(declaredTools(request)).not.toContain("todowrite")
      expect(declaredTools(request)).not.toContain("todoread")
    } finally {
      server.stop(true)
    }
  }, 40000)
})
