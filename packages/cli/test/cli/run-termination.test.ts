import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { MessageV2 } from "../../src/session/message-v2"
import type { StepFinishPart } from "../../../sdk/src/v2/gen/types.gen"
import type { StepFinishPart as LegacyStepFinishPart } from "../../../sdk/src/gen/types.gen"

test("provider termination survives adapter, storage, and headless NDJSON without raw payloads", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              index: 0,
              finishReason: "MALFORMED_FUNCTION_CALL",
              finishMessage: "Invalid arguments: api_key=private-fixture-value " + "x".repeat(3000),
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream", "x-request-id": "xoxb-private-fixture-value" } },
      )
    },
  })
  await using tmp = await tmpdir({
    config: {
      provider: {
        fixture: {
          npm: "@ai-sdk/google",
          options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}` },
          models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
        },
      },
      agent: { title: { disable: true } },
    },
  })
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../src/index.ts"),
      "run",
      "--format",
      "json",
      "--model",
      "fixture/gemini-fixture",
      "Synthetic diagnostic fixture",
    ],
    {
      cwd: tmp.path,
      env: {
        ...process.env,
        AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
        AICTRL_DISABLE_MODELS_FETCH: "true",
        AICTRL_DISABLE_AUTOCOMPACT: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 15000)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const events = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
    const finish = events.find((event) => event.type === "step_finish")
    expect(finish, stderr + stdout).toBeDefined()
    const part: StepFinishPart = MessageV2.StepFinishPart.parse(finish.part)
    const legacy: LegacyStepFinishPart = part
    expect(legacy.termination).toEqual({
      providerID: "fixture",
      modelID: "gemini-fixture",
      normalizedReason: "error",
      rawReason: { status: "available", value: "MALFORMED_FUNCTION_CALL", truncated: false },
      requestID: { status: "redacted", truncated: false },
      diagnostic: { status: "redacted", truncated: true },
    })
    expect(finish.part.sessionID).toBe(finish.sessionID)
    expect(finish.part.messageID).toBeString()
    expect(finish.invocationID).toBe(events.find((event) => event.type === "invocation_complete").invocationID)
    expect(stdout + stderr).not.toContain("private-fixture-value")
    expect(events.some((event) => event.type === "raw")).toBe(false)
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
    server.stop(true)
  }
}, 20000)
