# NDJSON Events

When the parsed `aictrl run --format json` handler starts, the CLI emits newline-delimited JSON (NDJSON) events to stdout. Each line is a self-contained JSON object with the following base shape:

```json
{
  "type": "<event_type>",
  "timestamp": 1741500000000,
  "invocationID": "7d142250-8bdc-43df-99af-efa252db62a7",
  "sessionID": "session_01abc..."
}
```

`invocationID` is present on every event from `run --format json`. `sessionID` is present only after a real session has been created; invocation events never fabricate one.

The schema is versioned via `invocation_start.schemaVersion` and `session_start.schemaVersion`. This document describes **schema version `"1"`**. Consumers should pin to this version and treat unknown fields as forward-compatible additions.

The invocation envelope covers accepted `run --format json` executions from the first line of the parsed handler through validation, bootstrap, session creation, and execution. Argument-parser failures, other commands, and process-global uncaught exceptions or unhandled rejections are outside this contract.

## Lifecycle Events

### `invocation_start`

Emitted once, before piped stdin is read and before run validation or bootstrap begins.

```json
{
  "type": "invocation_start",
  "timestamp": 1741500000000,
  "schemaVersion": "1",
  "invocationID": "7d142250-8bdc-43df-99af-efa252db62a7"
}
```

This event intentionally has no `sessionID`, because a session does not exist yet.

### `invocation_error`

Emitted for a fatal error before session creation, immediately before `invocation_complete`.

```json
{
  "type": "invocation_error",
  "timestamp": 1741500000001,
  "schemaVersion": "1",
  "invocationID": "7d142250-8bdc-43df-99af-efa252db62a7",
  "phase": "validation",
  "code": "INVOCATION_FILE_NOT_FOUND",
  "message": "Invocation failed during validation"
}
```

- `phase` (string, **required**) — one of `validation`, `stdin`, `bootstrap`, or `session`.
- `code` (string, **required**) — stable machine-readable error category.
- `message` (string, **required**) — sanitized human-readable phase summary. Details remain on stderr and in the log.

Errors after a real session has been created use `session_error` instead. They also set
`invocation_complete.status` to `error`, so the invocation result always agrees with the process result.

### `invocation_complete`

Emitted exactly once for every started invocation.

```json
{
  "type": "invocation_complete",
  "timestamp": 1741500000123,
  "schemaVersion": "1",
  "invocationID": "7d142250-8bdc-43df-99af-efa252db62a7",
  "sessionID": "session_01abc...",
  "status": "completed",
  "durationMs": 123
}
```

- `status` (string, **required**) — `completed` or `error`.
- `durationMs` (number, **required**) — elapsed invocation time.
- `sessionID` (string, optional) — included only when a real session was created.

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

### `tool_catalog`

Emitted once per session, immediately after `session_start` and before the first model turn (present even for zero-turn or immediately-failing runs). Lists every tool and skill that was resolved for the session so consumers can structurally verify tool exposure without string-matching the model's prose.

```json
{
  "type": "tool_catalog",
  "sessionID": "ses_…",
  "timestamp": 1741500000000,
  "tools": [
    { "name": "record_finding", "source": "mcp", "server": "aictrl" },
    { "name": "record_review_completed", "source": "mcp", "server": "aictrl" },
    { "name": "bash", "source": "builtin" },
    { "name": "read", "source": "builtin" }
  ],
  "skills": [
    { "name": "code-review", "version": "1.4.0" },
    { "name": "fullstack-code-review", "version": null }
  ]
}
```

#### `tools[]` — builtin and MCP tools resolved for this session

- **`name`** (string, **required**) — the tool/function name as exposed to the model. Mirrors upstream `ToolListItem.id`. For MCP tools this is `{serverName}_{toolName}` (both sanitised to `[a-zA-Z0-9_-]`).
- **`source`** (string, **required**) — `"builtin"` for tools built into the CLI; `"mcp"` for tools provided by a connected MCP server.
- **`server`** (string, optional) — the MCP server (client name from config) that provides this tool. Present only when `source` is `"mcp"`.

`description` and `parameters` are intentionally omitted to keep the event lean. The primary consumer only needs `name` + `source` to verify tool exposure.

#### `skills[]` — skill packs resolved for this session (separate from `tools[]`)

- **`name`** (string, **required**) — skill name from `SKILL.md` frontmatter.
- **`version`** (string or null, **required**) — version string from the `version` field in `SKILL.md` frontmatter. `null` when no version is declared.

> **Use case:** The server-side completion gate (aictrl-dev/aictrl #3216) uses `tools[]` to verify that `record_finding` and `record_review_completed` were actually in the model's function list at dispatch time, and `skills[]` to record which skill version produced the review. Detects the "silent success" failure mode where a missing MCP server lets a run complete green without ever having the review tools available.
>
> **Note on builtin tool filtering:** The `source: "builtin"` entries in `tools[]` reflect the _instance-level superset_ registered in `ToolRegistry`. Per-model filters (e.g. `apply_patch` only on gpt-\*, `codesearch`/`websearch` only for aictrl provider) are applied at dispatch time inside `resolveTools` and are **not** reflected here. Consumers should treat the presence of a builtin tool name as "registered and potentially available", not as "guaranteed to appear in the model's function list". The strong structural guarantee (tool present ↔ tool in dispatch list) applies only to `source: "mcp"` entries.

### `session_complete`

Emitted once when the session ends (success or failure).

```json
{
  "type": "session_complete",
  "durationMs": 12345,
  "error": null
}
```

`error` is `null` on success, or a string describing the failure.

> **Deprecated in v1.** Prefer the structured `session_error` event for new consumers. `session_complete.error` remains populated for back-compat and will be removed in a future schema version.
>
> Note: `session_error` is only emitted when the session terminates abnormally (provider/auth/rate-limit/timeout/OOM). Non-fatal errors that accumulate during an otherwise-successful run surface as individual `error` events and may also appear concatenated in `session_complete.error` without a preceding `session_error`. Alerting logic should key on `session_error`, not on `session_complete.error`.

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

## Message Events

### `message_complete`

Emitted when a primary-session assistant message finishes (one per LLM turn). Child-session assistant messages are
excluded; use the child-session lifecycle events when tracking subagents.

```json
{
  "type": "message_complete",
  "messageID": "msg_01abc...",
  "modelID": "claude-sonnet-4-20250514",
  "providerID": "anthropic",
  "agent": "default",
  "status": "completed",
  "usageStatus": "reported",
  "cost": { "input": 0.003, "output": 0.012, "cache": { "read": 0, "write": 0 } },
  "tokens": {
    "total": 11360,
    "input": 1024,
    "output": 512,
    "reasoning": 0,
    "cache": { "read": 8800, "write": 1024 }
  },
  "context": { "used": 10848, "limit": 200000, "ratio": 0.05424 },
  "finish": "tool-calls"
}
```

- `messageID` (string, **required**) — stable assistant-message identity. A message produces at most one `message_complete`; consumers should use this field rather than timestamps for identity.
- `status` (string, **required**) — `"completed"`, `"error"`, or `"aborted"`.
- `usageStatus` (string, **required**) — `"reported"` when the provider supplied usage, `"missing"` when it did not, or `"estimated"` for an explicitly estimated future source. The CLI does not currently estimate usage.
- `finish` (string, optional) — provider finish reason, such as `"tool-calls"`, `"end_turn"`, or `"max_tokens"`. It can be absent on failed or aborted turns.

**`tokens`** (5-way breakdown, mirrors upstream `LLM.Usage`):

- `total` (number) — provider-reported total, or a finite total computed from sufficient reported components.
- `input` (number) — raw input tokens billed at the standard input rate.
- `output` (number) — output (completion) tokens.
- `reasoning` (number) — extended-thinking / reasoning tokens (0 when thinking is off).
- `cache.read` (number) — tokens served from the prompt cache (billed at cache-read rate). Distinguishes cache hits from fresh input.
- `cache.write` (number) — tokens written to the prompt cache (billed at cache-write rate).

These fields are non-overlapping: a token is counted in exactly one bucket.

`tokens` is `null` when `usageStatus` is `"missing"`. This distinguishes unavailable usage from a provider-reported zero, which has `usageStatus: "reported"` and numeric zero fields. The additional identity, status, and provenance fields are additive to schema v1; successful events retain the existing `modelID`, `providerID`, `agent`, `cost`, `tokens`, `context`, and `finish` fields.

For compatibility with sessions written before usage provenance was persisted, a legacy terminal message with a finish reason is treated as `"reported"`; one without a finish reason is treated as `"missing"`.

**`context`** (context-window utilization):

- `used` (number) — tokens occupying the model's context window this turn: `input + cache.read + cache.write`.
- `limit` (number) — the model's total context-window size in tokens, sourced from the models.dev registry (`model.limit.context`).
- `ratio` (number) — `used / limit` (≥0; may exceed 1 if usage exceeds the model's registered limit). A value approaching or exceeding 1 signals context-exhaustion risk.
- `null` — emitted when the model's context limit is not known (e.g. unregistered custom endpoint), or usage is missing.

### `text`

Emitted when a text block from the assistant is complete.

```json
{
  "type": "text",
  "part": {
    "type": "text",
    "text": "Here is the result...",
    "time": { "start": 1741500000, "end": 1741500001 }
  }
}
```

- `sequenceNum` (number, **required**) — monotonic per-session counter shared across `text`, `reasoning`, and `tool_use` events. Use it to render a correctly-ordered trace without relying on timestamp ties. Subagent sessions have their own independent counters keyed on `part.sessionID`. Note: in JSON mode only `tool_use` events are emitted for subagent sessions, so subagent counters increment only on tool_use.

### `reasoning`

Emitted when extended thinking content is complete (requires `--thinking` flag).

```json
{
  "type": "reasoning",
  "part": {
    "type": "reasoning",
    "text": "Let me think about this...",
    "time": { "start": 1741500000, "end": 1741500001 }
  }
}
```

- `sequenceNum` (number, **required**) — monotonic per-session counter shared across `text`, `reasoning`, and `tool_use` events. Use it to render a correctly-ordered trace without relying on timestamp ties. Subagent sessions have their own independent counters keyed on `part.sessionID`. Note: in JSON mode only `tool_use` events are emitted for subagent sessions, so subagent counters increment only on tool_use.
- One event is emitted per complete reasoning block. `part.text` has no size cap; consumers must accept arbitrarily large strings.

## Tool Events

### `tool_use`

Emitted when a tool call completes (success or error). This includes tools executed within subagent sessions.

```json
{
  "type": "tool_use",
  "part": {
    "type": "tool",
    "tool": "bash",
    "sessionID": "session_01abc...",
    "state": {
      "status": "completed",
      "input": { "command": "ls" },
      "metadata": { "exit": 0, "output": "..." }
    }
  }
}
```

- `sequenceNum` (number, **required**) — monotonic per-session counter shared across `text`, `reasoning`, and `tool_use` events. Use it to render a correctly-ordered trace without relying on timestamp ties. Subagent sessions have their own independent counters keyed on `part.sessionID`. Note: in JSON mode only `tool_use` events are emitted for subagent sessions, so subagent counters increment only on tool_use.

`state.status` is `"completed"` or `"error"`. On error, `state.error` contains the error message.

For tools executed inside a subagent, `part.sessionID` will differ from the top-level `sessionID` — compare the two to identify subagent tool calls.

### `step_start` / `step_finish`

Emitted at step boundaries during multi-step tool use.

```json
{ "type": "step_start", "part": { "type": "step-start" } }
{ "type": "step_finish", "part": { "type": "step-finish" } }
```

## Skill Events

Skills are loaded progressively. The model first sees skill names and descriptions in the tool schema. Full skill content only enters context when the model explicitly invokes the skill tool.

### `skill_discovered`

Emitted per skill when the skill tool is initialized and skill descriptions are registered in the tool schema. This happens at the start of each LLM turn.

```json
{
  "type": "skill_discovered",
  "name": "commit",
  "description": "Create well-structured git commits",
  "location": "/home/user/.claude/skills/commit/SKILL.md"
}
```

### `skill_loaded`

Emitted when the model invokes the skill tool and the full SKILL.md content enters context.

```json
{
  "type": "skill_loaded",
  "name": "commit",
  "location": "/home/user/.claude/skills/commit/SKILL.md"
}
```

### `skill_resource_loaded`

Emitted when the model reads a file that belongs to a skill directory (e.g., a script, template, or reference file bundled with the skill).

```json
{
  "type": "skill_resource_loaded",
  "skillName": "commit",
  "filePath": "/home/user/.claude/skills/commit/templates/conventional.md"
}
```

## Subagent Events

### `subagent_start`

Emitted when a child session (subagent) is spawned.

```json
{
  "type": "subagent_start",
  "subagentSessionID": "session_01xyz...",
  "parentSessionID": "session_01abc...",
  "title": "Research codebase"
}
```

### `subagent_complete`

Emitted when a child session completes.

```json
{
  "type": "subagent_complete",
  "subagentSessionID": "session_01xyz...",
  "parentSessionID": "session_01abc..."
}
```

## Error Events

### `error`

Emitted when a session error occurs.

```json
{
  "type": "error",
  "error": {
    "name": "Unknown",
    "data": { "message": "Something went wrong" }
  },
  "sourceSessionID": "session_01abc..."
}
```

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
