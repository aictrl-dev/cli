import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entries = {
  full: path.resolve(import.meta.dir, "../../src/index.ts"),
  headless: path.resolve(import.meta.dir, "../../src/headless.ts"),
}

/** Runs `aictrl run` against a fixture Gemini server and returns the tool names of the first request. */
async function requestedTools(entry: string, env: Record<string, string> = {}) {
  await using tmp = await tmpdir()
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
  const environment: Record<string, string | undefined> = {
    ...process.env,
    AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
    AICTRL_DISABLE_MODELS_FETCH: "true",
    AICTRL_DISABLE_AUTOCOMPACT: "true",
    ...env,
  }
  // Only the opt-in passed by the test counts, not one inherited from the test process.
  if (!("AICTRL_ENABLE_TODO_TOOL" in env)) delete environment.AICTRL_ENABLE_TODO_TOOL
  const proc = Bun.spawn(
    ["bun", "run", "--conditions=browser", entry, "run", "--model", "fixture/gemini-fixture", "Check this input."],
    { cwd: tmp.path, env: environment, stdout: "pipe", stderr: "pipe" },
  )
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 15000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exit, stderr + stdout).toBe(0)
    expect(requests.length, stderr + stdout).toBeGreaterThan(0)
    const declarations: { name: string }[] = (requests[0].tools ?? []).flatMap(
      (tool: any) => tool.functionDeclarations ?? [],
    )
    expect(declarations.length, JSON.stringify(requests[0])).toBeGreaterThan(0)
    return declarations.map((declaration) => declaration.name)
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
    server.stop(true)
  }
}

describe("headless run default tools (#155)", () => {
  test.each(Object.entries(entries))(
    "a %s-build run sends no todowrite or todoread tool",
    async (_, entry) => {
      const tools = await requestedTools(entry)
      expect(tools).toContain("bash")
      expect(tools).not.toContain("todowrite")
      expect(tools).not.toContain("todoread")
    },
    20000,
  )

  test(
    "AICTRL_ENABLE_TODO_TOOL=1 brings todowrite back",
    async () => {
      expect(await requestedTools(entries.full, { AICTRL_ENABLE_TODO_TOOL: "1" })).toContain("todowrite")
    },
    20000,
  )
})
