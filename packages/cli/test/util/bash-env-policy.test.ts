import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BashEnvPolicy } from "../../src/util/bash-env-policy"

const canary = "FAKE_POLICY_CANARY_b19f"
test("unset defaults to frozen inheritance", () => {
  expect(BashEnvPolicy.current()).toEqual({ mode: "inherit" })
  expect(Object.isFrozen(BashEnvPolicy.current())).toBe(true)
  expect(BashEnvPolicy.parse(undefined)).toEqual({ mode: "inherit" })
})
test("empty list is an explicit frozen policy", () => {
  const value = BashEnvPolicy.parse("[]")
  expect(value).toEqual({ mode: "allowlist", names: [] })
  expect(Object.isFrozen(value)).toBe(true)
  if (value.mode !== "allowlist") throw new Error("Expected explicit policy")
  expect(Object.isFrozen(value.names)).toBe(true)
})
test("POSIX deduplicates exact identity without case folding", () => {
  expect(BashEnvPolicy.parse('["PATH","PATH","Path","ProgramFiles(x86)"]')).toEqual({
    mode: "allowlist",
    names: ["PATH", "Path", "ProgramFiles(x86)"],
  })
})
test("pure Windows identity comparison is case insensitive (not native launch proof)", () => {
  expect(BashEnvPolicy.parse('["Path","PATH","path","ProgramFiles(x86)"]', "win32")).toEqual({
    mode: "allowlist",
    names: ["Path", "ProgramFiles(x86)"],
  })
})
for (const [name, value] of [
  ["empty", ""],
  ["malformed", `{${canary}`],
  ["object", JSON.stringify({ [canary]: true })],
  ["null", "null"],
  ["scalar", JSON.stringify(canary)],
  ["number", "3"],
  ["boolean", "false"],
  ["array-value", ["PATH"]],
  ["empty-name", '[""]'],
  ["nul", `["BAD\\u0000${canary}"]`],
  ["equals", `["BAD=${canary}"]`],
  ["star", `["*${canary}"]`],
  ["question", '["A?B"]'],
  ["square", '["A[B]"]'],
  ["curly", '["A{B}"]'],
  ["wrong-element", `["${canary}",null]`],
] as [string, unknown][])
  test(name + " reports only safe classification", () => {
    let error: unknown
    try {
      BashEnvPolicy.parse(value)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(BashEnvPolicy.ConfigError)
    expect((error as BashEnvPolicy.ConfigError).code).toBe("BASH_ENV_CONFIGURATION")
    expect((error as Error).cause).toBeUndefined()
    expect([String(error), (error as Error).stack, JSON.stringify(error)].join("\n")).not.toContain(canary)
  })

async function isolated(name: string, script: string) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-bash-env-policy-"))
  const source = path.resolve(import.meta.dir, "../../src/util/bash-env-policy.ts")
  const file = path.join(cwd, "policy.ts")
  await fs.writeFile(file, `import { BashEnvPolicy as p } from ${JSON.stringify(source)}\n${script}\n`)
  const child = spawn(process.execPath, ["run", "--no-install", "--no-env-file", file], {
    cwd,
    env: { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", HOME: cwd, TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  child.stdout!.on("data", (value) => (stdout += value.toString()))
  child.stderr!.on("data", (value) => (stderr += value.toString()))
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  }).finally(() => clearTimeout(timer))
  const result = { name, code, stdout, stderr }
  if (process.env.BASH_ENV_EVIDENCE) {
    await fs.mkdir(process.env.BASH_ENV_EVIDENCE, { recursive: true })
    await fs.writeFile(
      path.join(process.env.BASH_ENV_EVIDENCE, `unit-${name}.json`),
      JSON.stringify(result, null, 2) + "\n",
    )
  }
  expect(code, stderr).toBe(0)
  return JSON.parse(stdout)
}
describe("isolated internal host initializer", () => {
  test("direct host default ignores the legacy environment key", async () => {
    expect(
      await isolated(
        "direct-default",
        'process.env.AICTRL_BASH_ENV_ALLOWLIST="[]"; console.log(JSON.stringify(p.current()))',
      ),
    ).toEqual({ mode: "inherit" })
  })
  test("write-once snapshot cannot be widened or mutated", async () => {
    const r = await isolated(
      "write-once",
      `const options = { "bash-env-allowlist": '["PATH"]' }; const first = p.initialize(options); options["bash-env-allowlist"]='["HOME"]'; process.env.AICTRL_BASH_ENV_ALLOWLIST='["HOME"]'; let code; try {p.initialize(options)} catch(e) {code=e.code}; console.log(JSON.stringify({first,current:p.current(),code,frozen:Object.isFrozen(first),namesFrozen:Object.isFrozen(first.names),same:p.initialize({"bash-env-allowlist":'["PATH"]'})===first}))`,
    )
    expect(r).toEqual({
      first: { mode: "allowlist", names: ["PATH"] },
      current: { mode: "allowlist", names: ["PATH"] },
      code: "BASH_ENV_CONFIGURATION",
      frozen: true,
      namesFrozen: true,
      same: true,
    })
  })
  test("default initialization cannot later acquire explicit authority", async () => {
    expect(
      await isolated(
        "default-write-once",
        `p.initialize({}); let code; try {p.initialize({"bash-env-allowlist":"[]"})}catch(e){code=e.code}; console.log(JSON.stringify({current:p.current(),code}))`,
      ),
    ).toEqual({ current: { mode: "inherit" }, code: "BASH_ENV_CONFIGURATION" })
  })
  for (const [name, options] of [
    ["undefined", '{"bash-env-allowlist":undefined}'],
    ["repeated", '{"bash-env-allowlist":["[]","[]"]}'],
    ["attach-empty", '{"bash-env-allowlist":"[]",attach:""}'],
    ["attach-undefined", '{"bash-env-allowlist":"[]",attach:undefined}'],
  ] as const)
    test(name + " rejects explicit invalid presence", async () => {
      expect(
        await isolated(
          name,
          `let code; try { p.initialize(${options}) } catch(e) { code=e.code }; console.log(JSON.stringify({code,current:p.current()}))`,
        ),
      ).toEqual({ code: "BASH_ENV_CONFIGURATION", current: { mode: "inherit" } })
    })
})
