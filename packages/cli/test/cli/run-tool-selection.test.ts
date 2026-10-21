import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")
const full = ["bash", "edit", "glob", "grep", "read", "skill", "task", "webfetch", "write"]
type Request = {
  model?: string
  input?: unknown
  instructions?: string
  tools?: { function: { name: string; description?: string } }[]
  messages?: { role: string; content: unknown }[]
}
type Call = { name: string; arguments: Record<string, unknown> }
type Input = {
  label: string
  args?: string[]
  config?: Record<string, unknown>
  entry?: string
  noReply?: boolean
  model?: string
  runtime?: string
  codex?: boolean
  proxy?: boolean
  noMessage?: boolean
  deadlineMs?: number
  calls?: (Call | null | ((requests: Request[]) => Call))[]
  setup?: (directory: string) => Promise<Record<string, unknown> | void>
  markers?: string[]
  files?: string[]
}

// Static fixture code only. Model/config payload remains data, never generated code.
const guard = [
  'import { appendFileSync } from "node:fs"',
  "const original = globalThis.fetch",
  "const spawn = Bun.spawn.bind(Bun)",
  "const checked = (...args) => {",
  "  const command = Array.isArray(args[0]) ? args[0] : args[0]?.cmd",
  "  if (command && /(?:^|\\/)bun$/.test(String(command[0])) && ['add','install'].includes(command[1])) throw new Error('Fixture forbids dependency installation')",
  "  return spawn(...args)",
  "}",
  "Bun.spawn = checked",
  "globalThis.fetch = Object.assign(async (input, init) => {",
  "  const url = new URL(input instanceof Request ? input.url : String(input))",
  "  if (process.env.SELECTOR_FIXTURE_CODEX === 'true' && url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/codex/responses') {",
  '    appendFileSync(process.env.SELECTOR_FIXTURE_GUARD_LOG,JSON.stringify({origin:url.origin,path:url.pathname,allowed:true,intercepted:true})+"\\n")',
  '    appendFileSync(process.env.SELECTOR_FIXTURE_CODEX_LOG,JSON.stringify(JSON.parse(String(init?.body)))+"\\n")',
  "    const events=[{type:'response.created',response:{id:'resp-fixture',created_at:1,model:'gpt-5.2',service_tier:null}},{type:'response.output_item.added',output_index:0,item:{type:'message',id:'item-fixture'}},{type:'response.output_text.delta',item_id:'item-fixture',delta:'done',logprobs:null},{type:'response.output_item.done',output_index:0,item:{type:'message',id:'item-fixture'}},{type:'response.completed',response:{incomplete_details:null,usage:{input_tokens:1,input_tokens_details:null,output_tokens:1,output_tokens_details:null},service_tier:null}}]",
  "    return new Response(events.map(event=>'data: '+JSON.stringify(event)).concat('data: [DONE]').join('\\n\\n')+'\\n\\n',{headers:{'content-type':'text/event-stream'}})",
  "  }",
  "  const allowed = url.origin === process.env.SELECTOR_FIXTURE_ORIGIN",
  '  appendFileSync(process.env.SELECTOR_FIXTURE_GUARD_LOG, JSON.stringify({ origin: url.origin, path: url.pathname, allowed }) + "\\n")',
  '  if (!allowed) throw new Error("Selector fixture blocked nonlocal fetch: " + url.origin)',
  "  return original(input, init)",
  '}, { preconnect: () => { throw new Error("Selector fixture forbids preconnect") } })',
].join("\n")

async function run(input: Input) {
  const fixturePath = [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter)
  const ripgrep = Bun.which("rg", { PATH: fixturePath })
  if (!ripgrep)
    throw new Error(
      "Selector CLI fixtures require a real ripgrep executable on the child PATH. On Ubuntu install ripgrep, then verify rg --version; fixture network downloads are forbidden.",
    )
  await using tmp = await tmpdir()
  const requests: Request[] = []
  const calls = [...(input.calls ?? [])]
  let siblingCount = 0
  let releaseConcurrent: (() => void) | undefined
  const concurrentBarrier = new Promise<void>((resolve) => {
    releaseConcurrent = resolve
  })
  const extra = await input.setup?.(tmp.path)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      requests.push((await request.json()) as Request)
      if (input.runtime === "concurrent-sessions") {
        if (requests.length >= 2) releaseConcurrent?.()
        await concurrentBarrier
      }
      if (
        (input.runtime === "cancel-model" && requests.length === 1) ||
        (input.runtime === "overlap-child-resume" &&
          requests.at(-1)?.messages?.at(-1)?.role === "user" &&
          String(requests.at(-1)?.messages?.at(-1)?.content).includes("Held resumed child"))
      ) {
        await Bun.write(path.join(tmp.path, "phase-ready.json"), "true")
        const deadline = Date.now() + 5000
        while (!(await Bun.file(path.join(tmp.path, "phase-release.json")).exists())) {
          if (Date.now() > deadline) throw new Error("Model cancellation fixture barrier timeout")
          await Bun.sleep(5)
        }
      }
      if (input.runtime === "sibling-children") {
        const last = requests.at(-1)?.messages?.at(-1)
        if (last?.role === "user" && String(last.content).includes("Child sibling")) {
          siblingCount += 1
          if (siblingCount >= 2) releaseConcurrent?.()
          await concurrentBarrier
        }
      }
      const scripted = calls.shift()
      const call = typeof scripted === "function" ? scripted(requests) : scripted
      const chunks = [
        {
          id: "selector-fixture",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                ...(call
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${requests.length}`,
                          type: "function",
                          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                        },
                      ],
                    }
                  : { content: "Fixture complete" }),
              },
            },
          ],
        },
        {
          id: "selector-fixture",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
        },
      ]
      return new Response(
        chunks
          .map((chunk) => `data: ${JSON.stringify(chunk)}`)
          .concat("data: [DONE]")
          .join("\n\n") + "\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const cleanup: (() => unknown | Promise<unknown>)[] = [() => server.stop(true)]
  let primaryFailure: { error: unknown } | undefined
  try {
    const config = {
      enabled_providers: [input.codex ? "openai" : "fixture"],
      provider: {
        [input.codex ? "openai" : "fixture"]: {
          npm: input.codex ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
          options: {
            apiKey: "fixture",
            baseURL: `${server.url.origin}/v1`,
            ...(input.proxy ? { litellmProxy: true } : {}),
          },
          ...(input.codex
            ? {}
            : {
                models: Object.fromEntries(
                  ["fixture", "gpt-5"].map((id) => [
                    id,
                    { name: id, tool_call: true, limit: { context: 200000, output: 1000 } },
                  ]),
                ),
              }),
        },
      },
      agent: { title: { disable: true } },
      permission: { "*": "allow" },
      ...input.config,
      ...(extra ?? {}),
    }
    const home = path.join(tmp.path, "home")
    const preload = path.join(tmp.path, "network-guard.ts")
    const ledger = path.join(tmp.path, "network.jsonl")
    await fs.mkdir(home)
    await Bun.write(preload, guard)
    await Bun.write(ledger, "")
    const codexLog = path.join(tmp.path, "codex-captures.jsonl")
    await Bun.write(codexLog, "")
    if (input.codex)
      await Bun.write(
        path.join(tmp.path, "data/aictrl/auth.json"),
        JSON.stringify({
          openai: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 60000 },
        }),
      )
    const selected = input.entry ?? entry
    const program = path.join(tmp.path, "record-only.ts")
    if (input.noReply)
      await Bun.write(
        program,
        [
          "const root = process.env.SELECTOR_RUNTIME_ROOT",
          'const [{ Instance }, { Session }, { SessionPrompt }] = await Promise.all([import(root + "/project/instance.ts"), import(root + "/session/index.ts"), import(root + "/session/prompt.ts")])',
          "try { await Instance.provide({ directory: process.cwd(), fn: async () => {",
          '  const session = await Session.create({ title: "Record unavailable model" })',
          '  const message = await SessionPrompt.prompt({ sessionID: session.id, noReply: true, model: { providerID: "fixture", modelID: "unavailable-model" }, parts: [{ type: "text", text: "Record only; do not run a model." }] })',
          "  console.log(JSON.stringify({ role: message.info.role, model: message.info.model, saved: (await Session.messages({ sessionID: session.id })).length }))",
          "} }) } catch (error) { console.error(String(error)); process.exitCode = 1 }",
          "await Instance.disposeAll()",
        ].join("\n"),
      )
    const command = [
      process.execPath,
      "run",
      "--preload",
      preload,
      "--conditions=browser",
      ...(input.runtime
        ? [path.resolve(import.meta.dir, "../fixture/tool-selection-runtime.ts")]
        : input.noReply
          ? [program]
          : [
              selected,
              "run",
              "--format",
              "json",
              "--model",
              input.codex ? "openai/gpt-5.2" : "fixture/" + (input.model ?? "fixture"),
              ...(input.args ?? []),
              ...(input.noMessage ? [] : ["Say fixture complete without tools."]),
            ]),
    ]
    const process_ = Bun.spawn(command, {
      cwd: tmp.path,
      env: {
        PATH: fixturePath,
        SHELL: "/bin/bash",
        HOME: home,
        AICTRL_TEST_HOME: home,
        AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
        XDG_DATA_HOME: path.join(tmp.path, "data"),
        XDG_CONFIG_HOME: path.join(tmp.path, "config"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        AICTRL_CONFIG_CONTENT: JSON.stringify(config),
        AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
        AICTRL_DISABLE_AUTOCOMPACT: "true",
        AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS: "5000",
        SELECTOR_FIXTURE_ORIGIN: server.url.origin,
        SELECTOR_FIXTURE_GUARD_LOG: ledger,
        SELECTOR_FIXTURE_ZOD: import.meta.resolve("zod"),
        SELECTOR_RUNTIME_ROOT: path.dirname(selected),
        SELECTOR_RUNTIME_MODE: input.runtime ?? "",
        SELECTOR_RUNTIME_PRELOAD: preload,
        SELECTOR_FIXTURE_CODEX: String(!!input.codex),
        SELECTOR_FIXTURE_CODEX_LOG: codexLog,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    const deadlineMs = input.deadlineMs ?? 15000
    let deadlineFired = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const output = { stdout: "", stderr: "" }
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
    async function read(reader: (typeof readers)[number], name: keyof typeof output) {
      const decoder = new TextDecoder()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        output[name] += decoder.decode(chunk.value, { stream: true })
      }
      output[name] += decoder.decode()
      return output[name]
    }
    function signalGroup(signal: NodeJS.Signals | 0) {
      try {
        process.kill(-process_.pid, signal)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
        throw error
      }
    }
    async function waitGroupGone(milliseconds: number) {
      const until = Date.now() + milliseconds
      while (signalGroup(0)) {
        if (Date.now() >= until) return false
        await Bun.sleep(10)
      }
      return true
    }
    let stopping: Promise<void> | undefined
    function stopGroup() {
      return (stopping ??= (async () => {
        const errors: unknown[] = []
        let gone = false
        try {
          gone = !signalGroup("SIGTERM") || (await waitGroupGone(200))
        } catch (error) {
          errors.push(error)
        }
        if (!gone) {
          try {
            signalGroup("SIGKILL")
          } catch (error) {
            errors.push(error)
          }
          try {
            if (!(await waitGroupGone(2000))) throw new Error("Owned selector process group remains after SIGKILL")
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) throw new AggregateError(errors, "Owned selector group termination failed")
      })())
    }
    async function bounded<T>(task: Promise<T>, milliseconds: number, message: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          task,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), milliseconds)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    const drains: Promise<string>[] = []
    cleanup.push(async () => {
      clearTimeout(timeout)
      const errors: unknown[] = []
      for (const operation of [
        () => stopGroup(),
        () => bounded(process_.exited, 1000, "Owned selector child was not reaped after termination"),
        ...readers.map((reader) => () => bounded(reader.cancel(), 500, "Owned selector pipe cancellation timed out")),
        () => bounded(Promise.allSettled(drains), 500, "Owned selector output did not settle after cancellation"),
      ]) {
        try {
          await operation()
        } catch (error) {
          errors.push(error)
        }
      }
      for (const reader of readers) {
        try {
          reader.releaseLock()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, "Owned selector process cleanup failed")
    })
    readers.push(process_.stdout.getReader())
    readers.push(process_.stderr.getReader())
    drains.push(read(readers[0], "stdout"), read(readers[1], "stderr"))
    const exited = process_.exited.then(async (exit) => {
      if (signalGroup(0)) {
        try {
          await stopGroup()
        } catch (error) {
          if (!deadlineFired) throw error
        }
        if (!deadlineFired) throw new Error("Owned selector descendants outlived the fixture child")
      }
      return exit
    })
    const deadlineFailure = () =>
      new Error(
        `${input.label}: child deadline exceeded after ${deadlineMs}ms; providerRequests=${requests.length}; stdout=${output.stdout.slice(-2000)}; stderr=${output.stderr.slice(-2000)}`,
      )
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        deadlineFired = true
        // The deadline also interrupts collection when descendants retain the pipes.
        void stopGroup().then(
          () => reject(deadlineFailure()),
          () => reject(deadlineFailure()),
        )
      }, deadlineMs)
    })
    const [stdout, stderr, exit] = await Promise.race([Promise.all([drains[0], drains[1], exited]), deadline])
    clearTimeout(timeout)
    const network = (await Bun.file(ledger).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { origin: string; path: string; allowed: boolean })
    if (input.codex)
      requests.push(
        ...(await Bun.file(codexLog).text())
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Request),
      )
    const markers: Record<string, unknown> = {}
    for (const name of input.markers ?? []) {
      const file = Bun.file(path.join(tmp.path, name))
      markers[name] = (await file.exists()) ? await file.json() : null
    }
    const files: Record<string, string | null> = {}
    for (const name of input.files ?? []) {
      const file = Bun.file(path.join(tmp.path, name))
      files[name] = (await file.exists()) ? await file.text() : null
    }
    const result = {
      ripgrep,
      deadlineFired,
      deadlineMs,
      files,
      label: input.label,
      args: input.args ?? [],
      config,
      command,
      exit,
      stdout,
      stderr,
      requests,
      network,
      markers,
    }
    if (process.env.SELECTOR_CAPTURE_DIR)
      await Bun.write(
        path.join(process.env.SELECTOR_CAPTURE_DIR, input.label + ".json"),
        JSON.stringify(result, null, 2),
      )
    if (deadlineFired)
      throw new Error(
        `${input.label}: child deadline exceeded after ${deadlineMs}ms; providerRequests=${requests.length}; exit=${exit}; stdout=${stdout.slice(-2000)}; stderr=${stderr.slice(-2000)}`,
      )
    expect(network.filter((request) => !request.allowed)).toEqual([])
    return result
  } catch (error) {
    primaryFailure = { error }
    throw error
  } finally {
    const errors: unknown[] = []
    for (const dispose of cleanup.reverse()) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) {
      throw new AggregateError(
        [...(primaryFailure ? [primaryFailure.error] : []), ...errors],
        primaryFailure
          ? `${input.label}: ${String(primaryFailure.error)}; fixture cleanup also failed`
          : `${input.label}: fixture cleanup failed`,
        primaryFailure ? { cause: primaryFailure.error } : undefined,
      )
    }
  }
}

function names(request: Request) {
  return (request.tools ?? []).map((tool) => tool.function.name).sort()
}

const cases = [
  { label: "no-selector", expected: full },
  { label: "explicit-read", args: ["--tools", "read"], expected: ["read"] },
  { label: "config-read", config: { tool_allowlist: ["read"] }, expected: ["read"] },
  { label: "explicit-empty", args: ["--tools", ""], expected: [] },
  { label: "config-empty", config: { tool_allowlist: [] }, expected: [] },
  {
    label: "cli-replaces-config",
    args: ["--tools", "read"],
    config: { tool_allowlist: ["bash", "write"] },
    expected: ["read"],
  },
]

describe("per-run work-tool selection through actual CLI (#246)", () => {
  for (const item of cases) {
    test(
      item.label,
      async () => {
        const result = await run(item)
        expect(result.exit, result.stderr + result.stdout).toBe(0)
        expect(result.requests).toHaveLength(1)
        expect(names(result.requests[0])).toEqual(item.expected)
        expect(JSON.stringify(result.requests[0].messages)).toContain("Say fixture complete without tools.")
      },
      20000,
    )
  }
})

const baseline = process.env.SELECTOR_BASELINE_ENTRY ?? entry
const collision = [
  'import { writeFile } from "node:fs/promises"',
  'export default { description: "Ordinary custom work tool", args: {}, execute: async () => { await writeFile(new URL("../../work-marker.json", import.meta.url), JSON.stringify({ executed: true })); return "Custom work executed" } }',
].join("\n")
const custom = [
  'import { writeFile } from "node:fs/promises"',
  "const { default: z } = await import(process.env.SELECTOR_FIXTURE_ZOD)",
  'export default { description: "Raw custom schema fixture", args: { text: z.string().trim(), tag: z.string().default("default-tag") }, execute: async (args) => { await writeFile(new URL("../../custom-marker.json", import.meta.url), JSON.stringify(args)); return "Custom executed" } }',
].join("\n")
const hooks = [
  'import { writeFile } from "node:fs/promises"',
  'export default async () => ({ "tool.execute.before": async (input, output) => { if (input.tool === "strict") await writeFile(new URL("./hook-marker.json", import.meta.url), JSON.stringify(output.args)) } })',
].join("\n")

const publicDelegate = `import { tool, type ToolContext } from "@aictrl/plugin/tool"
import { writeFile } from "node:fs/promises"
export default tool({
  description: "Dispatch through the public checked selection facade",
  args: { name: tool.schema.string(), payload: tool.schema.unknown().optional(), spoof: tool.schema.boolean().optional(), waitRunning:tool.schema.boolean().optional() },
  async execute(args, context: ToolContext) {
    const selection = context.selection
    if (!selection) throw new Error("Expected request-local selection facade")
    await writeFile(new URL("../../caller-marker.json",import.meta.url),JSON.stringify({sessionID:context.sessionID,messageID:context.messageID,agent:context.agent,directory:context.directory,worktree:context.worktree,abortPresent:context.abort instanceof AbortSignal,abortInitially:context.abort.aborted}))
    await writeFile(new URL("../../facade-marker.json",import.meta.url),JSON.stringify({names:[...selection.names].sort(),restricted:selection.restricted,frozen:Object.isFrozen(selection),namesFrozen:Object.isFrozen(selection.names),executeArity:selection.execute.length,assertArity:selection.assert.length}))
    if(args.waitRunning) {
      const deadline=Date.now()+2000
      while(!await Bun.file(new URL("../../delegate-running.json",import.meta.url)).exists()){if(Date.now()>deadline)throw new Error("Actual delegate never entered running state");await Bun.sleep(5)}
    }
    await context.metadata({title:"Public delegate running",metadata:{facade:true}})
    selection.assert(args.name)
    const result = args.spoof ? await Reflect.apply(selection.execute,undefined,[args.name,args.payload ?? {},{sessionID:"spoofed",messageID:"spoofed",abort:new AbortController().signal}]) : await selection.execute(args.name,args.payload ?? {})
    await writeFile(new URL("../../delegate-marker.json",import.meta.url),JSON.stringify({title:result.title,output:result.output,metadata:result.metadata}))
    return result.output
  }
})`
const publicLeaf = `import { tool, type ToolContext } from "@aictrl/plugin/tool"
import { writeFile } from "node:fs/promises"
export default tool({
  description: "Public plugin work with parsed arguments",
  args: {text:tool.schema.string().trim(),tag:tool.schema.string().default("public-default")},
  async execute(args, context: ToolContext) {
    await context.ask({permission:"public_leaf",patterns:["fixture"],always:["fixture"],metadata:{}})
    await writeFile(new URL("../../leaf-marker.json",import.meta.url),JSON.stringify(args))
    return "Public leaf complete"
  }
})`
const publicAbortLeaf = `import { tool, type ToolContext } from "@aictrl/plugin/tool"
import { writeFile } from "node:fs/promises"
export default tool({description:"Wait until the bound caller signal aborts",args:{},async execute(args,context:ToolContext){
  await context.metadata({title:"Public leaf waiting",metadata:{abortLeaf:true}})
  await writeFile(new URL("../../abort-ready.json",import.meta.url),JSON.stringify({sessionID:context.sessionID,messageID:context.messageID,agent:context.agent,directory:context.directory,worktree:context.worktree,abortPresent:context.abort instanceof AbortSignal,abortInitially:context.abort.aborted}))
  return await new Promise(resolve=>{
    const stop=()=>{void(async()=>{await writeFile(new URL("../../abort-observed.json",import.meta.url),JSON.stringify({aborted:context.abort.aborted}));resolve("Bound caller aborted")})()}
    if(context.abort.aborted)stop();else context.abort.addEventListener("abort",stop,{once:true})
  })
}})`
const metadataProbe = `import {tool,type ToolContext} from "@aictrl/plugin/tool"
export default tool({description:"Probe actual metadata registration timing",args:{},async execute(args,context:ToolContext){
  await context.metadata({title:"Immediate metadata probe",metadata:{immediateProbe:true}})
  const deadline=Date.now()+2000
  while(!await Bun.file(new URL("../../probe-running.json",import.meta.url)).exists()){if(Date.now()>deadline)throw new Error("Probe never entered real running state");await Bun.sleep(5)}
  await context.metadata({title:"Ready metadata probe",metadata:{readyProbe:true}})
  return "Metadata probe complete"
}})`
async function setupPublicFacade(directory: string) {
  const modules = path.join(directory, "node_modules/@aictrl")
  await fs.mkdir(modules, { recursive: true })
  await fs.symlink(path.resolve(import.meta.dir, "../../../plugin"), path.join(modules, "plugin"), "dir")
  await Bun.write(path.join(directory, ".aictrl/tool/delegate.ts"), publicDelegate)
  await Bun.write(path.join(directory, ".aictrl/tool/leaf.ts"), publicLeaf)
}

const mcpFixture = `import {createInterface} from "node:readline"
import {writeFile} from "node:fs/promises"
for await (const line of createInterface({input:process.stdin})) {
  const request=JSON.parse(line)
  if (request.id === undefined) continue
  let result={}
  if (request.method === "initialize") result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"selector-fixture",version:"1"}}
  if (request.method === "tools/list") result={tools:[{name:"echo",description:"Original MCP Task Grep Read body preserved",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}}]}
  if (request.method === "tools/call") {
    await writeFile(new URL("./mcp-marker.json",import.meta.url),JSON.stringify(request.params))
    result={content:[{type:"text",text:"MCP fixture result: "+request.params.arguments.text}]}
  }
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n")
}`
async function setupMCP(directory: string) {
  const file = path.join(directory, "mcp.ts")
  await Bun.write(file, mcpFixture)
  return { mcp: { fixture: { type: "local", command: [process.execPath, file], enabled: true } } }
}
const groupHooks = `import {writeFile} from "node:fs/promises"
export default async()=>({"tool.execute.before":async(input)=>{await writeFile(new URL("./group-hook-"+input.tool+".json",import.meta.url),JSON.stringify({tool:input.tool}))}})`

const childTask: Call = {
  name: "task",
  arguments: { description: "Fixture child", prompt: "Child fixture harmless response", subagent_type: "explore" },
}
describe("immutable snapshots through actual session lifecycles (#246)", () => {
  for (const configured of [false, true])
    test(`loop freezes saved selector and fresh omission ${configured ? "resolves config" : "restores unrestricted default"}`, async () => {
      const result = await run({
        label: configured ? "snapshot-reset-config" : "snapshot-reset-default",
        runtime: "snapshot-reset",
        config: configured ? { tool_allowlist: ["bash"] } : {},
        markers: ["runtime-report.json"],
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(result.requests.map(names)).toEqual([
        ["read"],
        configured ? ["bash"] : full,
        [],
        configured ? ["bash"] : full,
      ])
      expect(result.markers["runtime-report.json"]).toMatchObject({
        users: [
          { toolSelection: { version: 1, allowlist: ["read"] } },
          { toolSelection: { version: 1, allowlist: configured ? ["bash"] : null } },
          { toolSelection: { version: 1, allowlist: [] } },
          { toolSelection: { version: 1, allowlist: configured ? ["bash"] : null } },
        ],
      })
    }, 20000)
  test("historical wire User without metadata resumes unrestricted and new prompt resolves config", async () => {
    const result = await run({
      label: "snapshot-historical-missing",
      runtime: "historical-missing",
      config: { tool_allowlist: ["read"] },
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests.map(names)).toEqual([full, ["read"]])
    const report = result.markers["runtime-report.json"] as { users: unknown[] }
    expect(report.users[0]).not.toHaveProperty("toolSelection")
    expect(report.users[1]).toMatchObject({ toolSelection: { version: 1, allowlist: ["read"] } })
  }, 20000)
  test("actual fork copies frozen snapshot but fresh fork prompt resolves current config", async () => {
    const result = await run({
      label: "snapshot-fork",
      runtime: "fork-snapshot",
      config: { tool_allowlist: ["bash"] },
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests.map(names)).toEqual([["read"], ["bash"]])
    expect(result.markers["runtime-report.json"]).toMatchObject({
      original: [{ toolSelection: { version: 1, allowlist: ["read"] } }],
      forked: [
        { toolSelection: { version: 1, allowlist: ["read"] } },
        { toolSelection: { version: 1, allowlist: ["bash"] } },
      ],
    })
  }, 20000)
  test("actual CLI export and import preserve selector before resumed inference", async () => {
    const result = await run({
      label: "snapshot-export-import",
      runtime: "export-import",
      config: { tool_allowlist: ["bash"] },
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests.map(names)).toEqual([["read"]])
    expect(result.markers["runtime-report.json"]).toMatchObject({
      exported: [{ toolSelection: { version: 1, allowlist: ["read"] } }],
      users: [{ toolSelection: { version: 1, allowlist: ["read"] } }],
      imported: expect.stringContaining("Imported session:"),
    })
  }, 20000)
  test("real compaction summary and automatic continuation both copy the saved snapshot", async () => {
    const result = await run({
      label: "snapshot-compaction",
      runtime: "compaction-snapshot",
      config: { tool_allowlist: ["bash"] },
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests.map(names)).toEqual([[], ["read"]])
    expect(result.markers["runtime-report.json"]).toMatchObject({
      users: [
        { toolSelection: { version: 1, allowlist: ["read"] } },
        { toolSelection: { version: 1, allowlist: ["read"] } },
        { toolSelection: { version: 1, allowlist: ["read"] } },
      ],
      parts: [{ type: "compaction", auto: true }],
    })
  }, 20000)
  test("real command Task summary continuation copies its invocation snapshot", async () => {
    const result = await run({
      label: "snapshot-command",
      runtime: "command-snapshot",
      config: { command: { inspect: { template: "Inspect harmless fixture.", agent: "explore", subtask: true } } },
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests.map(names)).toEqual([["read"], ["read", "task"]])
    expect(result.markers["runtime-report.json"]).toMatchObject({
      users: [
        { toolSelection: { version: 1, allowlist: ["task", "read"] } },
        { toolSelection: { version: 1, allowlist: ["task", "read"] } },
      ],
      parts: expect.arrayContaining([
        expect.objectContaining({
          text: "Summarize the task tool output above and continue with your task.",
          synthetic: true,
        }),
      ]),
    })
  }, 20000)
  test("concurrent sessions retain separate selections while both provider requests are held", async () => {
    const result = await run({
      label: "snapshot-concurrent",
      runtime: "concurrent-sessions",
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests).toHaveLength(2)
    for (const request of result.requests)
      expect(names(request)).toEqual(
        JSON.stringify(request.messages).includes("Concurrent read invocation") ? ["read"] : ["bash"],
      )
    expect(result.markers["runtime-report.json"]).toMatchObject({
      first: { users: [{ toolSelection: { version: 1, allowlist: ["read"] } }] },
      second: { users: [{ toolSelection: { version: 1, allowlist: ["bash"] } }] },
    })
  }, 20000)
})
describe("actual child ceilings and model catalogs (#246)", () => {
  for (const item of [
    { label: "child-default-cross-model", selected: undefined, expected: full.filter((name) => name !== "task") },
    { label: "child-active-read", selected: ["task", "read"], expected: ["read"] },
    { label: "child-active-unavailable-peer", selected: ["task", "apply_patch"], expected: [] },
    { label: "child-own-config", selected: ["task", "read"], expected: [] },
  ])
    test(
      item.label,
      async () => {
        const result = await run({
          label: item.label,
          model: "gpt-5",
          args: item.selected ? ["--tools", item.selected.join(",")] : [],
          config: {
            agent: { title: { disable: true }, explore: { model: "fixture/fixture" } },
            ...(item.label === "child-own-config" ? { tool_allowlist: ["bash"] } : {}),
          },
          calls: [childTask],
        })
        expect(result.exit, result.stderr + result.stdout).toBe(0)
        expect(result.requests.map((request) => request.model)).toEqual(["gpt-5", "fixture", "gpt-5"])
        expect(names(result.requests[1])).toEqual(item.expected)
        if (!item.selected) {
          expect(names(result.requests[0])).toContain("apply_patch")
          expect(names(result.requests[1])).toContain("edit")
          expect(names(result.requests[1])).toContain("write")
        }
      },
      20000,
    )
  test("resumed real Task child intersects the new parent effective ceiling and saves each snapshot", async () => {
    const result = await run({
      label: "child-resume-tighten",
      runtime: "resume-child",
      markers: ["runtime-report.json"],
      calls: [
        childTask,
        null,
        null,
        (requests) => {
          const id = JSON.stringify(requests).match(/task_id: (ses_[a-zA-Z0-9]+)/)?.[1]
          if (!id) throw new Error("Missing actual Task result task_id")
          return { ...childTask, arguments: { ...childTask.arguments, task_id: id } }
        },
        null,
        null,
      ],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests).toHaveLength(6)
    expect(names(result.requests[1])).toEqual(["bash", "read"])
    expect(names(result.requests[4])).toEqual(["read"])
    expect(result.markers["runtime-report.json"]).toMatchObject({
      users: [
        { toolSelection: { version: 1, allowlist: ["task", "read", "bash"] } },
        { toolSelection: { version: 1, allowlist: ["task", "read"] } },
      ],
      children: [
        {
          users: [
            { toolSelection: { version: 1, allowlist: ["bash", "read", "task"] } },
            { toolSelection: { version: 1, allowlist: ["read", "task"] } },
          ],
        },
      ],
    })
  }, 20000)
  test("resumed real Task child also intersects its own config on each invocation", async () => {
    const result = await run({
      label: "child-resume-own-config",
      runtime: "resume-child-config",
      config: { tool_allowlist: ["bash"] },
      markers: ["runtime-report.json"],
      calls: [
        childTask,
        null,
        null,
        (requests) => {
          const task_id = JSON.stringify(requests).match(/task_id: (ses_[a-zA-Z0-9]+)/)?.[1]
          if (!task_id) throw new Error("Missing real child task_id")
          return { ...childTask, arguments: { ...childTask.arguments, task_id } }
        },
        null,
        null,
      ],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests).toHaveLength(6)
    expect(names(result.requests[1])).toEqual(["bash"])
    expect(names(result.requests[4])).toEqual([])
    expect(result.markers["runtime-report.json"]).toMatchObject({
      children: [
        {
          users: [
            { toolSelection: { version: 1, allowlist: ["bash"] } },
            { toolSelection: { version: 1, allowlist: [] } },
          ],
        },
      ],
    })
  }, 20000)
  test("private child submission rejects explicit widening before saving a User or invoking a model", async () => {
    const result = await run({
      label: "child-explicit-widen",
      runtime: "child-widen",
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests).toEqual([])
    expect(result.markers["runtime-report.json"]).toEqual({
      failure: expect.stringContaining("cannot widen"),
      users: [],
    })
  }, 20000)
  for (const customTask of [false, true])
    test(`explicit command selected ${customTask ? "custom Task identity" : "omitted Task"} is rejected before inference`, async () => {
      const result = await run({
        label: customTask ? "direct-task-custom-identity" : "direct-task-omitted",
        args: ["--command", "inspect", "--tools", customTask ? "task" : "read"],
        config: { command: { inspect: { template: "Inspect fixture", agent: "explore", subtask: true } } },
        markers: ["work-marker.json"],
        setup: customTask
          ? async (directory) => {
              await Bun.write(path.join(directory, ".aictrl/tool/task.ts"), collision)
            }
          : undefined,
      })
      expect(result.exit, result.stderr + result.stdout).not.toBe(0)
      expect(result.requests).toEqual([])
      expect(result.markers["work-marker.json"]).toBeNull()
    }, 20000)
  for (const model of ["fixture", "gpt-5"])
    test(`native read-only schema and guidance use final ${model} catalog`, async () => {
      const result = await run({ label: "model-read-guidance-" + model, model, args: ["--tools", "read"] })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(names(result.requests[0])).toEqual(["read"])
      expect(result.requests[0].tools?.[0].function.description).not.toMatch(/\b(?:Task|Grep|Glob|Bash)\b/)
      expect(JSON.stringify(result.requests[0].messages)).not.toContain("with bash")
    }, 20000)
  test("model-eligible native apply_patch remains selectable on actual GPT registry", async () => {
    const result = await run({ label: "model-gpt-apply-patch", model: "gpt-5", args: ["--tools", "apply_patch"] })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(names(result.requests[0])).toEqual(["apply_patch"])
  }, 20000)
})

describe("native protocol controls and Codex selector snapshots (#246)", () => {
  test("Codex actual serialized full reduced full uses saved selections without mutating instructions", async () => {
    const result = await run({
      label: "selector-codex-reset",
      codex: true,
      runtime: "codex-reset",
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests).toHaveLength(3)
    const definitions = (request: Request) => request.tools as unknown as { name: string; description: string }[]
    const list = (request: Request) =>
      definitions(request)
        .map((tool) => tool.name)
        .sort()
    const expected = ["apply_patch", ...full.filter((name) => name !== "edit" && name !== "write")].sort()
    expect(result.requests.map(list)).toEqual([expected, ["read"], expected])
    expect(result.requests[0].instructions).toContain("Try to use apply_patch")
    expect(result.requests[1].instructions).toContain("Use Read")
    for (const advice of ["Try to use apply_patch", "Use Glob", "Grep to search", "Use Bash for terminal"])
      expect(result.requests[1].instructions).not.toContain(advice)
    expect(result.requests[1].instructions).toContain("NEVER revert existing changes")
    expect(result.requests[0].instructions).toBe(result.requests[2].instructions)
    expect(result.requests[0].tools).toEqual(result.requests[2].tools)
    expect(result.markers["runtime-report.json"]).toMatchObject({
      users: [
        { toolSelection: { version: 1, allowlist: null } },
        { toolSelection: { version: 1, allowlist: ["read"] } },
        { toolSelection: { version: 1, allowlist: null } },
      ],
    })
  }, 20000)
  test("Codex CLI explicit empty work selector declares no work tools", async () => {
    const result = await run({ label: "selector-codex-empty", codex: true, args: ["--tools", ""] })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0].tools ?? []).toEqual([])
  }, 20000)
  for (const name of ["invalid", "_noop"])
    test(`native ${name} cannot be explicitly selected as work`, async () => {
      const result = await run({ label: "protocol-select-" + name, args: ["--tools", name] })
      expect(result.exit, result.stderr + result.stdout).not.toBe(0)
      expect(result.requests).toEqual([])
    }, 20000)
  for (const selected of [false, true])
    test(`schema protocol ${selected ? "cannot be selected as work" : "retains permission denial under empty work selector"}`, async () => {
      const result = await run({
        label: selected ? "protocol-select-structured" : "protocol-structured-denied",
        args: ["--tools", selected ? "StructuredOutput" : "", "--output-schema", "schema.json"],
        config: { permission: { "*": "deny", ...(selected ? { StructuredOutput: "allow" } : {}) } },
        setup: async (directory) => {
          await Bun.write(
            path.join(directory, "schema.json"),
            JSON.stringify({ type: "object", properties: { result: { type: "string" } }, required: ["result"] }),
          )
        },
      })
      expect(result.exit, result.stderr + result.stdout).not.toBe(0)
      expect(result.requests).toEqual([])
      expect(result.stderr + result.stdout).toContain("StructuredOutput")
    }, 20000)
  test("native LiteLLM noop survives empty work selection with real tool-call history", async () => {
    const result = await run({
      label: "protocol-noop-history",
      runtime: "noop-history",
      proxy: true,
      config: { permission: { "*": "allow", invalid: "deny" } },
      calls: [{ name: "read", arguments: { filePath: "read-fixture.txt" } }, null, null],
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests.map(names)).toEqual([["read"], ["read"], ["_noop"]])
    expect(result.markers["runtime-report.json"]).toMatchObject({
      users: [{ toolSelection: { version: 1, allowlist: ["read"] } }, { toolSelection: { version: 1, allowlist: [] } }],
    })
  }, 20000)
})

describe("exact selection and real dispatch boundaries (#246)", () => {
  test("repeated tools flags fail with actionable single-argument guidance before inference", async () => {
    const result = await run({ label: "exact-repeated-flags", args: ["--tools", "read", "--tools", "bash"] })
    expect(result.exit, result.stderr + result.stdout).not.toBe(0)
    expect(result.requests).toEqual([])
    expect(result.stderr + result.stdout).toContain("--tools")
    expect(result.stderr + result.stdout).toMatch(/once|single|comma|repeat/i)
    expect(result.stderr + result.stdout).not.toContain("split is not a function")
  }, 20000)
  test("missing tools argument is an explicit invocation error before inference", async () => {
    const result = await run({ label: "exact-missing-argument", args: ["--tools"], noMessage: true })
    expect(result.exit, result.stderr + result.stdout).not.toBe(0)
    expect(result.requests).toEqual([])
    expect(result.stderr + result.stdout).toContain("tools")
    expect(result.stderr + result.stdout).toMatch(/argument|following|value/i)
  }, 20000)
  for (const [label, value] of [
    ["leading-space", " read"],
    ["trailing-space", "read "],
    ["empty-middle", "read,,bash"],
    ["empty-prefix", ",read"],
    ["empty-suffix", "read,"],
    ["case-sensitive", "Read"],
    ["unknown", "unregistered_fixture"],
    ["model-ineligible", "apply_patch"],
  ])
    test(`rejects ${label} before title or model requests`, async () => {
      const result = await run({
        label: "exact-" + label,
        args: ["--tools", value],
        config: { agent: { title: { disable: false } } },
      })
      expect(result.exit, result.stderr + result.stdout).not.toBe(0)
      expect(result.requests).toEqual([])
    }, 20000)
  for (const [label, value] of [
    ["string", "read"],
    ["empty-element", ["read", ""]],
    ["whitespace", [" read"]],
    ["null", [null]],
  ] as const)
    test(`strictly rejects malformed config selector ${label}`, async () => {
      const result = await run({ label: "config-malformed-" + label, config: { tool_allowlist: value } })
      expect(result.exit, result.stderr + result.stdout).not.toBe(0)
      expect(result.requests).toEqual([])
    }, 20000)
  test("duplicate exact CLI names are stable-deduplicated without adding aliases", async () => {
    const result = await run({ label: "exact-dedup", args: ["--tools", "read,bash,read,bash"] })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(names(result.requests[0])).toEqual(["bash", "read"])
  }, 20000)
  for (const denied of [false, true])
    test(`selected Read ${denied ? "obeys path denial" : "reads allowed fixture control"}`, async () => {
      const sentinel = "Private path acceptance sentinel 246"
      const result = await run({
        label: denied ? "read-path-denied" : "read-path-positive",
        args: ["--tools", "read"],
        calls: [{ name: "read", arguments: { filePath: "private.txt" } }],
        setup: async (directory) => {
          const file = path.join(directory, "private.txt")
          await Bun.write(file, sentinel)
          return denied ? { permission: { "*": "allow", read: { "*": "allow", [file]: "deny" } } } : undefined
        },
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(names(result.requests[0])).toEqual(["read"])
      expect(result.requests).toHaveLength(2)
      expect(JSON.stringify(result.requests[1].messages).includes(sentinel)).toBe(!denied)
    }, 20000)
  test("empty work selection does not gate caller-directed file attachment loading", async () => {
    const result = await run({
      label: "caller-attachment-empty",
      args: ["--tools", "", "--file", "caller.txt", "--"],
      setup: async (directory) => {
        await Bun.write(path.join(directory, "caller.txt"), "Caller directed content 246")
      },
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(names(result.requests[0])).toEqual([])
    expect(JSON.stringify(result.requests[0].messages)).toContain("Caller directed content 246")
  }, 20000)
  for (const selected of [false, true])
    test(`real MCP wrapper ${selected ? "executes selected exact key" : "blocks omitted key"}`, async () => {
      const result = await run({
        label: selected ? "mcp-selected" : "mcp-omitted",
        args: ["--tools", selected ? "fixture_echo" : ""],
        calls: [{ name: "fixture_echo", arguments: { text: "accepted" } }],
        markers: ["mcp-marker.json"],
        setup: setupMCP,
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(names(result.requests[0])).toEqual(selected ? ["fixture_echo"] : [])
      expect(result.markers["mcp-marker.json"]).toEqual(
        selected ? { name: "echo", arguments: { text: "accepted" } } : null,
      )
      if (selected)
        expect(result.requests[0].tools?.[0].function.description).toBe("Original MCP Task Grep Read body preserved")
    }, 20000)
  for (const label of ["positive", "omitted", "permission", "unknown", "recursive", "external-mcp"])
    test(`Batch whole-group ${label} preflight precedes outer hook and all work effects`, async () => {
      const second =
        label === "unknown"
          ? "unregistered_fixture"
          : label === "recursive"
            ? "batch"
            : label === "external-mcp"
              ? "fixture_echo"
              : "omitted"
      const selected = ["batch", "first", ...(label === "omitted" || label === "unknown" ? [] : [second])]
      const result = await run({
        label: "group-" + label,
        args: ["--tools", selected.join(",")],
        config: {
          experimental: { batch_tool: true },
          ...(label === "permission" ? { permission: { "*": "allow", omitted: "deny" } } : {}),
        },
        markers: [
          "group-hook-batch.json",
          "group-hook-first.json",
          "group-hook-omitted.json",
          "work-marker.json",
          "mcp-marker.json",
        ],
        calls: [
          {
            name: "batch",
            arguments: {
              tool_calls: [
                { tool: "first", parameters: {} },
                { tool: second, parameters: label === "external-mcp" ? { text: "never" } : {} },
              ],
            },
          },
        ],
        setup: async (directory) => {
          await Bun.write(path.join(directory, ".aictrl/tool/first.ts"), collision)
          await Bun.write(path.join(directory, ".aictrl/tool/omitted.ts"), collision)
          const plugin = path.join(directory, "group-hooks.ts")
          await Bun.write(plugin, groupHooks)
          return {
            plugin: [new URL("file://" + plugin).href],
            ...(label === "external-mcp" ? await setupMCP(directory) : {}),
          }
        },
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(result.markers["work-marker.json"]).toEqual(label === "positive" ? { executed: true } : null)
      for (const tool of ["batch", "first", "omitted"])
        expect(result.markers[`group-hook-${tool}.json`]).toEqual(label === "positive" ? { tool } : null)
      expect(result.markers["mcp-marker.json"]).toBeNull()
    }, 20000)
})

describe("public plugin checked selection facade (#246)", () => {
  for (const [label, source] of [
    ["baseline", baseline],
    ["candidate", entry],
  ] as const)
    test.skipIf(label === "baseline" && !process.env.SELECTOR_BASELINE_ENTRY)(
      `${label} public metadata registration diagnostic uses real running-state barrier`,
      async () => {
        const result = await run({
          label: "metadata-registration-" + label,
          entry: source,
          runtime: "metadata-registration",
          calls: [{ name: "probe", arguments: {} }],
          markers: ["runtime-report.json"],
          setup: async (directory) => {
            const modules = path.join(directory, "node_modules/@aictrl")
            await fs.mkdir(modules, { recursive: true })
            await fs.symlink(path.resolve(path.dirname(source), "../../plugin"), path.join(modules, "plugin"), "dir")
            await Bun.write(path.join(directory, ".aictrl/tool/probe.ts"), metadataProbe)
          },
        })
        expect(result.exit, result.stderr + result.stdout).toBe(0)
        expect(result.requests).toHaveLength(2)
        expect(result.markers["runtime-report.json"]).toMatchObject({ ready: true })
      },
      20000,
    )
  for (const selected of [false, true])
    test(`public facade dispatch to MCP ${selected ? "normalizes selected result" : "blocks omitted target"}`, async () => {
      const result = await run({
        label: selected ? "public-mcp-selected" : "public-mcp-omitted",
        args: ["--tools", selected ? "delegate,fixture_echo" : "delegate"],
        calls: [{ name: "delegate", arguments: { name: "fixture_echo", payload: { text: "nested" }, spoof: true } }],
        markers: ["caller-marker.json", "mcp-marker.json", "delegate-marker.json"],
        setup: async (directory) => {
          await setupPublicFacade(directory)
          return await setupMCP(directory)
        },
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(names(result.requests[0])).toEqual(selected ? ["delegate", "fixture_echo"] : ["delegate"])
      expect(result.markers["mcp-marker.json"]).toEqual(
        selected ? { name: "echo", arguments: { text: "nested" } } : null,
      )
      expect(result.markers["delegate-marker.json"]).toEqual(
        selected ? { title: "", output: "MCP fixture result: nested", metadata: { truncated: false } } : null,
      )
      const event = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((event) => event.type === "tool_use" && event.part.tool === "delegate")
      expect(result.markers["caller-marker.json"]).toMatchObject({
        sessionID: event.sessionID,
        messageID: event.part.messageID,
        agent: expect.any(String),
        directory: path.dirname(result.command[3]),
        worktree: "/",
        abortPresent: true,
        abortInitially: false,
      })
    }, 20000)
  test("public nested dispatch binds real caller identity metadata and abort; busy prompt cannot persist or replace selection", async () => {
    const result = await run({
      label: "public-abort-busy",
      runtime: "public-abort-busy",
      calls: [{ name: "delegate", arguments: { name: "abortleaf", spoof: true, waitRunning: true } }, null],
      markers: ["runtime-report.json", "caller-marker.json", "abort-ready.json", "abort-observed.json"],
      setup: async (directory) => {
        await setupPublicFacade(directory)
        await Bun.write(path.join(directory, ".aictrl/tool/abortleaf.ts"), publicAbortLeaf)
      },
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests).toHaveLength(2)
    expect(names(result.requests[0])).toEqual(["abortleaf", "delegate"])
    expect(names(result.requests[1])).toEqual(["read"])
    expect(result.markers["abort-ready.json"]).toEqual(result.markers["caller-marker.json"])
    expect(result.markers["abort-observed.json"]).toEqual({ aborted: true })
    expect(result.markers["runtime-report.json"]).toMatchObject({
      busy: expect.stringMatching(/busy/i),
      users: [
        { toolSelection: { version: 1, allowlist: ["delegate", "abortleaf"] } },
        { toolSelection: { version: 1, allowlist: ["read"] } },
      ],
      metadata: [
        {
          tool: "delegate",
          sessionID: expect.stringMatching(/^ses_/),
          messageID: expect.stringMatching(/^msg_/),
          state: { title: "Public delegate running", metadata: { facade: true } },
        },
        {
          tool: "delegate",
          sessionID: expect.stringMatching(/^ses_/),
          messageID: expect.stringMatching(/^msg_/),
          state: { title: "Public leaf waiting", metadata: { abortLeaf: true } },
        },
      ],
    })
    const caller = result.markers["caller-marker.json"] as { sessionID: string; messageID: string }
    const report = result.markers["runtime-report.json"] as { metadata: { sessionID: string; messageID: string }[] }
    for (const part of report.metadata)
      expect({ sessionID: part.sessionID, messageID: part.messageID }).toEqual({
        sessionID: caller.sessionID,
        messageID: caller.messageID,
      })
  }, 20000)
  for (const item of [
    { label: "public-facade-unrestricted", selected: null, allowed: true },
    { label: "public-facade-positive", selected: ["delegate", "leaf"], allowed: true },
    { label: "public-facade-omitted", selected: ["delegate"], allowed: false },
    {
      label: "public-facade-permission",
      selected: ["delegate", "leaf"],
      permission: { "*": "allow", leaf: "deny" },
      allowed: false,
    },
    {
      label: "public-facade-ask-denied",
      selected: ["delegate", "leaf"],
      permission: { "*": "allow", public_leaf: "deny" },
      allowed: false,
    },
    { label: "public-facade-batch", selected: ["batch", "delegate", "leaf"], batch: true, allowed: true },
  ])
    test(
      item.label,
      async () => {
        const call = { name: "delegate", arguments: { name: "leaf", payload: { text: "  selected  " } } }
        const result = await run({
          label: item.label,
          args: item.selected ? ["--tools", item.selected.join(",")] : [],
          config: {
            ...(item.permission ? { permission: item.permission } : {}),
            ...(item.batch ? { experimental: { batch_tool: true } } : {}),
          },
          markers: ["facade-marker.json", "leaf-marker.json", "delegate-marker.json"],
          calls: [
            item.batch
              ? { name: "batch", arguments: { tool_calls: [{ tool: call.name, parameters: call.arguments }] } }
              : call,
          ],
          setup: setupPublicFacade,
        })
        expect(result.exit, result.stderr + result.stdout).toBe(0)
        const expectedNames =
          item.label === "public-facade-permission"
            ? ["delegate"]
            : item.selected
              ? [...item.selected].sort()
              : [...full, "delegate", "leaf"].sort()
        expect(names(result.requests[0])).toEqual(expectedNames)
        expect(result.markers["facade-marker.json"]).toEqual({
          names: expectedNames,
          restricted: item.selected !== null,
          frozen: true,
          namesFrozen: true,
          executeArity: 2,
          assertArity: 1,
        })
        expect(result.markers["leaf-marker.json"]).toEqual(
          item.allowed ? { text: "selected", tag: "public-default" } : null,
        )
        if (item.allowed)
          expect(result.markers["delegate-marker.json"]).toMatchObject({ output: "Public leaf complete" })
        else expect(result.markers["delegate-marker.json"]).toBeNull()
      },
      20000,
    )
})

describe("custom work names remain distinct from native control provenance (#246)", () => {
  test("native invalid repair remains available under empty work selection when permitted", async () => {
    const result = await run({
      label: "identity-native-invalid",
      args: ["--tools", ""],
      calls: [{ name: "unregistered_fixture", arguments: {} }],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(names(result.requests[0])).toEqual([])
    expect(result.requests).toHaveLength(2)
    expect(JSON.stringify(result.requests[1].messages)).toContain("The arguments provided to the tool are invalid:")
  }, 20000)
  test("permitted native StructuredOutput publishes under empty work selection", async () => {
    const result = await run({
      label: "identity-native-structured",
      args: ["--tools", "", "--output-schema", "schema.json"],
      config: { permission: { "*": "deny", StructuredOutput: "allow" } },
      calls: [{ name: "StructuredOutput", arguments: { path: "result.json" } }],
      setup: async (directory) => {
        await Bun.write(
          path.join(directory, "schema.json"),
          JSON.stringify({
            type: "object",
            properties: { result: { type: "string" } },
            required: ["result"],
            additionalProperties: false,
          }),
        )
        await Bun.write(path.join(directory, "result.json"), JSON.stringify({ result: "accepted" }))
      },
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(names(result.requests[0])).toEqual(["StructuredOutput"])
    expect(result.stdout).toContain('"result":"accepted"')
  }, 20000)
  for (const name of ["invalid", "_noop", "StructuredOutput"]) {
    test(`explicitly selected custom ${name} is declared and executes as work outside schema mode`, async () => {
      const result = await run({
        label: `identity-selected-${name}`,
        args: ["--tools", name],
        markers: ["work-marker.json"],
        calls: [{ name, arguments: {} }],
        setup: async (directory) => {
          await Bun.write(path.join(directory, ".aictrl/tool", name + ".ts"), collision)
        },
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(names(result.requests[0])).toEqual([name])
      expect(result.markers["work-marker.json"]).toEqual({ executed: true })
    }, 20000)
  }
  test("unknown tool repair cannot dispatch selected custom invalid as a native error fallback", async () => {
    const result = await run({
      label: "identity-unknown-repair",
      args: ["--tools", "invalid"],
      markers: ["work-marker.json"],
      calls: [{ name: "unregistered_fixture", arguments: {} }],
      setup: async (directory) => {
        await Bun.write(path.join(directory, ".aictrl/tool/invalid.ts"), collision)
      },
    })
    expect(result.requests.length).toBeGreaterThanOrEqual(1)
    expect(result.markers["work-marker.json"]).toBeNull()
  }, 20000)
})

describe("critical selector implementation boundaries (#246)", () => {
  for (const name of ["invalid", "StructuredOutput"]) {
    test(`empty selection excludes ordinary custom ${name} identity and execution`, async () => {
      const result = await run({
        label: `critical-custom-${name}`,
        args: ["--tools", ""],
        markers: ["work-marker.json"],
        calls: [{ name, arguments: {} }],
        setup: async (directory) => {
          await Bun.write(path.join(directory, ".aictrl/tool", name + ".ts"), collision)
        },
      })
      expect(result.requests.length).toBeGreaterThanOrEqual(1)
      expect(names(result.requests[0])).not.toContain(name)
      expect(result.markers["work-marker.json"]).toBeNull()
    }, 20000)
  }

  for (const [label, args] of [
    ["missing", {}],
    ["wrong-type", { text: 42 }],
  ] as const) {
    test(`Batch validates ${label} raw custom args before hooks and execution`, async () => {
      const result = await run({
        label: `critical-batch-${label}`,
        args: ["--tools", "batch,strict"],
        config: { experimental: { batch_tool: true } },
        markers: ["hook-marker.json", "custom-marker.json"],
        calls: [{ name: "batch", arguments: { tool_calls: [{ tool: "strict", parameters: args }] } }],
        setup: async (directory) => {
          await Bun.write(path.join(directory, ".aictrl/tool/strict.ts"), custom)
          const plugin = path.join(directory, "hooks.ts")
          await Bun.write(plugin, hooks)
          return { plugin: [new URL("file://" + plugin).href] }
        },
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(names(result.requests[0])).toEqual(["batch", "strict"])
      expect(result.markers).toEqual({ "hook-marker.json": null, "custom-marker.json": null })
    }, 20000)
  }

  test("Batch passes parsed trim and default values to actual custom hook and plugin", async () => {
    const result = await run({
      label: "critical-batch-transform",
      args: ["--tools", "batch,strict"],
      config: { experimental: { batch_tool: true } },
      markers: ["hook-marker.json", "custom-marker.json"],
      calls: [{ name: "batch", arguments: { tool_calls: [{ tool: "strict", parameters: { text: "  trimmed  " } }] } }],
      setup: async (directory) => {
        await Bun.write(path.join(directory, ".aictrl/tool/strict.ts"), custom)
        const plugin = path.join(directory, "hooks.ts")
        await Bun.write(plugin, hooks)
        return { plugin: [new URL("file://" + plugin).href] }
      },
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.markers).toEqual({
      "hook-marker.json": { text: "trimmed", tag: "default-tag" },
      "custom-marker.json": { text: "trimmed", tag: "default-tag" },
    })
  }, 20000)

  const command = {
    permission: { "*": "allow", task: "deny" },
    command: { inspect: { template: "Inspect harmless fixture.", agent: "explore", subtask: true } },
  }
  test.skipIf(!process.env.SELECTOR_BASELINE_ENTRY)(
    "pinned baseline permits explicit command subtask despite Task permission denial",
    async () => {
      const result = await run({
        label: "critical-command-baseline",
        entry: baseline,
        args: ["--command", "inspect"],
        config: command,
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(result.requests.length).toBeGreaterThanOrEqual(1)
    },
    20000,
  )
  for (const selected of [false, true]) {
    test(`explicit command preserves manual Task bypass with selection ${selected ? "task" : "omitted"}`, async () => {
      const result = await run({
        label: `critical-command-${selected ? "selected" : "default"}`,
        args: ["--command", "inspect", ...(selected ? ["--tools", "task"] : [])],
        config: command,
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(result.requests.length).toBeGreaterThanOrEqual(1)
    }, 20000)
  }

  for (const [label, source] of [
    ["baseline", baseline],
    ["candidate", entry],
  ] as const) {
    test.skipIf(label === "baseline" && !process.env.SELECTOR_BASELINE_ENTRY)(
      `${label} no-selector noReply records an unavailable model without inference`,
      async () => {
        const result = await run({ label: `critical-noreply-${label}`, entry: source, noReply: true })
        expect(result.exit, result.stderr + result.stdout).toBe(0)
        expect(result.requests).toEqual([])
        expect(JSON.parse(result.stdout.trim())).toEqual({
          role: "user",
          model: { providerID: "fixture", modelID: "unavailable-model" },
          saved: 1,
        })
      },
      20000,
    )
  }
})

describe("remaining permission and input preparation contracts (#246)", () => {
  for (const tool of ["edit", "write"] as const)
    for (const denied of [false, true])
      test(`selected ${tool} canonical edit permission last-match ${denied ? "denies without changing bytes" : "allows after earlier denial"}`, async () => {
        const before = '{"value":"before"}\n'
        const after = '{"value":"after"}\n'
        const result = await run({
          label: `mutation-${tool}-${denied ? "denied" : "allowed"}`,
          args: ["--tools", `read,${tool}`],
          files: ["target.json"],
          calls: [
            { name: "read", arguments: { filePath: "target.json" } },
            {
              name: tool,
              arguments:
                tool === "edit"
                  ? { filePath: "target.json", oldString: "before", newString: "after" }
                  : { filePath: "target.json", content: after },
            },
          ],
          setup: async (directory) => {
            await Bun.write(path.join(directory, "target.json"), before)
            return {
              permission: {
                "*": "allow",
                edit: denied ? { "*": "allow", "*/target.json": "deny" } : { "*/target.json": "deny", "*": "allow" },
              },
            }
          },
        })
        expect(result.exit, result.stderr + result.stdout).toBe(0)
        expect(names(result.requests[0])).toEqual([tool, "read"].sort())
        expect(result.requests).toHaveLength(3)
        expect(JSON.stringify(result.requests[1].messages)).toContain("before")
        expect(result.files["target.json"]).toBe(denied ? before : after)
        if (denied) expect(JSON.stringify(result.requests[2].messages)).toContain("rule which prevents you")
      }, 20000)
  for (const override of [false, true])
    test(`legacy tools false ${override ? "explicit permission allow takes precedence" : "cannot be regranted by selector"}`, async () => {
      const result = await run({
        label: `legacy-selector-${override ? "override" : "deny"}`,
        args: ["--tools", "read,bash"],
        config: {
          tools: { bash: false },
          ...(override ? { permission: { "*": "allow", bash: "allow" } } : { permission: { read: "allow" } }),
        },
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(names(result.requests[0])).toEqual(override ? ["bash", "read"] : ["read"])
    }, 20000)
})

describe("caller preparation and imported fresh prompt (#246)", () => {
  for (const mode of ["resolved-file-empty", "command-file-empty", "command-shell-empty"])
    test(`${mode} preserves caller-directed content outside model work selection`, async () => {
      const result = await run({
        label: mode,
        runtime: mode,
        config: { permission: { "*": "allow", read: "deny", bash: "deny" } },
        setup: async (directory) => {
          const file = path.join(directory, "caller-input.txt")
          await Bun.write(file, "Caller explicit at-file content 246")
          return {
            command: {
              prepare: {
                template:
                  mode === "command-shell-empty"
                    ? "Include !`printf 'Caller explicit shell content 246'`"
                    : `Inspect @${file}`,
                description: "Explicit caller file preparation",
              },
            },
          }
        },
        markers: ["runtime-report.json"],
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(result.requests).toHaveLength(1)
      expect(names(result.requests[0])).toEqual([])
      expect(JSON.stringify(result.requests[0].messages)).toContain(
        mode === "command-shell-empty" ? "Caller explicit shell content 246" : "Caller explicit at-file content 246",
      )
      expect(result.markers["runtime-report.json"]).toMatchObject({
        users: [{ toolSelection: { version: 1, allowlist: [] } }],
      })
    }, 20000)
  test("fresh omitted prompt after real CLI import resets to current config", async () => {
    const result = await run({
      label: "import-fresh-reset",
      runtime: "export-import-reset",
      config: { tool_allowlist: ["bash"] },
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests.map(names)).toEqual([["read"], ["bash"]])
    expect(result.markers["runtime-report.json"]).toMatchObject({
      users: [{ toolSelection: { allowlist: ["read"] } }, { toolSelection: { allowlist: ["bash"] } }],
    })
  }, 20000)
})

describe("phase cancellation and overlapping child isolation (#246)", () => {
  for (const mode of ["cancel-record", "cancel-model"])
    test(`${mode} retains owner snapshot, rejects busy replacement and releases for fresh prompt`, async () => {
      const result = await run({
        label: mode,
        runtime: mode,
        markers: ["runtime-report.json"],
        setup: async (directory) => {
          if (mode !== "cancel-record") return
          const plugin = path.join(directory, "record-barrier.ts")
          await Bun.write(
            plugin,
            `import {writeFile} from "node:fs/promises"
export default async()=>({"chat.message":async()=>{
 const root=new URL("./",import.meta.url)
 if(await Bun.file(new URL("phase-release.json",root)).exists())return
 await writeFile(new URL("phase-ready.json",root),"true")
 const deadline=Date.now()+5000
 while(!await Bun.file(new URL("phase-release.json",root)).exists()){if(Date.now()>deadline)throw new Error("Record fixture barrier timeout");await Bun.sleep(5)}
}})`,
          )
          return { plugin: [new URL("file://" + plugin).href] }
        },
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(result.requests.map(names)).toEqual(mode === "cancel-record" ? [["bash"]] : [["read"], ["bash"]])
      const report = result.markers["runtime-report.json"] as { ownerFailure?: string }
      if (mode === "cancel-record") expect(report.ownerFailure).toContain("Impossible")
      else expect(report.ownerFailure).toBeUndefined()
      expect(result.markers["runtime-report.json"]).toMatchObject({
        before: mode === "cancel-record" ? 0 : 1,
        busy: expect.stringContaining("busy"),
        users: [{ toolSelection: { allowlist: ["read"] } }, { toolSelection: { allowlist: ["bash"] } }],
      })
    }, 20000)
  test("concurrent real Task siblings retain independent effective ceilings", async () => {
    const script = (requests: Request[]): Call | null => {
      const messages = requests.at(-1)?.messages ?? []
      if (messages.some((message) => message.role === "assistant")) return null
      const text = String(messages.at(-1)?.content)
      if (text.includes("Parent sibling read"))
        return { ...childTask, arguments: { ...childTask.arguments, prompt: "Child sibling read" } }
      if (text.includes("Parent sibling bash"))
        return { ...childTask, arguments: { ...childTask.arguments, prompt: "Child sibling bash" } }
      return null
    }
    const result = await run({
      label: "sibling-children",
      runtime: "sibling-children",
      calls: Array(6).fill(script),
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests).toHaveLength(6)
    const children = result.requests.filter(
      (request) =>
        request.messages?.at(-1)?.role === "user" && String(request.messages.at(-1)?.content).includes("Child sibling"),
    )
    expect(children).toHaveLength(2)
    for (const child of children)
      expect(names(child)).toEqual(String(child.messages?.at(-1)?.content).includes("read") ? ["read"] : ["bash"])
    expect(result.markers["runtime-report.json"]).toMatchObject({
      first: { children: [{ users: [{ toolSelection: { allowlist: ["read", "task"] } }] }] },
      second: { children: [{ users: [{ toolSelection: { allowlist: ["bash", "task"] } }] }] },
    })
  }, 20000)
})

test.skipIf(!process.env.SELECTOR_BASELINE_ENTRY)(
  "baseline record-phase cancellation diagnostic",
  async () => {
    const result = await run({
      label: "baseline-record-cancel",
      runtime: "cancel-record",
      entry: baseline,
      markers: ["runtime-report.json"],
      setup: async (directory) => {
        const plugin = path.join(directory, "record-barrier.ts")
        await Bun.write(
          plugin,
          `import {writeFile} from "node:fs/promises"
export default async()=>({"chat.message":async()=>{
 const root=new URL("./",import.meta.url)
 if(await Bun.file(new URL("phase-release.json",root)).exists())return
 await writeFile(new URL("phase-ready.json",root),"true")
 const deadline=Date.now()+5000
 while(!await Bun.file(new URL("phase-release.json",root)).exists()){if(Date.now()>deadline)throw new Error("Record fixture barrier timeout");await Bun.sleep(5)}
}})`,
        )
        return { plugin: [new URL("file://" + plugin).href] }
      },
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.markers["runtime-report.json"]).toMatchObject({
      before: 0,
      busy: expect.stringContaining("busy"),
      ownerFailure: expect.stringContaining("Impossible"),
    })
    expect(result.requests).toHaveLength(1)
  },
  20000,
)

test("overlapping actual Task resume cannot replace an active child snapshot", async () => {
  const script = (requests: Request[]): Call | null => {
    const last = requests.at(-1)?.messages?.at(-1)
    if (last?.role !== "user") return null
    const text = String(last.content)
    const task_id = text.match(/ses_[a-zA-Z0-9]+/)?.[0]
    const prompt = text.includes("Initial resume parent")
      ? "Initial child"
      : text.includes("Resume held parent")
        ? "Held resumed child"
        : text.includes("Overlap rejected parent")
          ? "Rejected overlap child"
          : text.includes("Fresh resumed parent")
            ? "Fresh resumed child"
            : undefined
    return prompt
      ? { ...childTask, arguments: { ...childTask.arguments, prompt, ...(task_id ? { task_id } : {}) } }
      : null
  }
  const result = await run({
    label: "overlap-child-resume",
    runtime: "overlap-child-resume",
    calls: Array(11).fill(script),
    markers: ["runtime-report.json"],
  })
  expect(result.exit, result.stderr + result.stdout).toBe(0)
  expect(result.requests).toHaveLength(11)
  const held = result.requests.find(
    (request) =>
      request.messages?.at(-1)?.role === "user" &&
      String(request.messages.at(-1)?.content).includes("Held resumed child"),
  )
  const fresh = result.requests.find(
    (request) =>
      request.messages?.at(-1)?.role === "user" &&
      String(request.messages.at(-1)?.content).includes("Fresh resumed child"),
  )
  expect(held).toBeDefined()
  expect(fresh).toBeDefined()
  expect(names(held!)).toEqual(["read"])
  expect(names(fresh!)).toEqual(["bash"])
  expect(result.markers["runtime-report.json"]).toMatchObject({
    during: [
      { toolSelection: { allowlist: ["bash", "read", "task"] } },
      { toolSelection: { allowlist: ["read", "task"] } },
    ],
    after: [
      { toolSelection: { allowlist: ["bash", "read", "task"] } },
      { toolSelection: { allowlist: ["read", "task"] } },
      { toolSelection: { allowlist: ["bash", "task"] } },
    ],
  })
  expect(JSON.stringify(result.requests)).toContain("busy")
}, 20000)

describe("persisted process and MCP identity controls (#246)", () => {
  test("fresh process replays saved ceiling then fresh omission resolves config", async () => {
    const result = await run({
      label: "restart-snapshot",
      runtime: "restart-snapshot",
      config: { tool_allowlist: ["bash"] },
      markers: ["runtime-report.json"],
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests.map(names)).toEqual([["read"], ["bash"]])
    expect(result.markers["runtime-report.json"]).toMatchObject({
      users: [{ toolSelection: { allowlist: ["read"] } }, { toolSelection: { allowlist: ["bash"] } }],
    })
  }, 20000)
  for (const denied of [false, true])
    test(`MCP collision ${denied ? "keeps permission denial" : "declares and dispatches the same captured external identity"}`, async () => {
      const result = await run({
        label: `mcp-collision-${denied ? "denied" : "positive"}`,
        args: ["--tools", "fixture_echo"],
        config: denied ? { permission: { "*": "allow", fixture_echo: "deny" } } : undefined,
        calls: [{ name: "fixture_echo", arguments: { text: "collision" } }],
        markers: ["mcp-marker.json", "work-marker.json"],
        setup: async (directory) => {
          await Bun.write(path.join(directory, ".aictrl/tool/fixture_echo.ts"), collision)
          return await setupMCP(directory)
        },
      })
      expect(result.exit, result.stderr + result.stdout).toBe(0)
      expect(names(result.requests[0])).toEqual(denied ? [] : ["fixture_echo"])
      expect(result.markers["work-marker.json"]).toBeNull()
      expect(result.markers["mcp-marker.json"]).toEqual(
        denied ? null : { name: "echo", arguments: { text: "collision" } },
      )
      if (!denied) {
        expect(result.requests[0].tools?.[0].function.description).toContain(
          "Original MCP Task Grep Read body preserved",
        )
        expect(JSON.stringify(result.requests[1].messages)).toContain("MCP fixture result: collision")
      }
    }, 20000)
})

describe("feature flag and Batch independent runtime compatibility (#246)", () => {
  test("flag-disabled Batch selector rejects before title or model inference", async () => {
    const result = await run({
      label: "batch-flag-ineligible",
      args: ["--tools", "batch"],
      config: { agent: { title: { disable: false } } },
    })
    expect(result.exit, result.stderr + result.stdout).not.toBe(0)
    expect(result.requests).toEqual([])
    expect(result.stdout + result.stderr).toContain("batch")
  }, 20000)
  test("allowed Batch runtime failure preserves independent permitted work", async () => {
    const result = await run({
      label: "batch-independent-runtime",
      args: ["--tools", "batch,failing,succeed"],
      config: { experimental: { batch_tool: true } },
      calls: [
        {
          name: "batch",
          arguments: {
            tool_calls: [
              { tool: "failing", parameters: {} },
              { tool: "succeed", parameters: {} },
            ],
          },
        },
      ],
      markers: ["failing-ran.json", "work-marker.json"],
      setup: async (directory) => {
        await Bun.write(
          path.join(directory, ".aictrl/tool/failing.ts"),
          `import {writeFile} from "node:fs/promises"
export default {description:"Actual permitted runtime failure",args:{},execute:async()=>{await writeFile(new URL("../../failing-ran.json",import.meta.url),"true");throw new Error("Independent runtime failure sentinel")}}`,
        )
        await Bun.write(path.join(directory, ".aictrl/tool/succeed.ts"), collision)
      },
    })
    expect(result.exit, result.stderr + result.stdout).toBe(0)
    expect(result.requests).toHaveLength(2)
    expect(result.markers).toEqual({ "failing-ran.json": true, "work-marker.json": { executed: true } })
    expect(JSON.stringify(result.requests[1].messages)).toContain("Independent runtime failure sentinel")
    expect(JSON.stringify(result.requests[1].messages)).toContain("Custom work executed")
  }, 20000)
})

test("forced CLI fixture deadline cannot pass as an expected negative exit", async () => {
  await expect(run({ label: "forced-cli-deadline", runtime: "deadline-hang", deadlineMs: 20 })).rejects.toThrow(
    /child deadline exceeded after 20ms; providerRequests=0/,
  )
}, 20000)
