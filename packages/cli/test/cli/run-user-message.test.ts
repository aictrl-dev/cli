import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { schema, pathArgs } from "../fixture/output-schema"
import { alibabaProvider } from "../fixture/providers"
import { userMessages } from "../../src/cli/cmd/run.user-message"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const eventsDoc = path.resolve(import.meta.dir, "../../../../EVENTS.md")

// One scripted provider turn: plain text, or a StructuredOutput call with this result JSON.
type Turn = { text: string; promptTokens?: number } | { result: string }

function chunks(turn: Turn, call: string, directory: string) {
  const delta =
    "text" in turn
      ? { content: turn.text }
      : {
          tool_calls: [
            {
              index: 0,
              id: call,
              type: "function",
              function: { name: "StructuredOutput", arguments: pathArgs(directory, turn.result, `${call}.json`) },
            },
          ],
        }
  const promptTokens = "text" in turn ? (turn.promptTokens ?? 1) : 1
  return [
    { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
    },
  ]
}

async function run(input: {
  args: string[]
  turns?: Turn[]
  files?: Record<string, string>
  compaction?: boolean
  /** Source of a module preloaded into the CLI process, to fake bus traffic. */
  preload?: string
}) {
  await using tmp = await tmpdir()
  const turns = input.turns ?? [{ text: "Plain response" }]
  let requests = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json()
      const turn = turns[Math.min(requests, turns.length - 1)]
      requests++
      const body = chunks(turn, `call_${requests}`, tmp.path)
        .map((chunk) => `data: ${JSON.stringify(chunk)}`)
        .concat("data: [DONE]")
        .join("\n\n")
      return new Response(body + "\n\n", { headers: { "Content-Type": "text/event-stream" } })
    },
  })
  // A small context window lets one large usage report trigger auto-compaction.
  const model = input.compaction
    ? { ...alibabaProvider.models["qwen-plus"], limit: { context: 50_000, output: 1_000 } }
    : alibabaProvider.models["qwen-plus"]
  await Bun.write(
    path.join(tmp.path, "aictrl.json"),
    JSON.stringify({
      enabled_providers: ["alibaba"],
      provider: {
        alibaba: {
          ...alibabaProvider,
          models: { "qwen-plus": model },
          options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` },
        },
      },
      agent: { title: { disable: true } },
      command: { check: { template: "Check $ARGUMENTS." } },
    }),
  )
  await Bun.write(path.join(tmp.path, "schema.json"), JSON.stringify(schema))
  for (const [name, content] of Object.entries(input.files ?? {})) await Bun.write(path.join(tmp.path, name), content)
  const home = path.join(tmp.path, "home")
  await fs.mkdir(home)
  if (input.preload) await Bun.write(path.join(tmp.path, "preload.ts"), input.preload)
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--conditions=browser",
      ...(input.preload ? ["--preload", path.join(tmp.path, "preload.ts")] : []),
      entry,
      "run",
      "--format",
      "json",
      "--model",
      "alibaba/qwen-plus",
      ...input.args,
    ],
    {
      cwd: tmp.path,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        AICTRL_TEST_HOME: home,
        AICTRL_DISABLE_AUTOCOMPACT: input.compaction ? "" : "true",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const events = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line)) as Record<string, any>[]
    return { events, stderr, exit, requests, directory: tmp.path }
  } finally {
    clearTimeout(timer)
    proc.kill("SIGKILL")
    server.stop(true)
  }
}

function userMessageEvents(events: Record<string, any>[]) {
  return events.filter((event) => event.type === "user_message")
}

describe("run --format json user_message (#223)", () => {
  test("emits the prompt once with its parts, agent, model and sequence number", async () => {
    const result = await run({ args: ["Hello"] })
    expect(result.exit, result.stderr).toBe(0)
    const [message, ...rest] = userMessageEvents(result.events)
    expect(rest).toEqual([])
    expect(message).toMatchObject({
      schemaVersion: "1",
      sessionID: expect.stringMatching(/^ses_/),
      messageID: expect.stringMatching(/^msg_/),
      agent: "build",
      model: { providerID: "alibaba", modelID: "qwen-plus" },
      sequenceNum: 1,
      // An explicit prompt leaves unused stdin unread and adds no separator newline.
      parts: [{ type: "text", text: "Hello", messageID: message.messageID, sessionID: message.sessionID }],
    })
    expect(message.parts[0].synthetic).toBeUndefined()
    const text = result.events.find((event) => event.type === "text")
    expect(text?.sequenceNum).toBe(2)
  }, 25_000)

  test("precedes the first assistant event it triggers", async () => {
    const result = await run({ args: ["Hello"] })
    expect(result.exit, result.stderr).toBe(0)
    expect(result.events.map((event) => event.type)).toEqual([
      "invocation_start",
      "session_start",
      "tool_catalog",
      "user_message",
      "step_start",
      "text",
      "step_finish",
      "message_complete",
      "session_complete",
      "invocation_complete",
    ])
  }, 25_000)

  test("carries -f attachments with their synthetic expansion as stored", async () => {
    const result = await run({ args: ["Summarize", "-f", "notes.txt"], files: { "notes.txt": "attached content" } })
    expect(result.exit, result.stderr).toBe(0)
    const [message, ...rest] = userMessageEvents(result.events)
    expect(rest).toEqual([])
    const parts = message.parts as Record<string, any>[]
    expect(parts.find((part) => part.type === "file")).toMatchObject({
      filename: "notes.txt",
      mime: "text/plain",
      url: expect.stringMatching(/^file:.*notes\.txt$/),
    })
    expect(parts.filter((part) => part.synthetic === true).map((part) => part.text)).toEqual(
      expect.arrayContaining([expect.stringContaining("attached content")]),
    )
    expect(parts.at(-1)).toMatchObject({ type: "text", text: "Summarize" })
  }, 25_000)

  test("carries the --command expansion", async () => {
    const result = await run({ args: ["--command", "check", "input"] })
    expect(result.exit, result.stderr).toBe(0)
    const [message, ...rest] = userMessageEvents(result.events)
    expect(rest).toEqual([])
    expect(message.parts).toMatchObject([{ type: "text", text: "Check input." }])
  }, 25_000)

  test("a StructuredOutput corrective turn adds no user_message: its reminder is never stored", async () => {
    const result = await run({
      args: ["--output-schema", "schema.json", "Hello"],
      turns: [{ text: "prose" }, { result: '{"result":"accepted"}' }],
    })
    expect(result.exit, result.stderr).toBe(0)
    expect(result.requests).toBe(2)
    expect(result.events.filter((event) => event.type === "structured_output_rejected")).toHaveLength(1)
    expect(userMessageEvents(result.events)).toMatchObject([{ parts: [{ type: "text", text: "Hello" }] }])
  }, 25_000)

  test("emits the compaction request and its synthetic continue message", async () => {
    const result = await run({
      args: ["Hello"],
      compaction: true,
      turns: [{ text: "Large turn", promptTokens: 60_000 }, { text: "Summary" }, { text: "Done" }],
    })
    expect(result.exit, result.stderr).toBe(0)
    const messages = userMessageEvents(result.events)
    expect(messages.map((message) => message.parts.map((part: Record<string, any>) => part.type))).toEqual([
      ["text"],
      ["compaction"],
      ["text"],
    ])
    expect(messages[2].parts[0]).toMatchObject({ synthetic: true, text: expect.stringContaining("Continue") })
    const types = result.events.map((event) => event.type)
    const continued = types.lastIndexOf("user_message")
    expect(types.indexOf("step_start", continued)).toBeGreaterThan(continued)
    const sequence = result.events.filter((event) => event.sequenceNum !== undefined).map((event) => event.sequenceNum)
    expect(sequence).toEqual(sequence.map((_, index) => index + 1))
  }, 25_000)

  const source = (file: string) => JSON.stringify(path.resolve(import.meta.dir, "../../src", file))

  // The prompt stores a user message, then a child-session permission request makes the
  // event handler throw before any later primary-session event could complete the message.
  const throwingHandler = `import { SessionPrompt } from ${source("session/prompt.ts")}
import { PermissionNext } from ${source("permission/next.ts")}
import { GlobalBus } from ${source("bus/global.ts")}
const publish = (type, properties) => GlobalBus.emit("event", { payload: { type, properties } })
PermissionNext.reply = async () => {
  throw new Error("Fixture handler failure")
}
SessionPrompt.prompt = async ({ sessionID }) => {
  publish("session.created", { info: { id: "ses_child", parentID: sessionID, title: "child" } })
  publish("message.updated", {
    info: { id: "msg_user", sessionID, role: "user", time: { created: 1 }, agent: "build",
      model: { providerID: "alibaba", modelID: "qwen-plus" } },
  })
  publish("message.part.updated", {
    part: { id: "prt_user", messageID: "msg_user", sessionID, type: "text", text: "Hello" },
  })
  publish("permission.asked", { id: "per_child", sessionID: "ses_child", permission: "bash", patterns: ["ls"], metadata: {} })
}
`

  test("a pending user message is emitted when an event handler throws", async () => {
    const result = await run({ args: ["Hello"], preload: throwingHandler })
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain("Fixture handler failure")
    expect(userMessageEvents(result.events)).toMatchObject([
      { messageID: "msg_user", parts: [{ id: "prt_user", text: "Hello" }], sequenceNum: 1 },
    ])
    const types = result.events.map((event) => event.type)
    expect(types.indexOf("user_message")).toBeLessThan(types.indexOf("session_error"))
  }, 25_000)
})

describe("userMessages", () => {
  const sessionID = "ses_primary"
  const info = (id: string, session = sessionID) => ({
    type: "message.updated",
    properties: {
      info: { id, sessionID: session, role: "user", agent: "build", model: { providerID: "p", modelID: "m" } },
    },
  })
  const part = (id: string, messageID: string, session = sessionID) => ({
    type: "message.part.updated",
    properties: { part: { id, messageID, sessionID: session, type: "text", text: id } },
  })

  function track() {
    const emitted: Record<string, any>[] = []
    let sequence = 0
    const users = userMessages({ sessionID, emit: (_, data) => emitted.push(data), nextSeq: () => ++sequence })
    return { users, emitted }
  }

  test("waits for the session to move past the message, then emits it once", () => {
    const { users, emitted } = track()
    users.observe(info("msg_1"))
    users.observe(part("prt_1", "msg_1"))
    users.observe({ type: "session.updated", properties: { info: { id: sessionID } } })
    users.observe(part("prt_2", "msg_1"))
    expect(emitted).toEqual([])

    users.observe({ type: "session.status", properties: { sessionID, status: { type: "busy" } } })
    users.observe(info("msg_1"))
    users.flush()
    expect(emitted).toEqual([
      {
        messageID: "msg_1",
        agent: "build",
        model: { providerID: "p", modelID: "m" },
        parts: [part("prt_1", "msg_1").properties.part, part("prt_2", "msg_1").properties.part],
        sequenceNum: 1,
      },
    ])
  })

  test("ignores child-session user messages", () => {
    const { users, emitted } = track()
    users.observe(info("msg_child", "ses_child"))
    users.observe(part("prt_child", "msg_child", "ses_child"))
    users.flush()
    expect(emitted).toEqual([])
  })
})

test("EVENTS.md documents user_message", async () => {
  const doc = await Bun.file(eventsDoc).text()
  const section = doc.slice(doc.indexOf("### `user_message`"), doc.indexOf("### `message_complete`"))
  expect(section).toContain("sequenceNum")
  expect(section).toContain("synthetic")
})
