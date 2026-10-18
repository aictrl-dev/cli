import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const command = process.env.AICTRL_TEST_BINARY
  ? [process.env.AICTRL_TEST_BINARY]
  : ["bun", "run", "--conditions=browser", entry]

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number }
type Tokens = {
  total: number
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}
type Event = {
  type: string
  sessionID: string
  subagentSessionID?: string
  messageID?: string
  tokens?: Tokens | null
  usageStatus?: string
}

function usage(prompt: number, completion: number): Usage {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

// Model turns in request order: the parent delegates through `task`, the child answers, the parent finishes.
const turns = [
  {
    delta: {
      tool_calls: [
        {
          index: 0,
          id: "call_task",
          type: "function",
          function: {
            name: "task",
            arguments: JSON.stringify({ description: "Search", prompt: "Find the file.", subagent_type: "general" }),
          },
        },
      ],
    },
    finish: "tool_calls",
    usage: usage(100, 10),
  },
  { delta: { content: "Found it." }, finish: "stop", usage: usage(50, 5) },
  { delta: { content: "Done." }, finish: "stop", usage: usage(120, 7) },
]

async function run() {
  await using tmp = await tmpdir({ git: true })
  const pending = [...turns]
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch() {
      const turn = pending.shift() ?? { delta: { content: "extra" }, finish: "stop", usage: usage(0, 0) }
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", ...turn.delta }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: turn.finish }], usage: turn.usage },
      ].map(
        (chunk) =>
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", ...chunk })}\n\n`,
      )
      return new Response(chunks.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  const config = {
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}/v1` },
        models: { fixture: { name: "fixture", tool_call: true, limit: { context: 100000, output: 1000 } } },
      },
    },
    agent: { title: { disable: true } },
    permission: { "*": "allow" },
  }
  const home = path.join(tmp.path, "home")
  const proc = Bun.spawn([...command, "run", "--format", "json", "--model", "fixture/fixture", "Delegate a search."], {
    cwd: tmp.path,
    env: {
      ...process.env,
      AICTRL_CONFIG_CONTENT: JSON.stringify(config),
      AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
      AICTRL_DISABLE_AUTOCOMPACT: "true",
      HOME: home,
      AICTRL_TEST_HOME: home,
      AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 20000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const events: Event[] = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
    return { exit, output: stderr + stdout, events, unused: pending.length }
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
    server.stop(true)
  }
}

describe("subagent token usage (#213)", () => {
  test("reports each child turn so parent + children add up to the provider total", async () => {
    const result = await run()
    expect(result.exit, result.output).toBe(0)
    expect(result.unused, result.output).toBe(0)

    const child = result.events.find((event) => event.type === "subagent_start")?.subagentSessionID
    expect(child, result.output).toBeDefined()
    const parentTurns = result.events.filter((event) => event.type === "message_complete")
    const childTurns = result.events.filter((event) => event.type === "subagent_message_complete")

    // message_complete keeps its primary-session meaning.
    expect(parentTurns).toHaveLength(2)
    expect(childTurns).toHaveLength(1)
    expect(childTurns[0]).toMatchObject({ subagentSessionID: child, usageStatus: "reported" })
    expect(childTurns[0].messageID).not.toBe(parentTurns[0].messageID)

    const total = [...parentTurns, ...childTurns].reduce((sum, event) => sum + event.tokens!.total, 0)
    const provider = turns.reduce((sum, turn) => sum + turn.usage.total_tokens, 0)
    expect(childTurns[0].tokens!.total).toBe(55)
    expect(total).toBe(provider)
  }, 30_000)
})
