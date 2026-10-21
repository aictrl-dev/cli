import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"

import { BashEnvPolicy } from "../../src/util/bash-env-policy"

const canary = "FAKE_VALUE_CANARY_f810"
type Input = {
  name: string
  policy: readonly string[] | null
  hook?: string
  deny?: boolean
  cancel?: boolean
  timeout?: number
  command?: string
  residual?: boolean
  trace?: boolean
  parentPrototype?: boolean
  preAbort?: boolean
  repeat?: number
  shell?: string
  guardNegative?: "fetch" | "install"
}
async function run(input: Input) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-bash-env-tool-"))
  const bin = path.join(cwd, "bin")
  await fs.mkdir(bin)
  const ledger = path.join(cwd, "ledger.jsonl")
  await fs.writeFile(ledger, "")
  const network = path.join(cwd, "network.jsonl")
  await fs.writeFile(network, "")
  const helper = path.join(cwd, "child.ts")
  await fs.writeFile(
    helper,
    `import{appendFileSync}from"node:fs";appendFileSync(${JSON.stringify(ledger)},JSON.stringify({kind:"final"})+"\\n");console.log(JSON.stringify({env:process.env,cwd:process.cwd()}))`,
  )
  const realpath = path.join(cwd, "realpath.ts")
  await fs.writeFile(
    realpath,
    `import{appendFileSync}from"node:fs";appendFileSync(${JSON.stringify(ledger)},JSON.stringify({kind:"preflight",argv:process.argv.slice(2),env:process.env,cwd:process.cwd(),pid:process.pid})+"\\n");console.log(${JSON.stringify(path.join(cwd, "target"))})`,
  )
  await fs.writeFile(
    path.join(bin, "realpath"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(realpath)} "$@"\n`,
    { mode: 0o755 },
  )
  await fs.writeFile(path.join(cwd, "target"), "owned")
  await fs.writeFile(path.join(cwd, "path with spaces;literal"), "owned")
  const hook = path.join(cwd, "plugin.ts")
  await fs.writeFile(
    hook,
    `import{appendFileSync}from"node:fs";export default async()=>({"shell.env":async(_input,output)=>{appendFileSync(${JSON.stringify(ledger)},JSON.stringify({kind:"hook"})+"\\n");${input.hook ?? 'output.env={ALLOWED:"hook-override",HOOK_SECRET:"fake-hook-secret",HOOK_EMPTY:""}'}}})`,
  )
  await fs.writeFile(path.join(cwd, "aictrl.json"), JSON.stringify({ plugin: [hook] }))
  const command =
    input.command ?? `cat target >/dev/null; ${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`
  const data = path.join(cwd, "input.json")
  await fs.writeFile(data, JSON.stringify({ ...input, command }))
  const env = Object.assign(Object.create(null), {
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: path.join(cwd, "home"),
    AICTRL_TEST_HOME: path.join(cwd, "home"),
    SHELL: "/bin/bash",
    AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(cwd, "managed"),
    XDG_DATA_HOME: path.join(cwd, "data"),
    XDG_CONFIG_HOME: path.join(cwd, "config"),
    XDG_CACHE_HOME: path.join(cwd, "cache"),
    XDG_STATE_HOME: path.join(cwd, "state"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(cwd, "bun-cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
    TZ: "UTC",
    BASH_ENV_INPUT: data,
    BASH_ENV_LEDGER: ledger,
    BASH_ENV_NETWORK_LEDGER: network,
    GH_TOKEN: "fake-gh",
    CUSTOM_GATEWAY_KEY: "fake-model",
    ALLOWED: "parent-allowed",
    EMPTY: "",
    Path: "case-value",
    constructor: "fake-constructor",
    __proto__: "fake-prototype",
    "ProgramFiles(x86)": "fake-program",
  })
  Object.defineProperty(env, "__proto__", {
    value: "fake-prototype",
    enumerable: true,
    writable: true,
    configurable: true,
  })
  const args = [
    "run",
    "--no-install",
    "--no-env-file",
    "--preload",
    path.resolve(import.meta.dir, "../cli/fixture/bash-env-forwarding-guard.ts"),
    "--conditions=browser",
    path.join(import.meta.dir, "fixture/bash-env-case.ts"),
  ]
  const trace = path.join(cwd, "execve.log")
  if (input.shell) env.SHELL = input.shell
  const executable = input.trace ? "/usr/bin/strace" : input.parentPrototype ? "/usr/bin/env" : process.execPath
  const actualArgs = input.parentPrototype
    ? ["__proto__=fake-parent-prototype", process.execPath, ...args]
    : input.trace
      ? ["-f", "-v", "-s", "8192", "-e", "trace=execve", "-o", trace, process.execPath, ...args]
      : args
  const child = spawn(executable, actualArgs, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "",
    stderr = "",
    deadline = false
  child.stdout!.on("data", (v) => (stdout += v))
  child.stderr!.on("data", (v) => (stderr += v))
  const exists = () => {
    try {
      process.kill(-child.pid!, 0)
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return false
      throw e
    }
  }
  const timer = setTimeout(() => {
    deadline = true
    if (exists()) process.kill(-child.pid!, "SIGTERM")
  }, 15000)
  const escalation = setTimeout(() => {
    if (exists()) process.kill(-child.pid!, "SIGKILL")
  }, 15200)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  }).finally(() => {
    clearTimeout(timer)
    clearTimeout(escalation)
  })
  const effects = (await fs.readFile(ledger, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((v) => JSON.parse(v))
  const logs = []
  for (const name of await fs.readdir(path.join(cwd, "data/aictrl/log")).catch(() => []))
    logs.push(await fs.readFile(path.join(cwd, "data/aictrl/log", name), "utf8"))
  const attempts = (await fs.readFile(network, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((v) => JSON.parse(v))
  const result = {
    launch: { executable, args: actualArgs, env },
    trace: input.trace ? await fs.readFile(trace, "utf8") : undefined,
    attempts,
    input,
    cwd,
    command,
    code,
    deadline,
    groupGone: !exists(),
    stdout,
    stderr,
    effects,
    logs,
    data: stdout.trim() ? JSON.parse(stdout.trim().split("\n").at(-1)!) : null,
  }
  if (process.env.BASH_ENV_EVIDENCE) {
    await fs.mkdir(process.env.BASH_ENV_EVIDENCE, { recursive: true })
    await fs.writeFile(
      path.join(process.env.BASH_ENV_EVIDENCE, `${input.name}.json`),
      JSON.stringify(result, null, 2) + "\n",
    )
  }
  expect(attempts.filter((r) => !r.allowed)).toHaveLength(input.guardNegative ? 1 : 0)
  expect(deadline, JSON.stringify(result)).toBe(false)
  expect(code, stderr + stdout).toBe(0)
  expect(result.groupGone).toBe(true)
  return result
}
function child(r: Awaited<ReturnType<typeof run>>) {
  expect(r.data.outcome.error, JSON.stringify(r)).toBeUndefined()
  expect(r.data.outcome.result.metadata.exit).toBe(0)
  return JSON.parse(r.data.outcome.result.output.trim())
}
test("default direct host preserves parent and actual hook overrides", async () => {
  const r = await run({ name: "inherit", policy: null })
  const c = child(r)
  expect(c.env.GH_TOKEN).toBe("fake-gh")
  expect(c.env.CUSTOM_GATEWAY_KEY).toBe("fake-model")
  expect(c.env.ALLOWED).toBe("hook-override")
  expect(c.env.HOOK_SECRET).toBe("fake-hook-secret")
  expect(r.effects.find((e) => e.kind === "preflight").env.GH_TOKEN).toBe("fake-gh")
  expect(r.data.before).toEqual(r.data.after)
})
test("selected parent reaches preflight and final real hook override stays selected", async () => {
  const r = await run({ name: "selected", policy: ["PATH", "ALLOWED", "EMPTY", "MISSING", "HOOK_EMPTY"] })
  const c = child(r)
  expect(c.env.ALLOWED).toBe("hook-override")
  expect(c.env.EMPTY).toBe("")
  expect(c.env.HOOK_EMPTY).toBe("")
  expect(c.env).not.toHaveProperty("MISSING")
  for (const key of ["GH_TOKEN", "CUSTOM_GATEWAY_KEY", "HOOK_SECRET", "HOME"]) expect(c.env).not.toHaveProperty(key)
  const p = r.effects.find((e) => e.kind === "preflight")
  expect(p.env.ALLOWED).toBe("parent-allowed")
  expect(p.env).not.toHaveProperty("GH_TOKEN")
  expect(p.env).not.toHaveProperty("CUSTOM_GATEWAY_KEY")
  expect(r.effects.map((e) => e.kind)).toEqual(["preflight", "permission", "hook", "final"])
  expect(r.data.before).toEqual(r.data.after)
})
test("empty policy excludes all supplied parent and hook entries", async () => {
  const r = await run({ name: "empty", policy: [], trace: true })
  const c = child(r)
  for (const key of ["PATH", "HOME", "GH_TOKEN", "CUSTOM_GATEWAY_KEY", "ALLOWED", "EMPTY", "HOOK_SECRET"])
    expect(c.env).not.toHaveProperty(key)
  const line = r
    .trace!.split("\n")
    .find((v) => v.includes("execve(" + JSON.stringify(path.join(r.cwd, "bin/realpath"))) && v.includes('"target"'))
  expect(line).toBeDefined()
  for (const key of ["GH_TOKEN=", "CUSTOM_GATEWAY_KEY=", "ALLOWED=", "HOME=", "PATH="]) expect(line!).not.toContain(key)
})
test("literal preflight argument and cwd survive exact env selection", async () => {
  const r = await run({
    name: "literal",
    policy: ["PATH"],
    command: `cat 'path with spaces;literal' >/dev/null; printf 'done'`,
  })
  expect(r.data.outcome.result.output).toBe("done")
  expect(r.effects.find((e) => e.kind === "preflight").argv).toEqual(["'path with spaces;literal'"])
  expect(r.effects.find((e) => e.kind === "preflight").cwd).toBe(r.cwd)
})
for (const [name, hook] of [
  ["null-hook", "output.env=null"],
  ["array-hook", "output.env=[]"],
  ["number-hook", "output.env={ALLOWED:3}"],
  ["nul-hook", `output.env={ALLOWED:${JSON.stringify(canary + "\0")}}`],
  ["bad-key-hook", `output.env=JSON.parse(${JSON.stringify(JSON.stringify({ ["BAD=" + canary]: "fake" }))})`],
] as const)
  test(name + " rejects safely after preflight before final shell", async () => {
    const r = await run({ name, policy: ["PATH", "ALLOWED"], hook })
    expect(r.data.outcome.error.code).toBe("BASH_ENV_CONFIGURATION")
    expect(r.effects.map((e) => e.kind)).toEqual(["preflight", "permission", "hook"])
    expect(JSON.stringify(r.data.outcome.error) + r.stderr + r.logs.join("\n")).not.toContain(canary)
  })
test("permission denial prevents hook and final shell", async () => {
  const r = await run({ name: "permission-deny", policy: ["PATH"], deny: true })
  expect(r.data.outcome.error.message).toContain("prevents you from using this specific tool call")
  expect(r.effects.map((e) => e.kind)).toEqual(["preflight", "permission"])
})

for (const shape of ["plain", "null"] as const)
  test(shape + " prototype-looking selected keys reach native preflight and final env", async () => {
    const r = await run({
      name: "prototype-keys-" + shape,
      policy: ["PATH", "constructor", "__proto__"],
      parentPrototype: true,
      command: "cat target >/dev/null; /usr/bin/env -0",
      hook:
        shape === "plain"
          ? `output.env=JSON.parse('{"constructor":"hook-constructor","__proto__":"hook-prototype"}')`
          : `output.env=Object.assign(Object.create(null),JSON.parse('{"constructor":"hook-constructor","__proto__":"hook-prototype"}'))`,
    })
    expect(r.data.outcome.error).toBeUndefined()
    expect(r.data.outcome.result.output.split("\0")).toContain("__proto__=hook-prototype")
    expect(r.data.outcome.result.output.split("\0")).toContain("constructor=hook-constructor")
    expect(r.effects.find((e) => e.kind === "preflight").env.__proto__).toBe("fake-parent-prototype")
  })

test("unset policy keeps legacy numeric hook coercion", async () => {
  const r = await run({ name: "inherit-numeric-hook", policy: null, hook: "output.env={ALLOWED:42}" })
  expect(child(r).env.ALLOWED).toBe("42")
})
test("POSIX names remain literal case-sensitive", async () => {
  const r = await run({
    name: "posix-case",
    policy: ["PATH", "Path"],
    hook: 'output.env={PATH:process.env.PATH,Path:"hook-case",PATH_OTHER:"excluded"}',
  })
  const c = child(r)
  expect(c.env.Path).toBe("hook-case")
  expect(c.env.PATH).toContain(r.cwd)
  expect(c.env).not.toHaveProperty("PATH_OTHER")
})
test("selected child still reaches owned parent proc and credential file (not confinement)", async () => {
  const r = await run({ name: "residual", policy: [], residual: true })
  expect(child(r)).toEqual({ childGh: null, parentGh: "GH_TOKEN=fake-gh", credential: "fake-owned-file-credential" })
})
for (const kind of ["cancel", "timeout"] as const)
  test(kind + " reaps actual shell and grandchild", async () => {
    const r = await run({ name: kind, policy: [], ...(kind === "cancel" ? { cancel: true } : { timeout: 200 }) })
    expect(r.data.outcome.error).toBeUndefined()
    expect(r.data.outcome.result.output).toContain(kind === "cancel" ? "User aborted" : "exceeding timeout")
    expect(r.effects.filter((e) => e.kind === "lifecycle-start")).toHaveLength(1)
    expect(r.effects.filter((e) => e.kind === "lifecycle-reaped")).toHaveLength(1)
    const e = r.effects.find((e) => e.kind === "lifecycle-start")
    for (const pid of [e.pid, e.grandchild]) expect(() => process.kill(pid, 0)).toThrow()
  })

function policy(names: string[]) {
  return { mode: "allowlist" as const, names }
}
test("pure selector ignores inherited and missing parent entries; keeps empty values", () => {
  const parent = Object.assign(Object.create({ INHERITED: "fake-inherited" }), { EMPTY: "", ABSENT: undefined })
  const out = BashEnvPolicy.select(policy(["INHERITED", "EMPTY", "ABSENT", "MISSING"]), parent)
  expect(Object.getPrototypeOf(out)).toBeNull()
  expect(Object.entries(out)).toEqual([["EMPTY", ""]])
})
test("pure selector preserves own prototype-like keys", () => {
  const parent = JSON.parse('{"__proto__":"parent-proto","constructor":"parent-constructor"}')
  const hook = JSON.parse('{"__proto__":"hook-proto"}')
  const out = BashEnvPolicy.select(policy(["__proto__", "constructor"]), parent, hook)
  expect(Object.getPrototypeOf(out)).toBeNull()
  expect(Object.entries(out)).toEqual([
    ["__proto__", "hook-proto"],
    ["constructor", "parent-constructor"],
  ])
  expect(Object.hasOwn(out, "__proto__")).toBe(true)
})
test("pure Windows identity merges hook override deterministically without native claim", () => {
  const out = BashEnvPolicy.select(
    policy(["Path", "missing"]),
    { PATH: "parent-uppercase", Path: "parent-mixed" },
    { path: "hook-lower", PATH: "hook-uppercase" },
    "win32",
  )
  expect(Object.entries(out)).toEqual([["PATH", "hook-uppercase"]])
})
for (const [name, parent, hook] of [
  ["selected-parent-nul", { ALLOWED: canary + "\0" }, {}],
  ["excluded-hook-nul", {}, { EXCLUDED: canary + "\0" }],
  ["excluded-hook-number", {}, { EXCLUDED: 3 }],
  ["symbol-hook", {}, { [Symbol("fake")]: "fake" }],
] as const)
  test(name + " pure rejection is value-free", () => {
    let error: unknown
    try {
      BashEnvPolicy.select(policy(["ALLOWED"]), parent, hook)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(BashEnvPolicy.ConfigError)
    expect(String(error) + (error as Error).stack + JSON.stringify(error)).not.toContain(canary)
  })
for (const [name, hook] of [
  ["excluded-nul-hook", `output.env={EXCLUDED:${JSON.stringify(canary + "\0")}}`],
  ["excluded-number-hook", "output.env={EXCLUDED:3}"],
  ["non-record-hook", "output.env=new Date()"],
] as const)
  test(name + " fails after real preflight without widening", async () => {
    const r = await run({ name, policy: ["PATH"], hook })
    expect(r.data.outcome.error.code).toBe("BASH_ENV_CONFIGURATION")
    expect(r.effects.map((e) => e.kind)).toEqual(["preflight", "permission", "hook"])
    expect(JSON.stringify(r.data.outcome.error) + r.stderr + r.logs.join("\n")).not.toContain(canary)
  })

for (const policy of [null, []] as const)
  test((policy === null ? "inherit" : "exact") + " preserves stdout stderr and nonzero status", async () => {
    const r = await run({
      name: policy === null ? "inherit-exit7" : "exact-exit7",
      policy,
      command: "printf stdout; printf stderr >&2; exit 7",
    })
    expect(r.data.outcome.error).toBeUndefined()
    expect(r.data.outcome.result.metadata.exit).toBe(7)
    expect(r.data.outcome.result.output).toContain("stdout")
    expect(r.data.outcome.result.output).toContain("stderr")
  })
for (const policy of [null, []] as const)
  test((policy === null ? "inherit" : "exact") + " preserves shell launch errors", async () => {
    const r = await run({
      name: policy === null ? "inherit-launch-error" : "exact-launch-error",
      policy,
      shell: "/owned-does-not-exist/bash",
      command: "printf unreachable",
    })
    expect(r.data.outcome.error).toBeDefined()
    expect(r.data.outcome.error.message).toMatch(/ENOENT|No such file|not found|posix_spawn/i)
    expect(r.data.outcome.result).toBeUndefined()
  })

for (const action of ["fetch", "install"] as const)
  test("network guard rejects owned " + action + " negative control", async () => {
    const r = await run({ name: "guard-negative-" + action, policy: [], guardNegative: action })
    expect(r.data.guardBlocked).toBe(true)
    expect(r.attempts).toHaveLength(1)
    expect(r.attempts[0].allowed).toBe(false)
  })

for (const policy of [null, []] as const)
  test(
    (policy === null ? "inherit" : "exact") + " pre-aborted context settles without losing the exit event",
    async () => {
      const r = await run({
        name: policy === null ? "inherit-pre-aborted" : "exact-pre-aborted",
        policy,
        preAbort: true,
        command: "printf owned-preabort",
      })
      expect(r.data.outcome.error).toBeUndefined()
      expect(r.data.outcome.result.output).toContain("User aborted")
    },
  )
for (const policy of [null, []] as const)
  test(
    (policy === null ? "inherit" : "exact") + " rapid exits drain both output streams and retain status",
    async () => {
      const r = await run({
        name: policy === null ? "inherit-rapid-exit" : "exact-rapid-exit",
        policy,
        repeat: 20,
        command: "printf stdout; printf stderr >&2; exit 7",
      })
      expect(r.data.outcome.error).toBeUndefined()
      expect(r.data.outcome.results).toHaveLength(20)
      for (const result of r.data.outcome.results) {
        expect(result.metadata.exit).toBe(7)
        expect(result.output).toContain("stdout")
        expect(result.output).toContain("stderr")
      }
    },
  )

test("real hook failure stops before final shell without unfiltered fallback", async () => {
  const r = await run({ name: "hook-throws", policy: ["PATH"], hook: 'throw new Error("Owned hook failure")' })
  expect(r.data.outcome.error.message).toBe("Owned hook failure")
  expect(r.effects.map((e) => e.kind)).toEqual(["preflight", "permission", "hook"])
})
