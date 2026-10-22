// Token-capture snapshot: adds output argument evidence only.
/**
 * Scripted model stub shared by every harness. It speaks two wire APIs on the same port:
 *   POST /v1/chat/completions  (OpenAI chat completions, streaming)  aictrl, opencode, pi
 *   POST /v1/responses         (OpenAI Responses API, streaming)      codex
 * Standard OpenAI model discovery is supported and logged separately. Other backend
 * probes are logged and answered 404, so stray calls show up in the results.
 *
 * The next turn is keyed by the latest returned scripted call ID, so retries cannot
 * shift it and pruning older results does not restart the loop. History regression fails. The tool to call is
 * picked from the request's own tool list: `read` when the harness has one, otherwise its
 * shell tool with `cat`. Argument names come from the tool's JSON schema.
 *
 * A request is "main" when it carries tools and the BENCH marker from the task prompt.
 * Anything else (title generation and the like) is "aux": it gets a short text reply and
 * does not advance the script.
 */

export type Scenario = "trivial" | "short" | "long" | "version"
export type Req = {
  at: number
  epoch: number
  path: string
  api: "chat" | "responses" | "other"
  kind: "main" | "aux" | "discovery" | "other"
  step: number
  bytes: number
  codeUnits: number
  toolResults?: FixtureEvidence[]
  error?: string
  response?: {
    kind: "tool" | "text"
    callId?: string
    name?: string
    arguments?: Record<string, unknown>
    text?: string
  }
  responseDelivery?: {
    stage: "planned" | "body-created" | "handler-returning"
    plannedAt: number
    plannedEpoch: number
    bodyCreatedAt?: number
    bodyCreatedEpoch?: number
    handlerReturningAt?: number
    handlerReturningEpoch?: number
    bodyBytes?: number
    completionId?: string
    completionCreated?: number
    clientAbortedAt?: number
    clientAbortedEpoch?: number
  }
  responseBody?: string
  body?: string
}

export const fixturePath = (scenario: Scenario, index: number) =>
  `/workspace/${scenario === "long" ? "big" : "notes"}-${index}.txt`
export const MARKER = "BENCHTASK"
export const PROTOCOL_VERSION = 3
const CHAT_NONCE = crypto.randomUUID().replaceAll("-", "")
let chatCompletionSequence = 0

export class Stub {
  scenario: Scenario = "trivial"
  longSteps = 50
  latency: number
  log: Req[] = []
  keepBodies = false
  server: ReturnType<typeof Bun.serve>

  constructor(latency: number) {
    this.latency = latency
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (req) => {
        try {
          return await this.handle(req)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`Stub rejected request: ${message}`)
          this.log.push({
            at: performance.now(),
            epoch: Date.now(),
            path: new URL(req.url).pathname,
            api: "other",
            kind: "other",
            step: -1,
            bytes: 0,
            codeUnits: 0,
            error: message,
          })
          return Response.json({ error: { message, type: "benchmark_validation_error" } }, { status: 400 })
        }
      },
    })
  }

  get port() {
    return this.server.port
  }

  reset(scenario: Scenario) {
    this.scenario = scenario
    this.log = []
  }

  private async handle(req: Request) {
    const at = performance.now()
    const epoch = Date.now()
    const path = new URL(req.url).pathname
    const body = req.method === "POST" ? await req.text() : ""
    const api = path.endsWith("/chat/completions") ? "chat" : path.endsWith("/responses") ? "responses" : "other"
    if (req.method === "GET" && ["/v1/models", "/models", "/v1/models/fixture", "/models/fixture"].includes(path)) {
      this.log.push({
        at,
        epoch,
        path: `GET ${path}`,
        api: "other",
        kind: "discovery",
        step: -1,
        bytes: 0,
        codeUnits: 0,
      })
      const model = {
        id: "fixture",
        object: "model",
        created: 1,
        owned_by: "benchmark",
        context_window: 200_000,
        context_length: 200_000,
        max_output_tokens: 1000,
      }
      return Response.json(path.endsWith("/fixture") ? model : { object: "list", data: [model] })
    }
    if (api === "other") {
      this.log.push({
        at,
        epoch,
        path: `${req.method} ${path}`,
        api,
        kind: "other",
        step: -1,
        bytes: Buffer.byteLength(body, "utf8"),
        codeUnits: body.length,
      })
      return new Response("not found", { status: 404 })
    }
    const json = JSON.parse(body)
    const tools = toolList(json, api)
    const main = tools.length > 0 && body.includes(MARKER)
    const resultEvidence = fixtureEvidence(json, api, this.scenario)
    const done = main ? scriptProgress(resultEvidence) : 0
    const furthest = Math.max(0, ...this.log.filter((r) => r.kind === "main").map((r) => r.step))
    if (main && done < furthest) throw new Error(`Tool history regressed from scripted step ${furthest} to ${done}`)
    const turn = main ? this.next(done, tools) : { text: "Bench title" }
    const firstMain = main && !this.log.some((r) => r.kind === "main")
    const evidence: Req = {
      at,
      epoch,
      path,
      api,
      kind: main ? "main" : "aux",
      step: done,
      bytes: Buffer.byteLength(body, "utf8"),
      codeUnits: body.length,
      toolResults: resultEvidence,
      response: turn.call
        ? { kind: "tool", callId: turn.call.id, name: turn.call.name, arguments: turn.call.args }
        : { kind: "text", text: turn.text },
      responseDelivery: { stage: "planned", plannedAt: performance.now(), plannedEpoch: Date.now() },
      body: this.keepBodies || firstMain ? body : undefined,
    }
    this.log.push(evidence)
    const delivery = evidence.responseDelivery!
    req.signal.addEventListener(
      "abort",
      () => {
        delivery.clientAbortedAt = performance.now()
        delivery.clientAbortedEpoch = Date.now()
      },
      { once: true },
    )
    await Bun.sleep(this.latency)
    const completion =
      api === "chat"
        ? { id: `chatcmpl-bench-${CHAT_NONCE}-${++chatCompletionSequence}`, created: Math.floor(Date.now() / 1000) }
        : undefined
    const sse = api === "chat" ? chatSSE(turn, completion!) : responsesSSE(turn, json)
    if (this.keepBodies) evidence.responseBody = sse
    delivery.stage = "body-created"
    delivery.bodyCreatedAt = performance.now()
    delivery.bodyCreatedEpoch = Date.now()
    delivery.bodyBytes = Buffer.byteLength(sse, "utf8")
    if (completion) {
      delivery.completionId = completion.id
      delivery.completionCreated = completion.created
    }
    const response = new Response(sse, { headers: { "content-type": "text/event-stream" } })
    // This is the fetch handler's return boundary, not proof of network delivery or client receipt.
    delivery.stage = "handler-returning"
    delivery.handlerReturningAt = performance.now()
    delivery.handlerReturningEpoch = Date.now()
    return response
  }

  private next(done: number, tools: Tool[]): Turn {
    const wanted = this.scenario === "short" ? 3 : this.scenario === "long" ? this.longSteps : 0
    if (done >= wanted) return { text: "Done." }
    return { call: fixtureCall(tools, fixturePath(this.scenario, done), done) }
  }
}

// ---- tool selection ---------------------------------------------------------------------
type Tool = { name: string; params: any; kind: "function" | "other" }
type Call = { id: string; name: string; args: Record<string, unknown> }
type Turn = { text?: string; call?: Call }

function toolList(json: any, api: "chat" | "responses"): Tool[] {
  const raw: any[] = json.tools ?? []
  return raw.map((t) =>
    api === "chat"
      ? { name: t.function?.name, params: t.function?.parameters, kind: "function" as const }
      : {
          name: t.name ?? t.type,
          params: t.parameters,
          kind: t.type === "function" ? ("function" as const) : ("other" as const),
        },
  )
}

const READ_NAMES = ["read", "read_file", "view"]
const SHELL_NAMES = [
  "developer__shell",
  "terminal",
  "bash",
  "shell",
  "exec_command",
  "shell_command",
  "run_shell_command",
]

/** A call that reads `file`: the harness's read tool if it has one, else `cat` through its shell tool. */
export function fixtureCall(tools: Tool[], file: string, n: number): Call {
  const fn = tools.filter((t) => t.kind === "function")
  const read = fn.find((t) => READ_NAMES.includes(t.name))
  if (read) {
    const props = read.params?.properties ?? {}
    const key = ["filePath", "path", "file_path"].find((k) => k in props) ?? "path"
    return {
      id: `call_${n}`,
      name: read.name,
      args: fillRequired(read, { [key]: file, ...(read.name === "read_file" ? { offset: 1, limit: 2000 } : {}) }),
    }
  }
  const shell = SHELL_NAMES.map((name) => fn.find((t) => t.name === name)).find(Boolean)
  if (!shell) throw new Error(`no read or shell tool in: ${tools.map((t) => t.name).join(",")}`)
  const props = shell.params?.properties ?? {}
  const cmd = `cat ${file}`
  if ("cmd" in props) return { id: `call_${n}`, name: shell.name, args: fillRequired(shell, { cmd }) }
  if (props.command?.type === "array")
    return { id: `call_${n}`, name: shell.name, args: fillRequired(shell, { command: ["bash", "-lc", cmd] }) }
  return { id: `call_${n}`, name: shell.name, args: fillRequired(shell, { command: cmd }) }
}

/** Plausible values for required arguments the script does not set (e.g. a bash `description`). */
function fillRequired(tool: Tool, args: Record<string, unknown>) {
  const props = tool.params?.properties ?? {}
  for (const key of tool.params?.required ?? []) {
    if (key in args) continue
    const type = props[key]?.type
    args[key] = type === "number" || type === "integer" ? 1 : type === "boolean" ? false : "Read the fixture file"
  }
  return args
}

/** Latest scripted call ID advances the loop even when a harness prunes older results.
 * Identical request retries yield the same next call. Unknown IDs fail explicitly.
 */
export function scriptProgress(results: FixtureEvidence[]): number {
  if (!results.length) return 0
  const indices = results
    .map((r) => /^call_(\d+)(?:_|$)/.exec(r.callId))
    .filter(Boolean)
    .map((m) => Number(m![1]))
  if (!indices.length) throw new Error("Tool results lost all scripted call IDs; cannot advance benchmark safely")
  return Math.max(...indices) + 1
}

// ---- wire formats -----------------------------------------------------------------------
const USAGE = { prompt: 100, completion: 10 }

function chatSSE(turn: Turn, completion: { id: string; created: number }) {
  const delta = turn.call
    ? {
        tool_calls: [
          {
            index: 0,
            id: turn.call.id,
            type: "function",
            function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) },
          },
        ],
      }
    : { content: turn.text }
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: turn.call ? "tool_calls" : "stop" }],
      usage: {
        prompt_tokens: USAGE.prompt,
        completion_tokens: USAGE.completion,
        total_tokens: USAGE.prompt + USAGE.completion,
      },
    },
  ]
  return (
    chunks
      .map(
        (c) =>
          `data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: completion.created, model: "fixture", ...c })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n"
  )
}

let responseSeq = 0
function responsesSSE(turn: Turn, json: any) {
  const id = `resp_${++responseSeq}`
  const base = {
    id,
    object: "response",
    created_at: 1,
    model: json.model ?? "fixture",
    status: "in_progress",
    output: [] as unknown[],
  }
  const item = turn.call
    ? {
        type: "function_call",
        id: `fc_${responseSeq}`,
        call_id: turn.call.id + `_${responseSeq}`,
        name: turn.call.name,
        arguments: JSON.stringify(turn.call.args),
        status: "completed",
      }
    : {
        type: "message",
        id: `msg_${responseSeq}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: turn.text, annotations: [] }],
      }
  const usage = {
    input_tokens: USAGE.prompt,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: USAGE.completion,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: USAGE.prompt + USAGE.completion,
  }
  const events: [string, unknown][] = [
    ["response.created", { type: "response.created", response: base }],
    [
      "response.output_item.added",
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
    ],
  ]
  if (!turn.call)
    events.push([
      "response.output_text.delta",
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: turn.text },
    ])
  events.push(
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
    [
      "response.completed",
      { type: "response.completed", response: { ...base, status: "completed", output: [item], usage } },
    ],
  )
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")
}

/** Privacy-safe evidence: retain only lengths, fixture coverage and hashes, never provider prompts. */
export type FixtureEvidence = {
  callId: string
  bytes: number
  codeUnits: number
  sha256: string
  expectedLines: number
  matchedLines: number
  firstMarker: boolean
  lastMarker: boolean
  complete: boolean
  truncationNotice: boolean
  errorNotice: boolean
  nativeSuppressed: boolean
  nativeGuardrailRefusal: boolean
}
export function fixtureLines(scenario: Scenario): string[] {
  return scenario === "long"
    ? Array.from(
        { length: 800 },
        (_, i) => `line ${String(i + 1).padStart(4, "0")} lorem ipsum dolor sit amet consectetur adipiscing`,
      )
    : Array.from({ length: 20 }, () => "alpha beta gamma")
}
function resultText(value: any): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(resultText).join("\n")
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text
    if (value.content !== undefined) return resultText(value.content)
  }
  return value === undefined ? "" : JSON.stringify(value)
}
export function fixtureEvidence(json: any, api: "chat" | "responses", scenario: Scenario): FixtureEvidence[] {
  const items =
    api === "chat"
      ? (json.messages ?? []).filter((m: any) => m.role === "tool")
      : (Array.isArray(json.input) ? json.input : []).filter((m: any) => m.type?.endsWith("_call_output"))
  const expected = fixtureLines(scenario)
  return items.map((m: any, index: number) => {
    const content = resultText(api === "chat" ? m.content : m.output)
    const flags = nativeResultFlags(content)
    // Native tools can add line numbers/XML envelopes. Require every source line in order,
    // including 20 occurrences of the repeated short fixture, without requiring identical wrappers.
    let cursor = 0,
      matchedLines = 0
    for (const line of expected) {
      const at = content.indexOf(line, cursor)
      if (at < 0) break
      matchedLines++
      cursor = at + line.length
    }
    return {
      callId: String(m.tool_call_id ?? m.call_id ?? index),
      bytes: Buffer.byteLength(content, "utf8"),
      codeUnits: content.length,
      sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      expectedLines: expected.length,
      matchedLines,
      firstMarker: content.includes(expected[0]),
      lastMarker: content.includes(expected.at(-1)!),
      complete: matchedLines === expected.length,
      truncationNotice: flags.truncated,
      errorNotice:
        flags.error || /(?:^|\n)(?:error:|traceback|permission denied|cat:.*(?:No such|denied))/i.test(content),
      nativeSuppressed: flags.suppressed,
      nativeGuardrailRefusal: flags.guardrail,
    }
  })
}

/** Native tools often JSON-encode their result inside OpenAI's string content.
 * Respect explicit booleans: the field `truncated: false` is not a notice.
 */
function nativeResultFlags(content: string) {
  const flags = { truncated: false, error: false, suppressed: false, guardrail: false }
  const humanTruncation = (s: string) =>
    /(?:\btruncated\b|output.{0,30}(?:limit|cap)|(?:lines|characters|bytes) omitted)/i.test(s)
  function walk(value: any) {
    if (typeof value === "string") {
      try {
        walk(JSON.parse(value))
      } catch {
        flags.truncated ||= humanTruncation(value)
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (!value || typeof value !== "object") return
    for (const [key, item] of Object.entries(value)) {
      if (/^truncat/i.test(key)) {
        flags.truncated ||=
          item !== false && item !== null && item !== 0 && item !== "" && !(Array.isArray(item) && !item.length)
        continue
      }
      if (key === "guardrail_refusal" && item === true) {
        flags.guardrail = true
        flags.error = true
      }
      if (
        (key === "is_error" && item === true) ||
        (key === "error" && !!item) ||
        (key === "status" && ["error", "blocked", "refused", "failed"].includes(String(item)))
      )
        flags.error = true
      if ((key === "content_returned" && item === false) || (key === "dedup" && item === true)) flags.suppressed = true
      walk(item)
    }
  }
  walk(content)
  return flags
}
