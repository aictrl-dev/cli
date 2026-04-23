# NDJSON Events

When running `aictrl run --format json`, the CLI emits newline-delimited JSON (NDJSON) events to stdout. Each line is a self-contained JSON object with the following base shape:

```json
{
  "type": "<event_type>",
  "timestamp": 1741500000000,
  "sessionID": "session_01abc..."
}
```

The schema is versioned via `session_start.schemaVersion`. This document describes **schema version `"1"`**. Consumers should pin to this version and treat unknown fields as forward-compatible additions.

## Lifecycle Events

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

Emitted when an assistant message finishes (one per LLM turn).

```json
{
  "type": "message_complete",
  "modelID": "claude-sonnet-4-20250514",
  "providerID": "anthropic",
  "agent": "default",
  "cost": { "input": 0.003, "output": 0.012, "cache": { "read": 0, "write": 0 } },
  "tokens": { "input": 1024, "output": 512, "cache": { "read": 0, "write": 0 } },
  "finish": "tool-calls"
}
```

`finish` values: `"tool-calls"` (model wants to call tools), `"end_turn"` (model is done), `"max_tokens"` (output truncated).

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

- `sequenceNum` (number, **required**) — monotonic per-session counter shared across `text`, `reasoning`, and `tool_use` events. Use it to render a correctly-ordered trace without relying on timestamp ties. Subagent sessions have their own independent counters keyed on `part.sessionID`.

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

- `sequenceNum` (number, **required**) — monotonic per-session counter shared across `text`, `reasoning`, and `tool_use` events. Use it to render a correctly-ordered trace without relying on timestamp ties. Subagent sessions have their own independent counters keyed on `part.sessionID`.
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

- `sequenceNum` (number, **required**) — monotonic per-session counter shared across `text`, `reasoning`, and `tool_use` events. Use it to render a correctly-ordered trace without relying on timestamp ties. Subagent sessions have their own independent counters keyed on `part.sessionID`.

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
