# NDJSON Event Schema Gaps for Downstream Consumers

Issue: [aictrl-dev/cli#63](https://github.com/aictrl-dev/cli/issues/63)
Date: 2026-04-23
Branch: `feature/ndjson-schema-gaps`

## Problem

The aictrl executor (downstream consumer, `aictrl-dev/aictrl`) aggregates metrics and renders an Agent Activity view from the CLI's `aictrl run --format json` NDJSON stream. Five schema gaps force defensive shape-guessing, stderr parsing, and out-of-band config reads. This work closes those gaps for v1 of the event schema.

## Scope

In scope:

1. Enrich `permission_rejected` payload (stable shape with tool/input/sessionID/callID)
2. New `session_error` event with structured `{reason, code, message}`; deprecate `session_complete.error` string
3. Publish `EVENTS.md` via npm package, new `aictrl events` subcommand, `schemaVersion` in `session_start`
4. Echo resolved permission ruleset in `session_start`
5. Add `sequenceNum` to `reasoning`, `text`, and `tool_use` events; document per-event emission semantics
6. New `permission_granted` event (symmetric with `permission_rejected`)

Out of scope:

- Changing `subagent_start`/`subagent_complete` — already emitted, match downstream fixture.
- Size caps on reasoning text — documented as unbounded; downstream sizes buffers based on observed distribution.
- Back-compat shim for `session_complete.error` — deprecated in docs only this PR; still emitted as today. Full removal deferred to a later CLI major.

## Design

### 1. `permission_rejected` — enriched flat shape

Current emission (`packages/cli/src/cli/cmd/run.ts:622`):

```json
{"type":"permission_rejected","permission":"bash","patterns":["rm -rf /"]}
```

New emission:

```json
{
  "type": "permission_rejected",
  "sessionID": "session_01abc...",
  "callID": "call_01xyz...",
  "tool": "bash",
  "permission": "bash",
  "patterns": ["rm -rf /"],
  "input": { "command": "rm -rf /" }
}
```

Field sources:

- `sessionID` — `permission.asked.sessionID` (already present).
- `callID` — `permission.asked.tool.callID` when present (populated by per-tool `ctx.ask` in `packages/cli/src/session/prompt.ts:786`); omitted otherwise.
- `tool` — tool registry id; see "Tool id threading" below. Falls back to `permission` string if the ask did not originate from a tool execute closure.
- `permission` — kept for back-compat; same string as today.
- `patterns` — unchanged.
- `input` — tool arguments at ask time. See "Input threading" below.
- `reason` — not emitted in v1 (deferred).

Tool id threading: the per-tool `execute(args, options)` closure in `prompt.ts` knows `item.id` and `args`. Wrap the existing `ctx.ask` so it forwards `tool: item.id` and `input: args` into the `PermissionNext.Request.metadata` field. The `permission.asked` bus event already carries `metadata: z.record(...)`. The run.ts consumer reads `metadata.tool` and `metadata.input` when emitting `permission_rejected`.

Edge cases:

- Permission asks not originating from a tool execute closure (e.g., `processor.ts:166` doom_loop check) already populate `metadata.tool` and `metadata.input`; this works automatically.
- Permission asks with no metadata (task subagent permission, `prompt.ts:444`) — emit with `tool` absent and `input: null`. Consumers MUST tolerate missing `tool`/`input`.

### 2. `session_error` event — structured failure

Emitted immediately before `session_complete` on abnormal termination (provider error, auth failure, rate limit, timeout, OOM, uncaught exception in the prompt loop).

```json
{
  "type": "session_error",
  "sessionID": "session_01abc...",
  "reason": "rate_limit",
  "code": "429",
  "message": "Rate limit exceeded: 40000 input tokens per minute"
}
```

`reason` vocabulary (closed set, documented in `EVENTS.md`):

- `rate_limit` — provider returned 429 or equivalent.
- `auth` — 401/403 or missing/invalid API key.
- `timeout` — request timeout at provider or CLI level.
- `oom` — out-of-memory (detected via process exit signal or Node heap error).
- `provider` — any other provider-side error (5xx, malformed response).
- `unknown` — unclassified; `message` contains the raw string.

`code` is the provider HTTP status code when available, otherwise the error `name`/`code` property, otherwise omitted.

Classification happens in the `.catch` blocks of `run.ts:683` and `run.ts:723`. A small helper `classifySessionError(err) -> {reason, code, message}` lives in `packages/cli/src/cli/cmd/run.ts` (or a new `packages/cli/src/cli/cmd/run.errors.ts` if it grows).

`session_complete.error` remains a string for now — set to `message` so existing consumers keep working. `EVENTS.md` marks it **deprecated**; new consumers read `session_error`.

### 3. Schema publishing

Three changes:

a. **`schemaVersion` on `session_start`** — literal `"1"` in this release. Declared as a versioned contract going forward; breaking changes bump the integer.

```json
{"type":"session_start","schemaVersion":"1","model":"...","agent":"...","permissions":[...]}
```

b. **Ship `EVENTS.md` in the npm package** — add `"EVENTS.md"` to `packages/cli/package.json`'s `files` array. Consumers can `require.resolve('aictrl/EVENTS.md')`.

c. **`aictrl events` subcommand** — new CLI command prints the bundled `EVENTS.md` to stdout. Flag `--schema-version` prints just the version string.

Implementation: new file `packages/cli/src/cli/cmd/events.ts`, registered alongside existing commands in the CLI entrypoint. Reads `EVENTS.md` via `import.meta.resolve` (or equivalent bun-compatible path resolution).

### 4. `session_start` — echo permission ruleset

Current (`run.ts:671`):

```json
{"type":"session_start","model":"...","agent":"..."}
```

New:

```json
{
  "type": "session_start",
  "schemaVersion": "1",
  "model": "anthropic/claude-sonnet-4-20250514",
  "agent": "default",
  "permissions": [
    {"permission": "bash", "pattern": "*", "action": "allow"},
    {"permission": "write", "pattern": "*", "action": "ask"},
    {"permission": "webfetch", "pattern": "*", "action": "deny"}
  ]
}
```

`permissions` is the fully-resolved `PermissionNext.Ruleset` — the merge of agent permission and session permission that would be passed to `PermissionNext.ask(...)`. Computed once at session start via the existing `PermissionNext.merge(agent.permission, session.permission ?? [])` call.

In headless mode the effective rule for anything not explicitly `allow` is auto-reject, so downstream can compute "would this have been rejected?" from the echoed ruleset alone.

### 5. `sequenceNum` on event stream

Add a monotonic per-session counter (reset per session, starts at `0`) to the interleavable events:

- `text`
- `reasoning`
- `tool_use`

Top-level events (`session_start`, `session_complete`, `session_error`, `message_complete`, `step_start`, `step_finish`, skill events, subagent events, permission events) do **not** get `sequenceNum`. Timestamps already order them adequately; they don't interleave with reasoning.

Counter implementation: module-level `Map<sessionID, number>` in `run.ts` incremented before each `emit()` call for the three interleavable types. Child session (subagent) sequence numbers are distinct from the parent's — keyed on `part.sessionID`, not the top-level session.

Documentation guarantees:

- `reasoning`: one event per complete reasoning block; text is unbounded in size; consumers must accept arbitrarily large `part.text` strings.
- `text`: one event per complete text block (same as today).
- `tool_use`: one event per completed (or errored) tool call.
- `sequenceNum` is strictly monotonic per session and reflects emission order within that session's stream.

### 6. `permission_granted` event

Symmetric to `permission_rejected`. Emitted when a permission ask resolves to `allow` (either by matching an `allow` rule or by an `always` pattern already on file). Same payload shape as `permission_rejected` minus the rejection-specific framing.

```json
{
  "type": "permission_granted",
  "sessionID": "session_01abc...",
  "callID": "call_01xyz...",
  "tool": "bash",
  "permission": "bash",
  "patterns": ["ls"],
  "input": { "command": "ls" }
}
```

Emission site: `PermissionNext.Event.Replied` (new or existing — see `packages/cli/src/permission/next.ts:99`). The `permission.replied` event fires with `reply: "once" | "always" | "reject"`. In run.ts, subscribe to replies; on `once` or `always`, emit `permission_granted` with metadata from the matching open request (tracked in a `Map<requestID, Request>` populated on `permission.asked`).

Edge case: if a rule matches with `action: "allow"` up front, `PermissionNext.ask` short-circuits without a `permission.replied` event. Add emission at the short-circuit point (see `packages/cli/src/permission/next.ts:139` RejectedError path; mirror for the allow path).

## Testing

Unit tests live in `packages/cli/test/` (following existing convention). Strategy:

- **Event shape snapshots**: for each enriched/new event type, write a fixture test that constructs the underlying bus event and asserts the emitted NDJSON line matches a golden JSON object. Tests target the emission code in `run.ts` directly (extract emitters into pure functions if they aren't already).
- **`classifySessionError` unit tests**: cover each `reason` category with representative error shapes (HTTP 429, `ENOTFOUND`, `AbortError`, heap OOM signal, generic Error).
- **`aictrl events` command**: smoke test that it prints the bundled file and `--schema-version` prints `"1"`.
- **Ruleset echo**: test that `session_start.permissions` equals the merged ruleset for a session with both agent-level and session-level rules.

No full end-to-end test spawning a real provider is needed for this scope; the existing integration tests cover the overall NDJSON stream wiring.

## Migration Notes for Downstream

Consumers pin to `schemaVersion: "1"` on `session_start`.

- `session_complete.error` remains a string; treat as deprecated.
- `permission_rejected` gains fields; existing `permission`/`patterns` keys unchanged.
- `permission_granted` is new; consumers ignoring unknown event types are unaffected.
- `session_error` is new; precedes `session_complete` on failure.
- `sequenceNum` on `text`/`reasoning`/`tool_use` is new; consumers ignoring unknown fields are unaffected.

## Build Order

1. `EVENTS.md` text updates describing final v1 shapes (docs land first so subsequent PRs can reference).
2. Enrich `permission_rejected` (thread tool/input metadata); add `permission_granted`.
3. Enrich `session_start` (schemaVersion + permissions).
4. Add `session_error` + `classifySessionError`; deprecate `session_complete.error` in docs.
5. Add `sequenceNum` to `text`/`reasoning`/`tool_use`.
6. `aictrl events` command + npm `files` addition for `EVENTS.md`.

Each step ships with tests. Whole scope targets a single PR unless review feedback suggests splitting.
