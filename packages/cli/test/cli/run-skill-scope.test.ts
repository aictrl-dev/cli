import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { tmpdir, writeSkill as skill } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const command = process.env.AICTRL_TEST_BINARY
  ? [process.env.AICTRL_TEST_BINARY]
  : ["bun", "run", "--conditions=browser", entry]

type Event = {
  type: string
  name?: string
  skills?: { name: string }[]
}

type Request = {
  tools?: { function: { name: string; description?: string } }[]
  messages: { role: string; content?: unknown }[]
}

/**
 * Runs `aictrl run --format json` against a fixture provider that answers each
 * model turn with the next `calls` entry (a skill tool call) and then stops.
 */
async function run(input: { args?: string[]; skills?: { paths: string[] }; calls?: string[] }) {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  const project = path.join(tmp.path, "project")
  await skill(path.join(home, ".claude", "skills"), "home-skill")
  await skill(path.join(project, ".claude", "skills"), "alpha")
  await skill(path.join(project, ".claude", "skills"), "beta")
  await $`git init`.cwd(project).quiet()
  await $`git -c user.email=test@example.com -c user.name=test commit --allow-empty -m root`.cwd(project).quiet()

  const calls = [...(input.calls ?? [])]
  const requests: Request[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = (await req.json()) as Request
      if (body.tools?.length) requests.push(body)
      const call = body.tools?.length ? calls.shift() : undefined
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `fixture_${requests.length}`,
                type: "function",
                function: { name: "skill", arguments: JSON.stringify({ name: call }) },
              },
            ],
          }
        : { content: "Fixture complete" }
      const chunks = [
        { delta: { role: "assistant", ...delta }, finish_reason: null },
        { delta: {}, finish_reason: call ? "tool_calls" : "stop" },
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
    agent: { title: { disable: true } },
    permission: { "*": "allow" },
    ...(input.skills ? { skills: input.skills } : {}),
  }
  const proc = Bun.spawn(
    [...command, "run", "--format", "json", "--model", "fixture/fixture", ...(input.args ?? []), "Use a skill."],
    {
      cwd: project,
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
        AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS: "5000",
      },
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
    const events: Event[] = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
    const names = (type: string) =>
      events
        .filter((event) => event.type === type)
        .map((event) => event.name!)
        .sort()
    return {
      exit,
      output: stderr + stdout,
      catalog: events
        .find((event) => event.type === "tool_catalog")
        ?.skills?.map((s) => s.name)
        .sort(),
      discovered: names("skill_discovered"),
      loaded: names("skill_loaded"),
      descriptions: requests.map(
        (request) => request.tools?.find((tool) => tool.function.name === "skill")?.function.description ?? "",
      ),
      requests,
    }
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
    server.stop(true)
  }
}

describe("headless skill scope", () => {
  test("home-directory skills are not listed", async () => {
    const result = await run({})
    expect(result.exit, result.output).toBe(0)
    expect(result.catalog).toEqual(["alpha", "beta"])
    expect(result.discovered).toEqual(["alpha", "beta"])
    expect(result.descriptions[0]).toContain("<name>alpha</name>")
    expect(result.descriptions[0]).not.toContain("home-skill")
  }, 20000)

  test("config skills.paths lists home-directory skills explicitly", async () => {
    const result = await run({ skills: { paths: ["~/.claude/skills"] } })
    expect(result.exit, result.output).toBe(0)
    expect(result.catalog).toEqual(["alpha", "beta", "home-skill"])
    expect(result.discovered).toEqual(["alpha", "beta", "home-skill"])
  }, 20000)

  test("--skill lists and loads only the allowed skills", async () => {
    const result = await run({ args: ["--skill", "alpha"], calls: ["beta", "alpha"] })
    expect(result.exit, result.output).toBe(0)
    expect(result.catalog).toEqual(["alpha"])
    expect(result.discovered).toEqual(["alpha"])
    expect(result.loaded).toEqual(["alpha"])
    expect(result.descriptions).toHaveLength(3)
    for (const description of result.descriptions) {
      expect(description).toContain("<name>alpha</name>")
      expect(description).not.toContain("beta")
    }
    expect(JSON.stringify(result.requests[1].messages)).toContain(
      'Skill \\"beta\\" is not in the skill allowlist for this run. Allowed skills: alpha',
    )
  }, 20000)

  test("--skill with an empty name is rejected", async () => {
    const result = await run({ args: ["--skill", " "] })
    expect(result.exit).toBe(1)
    expect(result.output).toContain("--skill requires a skill name")
  }, 20000)

  test("--skill is rejected with --attach", async () => {
    const result = await run({ args: ["--skill", "alpha", "--attach", "http://127.0.0.1:9"] })
    expect(result.exit).toBe(1)
    expect(result.output).toContain("--skill is not supported with --attach")
  }, 20000)
})
