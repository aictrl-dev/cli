import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

/**
 * Runs `aictrl run --format json` in a git worktree against a fixture Gemini server
 * whose first turn writes `out.txt` and whose second turn finishes. The run gets its
 * own home and XDG directories, so no outside config applies and the shadow snapshot
 * repo, if any, can be observed.
 */
async function run(config: Record<string, unknown> = {}) {
  await using tmp = await tmpdir({ git: true })
  // Outside the worktree, so a shadow repo never snapshots itself.
  await using home = await tmpdir()
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(): Response {
      calls++
      const parts =
        calls === 1
          ? [{ functionCall: { name: "write", args: { filePath: path.join(tmp.path, "out.txt"), content: "out\n" } } }]
          : [{ text: "Done." }]
      const chunk = {
        candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } })
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
      ...config,
    }),
  )
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--conditions=browser",
      entry,
      "run",
      "--format",
      "json",
      "--model",
      "fixture/gemini-fixture",
      "Write out.txt.",
    ],
    {
      cwd: tmp.path,
      env: {
        ...process.env,
        HOME: home.path,
        XDG_CONFIG_HOME: path.join(home.path, ".config"),
        XDG_DATA_HOME: path.join(home.path, ".local/share"),
        XDG_CACHE_HOME: path.join(home.path, ".cache"),
        AICTRL_TEST_HOME: home.path,
        AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
        AICTRL_DISABLE_MODELS_FETCH: "true",
        AICTRL_DISABLE_AUTOCOMPACT: "true",
      },
      stdin: "ignore",
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
    const events = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
    const shadow = await fs.readdir(path.join(home.path, ".local/share", "aictrl", "snapshot")).catch(() => [])
    return {
      exit,
      output: stderr + stdout,
      calls,
      events,
      shadow,
      written: await Bun.file(path.join(tmp.path, "out.txt")).exists(),
    }
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
    server.stop(true)
  }
}

describe("headless run snapshots (#146)", () => {
  test("a headless run creates no shadow snapshot repo and its step_finish events carry no snapshot", async () => {
    const result = await run()

    expect(result.exit, result.output).toBe(0)
    expect(result.calls).toBe(2)
    expect(result.written).toBe(true)
    expect(result.shadow).toEqual([])
    const steps = result.events.filter((event) => event.type === "step_finish")
    expect(steps, result.output).toHaveLength(2)
    expect(steps.map((event) => event.part.snapshot)).toEqual([undefined, undefined])
    expect(result.events.filter((event) => event.type === "session_complete")).toHaveLength(1)
  }, 20000)

  test("config `snapshot: true` snapshots every step of a headless run", async () => {
    const result = await run({ snapshot: true })

    expect(result.exit, result.output).toBe(0)
    expect(result.written).toBe(true)
    expect(result.shadow).toHaveLength(1)
    const steps = result.events.filter((event) => event.type === "step_finish")
    expect(steps, result.output).toHaveLength(2)
    for (const event of steps) expect(event.part.snapshot).toBeString()
  }, 20000)
})
