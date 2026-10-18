import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const preRemovalSession = path.resolve(import.meta.dir, "fixture/pre-lsp-removal-session.json")

type ModelPart = Record<string, unknown>

/**
 * A fixture Gemini server that answers the nth request with the nth turn (the last turn
 * repeats) and records every request body.
 */
function fixtureModel(turns: ModelPart[][]) {
  const requests: any[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      const parts = turns[Math.min(requests.length, turns.length) - 1]
      const chunk = {
        candidates: [{ index: 0, content: { role: "model", parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { server, requests }
}

/** A git repo with its own home and XDG directories, so no outside config or state applies. */
async function workspace() {
  const repo = await tmpdir({ git: true })
  const home = await tmpdir()
  const env = {
    ...process.env,
    HOME: home.path,
    XDG_CONFIG_HOME: path.join(home.path, ".config"),
    XDG_DATA_HOME: path.join(home.path, ".local/share"),
    XDG_CACHE_HOME: path.join(home.path, ".cache"),
    AICTRL_TEST_HOME: home.path,
    AICTRL_DISABLE_MODELS_FETCH: "true",
    AICTRL_DISABLE_AUTOCOMPACT: "true",
  }
  return { repo: repo.path, home: home.path, env, binDir: path.join(home.path, ".local/share", "aictrl", "bin") }
}

async function useFixtureModel(repo: string, port: number) {
  await Bun.write(
    path.join(repo, "aictrl.json"),
    JSON.stringify({
      provider: {
        fixture: {
          npm: "@ai-sdk/google",
          options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${port}` },
          models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
        },
      },
      agent: { title: { disable: true } },
    }),
  )
}

async function aictrl(args: string[], cwd: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn(["bun", "run", "--conditions=browser", entry, ...args], {
    cwd,
    env,
    stdin: "ignore",
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
    const events = stdout
      .split("\n")
      .filter((line) => line.startsWith('{"type":'))
      .map((line) => JSON.parse(line))
    return { exit, stdout, output: stderr + stdout, events }
  } finally {
    clearTimeout(timeout)
    proc.kill("SIGKILL")
  }
}

function isRipgrep(name: string) {
  return name === "rg" || name === "rg.exe" || name.startsWith("ripgrep-")
}

function declaredTools(request: any): string[] {
  return (request.tools ?? []).flatMap((tool: any) => tool.functionDeclarations ?? []).map((tool: any) => tool.name)
}

describe("headless run without the LSP subsystem (#144)", () => {
  test("write and edit on .ts and .py files return plain outputs and download no language servers", async () => {
    const ws = await workspace()
    const ts = path.join(ws.repo, "a.ts")
    const py = path.join(ws.repo, "b.py")
    // Both files are broken on purpose: a language server would have reported errors.
    const model = fixtureModel([
      [{ functionCall: { name: "write", args: { filePath: ts, content: "const n: number = 'x'\nexport {}\n" } } }],
      [{ functionCall: { name: "write", args: { filePath: py, content: "def f(:\n  return undefined_name\n" } } }],
      [{ functionCall: { name: "edit", args: { filePath: ts, oldString: "'x'", newString: "'y'" } } }],
      [{ functionCall: { name: "edit", args: { filePath: py, oldString: "undefined_name", newString: "other" } } }],
      [{ text: "Done." }],
    ])
    try {
      await useFixtureModel(ws.repo, model.server.port!)
      // The removed flag must not bring the `lsp` tool back.
      const env = { ...ws.env, AICTRL_EXPERIMENTAL_LSP_TOOL: "true" }

      const result = await aictrl(
        ["run", "--format", "json", "--model", "fixture/gemini-fixture", "Fix the files."],
        ws.repo,
        env,
      )

      expect(result.exit, result.output).toBe(0)
      const tools = result.events.filter((event) => event.type === "tool_use").map((event) => event.part)
      expect(tools.map((part) => [part.tool, part.state.status, part.state.output])).toEqual([
        ["write", "completed", "Wrote file successfully."],
        ["write", "completed", "Wrote file successfully."],
        ["edit", "completed", "Edit applied successfully."],
        ["edit", "completed", "Edit applied successfully."],
      ])
      for (const part of tools) expect(part.state.metadata).not.toHaveProperty("diagnostics")
      expect(result.stdout).not.toContain("<diagnostics")
      expect(declaredTools(model.requests[0])).not.toContain("lsp")
      // The bin dir is also where ripgrep lands on hosts without a system `rg`; anything else
      // there would be a downloaded language server.
      const installed = await fs.readdir(ws.binDir).catch(() => [])
      expect(installed.filter((name) => !isRipgrep(name))).toEqual([])
    } finally {
      model.server.stop(true)
    }
  }, 30000)

  test("an lsp rule in AICTRL_PERMISSION loads as a no-op with one deprecation warning", async () => {
    const ws = await workspace()
    const env = { ...ws.env, AICTRL_PERMISSION: JSON.stringify({ edit: "allow", lsp: "deny" }) }

    const result = await aictrl(["--print-logs", "--log-level", "WARN", "debug", "config"], ws.repo, env)

    expect(result.exit, result.output).toBe(0)
    const warnings = result.output.split("\n").filter((line) => line.includes("lsp config is deprecated"))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("path=AICTRL_PERMISSION")
  }, 30000)

  test("a session persisted with lsp tool parts and diagnostics metadata continues", async () => {
    const ws = await workspace()
    const model = fixtureModel([[{ text: "Continued." }]])
    try {
      await useFixtureModel(ws.repo, model.server.port!)
      await Bun.write(path.join(ws.repo, "a.ts"), "const n: number = 'y'\nexport {}\n")
      const projectID = (await $`git rev-list --max-parents=0 HEAD`.cwd(ws.repo).text()).trim()
      const fixture = (await Bun.file(preRemovalSession).text())
        .replaceAll("__DIRECTORY__", ws.repo)
        .replaceAll("__PROJECT_ID__", projectID)
      const sessionID = JSON.parse(fixture).info.id
      const exported = path.join(ws.home, "session.json")
      await Bun.write(exported, fixture)

      const imported = await aictrl(["import", exported], ws.repo, ws.env)
      expect(imported.exit, imported.output).toBe(0)
      expect(imported.stdout).toContain(`Imported session: ${sessionID}`)

      const result = await aictrl(
        ["run", "--continue", "--format", "json", "--model", "fixture/gemini-fixture", "Carry on."],
        ws.repo,
        ws.env,
      )

      expect(result.exit, result.output).toBe(0)
      expect(result.events.filter((event) => event.type === "session_complete")).toHaveLength(1)
      expect(new Set(result.events.map((event) => event.sessionID).filter(Boolean))).toEqual(new Set([sessionID]))
      expect(model.requests).toHaveLength(1)
      // The replayed history still carries the old lsp call and the diagnostics-bearing edit output.
      const history = JSON.stringify(model.requests[0].contents)
      expect(history).toContain('"name":"lsp"')
      expect(history).toContain("<diagnostics")
      expect(declaredTools(model.requests[0])).not.toContain("lsp")
    } finally {
      model.server.stop(true)
    }
  }, 30000)
})
