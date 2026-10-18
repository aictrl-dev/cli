import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { tmpdir } from "../fixture/fixture"

/**
 * The full build compiles src/index.ts and the lite build compiles src/headless.ts.
 * The same `aictrl run` must send the same system prompt from either entry point (#152).
 */
const entries = {
  full: path.resolve(import.meta.dir, "../../src/index.ts"),
  lite: path.resolve(import.meta.dir, "../../src/headless.ts"),
}

type Request = { messages: { role: string; content?: unknown }[] }

/** Runs `aictrl run` from `entry` and returns the system messages of the first model request. */
async function firstSystemPrompt(entry: string, root: string) {
  const requests: Request[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push((await req.json()) as Request)
      const chunks = [
        { delta: { role: "assistant", content: "done" }, finish_reason: null },
        { delta: {}, finish_reason: "stop" },
      ].map(
        (choice) =>
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`,
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
  }
  const proc = Bun.spawn(
    ["bun", "run", "--conditions=browser", entry, "run", "--format", "json", "--model", "fixture/fixture", "Say done."],
    {
      cwd: path.join(root, "project"),
      env: {
        ...process.env,
        AICTRL_CONFIG_CONTENT: JSON.stringify(config),
        HOME: path.join(root, "home"),
        AICTRL_TEST_HOME: path.join(root, "home"),
        AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
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
    expect(exit, stderr + stdout).toBe(0)
    expect(requests.length, `no model request from ${entry}`).toBeGreaterThan(0)
    return requests[0].messages.filter((message) => message.role === "system")
  } finally {
    clearTimeout(timeout)
    server.stop(true)
  }
}

describe("aictrl run system prompt (#152)", () => {
  test("full and lite entry points send the same system prompt", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    await Bun.write(path.join(tmp.path, "config", "aictrl", "AGENTS.md"), "# Global aictrl instructions")
    await Bun.write(path.join(project, ".keep"), "")
    await $`git init`.cwd(project).quiet()

    const full = await firstSystemPrompt(entries.full, tmp.path)
    const lite = await firstSystemPrompt(entries.lite, tmp.path)

    expect(lite).toEqual(full)
    const prompt = JSON.stringify(full)
    expect(prompt).toContain(`Working directory: ${project}`)
    expect(prompt).toContain("# Global aictrl instructions")
  }, 40000)
})
