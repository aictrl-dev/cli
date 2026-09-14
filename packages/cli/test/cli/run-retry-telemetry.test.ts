import path from "path"
import { afterEach, describe, expect, test } from "bun:test"

const cli = path.resolve(import.meta.dir, "../../src/index.ts")
const models = path.resolve(import.meta.dir, "../tool/fixtures/models-api.json")
const sessionID = "ses_retry_measurement"
const messageID = "msg_retry_measurement"
const servers: Bun.Server<unknown>[] = []

function server(events: unknown[]) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (req.method === "POST" && url.pathname === "/session") return Response.json({ id: sessionID })
      if (req.method === "GET" && url.pathname === "/config") return Response.json({})
      if (req.method === "POST" && url.pathname.endsWith("/message")) return Response.json({})
      if (req.method === "GET" && url.pathname === "/event") {
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  servers.push(server)
  return `http://localhost:${server.port}`
}

function status(value: Record<string, unknown>) {
  return {
    type: "session.status",
    properties: { sessionID, status: value },
  }
}

function completed(finish = "stop", id = messageID) {
  return {
    type: "message.updated",
    properties: {
      info: {
        id,
        sessionID,
        role: "assistant",
        time: { created: 1, completed: 2 },
        parentID: "msg_user",
        modelID: "glm-4.7",
        providerID: "zai",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        usageStatus: "reported",
        finish,
      },
    },
  }
}

function started(id: string) {
  const event = completed("stop", id)
  return {
    ...event,
    properties: {
      ...event.properties,
      info: {
        ...event.properties.info,
        time: { created: 3 },
      },
    },
  }
}

afterEach(() => servers.splice(0).map((item) => item.stop(true)))

describe("run --format json retry telemetry (#110)", () => {
  test("correlates retry ordinals and resolves eventual recovery", async () => {
    const first = "c76dbc08-64ce-48cc-b79f-ecc1ba16be2c"
    const second = "52d9f7cf-d667-4a82-a6c8-d65f75fb965b"
    const retry = (retryID: string, attempt: number, reason: string, delayMs: number) =>
      status({
        type: "retry",
        retryID,
        messageID,
        providerID: "zai",
        modelID: "glm-4.7",
        attempt,
        reason,
        delayMs,
        message: "redacted from NDJSON",
        next: Date.now() + delayMs,
      })

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cli,
        "run",
        "--format",
        "json",
        "--attach",
        server([
          retry(first, 1, "rate_limit", 2_000),
          retry(second, 2, "provider", 4_000),
          completed(),
          status({ type: "idle" }),
        ]),
        "prompt",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, AICTRL_MODELS_PATH: models },
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
      .filter((event) => event.type === "retry_scheduled" || event.type === "retry_complete")

    expect(output.map((event) => [event.type, event.retryID, event.outcome])).toEqual([
      ["retry_scheduled", first, undefined],
      ["retry_complete", first, "failed"],
      ["retry_scheduled", second, undefined],
      ["retry_complete", second, "recovered"],
    ])
    expect(output[0]).toMatchObject({
      messageID,
      providerID: "zai",
      modelID: "glm-4.7",
      attempt: 1,
      reason: "rate_limit",
      delayMs: 2_000,
    })
    expect(JSON.stringify(output)).not.toContain("redacted from NDJSON")
    expect(output.every((event) => typeof event.cliVersion === "string")).toBe(true)
  }, 20_000)

  test("marks an uncorrelated older-server retry unknown at the idle boundary", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cli,
        "run",
        "--format",
        "json",
        "--attach",
        server([
          status({ type: "retry", attempt: 1, message: "legacy", next: Date.now() + 1_000 }),
          status({ type: "idle" }),
        ]),
        "prompt",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, AICTRL_MODELS_PATH: models },
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
      .filter((event) => event.type === "retry_scheduled" || event.type === "retry_complete")

    expect(output).toHaveLength(2)
    expect(output[0]).toMatchObject({ messageID: null, providerID: null, modelID: null, reason: "unknown" })
    expect(output[1]).toMatchObject({ retryID: output[0].retryID, outcome: "unknown" })
  }, 20_000)

  test("does not count a normalized error finish as recovered", async () => {
    const retryID = "3c45ab98-65fe-4efe-9309-4d130341e31c"
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cli,
        "run",
        "--format",
        "json",
        "--attach",
        server([
          status({
            type: "retry",
            retryID,
            messageID,
            providerID: "zai",
            modelID: "glm-4.7",
            attempt: 1,
            reason: "provider",
            delayMs: 2_000,
            message: "provider error",
            next: Date.now() + 2_000,
          }),
          completed("error"),
          status({ type: "idle" }),
        ]),
        "prompt",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, AICTRL_MODELS_PATH: models },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const result = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "retry_complete")

    expect(result).toMatchObject({ retryID, outcome: "failed" })
  }, 20_000)

  test("waits for structured-output validation before resolving recovery", async () => {
    const retryID = "e62be190-51b4-4564-8bd6-7401ccf60476"
    const initial = completed()
    const corrected = {
      ...initial,
      properties: {
        ...initial.properties,
        info: {
          ...initial.properties.info,
          error: {
            name: "StructuredOutputError",
            data: { message: "Model did not produce structured output" },
          },
        },
      },
    }
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cli,
        "run",
        "--format",
        "json",
        "--attach",
        server([
          status({
            type: "retry",
            retryID,
            messageID,
            providerID: "zai",
            modelID: "glm-4.7",
            attempt: 1,
            reason: "provider",
            delayMs: 2_000,
            message: "provider error",
            next: Date.now() + 2_000,
          }),
          completed(),
          corrected,
          status({ type: "idle" }),
        ]),
        "prompt",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, AICTRL_MODELS_PATH: models },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const result = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "retry_complete")

    expect(result).toMatchObject({ retryID, outcome: "failed" })
  }, 20_000)

  test("treats server-side message cancellation as aborted", async () => {
    const retryID = "01fffcfe-4381-47dd-83f9-257175014779"
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cli,
        "run",
        "--format",
        "json",
        "--attach",
        server([
          status({
            type: "retry",
            retryID,
            messageID,
            providerID: "zai",
            modelID: "glm-4.7",
            attempt: 1,
            reason: "network",
            delayMs: 2_000,
            message: "network error",
            next: Date.now() + 2_000,
          }),
          {
            type: "session.error",
            properties: {
              sessionID,
              error: { name: "MessageAbortedError", data: { message: "Session cancelled" } },
            },
          },
          status({ type: "idle" }),
        ]),
        "prompt",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, AICTRL_MODELS_PATH: models },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const output = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    expect(output.find((event) => event.type === "retry_complete")).toMatchObject({ retryID, outcome: "aborted" })
    expect(output.find((event) => event.type === "session_error")).toMatchObject({ reason: "interrupted" })
  }, 20_000)

  test("keeps retry outcomes scoped to their owning message across tool turns", async () => {
    const first = "6c0f1b08-87a0-48ac-8c33-cccf68d591f0"
    const second = "6907e224-9112-44f5-810d-2cf4f491646c"
    const firstMessage = "msg_tool_turn"
    const secondMessage = "msg_followup_turn"
    const retry = (retryID: string, owner: string) =>
      status({
        type: "retry",
        retryID,
        messageID: owner,
        providerID: "zai",
        modelID: "glm-4.7",
        attempt: 1,
        reason: "network",
        delayMs: 2_000,
        message: "network error",
        next: Date.now() + 2_000,
      })
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        cli,
        "run",
        "--format",
        "json",
        "--attach",
        server([
          retry(first, firstMessage),
          completed("tool-calls", firstMessage),
          retry(second, secondMessage),
          status({ type: "idle" }),
        ]),
        "prompt",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, AICTRL_MODELS_PATH: models },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const output = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "retry_complete")

    expect(output.map((event) => [event.retryID, event.messageID, event.outcome])).toEqual([
      [first, firstMessage, "recovered"],
      [second, secondMessage, "unknown"],
    ])
  }, 20_000)

  test.each([
    ["ProviderAuthError", "nonretryable failure"],
    ["MessageAbortedError", "cancellation"],
  ])(
    "does not attribute a later message %s to the prior recovered retry",
    async (name, label) => {
      const retryID = "a03f99e1-a49f-4dd9-a0fd-777eec13d8f7"
      const firstMessage = "msg_retried_turn"
      const secondMessage = "msg_later_failure"
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          cli,
          "run",
          "--format",
          "json",
          "--attach",
          server([
            status({
              type: "retry",
              retryID,
              messageID: firstMessage,
              providerID: "zai",
              modelID: "glm-4.7",
              attempt: 1,
              reason: "network",
              delayMs: 2_000,
              message: "network error",
              next: Date.now() + 2_000,
            }),
            completed("tool-calls", firstMessage),
            started(secondMessage),
            {
              type: "session.error",
              properties: {
                sessionID,
                error: { name, data: { message: label } },
              },
            },
            status({ type: "idle" }),
          ]),
          "prompt",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, AICTRL_MODELS_PATH: models },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const stdout = await new Response(proc.stdout).text()
      await proc.exited
      const output = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "retry_complete")

      expect(output).toEqual([expect.objectContaining({ retryID, messageID: firstMessage, outcome: "recovered" })])
    },
    20_000,
  )
})
