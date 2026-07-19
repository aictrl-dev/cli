import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const CLI = path.resolve(import.meta.dir, "../../src/headless.ts")

function events(stdout: string) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function spawn(args: string[], cwd = process.cwd()) {
  return Bun.spawn(["bun", "run", "--conditions=browser", CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function output(proc: ReturnType<typeof spawn>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { events: events(stdout), stderr, code }
}

function expectFailure(result: Awaited<ReturnType<typeof output>>, phase: string) {
  expect(result.code).not.toBe(0)
  expect(result.events.map((event) => event.type)).toEqual([
    "invocation_start",
    "invocation_error",
    "invocation_complete",
  ])

  const [start, error, complete] = result.events
  expect(start.schemaVersion).toBe("1")
  expect(typeof start.invocationID).toBe("string")
  expect(start).not.toHaveProperty("sessionID")
  expect(error.invocationID).toBe(start.invocationID)
  expect(error.phase).toBe(phase)
  expect(error).not.toHaveProperty("sessionID")
  expect(error.message).toBe(`Invocation failed during ${phase}`)
  expect(complete.invocationID).toBe(start.invocationID)
  expect(complete.status).toBe("error")
  expect(complete).not.toHaveProperty("sessionID")
  expect(result.events.filter((event) => event.type === "invocation_complete")).toHaveLength(1)
}

describe("run --format json invocation lifecycle (#90)", () => {
  test("emits invocation_start before waiting for piped stdin", async () => {
    const proc = Bun.spawn(["bun", "run", "--conditions=browser", CLI, "run", "--format", "json"], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const reader = proc.stdout.getReader()
    const timeout = setTimeout(() => proc.kill(), 10_000)
    const first = await reader.read()
    clearTimeout(timeout)
    proc.kill()
    await proc.exited

    expect(first.done).toBe(false)
    expect(events(new TextDecoder().decode(first.value))[0]).toMatchObject({
      type: "invocation_start",
      schemaVersion: "1",
    })
  }, 15_000)

  test("reports an invalid directory as a validation error", async () => {
    expectFailure(
      await output(spawn(["run", "--format", "json", "--dir", "/missing/aictrl-90", "prompt"])),
      "validation",
    )
  })

  test("reports a missing file as a validation error", async () => {
    const missing = "/missing/" + "a".repeat(100_000)
    const result = await output(spawn(["run", "--format", "json", "--file", missing, "prompt"]))
    expectFailure(result, "validation")
    expect(JSON.stringify(result.events)).not.toContain(missing)
  })

  test("reports empty input as a validation error", async () => {
    expectFailure(await output(spawn(["run", "--format", "json"])), "validation")
  })

  test("reports argument parsing failure", async () => {
    expectFailure(await output(spawn(["run", "--format", "json", "--unknown-option"])), "parse")
  })

  test("does not start a run invocation for a positional token on another command", async () => {
    const proc = spawn(["session", "list", "run", "--format", "json"])
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    expect(stdout).not.toContain('"type":"invocation_')
  })

  test("recognizes run after global options", async () => {
    expectFailure(
      await output(spawn(["--log-level", "ERROR", "run", "--format", "json", "--dir", "/missing/aictrl-90", "prompt"])),
      "validation",
    )
    expectFailure(
      await output(spawn(["--print-logs=false", "run", "--format", "json", "--dir", "/missing/aictrl-90", "prompt"])),
      "validation",
    )
  })

  test("reports bootstrap failure", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "aictrl.json"), "{")
    expectFailure(await output(spawn(["run", "--format", "json", "prompt"], tmp.path)), "bootstrap")
  })

  test("reports session creation failure", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (req.method === "GET" && url.pathname === "/event") {
          return new Response("", { headers: { "content-type": "text/event-stream" } })
        }
        if (req.method === "POST" && url.pathname === "/session") {
          return Response.json({ error: "session create failed" }, { status: 500 })
        }
        return Response.json({})
      },
    })

    try {
      expectFailure(
        await output(spawn(["run", "--format", "json", "--attach", `http://localhost:${server.port}`, "prompt"])),
        "session",
      )
    } finally {
      server.stop(true)
    }
  })

  test("links the invocation to a created session and carries invocationID on session events", async () => {
    const id = "sess-invocation-90"
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (req.method === "GET" && url.pathname === "/event") {
          return new Response(
            `data: ${JSON.stringify({
              type: "session.status",
              properties: { sessionID: id, status: { type: "idle" } },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        if (req.method === "POST" && url.pathname === "/session") return Response.json({ id })
        if (req.method === "GET" && url.pathname === "/config") return Response.json({})
        if (req.method === "POST" && url.pathname.endsWith("/message")) return Response.json({})
        return Response.json({})
      },
    })

    try {
      const result = await output(
        spawn(["run", "--format", "json", "--attach", `http://localhost:${server.port}`, "prompt"]),
      )
      expect(result.code).toBe(0)
      const start = result.events.find((event) => event.type === "invocation_start")
      const session = result.events.find((event) => event.type === "session_start")
      const complete = result.events.find((event) => event.type === "invocation_complete")
      expect(session).toMatchObject({
        invocationID: start?.invocationID,
        sessionID: id,
      })
      expect(complete).toMatchObject({
        invocationID: start?.invocationID,
        sessionID: id,
        status: "completed",
      })
      expect(result.events.filter((event) => event.type === "invocation_complete")).toHaveLength(1)
      expect(
        result.events
          .filter((event) => String(event.type).startsWith("session_"))
          .every((event) => event.invocationID === start?.invocationID),
      ).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test("reports a post-session failure as an invocation error result", async () => {
    const id = "sess-invocation-failure-90"
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (req.method === "GET" && url.pathname === "/event") {
          return new Response("", { headers: { "content-type": "text/event-stream" } })
        }
        if (req.method === "POST" && url.pathname === "/session") return Response.json({ id })
        if (req.method === "GET" && url.pathname === "/config") {
          return new Response('{"post-session-secret"', {
            headers: { "content-type": "application/json" },
          })
        }
        if (req.method === "POST" && url.pathname.endsWith("/message")) return Response.json({})
        return Response.json({})
      },
    })

    try {
      const result = await output(
        spawn(["run", "--format", "json", "--attach", `http://localhost:${server.port}`, "prompt"]),
      )
      expect(result.code).not.toBe(0)
      expect(result.events.find((event) => event.type === "invocation_complete")).toMatchObject({
        sessionID: id,
        status: "error",
      })
      expect(JSON.stringify(result.events)).not.toContain("post-session-secret")
    } finally {
      server.stop(true)
    }
  })
})
