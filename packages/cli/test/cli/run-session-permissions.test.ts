import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const command = process.env.AICTRL_TEST_BINARY
  ? [process.env.AICTRL_TEST_BINARY]
  : ["bun", "run", "--conditions=browser", entry]

type Rule = { permission: string; pattern: string; action: string }

/** Runs `aictrl run --format json` against a fixture provider that answers with text, and returns `session_start`. */
async function sessionStart(input: { config: Record<string, unknown>; args?: string[] }) {
  await using tmp = await tmpdir({ git: true })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch() {
      const chunks = [
        { delta: { role: "assistant", content: "Fixture complete" }, finish_reason: null },
        { delta: {}, finish_reason: "stop" },
      ].map(
        (choice) =>
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`,
      )
      return new Response(chunks.join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
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
    ...input.config,
  }
  const home = path.join(tmp.path, "home")
  const proc = Bun.spawn(
    [...command, "run", "--format", "json", "--model", "fixture/fixture", ...(input.args ?? []), "Say done."],
    {
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
    },
  )
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 15000)
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const event = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "session_start")
    if (!event) throw new Error(`no session_start event\n${stderr}\n${stdout}`)
    return event as { agent?: string; permissions: Rule[] }
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
    server.stop(true)
  }
}

/** The rule a tool call is decided by: the last rule whose permission and pattern match (exact match is enough here). */
function decisive(rules: Rule[], permission: string, pattern: string) {
  return rules.findLast(
    (rule) =>
      (rule.permission === "*" || rule.permission === permission) && (rule.pattern === "*" || rule.pattern === pattern),
  )
}

describe("session_start.permissions (#212)", () => {
  test("lists config rules for the default agent, in evaluation order", async () => {
    const event = await sessionStart({
      config: { agent: { title: { disable: true } }, permission: { "*": "allow", bash: { "rm *": "deny" } } },
    })

    expect(event.permissions).toContainEqual({ permission: "bash", pattern: "rm *", action: "deny" })
    expect(decisive(event.permissions, "bash", "rm *")?.action).toBe("deny")
    expect(decisive(event.permissions, "bash", "ls")?.action).toBe("allow")
  })

  test("places a selected agent's own rules after the config rules", async () => {
    const event = await sessionStart({
      args: ["--agent", "reviewer"],
      config: {
        agent: { title: { disable: true }, reviewer: { mode: "primary", permission: { bash: { "rm *": "allow" } } } },
        permission: { "*": "allow", bash: { "rm *": "deny" } },
      },
    })

    expect(event.agent).toBe("reviewer")
    expect(decisive(event.permissions, "bash", "rm *")?.action).toBe("allow")
  })

  test("uses a --command's own agent, which the command's tool calls run under", async () => {
    const config = {
      agent: { title: { disable: true }, reviewer: { mode: "primary", permission: { bash: { "rm *": "allow" } } } },
      permission: { "*": "allow", bash: { "rm *": "deny" } },
    }
    const inline = await sessionStart({
      args: ["--command", "review"],
      config: { ...config, command: { review: { template: "Review $ARGUMENTS", agent: "reviewer" } } },
    })
    // A subtask command runs in a child session; the primary session keeps the default agent.
    const subtask = await sessionStart({
      args: ["--command", "review"],
      config: { ...config, command: { review: { template: "Review $ARGUMENTS", agent: "reviewer", subtask: true } } },
    })

    expect(decisive(inline.permissions, "bash", "rm *")?.action).toBe("allow")
    expect(decisive(subtask.permissions, "bash", "rm *")?.action).toBe("deny")
  })

  test("is still emitted when the default agent cannot be resolved", async () => {
    // The prompt reports the unknown agent as session_error; session_start must not be lost.
    const event = await sessionStart({ config: { default_agent: "missing", agent: { title: { disable: true } } } })

    expect(event.permissions).toEqual([])
  })
})
