#!/usr/bin/env node
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const recipe = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const options = new Map()
for (let i = 0; i < args.length; i += 2) {
  assert(["--binary", "--evidence-dir", "--expected-sha256"].includes(args[i]), `Unknown option ${args[i]}`)
  assert(args[i + 1] && !options.has(args[i]), `Missing or duplicate option ${args[i]}`)
  options.set(args[i], args[i + 1])
}
const binary = options.get("--binary")
assert(binary && path.isAbsolute(binary), "Supply --binary with the absolute released native binary path")
assert(process.platform !== "win32", "This recipe requires POSIX process groups")
const evidence = options.get("--evidence-dir")
if (evidence) assert(path.isAbsolute(evidence), "--evidence-dir must be absolute")
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const marker = "CI_OWNED_FIXTURE_V1"
const callID = "owned-fixture-read-1"
const answer = "CI_FIXTURE_OK"
const groups = new Set()
const requests = []
const protocolErrors = []
const runs = []
const controller = new AbortController()
let root
let server
let overallTimer
let pendingFailure
const report = {
  recipe: marker,
  expectedVersion: "0.5.4",
  sourceCommit: "6c661f4cf3e3d555a0f290bc22e071c6de4bd19b",
  startedUTC: new Date().toISOString(),
  nodeVersion: process.version,
  binary,
  status: "running",
  runs,
  requests,
  protocolErrors,
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    throw error
  }
}
function abort(reason) {
  if (controller.signal.aborted) return
  controller.abort(new Error(reason))
  for (const pid of groups) signalGroup(pid, "SIGTERM")
}
const interrupted = (signal) => abort(`Runner received ${signal}`)
const onINT = () => interrupted("SIGINT")
const onTERM = () => interrupted("SIGTERM")
process.on("SIGINT", onINT)
process.on("SIGTERM", onTERM)

async function cleanupGroup(pid) {
  if (!signalGroup(pid, "SIGTERM")) return
  const until = Date.now() + 5000
  while (Date.now() < until) {
    if (!signalGroup(pid, 0)) return
    await pause(50)
  }
  signalGroup(pid, "SIGKILL")
  const killedUntil = Date.now() + 1000
  while (Date.now() < killedUntil) {
    if (!signalGroup(pid, 0)) return
    await pause(50)
  }
  throw new Error(`Process group ${pid} still exists after SIGKILL`)
}

async function run(label, argv, env, cwd) {
  controller.signal.throwIfAborted()
  const record = { label, argv, startedUTC: new Date().toISOString(), stdout: "", stderr: "" }
  runs.push(record)
  const child = spawn(binary, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  const pid = child.pid
  if (pid) groups.add(pid)
  let deadline = false
  let killTimer
  const term = () => {
    if (!pid) return
    signalGroup(pid, "SIGTERM")
    killTimer ??= setTimeout(() => signalGroup(pid, "SIGKILL"), 5000)
  }
  const timer = setTimeout(() => {
    deadline = true
    term()
  }, 30_000)
  controller.signal.addEventListener("abort", term, { once: true })
  const collect = (name, data) => {
    record[name] += data.toString("utf8")
    if (Buffer.byteLength(record[name]) > 2 * 1024 * 1024) {
      abort(`${label} ${name} exceeds the fixture's 2 MiB capture bound`)
    }
  }
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (data) => collect("stdout", data))
  child.stderr.on("data", (data) => collect("stderr", data))
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    Object.assign(record, result, { finishedUTC: new Date().toISOString(), deadline })
    if (deadline) throw new Error(`${label} exceeded its external 30-second deadline`)
    controller.signal.throwIfAborted()
    return record
  } finally {
    clearTimeout(timer)
    clearTimeout(killTimer)
    controller.signal.removeEventListener("abort", term)
    if (pid) {
      await cleanupGroup(pid)
      groups.delete(pid)
    }
  }
}

function events(run) {
  assert(run.stdout.trim(), `${run.label} emitted no stdout`)
  return run.stdout
    .trim()
    .split(/\r?\n/)
    .map((line, i) => {
      let value
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`${run.label} stdout line ${i + 1} is not JSON`)
      }
      assert.equal(value.schemaVersion, "1", `${run.label} event schema version`)
      return value
    })
}
function one(list, type) {
  const found = list.filter((event) => event.type === type)
  assert.equal(found.length, 1, `Expected exactly one ${type}`)
  return found[0]
}
function stream(response, call, text) {
  const base = { id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture" }
  const delta = call
    ? {
        tool_calls: [
          { index: 0, id: callID, type: "function", function: { name: "read", arguments: JSON.stringify(call) } },
        ],
      }
    : { content: text }
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    },
  ]
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  response.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n")
}

try {
  report.sourceHashes = {}
  for (const name of ["smoke.mjs", "fixture.txt", "README.md", "workflow.example.yml"])
    report.sourceHashes[name] = sha256(await readFile(path.join(recipe, name)))
  report.binarySha256 = sha256(await readFile(binary))
  if (options.has("--expected-sha256"))
    assert.equal(report.binarySha256, options.get("--expected-sha256"), "Native artifact SHA-256")
  const fixture = await readFile(path.join(recipe, "fixture.txt"), "utf8")
  assert.equal(fixture, "CI_FIXTURE_BYTES_20261021=owned-and-inert\n", "Owned fixture bytes")
  root = await mkdtemp(path.join(tmpdir(), "aictrl-owned-ci-"))
  const workspace = path.join(root, "workspace")
  const dirs = Object.fromEntries(
    ["home", "data", "config", "cache", "state"].map((name) => [name, path.join(root, name)]),
  )
  await Promise.all([workspace, ...Object.values(dirs)].map((dir) => mkdir(dir)))
  // v0.5.4 still discovers nested instruction files despite the config flag.
  for (let directory = workspace; ; directory = path.dirname(directory)) {
    for (const name of ["AGENTS.md", ".opencode/AGENTS.md"]) {
      const instruction = path.join(directory, name)
      const absent = await lstat(instruction).then(
        () => false,
        (error) => {
          if (error.code === "ENOENT") return true
          throw error
        },
      )
      assert(absent, `Unexpected ancestor instruction file: ${instruction}`)
    }
    if (directory === path.dirname(directory)) break
  }
  const file = path.join(workspace, "fixture.txt")
  await writeFile(file, fixture)
  await writeFile(path.join(workspace, "invalid.schema.json"), "[]\n")
  overallTimer = setTimeout(() => abort("Recipe exceeded its external 60-second deadline"), 60_000)
  server = createServer(async (request, response) => {
    const record = { method: request.method, path: request.url, atUTC: new Date().toISOString() }
    requests.push(record)
    try {
      assert.equal(request.method, "POST", "Only model POST requests are expected")
      assert.equal(request.url, "/v1/chat/completions", "Only the loopback chat endpoint is expected")
      let raw = ""
      for await (const part of request) {
        raw += part.toString("utf8")
        assert(Buffer.byteLength(raw) <= 2 * 1024 * 1024, "Request exceeds 2 MiB")
      }
      const body = JSON.parse(raw)
      record.body = body
      assert.equal(body.model, "fixture")
      assert.equal(body.stream, true)
      assert(Array.isArray(body.messages))
      assert(
        body.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(marker)),
        "Unexpected auxiliary/model request",
      )
      assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), ["read"], "Wire tool allowlist")
      if (requests.length === 1) {
        assert(!body.messages.some((message) => message.role === "tool"))
        record.response = "read"
        stream(response, { filePath: file })
        return
      }
      assert.equal(requests.length, 2, "Only two model turns are scripted")
      const result = body.messages.find((message) => message.role === "tool" && message.tool_call_id === callID)
      assert(result, "Second model request lacks the real read result")
      assert.equal(typeof result.content, "string")
      assert(result.content.includes(fixture.trimEnd()), "Fixture bytes missing from actual tool output")
      record.verifiedReadResult = true
      record.response = answer
      stream(response, undefined, answer)
    } catch (error) {
      record.error = error.message
      protocolErrors.push(error.message)
      console.error(`[fixture transport] ${error.message}`)
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: error.message, type: "fixture_protocol_error" } }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const config = {
    enabled_providers: ["fixture"],
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "fixture-not-a-credential", baseURL: `http://127.0.0.1:${server.address().port}/v1` },
        models: { fixture: { name: "fixture", tool_call: true, limit: { context: 32000, output: 1000 } } },
      },
    },
    permission: { "*": "deny", read: "allow" },
    skills: { allow: [] },
    agent: { build: { steps: 3 } },
  }
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: dirs.home,
    XDG_DATA_HOME: dirs.data,
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    AICTRL_CONFIG_CONTENT: JSON.stringify(config),
    AICTRL_DISABLE_PROJECT_CONFIG: "true",
    AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS: "5000",
    NO_COLOR: "1",
    TERM: "dumb",
  }
  report.childEnvKeys = Object.keys(env).sort()
  report.config = config
  const version = await run("version", ["--version"], env, workspace)
  assert.equal(version.code, 0)
  assert.equal(version.stdout.trim(), "0.5.4", "Released native version")
  assert.equal(requests.length, 0, "Version command must not call the model")
  const prompt = `${marker}: Read fixture.txt, then report the fixture result.`
  const positive = await run(
    "read-success",
    ["run", "--format", "json", "--model", "fixture/fixture", "--title", "Owned fixture CI smoke", prompt],
    env,
    workspace,
  )
  assert.equal(positive.code, 0, `Positive command failed: ${positive.stderr}`)
  assert.equal(positive.signal, null)
  assert.deepEqual(protocolErrors, [])
  assert.equal(requests.length, 2)
  assert.equal(requests[1].verifiedReadResult, true)
  const output = events(positive)
  one(output, "invocation_start")
  one(output, "session_start")
  assert.equal(one(output, "invocation_complete").status, "completed")
  assert.equal(one(output, "session_complete").error, null)
  assert(
    !output.some((event) => ["error", "session_error", "invocation_error", "permission_rejected"].includes(event.type)),
  )
  const read = one(output, "tool_use").part
  assert.equal(read.tool, "read")
  assert.equal(read.state.status, "completed")
  assert(read.state.output.includes(fixture.trimEnd()))
  assert.equal(
    output
      .filter((event) => event.type === "text")
      .map((event) => event.part.text)
      .join("\n")
      .trim(),
    answer,
  )
  const before = requests.length
  const negative = await run(
    "invalid-schema",
    ["run", "--format", "json", "--model", "fixture/fixture", "--output-schema", "invalid.schema.json", prompt],
    env,
    workspace,
  )
  assert.equal(negative.code, 2)
  assert.equal(negative.signal, null)
  const rejected = events(negative)
  assert.equal(one(rejected, "invocation_error").code, "OUTPUT_SCHEMA_CONFIG")
  assert.equal(one(rejected, "invocation_complete").status, "error")
  assert(!rejected.some((event) => event.type === "session_start"))
  assert.equal(requests.length, before, "Invalid schema must not issue any model request")
  report.assertions = {
    version: true,
    artifactHashRecorded: true,
    twoWireRequests: true,
    realReadResult: true,
    readOnlyWireCatalog: true,
    validNDJSON: true,
    successExitAndTerminalEvents: true,
    invalidSchemaExit2: true,
    invalidSchemaNoModelCalls: true,
  }
  report.status = "pass"
} catch (error) {
  pendingFailure = error
  report.status = "fail"
  report.error = { message: error.message, stack: error.stack }
} finally {
  clearTimeout(overallTimer)
  if (server?.listening) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  report.cleanupErrors = []
  for (const pid of groups) {
    try {
      await cleanupGroup(pid)
      groups.delete(pid)
    } catch (error) {
      pendingFailure ??= error
      report.status = "fail"
      report.cleanupErrors.push(error.message)
    }
  }
  let removed = !root
  try {
    if (root) await rm(root, { recursive: true, force: true })
    removed = true
  } catch (error) {
    pendingFailure ??= error
    report.status = "fail"
    report.cleanupErrors.push(error.message)
  }
  report.cleanup = { processGroupsRemaining: groups.size, temporaryRootRemoved: removed }
  process.removeListener("SIGINT", onINT)
  process.removeListener("SIGTERM", onTERM)
  report.finishedUTC = new Date().toISOString()
  if (evidence) {
    await mkdir(evidence, { recursive: true })
    await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n")
    for (const record of runs) {
      await writeFile(path.join(evidence, `${record.label}.stdout`), record.stdout)
      await writeFile(path.join(evidence, `${record.label}.stderr`), record.stderr)
    }
  }
  console.log(JSON.stringify(report, null, 2))
}
if (pendingFailure) {
  console.error(`[owned CLI smoke] ${pendingFailure.message}`)
  process.exitCode = 1
}
