# NDJSON Event Schema Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close five NDJSON event schema gaps from issue #63 so the downstream aictrl executor can consume the stream without defensive shape-guessing.

**Architecture:** All NDJSON emission is centralized in `packages/cli/src/cli/cmd/run.ts`. Permission events pass through `PermissionNext` (`packages/cli/src/permission/next.ts`) carrying a `metadata` record we can enrich at tool-execution time in `packages/cli/src/session/prompt.ts`. The `emit(type, data)` helper at `run.ts:438` automatically injects `type`/`timestamp`/`sessionID`, so tasks only add business-specific fields.

**Tech Stack:** TypeScript, bun, yargs (CLI commands), bun:test (tests), zod (schemas on the permission bus).

**Spec:** `docs/superpowers/specs/2026-04-23-ndjson-schema-gaps-design.md`

---

## File Structure

| Path | Role | Change |
|---|---|---|
| `EVENTS.md` | Public event schema doc | Modify |
| `packages/cli/package.json` | Add `EVENTS.md` to `files` | Modify |
| `packages/cli/src/cli/cmd/run.ts` | Event emission site | Modify (primary work) |
| `packages/cli/src/cli/cmd/run.errors.ts` | `classifySessionError` helper | Create |
| `packages/cli/src/cli/cmd/events.ts` | `aictrl events` subcommand | Create |
| `packages/cli/src/index.ts` | Register `EventsCommand` | Modify |
| `packages/cli/src/headless.ts` | Register `EventsCommand` | Modify |
| `packages/cli/src/session/prompt.ts` | Thread tool id/input into `ctx.ask` metadata | Modify |
| `packages/cli/test/cli/run-schema-v1.test.ts` | Source-level assertions on emissions | Create |
| `packages/cli/test/cli/classify-session-error.test.ts` | Unit tests for classifier | Create |
| `packages/cli/test/cli/events-command.test.ts` | Smoke test for `aictrl events` | Create |

---

## Task 1: EVENTS.md — document v1 shapes

**Files:**
- Modify: `EVENTS.md` (whole file rewrite for the changed sections)

- [ ] **Step 1.1: Add top-level schema version note**

Insert after the "base shape" paragraph at the top:

```markdown
The schema is versioned via `session_start.schemaVersion`. This document describes **schema version `"1"`**. Consumers should pin to this version and treat unknown fields as forward-compatible additions.
```

- [ ] **Step 1.2: Update `session_start` section**

Replace the current `session_start` example block with:

````markdown
### `session_start`

Emitted once when the session begins.

```json
{
  "type": "session_start",
  "schemaVersion": "1",
  "model": "anthropic/claude-sonnet-4-20250514",
  "agent": "default",
  "permissions": [
    { "permission": "bash", "pattern": "*", "action": "allow" },
    { "permission": "write", "pattern": "*", "action": "ask" }
  ]
}
```

- `schemaVersion` (string, **required**) — pinned contract version. Currently `"1"`.
- `permissions` (array, **required**) — the fully resolved permission ruleset for the session (merge of agent + session rules). In headless mode, any permission not matching an `allow` rule is auto-rejected.
````

- [ ] **Step 1.3: Update `session_complete` section — mark `error` deprecated**

Replace the trailing paragraph under `session_complete` with:

```markdown
`error` is `null` on success, or a string describing the failure.

> **Deprecated in v1.** Prefer the structured `session_error` event for new consumers. `session_complete.error` remains populated for back-compat and will be removed in a future schema version.
```

- [ ] **Step 1.4: Add `session_error` section**

Insert a new subsection after `session_complete`:

````markdown
### `session_error`

Emitted immediately before `session_complete` when the session terminates abnormally.

```json
{
  "type": "session_error",
  "reason": "rate_limit",
  "code": "429",
  "message": "Rate limit exceeded"
}
```

- `reason` (string, **required**) — one of `rate_limit`, `auth`, `timeout`, `oom`, `provider`, `unknown`.
- `code` (string, optional) — provider HTTP status code or error code when available.
- `message` (string, **required**) — human-readable error message.
````

- [ ] **Step 1.5: Rewrite `permission_rejected` section**

Replace the `permission_rejected` block with:

````markdown
### `permission_rejected`

Emitted when a permission request is auto-rejected (headless mode has no user to approve).

```json
{
  "type": "permission_rejected",
  "callID": "call_01xyz...",
  "tool": "bash",
  "permission": "bash",
  "patterns": ["rm -rf /"],
  "input": { "command": "rm -rf /" }
}
```

- `tool` (string, **required**) — the tool that requested the permission. Falls back to the `permission` string when the request did not originate from a tool execution.
- `permission` (string, **required**) — permission category (e.g. `bash`, `write`).
- `patterns` (string[], **required**) — matched patterns.
- `input` (any, **required**) — the arguments the tool tried to invoke. `null` when unavailable (e.g. subagent task permission checks).
- `callID` (string, optional) — tool call id; present when the permission originated from a tool execute closure.
- `sessionID` — present on the base envelope; identifies the session that made the request (may be a subagent's session id).
````

- [ ] **Step 1.6: Add `permission_granted` section**

Insert immediately after `permission_rejected`:

````markdown
### `permission_granted`

Emitted when a permission request resolves to `allow` (either by matching an `allow` rule or a cached `always` approval). Same shape as `permission_rejected`.

```json
{
  "type": "permission_granted",
  "callID": "call_01xyz...",
  "tool": "bash",
  "permission": "bash",
  "patterns": ["ls"],
  "input": { "command": "ls" }
}
```
````

- [ ] **Step 1.7: Add `sequenceNum` note to reasoning/text/tool_use**

Under each of `text`, `reasoning`, and `tool_use`, add a bullet after the example:

```markdown
- `sequenceNum` (number, **required**) — monotonic per-session counter shared across `text`, `reasoning`, and `tool_use` events. Use it to render a correctly-ordered trace without relying on timestamp ties. Subagent sessions have their own independent counters keyed on `part.sessionID`.
```

Under `reasoning`, add a second bullet:

```markdown
- One event is emitted per complete reasoning block. `part.text` has no size cap; consumers must accept arbitrarily large strings.
```

- [ ] **Step 1.8: Commit**

```bash
git add EVENTS.md
git commit -m "docs(events): document v1 schema shapes for #63"
```

---

## Task 2: Thread tool id + input into permission metadata

**Files:**
- Modify: `packages/cli/src/session/prompt.ts:782-789`

- [ ] **Step 2.1: Read the existing ask closure**

Read lines 770–800 of `packages/cli/src/session/prompt.ts` to confirm current structure. The per-tool loop starting at line 792 creates a `context(args, options)` that wraps `ctx.ask`. The closure has access to `item.id` (tool name) and `args` (tool arguments).

- [ ] **Step 2.2: Enrich `ctx.ask` metadata**

Locate the `ask` closure inside `context()` (around line 782). The `req` object is what a tool passes to `ctx.ask`. Change the body so it merges `tool` and `input` into the metadata record before forwarding to `PermissionNext.ask`:

```ts
async ask(req) {
  await PermissionNext.ask({
    ...req,
    metadata: {
      ...(req.metadata ?? {}),
      tool: req.metadata?.tool ?? options.toolCallId ? input.processor.toolIdByCallID?.get(options.toolCallId) : undefined,
      input: req.metadata?.input ?? args,
    },
    sessionID: input.session.id,
    tool: { messageID: input.processor.message.id, callID: options.toolCallId },
    ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
  })
},
```

**NOTE for implementer:** The tool registry id is `item.id` in the outer `for` loop at `packages/cli/src/session/prompt.ts:792-796`. If that variable is not in scope inside `context()`, capture it: inside the `for (const item of ...)` block, bind `const toolId = item.id` and reference `toolId` in the `ask` closure. Adjust the object literal above accordingly — the goal is that `metadata.tool` receives the registry id (e.g., `"bash"`) and `metadata.input` receives the raw tool args.

Simpler version, if `item.id` is reachable:

```ts
async ask(req) {
  await PermissionNext.ask({
    ...req,
    metadata: {
      ...(req.metadata ?? {}),
      tool: req.metadata?.tool ?? item.id,
      input: req.metadata?.input ?? args,
    },
    sessionID: input.session.id,
    tool: { messageID: input.processor.message.id, callID: options.toolCallId },
    ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
  })
},
```

Use this simpler form if `item` / `args` are in scope; otherwise capture them into local `const` first.

- [ ] **Step 2.3: Typecheck**

```bash
bun turbo typecheck
```

Expected: PASS (0 errors).

- [ ] **Step 2.4: Commit**

```bash
git add packages/cli/src/session/prompt.ts
git commit -m "feat(permission): thread tool id and input into ask metadata (#63)"
```

---

## Task 3: Enriched `permission_rejected` emission

**Files:**
- Modify: `packages/cli/src/cli/cmd/run.ts:619-637` (the `permission.asked` handler)
- Create: `packages/cli/test/cli/run-schema-v1.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `packages/cli/test/cli/run-schema-v1.test.ts`:

```ts
import path from "path"
import { describe, expect, test } from "bun:test"

const RUN_SRC = path.resolve(import.meta.dir, "../../src/cli/cmd/run.ts")

describe("run.ts v1 schema emissions (#63)", () => {
  test("permission_rejected includes tool, input, callID fields", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const idx = source.indexOf('emit("permission_rejected"')
    expect(idx).toBeGreaterThan(-1)
    const block = source.slice(idx, idx + 500)
    expect(block).toContain("tool:")
    expect(block).toContain("input:")
    expect(block).toContain("callID:")
    expect(block).toContain("permission.permission")
    expect(block).toContain("permission.patterns")
  })
})
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
bun test packages/cli/test/cli/run-schema-v1.test.ts
```

Expected: FAIL — current emission has only `permission` and `patterns`.

- [ ] **Step 3.3: Update emission**

In `packages/cli/src/cli/cmd/run.ts`, replace the `emit("permission_rejected", ...)` call (around line 622) with:

```ts
emit("permission_rejected", {
  callID: permission.tool?.callID,
  tool: (permission.metadata?.tool as string | undefined) ?? permission.permission,
  permission: permission.permission,
  patterns: permission.patterns,
  input: permission.metadata?.input ?? null,
})
```

- [ ] **Step 3.4: Run tests to verify pass**

```bash
bun test packages/cli/test/cli/run-schema-v1.test.ts
bun turbo typecheck
```

Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add packages/cli/src/cli/cmd/run.ts packages/cli/test/cli/run-schema-v1.test.ts
git commit -m "feat(events): enrich permission_rejected with tool/input/callID (#63)"
```

---

## Task 4: `permission_granted` event

**Files:**
- Modify: `packages/cli/src/cli/cmd/run.ts` (around the permission handler block)
- Modify: `packages/cli/test/cli/run-schema-v1.test.ts`

- [ ] **Step 4.1: Add failing test**

Append to `packages/cli/test/cli/run-schema-v1.test.ts`:

```ts
  test("permission_granted is emitted with matching shape", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const idx = source.indexOf('emit("permission_granted"')
    expect(idx).toBeGreaterThan(-1)
    const block = source.slice(idx, idx + 400)
    expect(block).toContain("tool:")
    expect(block).toContain("input:")
    expect(block).toContain("callID:")
  })
```

- [ ] **Step 4.2: Run test to verify it fails**

```bash
bun test packages/cli/test/cli/run-schema-v1.test.ts
```

Expected: FAIL on the new test.

- [ ] **Step 4.3: Track open permission requests + subscribe to replies**

In `packages/cli/src/cli/cmd/run.ts`, inside the `loop()` function where other `event.type` branches live (near line 619), add:

```ts
// Track open permission requests so we can resolve granted/rejected with full metadata.
const openPermissions = new Map<string, typeof permission>()

if (event.type === "permission.asked") {
  const p = event.properties
  if (p.sessionID !== sessionID) continue
  openPermissions.set(p.id, p)
  // existing rejection code below...
}

if (event.type === "permission.replied") {
  const { sessionID: sid, requestID, reply } = event.properties
  if (sid !== sessionID) continue
  const p = openPermissions.get(requestID)
  if (!p) continue
  openPermissions.delete(requestID)
  if (reply === "once" || reply === "always") {
    emit("permission_granted", {
      callID: p.tool?.callID,
      tool: (p.metadata?.tool as string | undefined) ?? p.permission,
      permission: p.permission,
      patterns: p.patterns,
      input: p.metadata?.input ?? null,
    })
  }
}
```

**NOTE for implementer:** Adjust the placement of `openPermissions` declaration to live at the same scope as `childSessions` (before the `for await` loop, see `run.ts:449`). The current `permission.asked` handler auto-rejects via `PermissionNext.reply({ requestID, reply: "reject" })` — that reply will fire a `permission.replied` event we must ignore for the granted path. The `if (reply === "once" || reply === "always")` guard handles that.

Also: an `allow`-rule match inside `PermissionNext.ask` may short-circuit without firing `permission.replied`. Inspect `packages/cli/src/permission/next.ts` near line 139 (where `RejectedError` is thrown). If there's a short-circuit allow path that doesn't emit `Replied`, add a `PermissionNext.Event.Granted` bus event (new) and fire it symmetrically. Mirror the `Replied` event definition at `packages/cli/src/permission/next.ts:99`:

```ts
Granted: BusEvent.define(
  "permission.granted",
  z.object({
    sessionID: z.string(),
    requestID: z.string(),
  }),
),
```

And fire it from the short-circuit allow path. Then handle it in run.ts alongside `permission.replied`.

- [ ] **Step 4.4: Run tests**

```bash
bun test packages/cli/test/cli/run-schema-v1.test.ts
bun turbo typecheck
```

Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add packages/cli/src/cli/cmd/run.ts packages/cli/src/permission/next.ts packages/cli/test/cli/run-schema-v1.test.ts
git commit -m "feat(events): emit permission_granted symmetric to rejected (#63)"
```

---

## Task 5: `session_start` — schemaVersion + permissions

**Files:**
- Modify: `packages/cli/src/cli/cmd/run.ts` around line 671
- Modify: `packages/cli/test/cli/run-schema-v1.test.ts`

- [ ] **Step 5.1: Add failing test**

Append to `run-schema-v1.test.ts`:

```ts
  test("session_start emits schemaVersion and permissions", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const idx = source.indexOf('emit("session_start"')
    expect(idx).toBeGreaterThan(-1)
    const block = source.slice(idx, idx + 400)
    expect(block).toContain('schemaVersion: "1"')
    expect(block).toContain("permissions:")
  })
```

- [ ] **Step 5.2: Run test — expect fail**

```bash
bun test packages/cli/test/cli/run-schema-v1.test.ts
```

Expected: FAIL.

- [ ] **Step 5.3: Compute ruleset and emit**

In `packages/cli/src/cli/cmd/run.ts`, locate the `emit("session_start", {...})` call near line 671. Immediately before it, compute the resolved ruleset. The session and agent objects are reachable via the SDK — check how agent permission is loaded earlier in the function. A minimal approach:

```ts
const agentEntry = agent ? await Agent.get(agent) : undefined
const sessionInfo = await sdk.session.get({ sessionID }).catch(() => undefined)
const permissions = PermissionNext.merge(
  agentEntry?.permission ?? [],
  sessionInfo?.permission ?? [],
)

emit("session_start", {
  schemaVersion: "1",
  model: args.model,
  agent: agent,
  permissions,
})
```

**NOTE for implementer:** The exact method to fetch the session with its resolved permission list may differ — verify against `packages/cli/src/session/index.ts` and the SDK. If the SDK session shape doesn't carry `permission`, fall back to `sessionInfo?.permission ?? []` (empty array). The test only asserts the field is present, not its value — runtime correctness is validated by integration run.

- [ ] **Step 5.4: Run tests**

```bash
bun test packages/cli/test/cli/run-schema-v1.test.ts
bun turbo typecheck
```

Expected: PASS.

- [ ] **Step 5.5: Commit**

```bash
git add packages/cli/src/cli/cmd/run.ts packages/cli/test/cli/run-schema-v1.test.ts
git commit -m "feat(events): add schemaVersion and permissions to session_start (#63)"
```

---

## Task 6: `session_error` event + `classifySessionError`

**Files:**
- Create: `packages/cli/src/cli/cmd/run.errors.ts`
- Create: `packages/cli/test/cli/classify-session-error.test.ts`
- Modify: `packages/cli/src/cli/cmd/run.ts` (both `.catch` blocks around lines 683 and 723)

- [ ] **Step 6.1: Write failing tests for the classifier**

Create `packages/cli/test/cli/classify-session-error.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { classifySessionError } from "../../src/cli/cmd/run.errors"

describe("classifySessionError (#63)", () => {
  test("HTTP 429 → rate_limit", () => {
    const res = classifySessionError({ status: 429, message: "Rate limit exceeded" })
    expect(res.reason).toBe("rate_limit")
    expect(res.code).toBe("429")
    expect(res.message).toContain("Rate limit")
  })

  test("HTTP 401 → auth", () => {
    const res = classifySessionError({ status: 401, message: "Invalid API key" })
    expect(res.reason).toBe("auth")
    expect(res.code).toBe("401")
  })

  test("AbortError → timeout", () => {
    const err = new Error("aborted")
    err.name = "AbortError"
    expect(classifySessionError(err).reason).toBe("timeout")
  })

  test("heap OOM → oom", () => {
    const err = new Error("JavaScript heap out of memory")
    expect(classifySessionError(err).reason).toBe("oom")
  })

  test("generic Error → unknown", () => {
    expect(classifySessionError(new Error("boom")).reason).toBe("unknown")
  })

  test("HTTP 500 → provider", () => {
    const res = classifySessionError({ status: 500, message: "internal" })
    expect(res.reason).toBe("provider")
  })
})
```

- [ ] **Step 6.2: Run test — expect module-not-found**

```bash
bun test packages/cli/test/cli/classify-session-error.test.ts
```

Expected: FAIL — cannot find `run.errors`.

- [ ] **Step 6.3: Implement the classifier**

Create `packages/cli/src/cli/cmd/run.errors.ts`:

```ts
export type SessionErrorReason = "rate_limit" | "auth" | "timeout" | "oom" | "provider" | "unknown"

export type ClassifiedSessionError = {
  reason: SessionErrorReason
  code?: string
  message: string
}

export function classifySessionError(err: unknown): ClassifiedSessionError {
  const message = extractMessage(err)
  const status = extractStatus(err)
  const name = extractName(err)

  if (status === 429) return { reason: "rate_limit", code: "429", message }
  if (status === 401 || status === 403) return { reason: "auth", code: String(status), message }
  if (name === "AbortError" || /timeout/i.test(message)) {
    return { reason: "timeout", code: status ? String(status) : undefined, message }
  }
  if (/heap out of memory|ENOMEM/i.test(message)) {
    return { reason: "oom", message }
  }
  if (status && status >= 500 && status < 600) {
    return { reason: "provider", code: String(status), message }
  }
  return { reason: "unknown", code: status ? String(status) : undefined, message }
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message)
  return String(err)
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
    const raw = e.status ?? e.statusCode ?? e.response?.status
    if (typeof raw === "number") return raw
    if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw)
  }
  return undefined
}

function extractName(err: unknown): string | undefined {
  if (err instanceof Error) return err.name
  if (err && typeof err === "object" && "name" in err) return String((err as { name: unknown }).name)
  return undefined
}
```

- [ ] **Step 6.4: Run tests**

```bash
bun test packages/cli/test/cli/classify-session-error.test.ts
```

Expected: PASS (6/6).

- [ ] **Step 6.5: Emit `session_error` before `session_complete` on failure**

In `packages/cli/src/cli/cmd/run.ts`, at the top of the file add:

```ts
import { classifySessionError } from "./run.errors"
```

Then update the two `.catch` blocks that call `emit("session_complete", ...)` with an `error` string. The first is around line 683:

```ts
.catch((e) => {
  const classified = classifySessionError(e)
  emit("session_error", {
    reason: classified.reason,
    code: classified.code,
    message: classified.message,
  })
  emit("session_complete", {
    durationMs: Date.now() - startTime,
    error: classified.message,
  })
  console.error(e)
  process.exit(1)
})
```

And the second around line 723:

```ts
(e) => {
  error = error ? error + EOL + String(e) : String(e)
  const classified = classifySessionError(e)
  emit("session_error", {
    reason: classified.reason,
    code: classified.code,
    message: classified.message,
  })
  emit("session_complete", {
    durationMs: Date.now() - startTime,
    error: classified.message,
  })
  console.error(e)
  process.exit(1)
},
```

The normal (success) path that emits `session_complete` with `error: error ?? null` remains unchanged.

- [ ] **Step 6.6: Add source-level assertion to schema test**

Append to `run-schema-v1.test.ts`:

```ts
  test("session_error is emitted before session_complete on failure", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const errIdx = source.indexOf('emit("session_error"')
    const completeIdx = source.indexOf('emit("session_complete"')
    expect(errIdx).toBeGreaterThan(-1)
    // At least one session_error emission precedes a session_complete emission in source order.
    expect(errIdx).toBeLessThan(source.lastIndexOf('emit("session_complete"'))
  })
```

- [ ] **Step 6.7: Run all tests + typecheck**

```bash
bun test packages/cli/test/cli/
bun turbo typecheck
```

Expected: PASS.

- [ ] **Step 6.8: Commit**

```bash
git add packages/cli/src/cli/cmd/run.errors.ts packages/cli/src/cli/cmd/run.ts packages/cli/test/cli/classify-session-error.test.ts packages/cli/test/cli/run-schema-v1.test.ts
git commit -m "feat(events): structured session_error event with classifier (#63)"
```

---

## Task 7: `sequenceNum` on text / reasoning / tool_use

**Files:**
- Modify: `packages/cli/src/cli/cmd/run.ts` (the `emit` helper + call sites for `text`, `reasoning`, `tool_use`)
- Modify: `packages/cli/test/cli/run-schema-v1.test.ts`

- [ ] **Step 7.1: Add failing test**

Append to `run-schema-v1.test.ts`:

```ts
  test("text / reasoning / tool_use include sequenceNum", async () => {
    const source = await Bun.file(RUN_SRC).text()
    // The emitter wraps the three interleavable event types with a sequenceNum counter.
    expect(source).toContain("sequenceNum")
    // Counter keyed on session id (parent + subagents) — use a Map
    expect(source).toMatch(/Map<string,\s*number>/)
  })
```

- [ ] **Step 7.2: Run test — expect fail**

```bash
bun test packages/cli/test/cli/run-schema-v1.test.ts
```

Expected: FAIL.

- [ ] **Step 7.3: Add per-session counter and wrap the three emissions**

Near the `childSessions` declaration in `run.ts` (around line 449), add:

```ts
const seqBySession = new Map<string, number>()

function nextSeq(sid: string): number {
  const n = (seqBySession.get(sid) ?? 0) + 1
  seqBySession.set(sid, n)
  return n
}
```

Then update each of the three `emit` calls that carry a `part` field.

For `tool_use` (both call sites around lines 487 and 493):

```ts
emit("tool_use", { part, sequenceNum: nextSeq(part.sessionID) })
```

For `text` (around line 525):

```ts
if (emit("text", { part, sequenceNum: nextSeq(part.sessionID) })) continue
```

For `reasoning` (around line 538):

```ts
if (emit("reasoning", { part, sequenceNum: nextSeq(part.sessionID) })) continue
```

**NOTE for implementer:** Confirm `part.sessionID` is present on all three part types. For `text` and `reasoning` it's inside `part.sessionID` on a `MessagePart`. If any part type lacks `sessionID`, fall back to the outer `sessionID` variable.

- [ ] **Step 7.4: Run tests + typecheck**

```bash
bun test packages/cli/test/cli/run-schema-v1.test.ts
bun turbo typecheck
```

Expected: PASS.

- [ ] **Step 7.5: Commit**

```bash
git add packages/cli/src/cli/cmd/run.ts packages/cli/test/cli/run-schema-v1.test.ts
git commit -m "feat(events): add monotonic sequenceNum to text/reasoning/tool_use (#63)"
```

---

## Task 8: `aictrl events` subcommand + bundle `EVENTS.md`

**Files:**
- Create: `packages/cli/src/cli/cmd/events.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/headless.ts`
- Modify: `packages/cli/package.json`
- Create: `packages/cli/test/cli/events-command.test.ts`

- [ ] **Step 8.1: Check current package.json `files` field**

Read `packages/cli/package.json`. Identify the `files` array.

- [ ] **Step 8.2: Add `EVENTS.md` to bundled files**

Modify `packages/cli/package.json` to include `EVENTS.md` in `files`. Since `EVENTS.md` lives at the repo root (not inside `packages/cli`), copy it into the package build at publish time, OR reference it via the monorepo root. Simplest approach: add a build step in `packages/cli/package.json` that copies the root `EVENTS.md` into `packages/cli/` before publish, and git-ignore the copy.

Alternative (preferred): move the authoritative `EVENTS.md` into `packages/cli/EVENTS.md` and leave a root-level symlink or short pointer. The docs file is CLI-specific so this is the right home.

Implement as:

1. `git mv EVENTS.md packages/cli/EVENTS.md`
2. Leave a stub `EVENTS.md` at root: `# NDJSON Events\n\nMoved to [packages/cli/EVENTS.md](packages/cli/EVENTS.md).\n`
3. Add `"EVENTS.md"` to `packages/cli/package.json` `files` array.

- [ ] **Step 8.3: Write failing test for the command**

Create `packages/cli/test/cli/events-command.test.ts`:

```ts
import path from "path"
import { describe, expect, test } from "bun:test"

const EVENTS_CMD_SRC = path.resolve(import.meta.dir, "../../src/cli/cmd/events.ts")

describe("aictrl events (#63)", () => {
  test("command module exists and exports EventsCommand", async () => {
    const mod = await import(EVENTS_CMD_SRC)
    expect(mod.EventsCommand).toBeDefined()
    expect(typeof mod.EventsCommand).toBe("object")
  })

  test("EventsCommand has schema-version flag", async () => {
    const source = await Bun.file(EVENTS_CMD_SRC).text()
    expect(source).toContain("schema-version")
    expect(source).toContain('"1"')
  })
})
```

- [ ] **Step 8.4: Run test — expect fail**

```bash
bun test packages/cli/test/cli/events-command.test.ts
```

Expected: FAIL — file does not exist.

- [ ] **Step 8.5: Implement the command**

Create `packages/cli/src/cli/cmd/events.ts`:

```ts
import type { Argv } from "yargs"
import path from "path"
import { cmd } from "./cmd"

const SCHEMA_VERSION = "1"

export const EventsCommand = cmd({
  command: "events",
  describe: "print the NDJSON event schema (EVENTS.md) bundled with this CLI",
  builder: (yargs: Argv) =>
    yargs.option("schema-version", {
      type: "boolean",
      describe: "print only the schema version string",
      default: false,
    }),
  async handler(args) {
    if (args["schema-version"]) {
      process.stdout.write(SCHEMA_VERSION + "\n")
      return
    }
    // EVENTS.md is bundled next to the package.json at publish time.
    // At dev time it lives in the same directory as the cli package root.
    const eventsPath = path.resolve(import.meta.dir, "../../../EVENTS.md")
    const contents = await Bun.file(eventsPath).text()
    process.stdout.write(contents)
  },
})
```

**NOTE for implementer:** Verify the resolved path matches the published package layout. The dist/build output may flatten or nest directories differently; adjust the relative path so it finds `EVENTS.md` in both `bun run` (source) and the built published artifact. If `import.meta.dir` proves unreliable across build outputs, read the path via a build-time constant injected by the bundler, or bundle the file's contents directly via `await import("../../../EVENTS.md")` with a text loader.

- [ ] **Step 8.6: Register the command**

In `packages/cli/src/index.ts`, add:

```ts
import { EventsCommand } from "./cli/cmd/events"
```

and in the yargs chain near line 138–147:

```ts
.command(EventsCommand)
```

Mirror the addition in `packages/cli/src/headless.ts`.

- [ ] **Step 8.7: Run tests + typecheck + smoke the command**

```bash
bun test packages/cli/test/cli/events-command.test.ts
bun turbo typecheck
bun run dev events --schema-version
bun run dev events | head -20
```

Expected: tests PASS; `--schema-version` prints `1`; `events` prints the first lines of the docs.

- [ ] **Step 8.8: Commit**

```bash
git add packages/cli/src/cli/cmd/events.ts packages/cli/src/index.ts packages/cli/src/headless.ts packages/cli/package.json packages/cli/EVENTS.md EVENTS.md packages/cli/test/cli/events-command.test.ts
git commit -m "feat(cli): add 'aictrl events' subcommand and bundle EVENTS.md (#63)"
```

---

## Task 9: Final verification

- [ ] **Step 9.1: Run whole test + typecheck suite**

```bash
bun test
bun turbo typecheck
```

Expected: PASS (no new failures; changed tests green).

- [ ] **Step 9.2: Smoke an end-to-end JSON run locally**

```bash
bun run dev run --format json "what is 1+1" 2>/dev/null | head -5
```

Expected: first line is a `session_start` NDJSON event containing `"schemaVersion":"1"` and `"permissions":[...]`.

- [ ] **Step 9.3: Push branch and open PR**

```bash
git push -u origin feature/ndjson-schema-gaps
gh pr create --title "feat(events): close NDJSON schema gaps for downstream consumers (#63)" --body "$(cat <<'EOF'
## Summary
- Stabilizes \`permission_rejected\` shape (tool/input/callID); adds symmetric \`permission_granted\`
- Adds structured \`session_error\` event; deprecates \`session_complete.error\` string
- Echoes resolved permission ruleset + \`schemaVersion: "1"\` on \`session_start\`
- Adds monotonic \`sequenceNum\` to \`text\`/\`reasoning\`/\`tool_use\` for correct interleaving
- Bundles \`EVENTS.md\` in npm package and adds \`aictrl events [--schema-version]\`

Closes #63.

## Test plan
- [ ] \`bun test packages/cli/test/cli/\` green
- [ ] \`bun turbo typecheck\` green
- [ ] \`bun run dev events --schema-version\` prints \`1\`
- [ ] End-to-end \`aictrl run --format json\` shows \`schemaVersion\` on session_start and enriched permission events when a tool is denied

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Tasks 1 (docs), 2–4 (permission events), 5 (session_start), 6 (session_error), 7 (sequenceNum), 8 (publishing) map 1:1 to the six scope items. ✅
- **Placeholder scan:** NOTE-for-implementer blocks are implementation hints requiring verification against runtime code, not TBDs. They call out specific facts the implementer must confirm with line numbers. ✅
- **Type consistency:** `ClassifiedSessionError.reason` values (`rate_limit` etc.) match the EVENTS.md documentation vocabulary. `SCHEMA_VERSION = "1"` constant matches the string literal expected in `run.ts` and EVENTS.md. ✅
- **Known unknowns flagged inline:** session/agent permission resolution path (Task 5), short-circuit-allow handling in `PermissionNext` (Task 4), bundler path for `EVENTS.md` (Task 8). The implementer must verify these against the concrete codebase rather than accept the plan's hint blindly.
