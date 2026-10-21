import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const guard = path.join(import.meta.dir, "fixture/bash-env-startup.ts")
const canary = "FAKE_POLICY_CANARY_b19f"
type Input = {
  name: string
  entry: "index" | "headless"
  args: string[]
  dotenv?: string
  legacy?: string
  locale?: string
  mode?: string
  deadlineMs?: number
}
async function probe(input: Input) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-bash-env-startup-"))
  await fs.writeFile(path.join(cwd, ".env"), input.dotenv ?? "")
  await fs.writeFile(path.join(cwd, "aictrl.json"), JSON.stringify({ plugin: ["./owned-plugin.ts"] }))
  await fs.writeFile(
    path.join(cwd, "owned-plugin.ts"),
    'import {appendFileSync} from "node:fs"; appendFileSync(process.env.BASH_ENV_TEST_LEDGER, JSON.stringify({kind:"owned-plugin-load"})+"\\n"); throw new Error("Owned plugin must not load")\n',
  )
  const ledger = path.join(cwd, "effects.jsonl")
  await fs.writeFile(ledger, "")
  const env: Record<string, string> = {
    PATH: [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter),
    HOME: path.join(cwd, "home"),
    AICTRL_TEST_HOME: path.join(cwd, "home"),
    AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(cwd, "managed"),
    XDG_DATA_HOME: path.join(cwd, "data"),
    XDG_CONFIG_HOME: path.join(cwd, "config"),
    XDG_CACHE_HOME: path.join(cwd, "cache"),
    XDG_STATE_HOME: path.join(cwd, "state"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(cwd, "bun-cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    TZ: "UTC",
    AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
    BASH_ENV_TEST_LEDGER: ledger,
    BASH_ENV_TEST_MODE: input.mode ?? "capture",
  }
  if (input.locale !== undefined) env.LC_ALL = input.locale
  if (input.legacy !== undefined) env.AICTRL_BASH_ENV_ALLOWLIST = input.legacy
  const command = [
    "run",
    "--no-install",
    "--preload",
    guard,
    "--conditions=browser",
    path.resolve(import.meta.dir, `../../src/${input.entry}.ts`),
    "run",
    ...input.args,
  ]
  const child = spawn(process.execPath, command, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = "",
    stderr = "",
    deadline = false
  child.stdout!.on("data", (value) => (stdout += value.toString()))
  child.stderr!.on("data", (value) => (stderr += value.toString()))
  child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") stderr += String(error)
  })
  // Keep selected stdin deliberately open: invalid policy must not await its EOF.
  const exists = () => {
    try {
      process.kill(-child.pid!, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw error
    }
  }
  const started = performance.now()
  const timer = setTimeout(() => {
    deadline = true
    if (exists()) process.kill(-child.pid!, "SIGTERM")
  }, input.deadlineMs ?? 12000)
  const escalation = setTimeout(
    () => {
      if (exists()) process.kill(-child.pid!, "SIGKILL")
    },
    (input.deadlineMs ?? 12000) + 500,
  )
  let code: number | null = null
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
  } finally {
    clearTimeout(timer)
    clearTimeout(escalation)
    child.stdin!.destroy()
    if (exists()) {
      process.kill(-child.pid!, "SIGKILL")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const effects = (await fs.readFile(ledger, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((value) => JSON.parse(value))
  const logs: string[] = []
  async function readLogs(dir: string) {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, item.name)
      if (item.isDirectory()) await readLogs(file)
      else if (item.name.endsWith(".log")) logs.push(await fs.readFile(file, "utf8"))
    }
  }
  await readLogs(path.join(cwd, "data"))
  const result = {
    input,
    command,
    cwd,
    code,
    deadline,
    durationMs: performance.now() - started,
    groupGone: !exists(),
    stdinEOF: false,
    stdout,
    stderr,
    logs,
    effects,
  }
  if (process.env.BASH_ENV_EVIDENCE) {
    await fs.mkdir(process.env.BASH_ENV_EVIDENCE, { recursive: true })
    await fs.writeFile(
      path.join(process.env.BASH_ENV_EVIDENCE, `${input.entry}-${input.name}.json`),
      JSON.stringify(result, null, 2) + "\n",
    )
  }
  expect(result.groupGone, JSON.stringify(result)).toBe(true)
  if (input.mode !== "deadline") expect(deadline, JSON.stringify(result)).toBe(false)
  return result
}
function handler(result: Awaited<ReturnType<typeof probe>>) {
  expect(result.code, result.stderr + result.stdout).toBe(0)
  expect(result.effects.filter((row) => row.kind === "handler")).toHaveLength(1)
  expect(
    result.effects.filter((row) =>
      [
        "config",
        "config-read",
        "project-config-access",
        "owned-plugin-load",
        "plugin",
        "provider",
        "stdin",
        "instance",
        "network",
        "child",
      ].includes(row.kind),
    ),
  ).toEqual([])
  return result.effects.find((row) => row.kind === "handler")!
}
function rejected(result: Awaited<ReturnType<typeof probe>>) {
  expect(result.code, result.stderr + result.stdout).toBe(2)
  expect(result.effects.filter((row) => row.kind !== "preload")).toEqual([])
  const output = [result.stdout, result.stderr, ...result.logs].join("\n")
  expect(output).toContain("BASH_ENV_CONFIGURATION")
  expect(output).not.toContain(canary)
  expect(output).not.toContain("SyntaxError")
}
for (const entry of ["index", "headless"] as const)
  describe(entry, () => {
    test("unset policy ignores a project dotenv policy-looking key", async () => {
      const r = await probe({
        name: "unset-dotenv",
        entry,
        args: ["task"],
        dotenv: 'AICTRL_BASH_ENV_ALLOWLIST=["PROJECT_WIDER"]\n',
      })
      expect(r.effects[0].legacy).toBe('["PROJECT_WIDER"]')
      expect(handler(r).policy).toEqual({ mode: "inherit" })
    })
    test("legacy caller policy-looking key has no authority", async () => {
      const r = await probe({ name: "unset-legacy", entry, args: ["task"], legacy: "[]" })
      expect(handler(r).policy).toEqual({ mode: "inherit" })
    })
    for (const value of ["[]", '["PATH","HOME"]'])
      test(`explicit ${value} defeats wider dotenv`, async () => {
        const r = await probe({
          name: value === "[]" ? "empty-list" : "selected-list",
          entry,
          args: ["--bash-env-allowlist", value, "task"],
          dotenv: 'AICTRL_BASH_ENV_ALLOWLIST=["PROJECT_WIDER"]\n',
        })
        const h = handler(r)
        expect(h.policy).toEqual({ mode: "allowlist", names: JSON.parse(value) })
        expect(h.frozen).toBe(true)
        expect(h.namesFrozen).toBe(true)
      })
    test("equals form owns exactly one JSON value", async () => {
      const r = await probe({ name: "equals", entry, args: ['--bash-env-allowlist=["PATH"]', "task"] })
      expect(handler(r).policy).toEqual({ mode: "allowlist", names: ["PATH"] })
    })
    for (const [name, args] of [
      ["explicit-empty", ["--bash-env-allowlist", ""]],
      ["malformed", ["--bash-env-allowlist", `{${canary}`]],
      ["wrong-object", ["--bash-env-allowlist", JSON.stringify({ [canary]: true })]],
      ["wrong-null", ["--bash-env-allowlist", "null"]],
      ["wrong-number", ["--bash-env-allowlist", "21"]],
      ["wrong-element", ["--bash-env-allowlist", `["${canary}",3]`]],
      ["equals-name", ["--bash-env-allowlist", `["BAD=${canary}"]`]],
      ["nul-name", ["--bash-env-allowlist", `["BAD\\u0000${canary}"]`]],
      ["wildcard-name", ["--bash-env-allowlist", `["*${canary}"]`]],
      ["repeated", ["--bash-env-allowlist", `["${canary}"]`, "--bash-env-allowlist", "[]"]],
      ["hybrid-repeated", ["--bash-env-allowlist", `["${canary}"]`, "--bashEnvAllowlist", "[]"]],
      ["missing", ["--bash-env-allowlist"]],
      ["missing-before-option", ["--bash-env-allowlist", "--format", "json"]],
    ] as [string, string[]][])
      test(name + " fails early with redacted classification", async () =>
        rejected(await probe({ name, entry, args: [...args, ...(name === "missing" ? [] : ["-"])] })),
      )
    for (const [name, attach] of [
      ["url", ["--attach", "http://127.0.0.1:9/" + canary]],
      ["empty", ["--attach="]],
    ] as [string, string[]][]) {
      for (const policy of ["[]", '["PATH"]'])
        test(`unsupported attach ${name} with ${policy}`, async () =>
          rejected(
            await probe({
              name: `attach-${name}-${policy === "[]" ? "empty" : "selected"}`,
              entry,
              args: ["--bash-env-allowlist", policy, ...attach, "-"],
            }),
          ))
    }
    test("localized missing policy value retains safe classification", async () => {
      rejected(await probe({ name: "french-missing", entry, locale: "fr_FR.UTF-8", args: ["--bash-env-allowlist"] }))
    })
    test("other yargs errors on explicit policy redact their input", async () => {
      rejected(
        await probe({
          name: "other-parser-canary",
          entry,
          args: ["--bash-env-allowlist", "[]", "--format", canary, "task"],
        }),
      )
    })
    test("earlier yargs errors also redact later explicit policy", async () => {
      rejected(
        await probe({
          name: "earlier-parser-canary",
          entry,
          args: ["--format", canary, "--bash-env-allowlist", "[]", "task"],
        }),
      )
    })
    test("required scalar owns policy-looking text", async () => {
      const r = await probe({ name: "scalar-ownership", entry, args: ["--title=--bash-env-allowlist", "task"] })
      const h = handler(r)
      expect(h.policy).toEqual({ mode: "inherit" })
      expect(h.parsed.title).toBe("--bash-env-allowlist")
    })
    test("post-marker policy-looking and numeric data stay data", async () => {
      const r = await probe({
        name: "marker-data",
        entry,
        args: ["--", "--bash-env-allowlist", "[]", "-21", "007", "-"],
      })
      const h = handler(r)
      expect(h.policy).toEqual({ mode: "inherit" })
      expect(h.parsed["--"]).toEqual(["--bash-env-allowlist", "[]", "-21", "007", "-"])
    })
    test("policy log summary excludes raw policy names", async () => {
      const r = await probe({
        name: "log-redaction",
        entry,
        args: ["--bash-env-allowlist", `["${canary}"]`, "--print-logs", "task"],
      })
      handler(r)
      expect([r.stdout, r.stderr, ...r.logs].join("\n")).not.toContain(canary)
      expect(r.stderr).toContain("aictrl")
      expect(handler(r).argv).toEqual(["run", ...r.input.args])
    })
    test("file log summary excludes raw policy names", async () => {
      const r = await probe({
        name: "file-log-redaction",
        entry,
        args: ["--bash-env-allowlist", `["${canary}"]`, "task"],
      })
      expect(handler(r).argv).toEqual(["run", ...r.input.args])
      expect(r.logs.length).toBeGreaterThan(0)
      expect([r.stdout, r.stderr, ...r.logs].join("\n")).not.toContain(canary)
      expect(r.logs.join("\n")).toContain("bashEnvPolicy")
    })
    test("real local handler reaches the instrumented plugin boundary", async () => {
      const r = await probe({
        name: "real-plugin-control",
        entry,
        mode: "real",
        args: ["--bash-env-allowlist", "[]", "task"],
      })
      expect(r.effects.filter((row) => row.kind === "handler")).toHaveLength(1)
      expect(r.effects.filter((row) => row.kind === "instance")).toHaveLength(1)
      expect(r.effects.filter((row) => row.kind === "plugin")).toHaveLength(1)
      expect(r.effects.filter((row) => ["provider", "network", "child"].includes(row.kind))).toEqual([])
    })
    test("unset policy preserves attach path into config preflight", async () => {
      const r = await probe({
        name: "real-config-control",
        entry,
        mode: "real",
        args: ["--attach", "http://127.0.0.1:9/owned", "task"],
      })
      expect(r.effects.filter((row) => row.kind === "handler")).toHaveLength(1)
      expect(r.effects.filter((row) => row.kind === "config-read")).toHaveLength(1)
      expect(r.effects.filter((row) => ["provider", "network", "child", "plugin"].includes(row.kind))).toEqual([])
    })
    test("real attach preflight reads only the owned project config before guarded receiver dispatch", async () => {
      const r = await probe({
        name: "real-config-access-control",
        entry,
        mode: "real-config",
        args: ["--attach", "http://127.0.0.1:9/owned", "task"],
      })
      expect(r.effects.filter((row) => row.kind === "project-config-access").length).toBeGreaterThan(0)
      expect(r.effects.filter((row) => row.kind === "config-read")).toHaveLength(1)
      expect(
        r.effects.filter((row) => ["provider", "child", "owned-plugin-load", "plugin"].includes(row.kind)),
      ).toEqual([])
    })
    test("actual valid handler observes selected stdin before its EOF", async () => {
      const r = await probe({
        name: "real-stdin-control",
        entry,
        mode: "real",
        args: ["--bash-env-allowlist", "[]", "-"],
      })
      expect(r.effects.filter((row) => row.kind === "handler")).toHaveLength(1)
      expect(r.effects.filter((row) => row.kind === "stdin")).toHaveLength(1)
      expect(
        r.effects.filter((row) => ["config", "plugin", "provider", "network", "child"].includes(row.kind)),
      ).toEqual([])
    })
  })
test("boundary instrumentation has positive controls", async () => {
  const r = await probe({ name: "boundary-controls", entry: "index", mode: "controls", args: ["task"] })
  expect(r.effects.filter((row) => row.kind === "control").map((row) => row.boundary)).toEqual([
    "config",
    "plugin",
    "provider",
    "stdin",
    "network",
  ])
})
test("owned deadline terminates and reaps a real grandchild", async () => {
  const r = await probe({ name: "deadline-control", entry: "index", mode: "deadline", deadlineMs: 500, args: ["task"] })
  expect(r.deadline).toBe(true)
  expect(r.effects.filter((row) => row.kind === "grandchild")).toHaveLength(1)
  expect(r.effects.filter((row) => row.kind === "grandchild-reaped")).toHaveLength(1)
})
