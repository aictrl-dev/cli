import path from "path"
import { afterEach, describe, expect, test } from "bun:test"

const cli = path.resolve(import.meta.dir, "../../src/index.ts")
const models = path.resolve(import.meta.dir, "../tool/fixtures/models-api.json")
const eventsDoc = path.resolve(import.meta.dir, "../../../../EVENTS.md")
const sessionID = "ses_primary"
const servers: Bun.Server<unknown>[] = []

function message(input: {
  id: string
  sessionID?: string
  usageStatus?: "reported" | "missing"
  status?: "completed" | "error" | "aborted"
  terminal?: boolean
  tokens?: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}) {
  const status = input.status ?? "completed"
  return {
    type: "message.updated",
    properties: {
      info: {
        id: input.id,
        sessionID: input.sessionID ?? sessionID,
        role: "assistant",
        time: input.terminal === false ? { created: 1 } : { created: 1, completed: 2 },
        parentID: "msg_user",
        modelID: "glm-4.7",
        providerID: "zai",
        mode: "agent",
        agent: "agent",
        path: { cwd: "/", root: "/" },
        cost: input.usageStatus === "reported" ? 0.25 : 0,
        tokens: input.tokens ?? {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        usageStatus: input.usageStatus,
        finish: status === "completed" ? "stop" : undefined,
        error:
          status === "completed"
            ? undefined
            : {
                name: status === "aborted" ? "MessageAbortedError" : "ProviderAuthError",
                data: { message: `${status} message` },
              },
      },
    },
  }
}

function server(events: unknown[]) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (req.method === "POST" && url.pathname === "/session") return Response.json({ id: sessionID })
      if (req.method === "GET" && url.pathname === "/config") return Response.json({})
      if (req.method === "POST" && url.pathname.endsWith("/message")) return Response.json({})
      if (req.method === "GET" && url.pathname === "/event") {
        return new Response(
          events
            .concat({
              type: "session.status",
              properties: { sessionID, status: { type: "idle" } },
            })
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  servers.push(server)
  return `http://localhost:${server.port}`
}

afterEach(() => {
  servers.splice(0).map((server) => server.stop(true))
})

describe("run --format json terminal assistant telemetry (#93, #45)", () => {
  test("emits one scoped terminal event per message with explicit status and usage provenance", async () => {
    const zero = message({
      id: "msg_zero",
      usageStatus: "reported",
      tokens: {
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    })
    const partial = {
      input: 10,
      output: 4,
      reasoning: 2,
      cache: { read: 8, write: 0 },
    }
    const events = [
      zero,
      zero,
      message({ id: "msg_missing", usageStatus: "missing", status: "error" }),
      message({ id: "msg_aborted", usageStatus: "missing", status: "aborted" }),
      message({
        id: "msg_partial",
        usageStatus: "reported",
        terminal: false,
        tokens: partial,
      }),
      message({
        id: "msg_partial",
        usageStatus: "reported",
        status: "error",
        tokens: partial,
      }),
      message({
        id: "msg_legacy",
        tokens: partial,
      }),
      message({ id: "msg_child", sessionID: "ses_child", usageStatus: "reported" }),
    ]
    const proc = Bun.spawn(["bun", "run", cli, "run", "--format", "json", "--attach", server(events), "test prompt"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICTRL_MODELS_PATH: models,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, stderr).toBe(0)
    const output = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "message_complete")

    expect(output.map((event) => event.messageID)).toEqual([
      "msg_zero",
      "msg_missing",
      "msg_aborted",
      "msg_partial",
      "msg_legacy",
    ])
    expect(output.map((event) => event.status)).toEqual(["completed", "error", "aborted", "error", "completed"])
    expect(output.map((event) => event.usageStatus)).toEqual(["reported", "missing", "missing", "reported", "reported"])
    expect(output[0].tokens).toEqual({
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
    expect(output[1].tokens).toBeNull()
    expect(output[3].tokens).toEqual({
      input: 10,
      output: 4,
      reasoning: 2,
      cache: { read: 8, write: 0 },
    })
    expect(output[4].tokens.total).toBe(24)
    expect(output[3].context).toEqual({
      used: 18,
      limit: 204_800,
      ratio: 18 / 204_800,
    })
  }, 20_000)

  test("degrades to null context when the attached model registry is unavailable", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cli,
        "run",
        "--format",
        "json",
        "--attach",
        server([message({ id: "msg_registry", usageStatus: "reported" })]),
        "test prompt",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AICTRL_MODELS_PATH: path.resolve(import.meta.dir, "missing-models.json"),
          AICTRL_MODELS_URL: "http://127.0.0.1:1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, stderr).toBe(0)
    const output = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "message_complete")

    expect(output.messageID).toBe("msg_registry")
    expect(output.context).toBeNull()
  }, 20_000)

  test("documents primary-session scope", async () => {
    const doc = await Bun.file(eventsDoc).text()
    const section = doc.slice(doc.indexOf("### `message_complete`"), doc.indexOf("### `text`"))
    expect(section).toContain("primary-session")
    expect(section).toContain("Child-session assistant messages are")
  })
})
