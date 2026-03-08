# Phase 01: Process Exit Path - Research

**Researched:** 2026-03-08
**Domain:** CLI process lifecycle, error propagation, exit codes
**Confidence:** HIGH

## Summary

This phase addresses two specific bugs that cause `aictrl run` to silently swallow errors in headless CI mode: (1) the fire-and-forget `.catch(() => {})` on `SessionPrompt.prompt()` and `SessionPrompt.command()` in the local SDK stub at `run.ts:713-730`, and (2) the `uncaughtException`/`unhandledRejection` handlers in `index.ts:32-42` that log but never call `process.exit(1)`.

The codebase already has a well-structured error flow for the "normal" case: the event loop in `execute()` listens for `session.error` bus events and accumulates error strings, while `session.status` idle events break the loop. The top-level `index.ts` try/catch sets `process.exitCode = 1` on error. The problem is specifically that errors from `SessionPrompt.prompt()` are silently discarded before they can reach either the bus event system or the top-level catch.

**Primary recommendation:** Remove the `.catch(() => {})` calls, let `SessionPrompt.prompt()`/`.command()` errors propagate to the `execute()` function's `await loopDone` or directly to the top-level catch, and add `process.exit(1)` to both `uncaughtException` and `unhandledRejection` handlers as a safety net.

## Standard Stack

This phase requires no new libraries. All changes are to existing code in the `packages/cli/src` directory.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Bun runtime | (project default) | Runtime, test runner | Already used by the project |
| bun:test | (bundled) | Unit testing | Already used for all CLI tests |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@aictrl/util/error` (NamedError) | (workspace) | Structured error types | Already used for error formatting |

**Installation:** No new packages needed.

## Architecture Patterns

### Current Error Flow (run.ts)

```
index.ts (top-level)
  try { await cli.parse() }
    -> RunCommand.handler()
      -> bootstrap()
        -> execute(sdk)
          -> loop() [event listener on GlobalBus]
          -> sdk.session.prompt(...)  <-- BUG: .catch(() => {})
          -> await loopDone
  catch (e) { process.exitCode = 1 }
  finally { process.exit() }
```

### Current Bug Analysis

**Bug 1 (PROC-01): Fire-and-forget `.catch(() => {})`**

Location: `packages/cli/src/cli/cmd/run.ts` lines 713-720 and 722-730

```typescript
// CURRENT (buggy) - local SDK stub
async prompt(opts: any) {
  SessionPrompt.prompt({
    sessionID: opts.sessionID,
    parts: opts.parts,
    agent: opts.agent,
    model: opts.model,
    variant: opts.variant,
  }).catch(() => {})  // <-- SILENTLY SWALLOWS ALL ERRORS
},
async command(opts: any) {
  SessionPrompt.command({
    // ...
  }).catch(() => {})  // <-- SAME BUG
},
```

Why it was originally written this way: The `prompt()` and `command()` calls are intentionally fire-and-forget because the `execute()` function uses a separate event loop (`loop()`) to wait for completion via `session.status` idle events on the bus. The prompt kicks off async processing, and the event loop picks up results. However, if `SessionPrompt.prompt()` throws BEFORE it can emit any bus events (e.g., validation error, session not found, model resolution failure before the LLM loop starts), the error is silently eaten.

The fix must preserve the fire-and-forget semantics (prompt starts, event loop waits for completion) while ensuring that if the promise rejects, the error propagates to cause a non-zero exit.

**Bug 2 (PROC-02): Exception handlers without `process.exit(1)`**

Location: `packages/cli/src/index.ts` lines 32-42

```typescript
// CURRENT (buggy)
process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
  // No process.exit(1) -- process continues running
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
  // No process.exit(1) -- process continues running
  // Also: only logs e.message, not e.stack
})
```

### Pattern 1: Error Propagation via Shared Promise Variable

**What:** Store the prompt/command promise and race it against the event loop, so either path can surface errors.

**When to use:** When two async operations run concurrently and either can fail.

```typescript
// FIXED pattern
async prompt(opts: any) {
  // Don't await -- fire-and-forget is intentional for the event loop pattern
  // But DO NOT silently swallow errors
  SessionPrompt.prompt({
    sessionID: opts.sessionID,
    parts: opts.parts,
    agent: opts.agent,
    model: opts.model,
    variant: opts.variant,
  })
  // No .catch(() => {}) -- let unhandled rejection propagate
  // The uncaughtException/unhandledRejection handler will catch it
},
```

**Alternative (more explicit):** Capture the promise and handle its rejection in `execute()`.

```typescript
// In execute():
let promptError: Error | undefined

// In the local SDK stub:
async prompt(opts: any) {
  SessionPrompt.prompt({ ... }).catch((e) => {
    promptError = e instanceof Error ? e : new Error(String(e))
  })
},

// After await loopDone:
if (promptError) throw promptError
```

### Pattern 2: Safety Net Exit Handler

**What:** The `uncaughtException` and `unhandledRejection` handlers should always exit the process with code 1 after logging.

```typescript
// FIXED pattern
process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
    stack: e instanceof Error ? e.stack : undefined,
  })
  process.exit(1)
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
    stack: e instanceof Error ? e.stack : undefined,
  })
  process.exit(1)
})
```

### Anti-Patterns to Avoid

- **Bare `.catch(() => {})` on critical-path promises:** The root cause of PROC-01. Never silently swallow errors from operations that can fail in ways the process needs to know about. The `.catch(() => {})` pattern is only acceptable for truly non-critical cleanup operations (file deletion, unsubscription).
- **Logging without exiting in uncaughtException:** The Node.js/Bun documentation explicitly states that after an uncaught exception, the application is in an undefined state. The process must exit.
- **Only logging `e.message` in exception handlers:** Stack traces are essential for debugging. Always preserve `e.stack`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Error formatting | Custom error stringification | Existing `FormatError` + `FormatUnknownError` in `cli/error.ts` | Already handles NamedError, standard Error, and unknown types |
| Bus event error propagation | Custom event emitter | Existing `Bus.publish(Session.Event.Error, ...)` pattern | Already used throughout `session/prompt.ts` and `session/processor.ts` |
| Process exit handling | Custom exit handler | Existing top-level try/catch/finally in `index.ts` | Already sets exitCode and calls process.exit() |

**Key insight:** The error infrastructure already exists and works well. The bugs are specifically about two places where errors are prevented from reaching that infrastructure.

## Common Pitfalls

### Pitfall 1: Breaking the Fire-and-Forget Pattern

**What goes wrong:** If you `await SessionPrompt.prompt()` in the local SDK stub, the event loop (`loop()`) never starts processing events because `execute()` blocks waiting for prompt to complete. But the prompt itself emits events that the loop needs to consume.

**Why it happens:** The `execute()` function starts `loop()` first (which listens for bus events), then calls `sdk.session.prompt()` (which triggers the LLM and emits events). These are concurrent operations.

**How to avoid:** Keep the fire-and-forget semantics. Do NOT add `await` before `SessionPrompt.prompt()`. Instead, handle rejection separately -- either by capturing the promise and checking it after `await loopDone`, or by letting the unhandled rejection handler catch it.

**Warning signs:** If `aictrl run` hangs after the fix, you broke the concurrency. The loop must start before the prompt.

### Pitfall 2: Double Exit on Error

**What goes wrong:** If `SessionPrompt.prompt()` throws, the error might cause both the `loopDone.catch()` handler (which calls `process.exit(1)`) and the `uncaughtException` handler (which also calls `process.exit(1)`) to fire.

**Why it happens:** An unhandled rejection from the prompt might trigger the global handler AND the loopDone catch.

**How to avoid:** Make sure the prompt rejection is either handled by the local SDK stub's catch (setting a variable) OR handled by the global handler, but not both. The safest approach is to capture the promise in the local SDK stub.

**Warning signs:** If tests show double error output, investigate the propagation path.

### Pitfall 3: Hanging Event Loop After Prompt Error

**What goes wrong:** If `SessionPrompt.prompt()` fails before emitting any `session.status` idle event, the event `loop()` in `execute()` waits forever because it only breaks when it receives `session.status` with `type: "idle"`.

**Why it happens:** The `loop()` function iterates over the bus event stream and only breaks on idle status. If the prompt fails before it can set idle status, no break event is emitted.

**How to avoid:** The `cancel()` function in `SessionPrompt` calls `SessionStatus.set(sessionID, { type: "idle" })`, which publishes the idle event. When catching a prompt error, need to ensure the session transitions to idle. However, examining the code: `SessionPrompt.prompt()` uses `using _ = defer(() => cancel(sessionID))` which means `cancel` runs when the prompt function's scope exits (including on error). This means: if `SessionPrompt.prompt()` enters the `loop()` call and then throws, the `defer` will call `cancel()` which will emit idle. BUT if `SessionPrompt.prompt()` throws BEFORE reaching `loop()` (e.g., during `Session.get()` or `createUserMessage()`), the `defer` in `loop` never runs. Check if `prompt` itself has cleanup.

Looking at the code flow:
- `SessionPrompt.prompt()` calls `Session.get()`, `createUserMessage()`, then `loop()`.
- `loop()` calls `start(sessionID)` which creates the abort controller and then has `using _ = defer(() => cancel(sessionID))`.
- If `Session.get()` throws (before `loop`), no cleanup runs, no idle event is emitted, the event loop hangs.

**This is critical:** The fix must handle both early failures (before the session loop starts) and late failures (during LLM processing).

**Warning signs:** Tests where the test process hangs without exiting indicate this pitfall.

### Pitfall 4: Missing the `command()` Path

**What goes wrong:** The same `.catch(() => {})` bug exists on both `prompt()` and `command()` in the local SDK stub. Fixing only one leaves the other broken.

**Why it happens:** Copy-paste code with identical bug.

**How to avoid:** Fix both `prompt()` (line 720) and `command()` (line 730) in the same task.

### Pitfall 5: Error Object Serialization in JSON Format

**What goes wrong:** When `--format json` is used, errors need to be emitted as proper NDJSON events, not just logged to stderr.

**Why it happens:** The `emit("session_complete", { error: ... })` call in `loopDone.then()` uses the accumulated `error` string, but if the prompt fails before any events are emitted, the session_complete event might not include the actual error.

**How to avoid:** Ensure prompt failures are captured and included in the `session_complete` event's `error` field.

## Code Examples

### Fix for PROC-01: Remove .catch(() => {}) and Capture Errors

```typescript
// Source: packages/cli/src/cli/cmd/run.ts (local SDK stub, lines 711-731)

// APPROACH: Capture the prompt promise, handle rejection after loopDone
// This preserves fire-and-forget while propagating errors

// Inside execute(), add a variable to capture prompt errors:
let promptDone: Promise<void> = Promise.resolve()

// In the local SDK stub:
async prompt(opts: any) {
  promptDone = SessionPrompt.prompt({
    sessionID: opts.sessionID,
    parts: opts.parts,
    agent: opts.agent,
    model: opts.model,
    variant: opts.variant,
  }).then(
    () => {},
    () => {},  // Silently handle here -- errors surface via bus events
  )
  // NOTE: SessionPrompt.prompt errors that happen BEFORE the loop starts
  // (e.g., Session.get fails) won't emit bus events. See alternative below.
},
```

**Alternative approach (recommended):** Let the prompt promise reject, and race it with loopDone.

```typescript
// Inside execute():
let promptResult: Promise<any>

// In the local SDK stub:
async prompt(opts: any) {
  // Store but don't await -- fire-and-forget with error capture
  promptResult = SessionPrompt.prompt({
    sessionID: opts.sessionID,
    parts: opts.parts,
    agent: opts.agent,
    model: opts.model,
    variant: opts.variant,
  })
},

// After the prompt call, replace `await loopDone` with:
// Wait for EITHER the event loop to complete OR the prompt to fail
await Promise.all([
  loopDone,
  promptResult.catch((e) => {
    // If prompt rejects, the loop might hang forever
    // because no idle event was emitted.
    // Signal the error and ensure we exit.
    error = error ? error + EOL + String(e) : String(e)
  }),
])
```

### Fix for PROC-02: Add process.exit(1) and Stack Traces

```typescript
// Source: packages/cli/src/index.ts (lines 32-42)

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
    stack: e instanceof Error ? e.stack : undefined,
  })
  process.exit(1)
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
    stack: e instanceof Error ? e.stack : undefined,
  })
  process.exit(1)
})
```

### Regression Test Pattern

```typescript
// Source: packages/cli/test/fixture/fixture.ts pattern + bun:test
// Test: Verify that a prompt failure causes non-zero exit

import { describe, expect, test } from "bun:test"
import { $ } from "bun"

describe("aictrl run error propagation", () => {
  test("exits non-zero when SessionPrompt.prompt fails", async () => {
    // Run aictrl with conditions that cause SessionPrompt.prompt to fail
    // e.g., invalid model, invalid session, network error simulation
    const result = await $`bun run packages/cli/src/index.ts run "test" --model invalid/model`
      .nothrow()
      .quiet()
    expect(result.exitCode).not.toBe(0)
  })
})
```

**Note:** The exact test approach depends on how easily SessionPrompt.prompt can be made to fail deterministically in tests. The existing test infrastructure uses `Instance.provide()` with tmpdir fixtures. A unit test approach would mock SessionPrompt to throw, while an integration test would use invalid configuration.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Log-only uncaughtException handler | Log + `process.exit(1)` | Node.js best practice since v15+ (2020) | Process MUST exit after uncaught exception per Node.js docs |
| `.catch(() => {})` to prevent unhandled rejections | Explicit error handling or `.catch(log)` | Node.js v15+ changed to terminate on unhandled rejections | Silent swallowing is never appropriate on critical-path code |

**Deprecated/outdated:**
- Bun historically had incomplete `process.on("uncaughtException")` support (issue #5219), but this has been resolved since Bun 1.1.8+.

## Open Questions

1. **Event loop hang when prompt fails before `loop()` starts**
   - What we know: If `SessionPrompt.prompt()` throws during `Session.get()` or `createUserMessage()` (before entering the internal `loop()` function), no `session.status` idle event is emitted, and the event loop in `execute()` hangs forever.
   - What's unclear: Whether the `Promise.all` approach (racing promptResult with loopDone) is sufficient, or if we need to explicitly break the event loop when prompt fails.
   - Recommendation: The `Promise.all` approach should work because `promptResult.catch` will set the `error` variable, but `loopDone` will still hang. Need to either: (a) use `Promise.race` instead of `Promise.all`, or (b) have the catch handler also break the event loop. Option (b) could be done by emitting a `session.status` idle event in the catch handler: `SessionStatus.set(sessionID, { type: "idle" })`. But this requires the sessionID which is available in the `execute` closure. The planner should consider this carefully.

2. **Test isolation for process.exit tests**
   - What we know: Testing `process.exit(1)` behavior requires either spawning a subprocess (like `process.test.ts` does with `Process.run()`) or mocking `process.exit`.
   - What's unclear: Whether the Bun test runner supports `process.exit` mocking cleanly, or if subprocess-based tests are required.
   - Recommendation: Use subprocess-based testing (spawn `bun run ... run "message" --model invalid/model`, check exit code) for the regression test. This matches the pattern in `test/util/process.test.ts`.

3. **The `loopDone.catch` already calls `process.exit(1)`**
   - What we know: At line 651-658 of run.ts, `loopDone.catch((e) => { ... process.exit(1) })` already exits on event loop errors.
   - What's unclear: If we remove `.catch(() => {})` from prompt and let errors propagate, will the `loopDone.catch` path fire? It depends on whether the prompt error causes `loop()` to throw or reject.
   - Recommendation: The prompt error and the loop error are independent promises. The prompt error won't cause `loopDone` to reject (they're separate promise chains). The fix must handle prompt errors separately from loop errors.

## Sources

### Primary (HIGH confidence)
- Direct code inspection of `packages/cli/src/cli/cmd/run.ts` - Fire-and-forget bug at lines 713-730
- Direct code inspection of `packages/cli/src/index.ts` - Exception handler bug at lines 32-42
- Direct code inspection of `packages/cli/src/session/prompt.ts` - `SessionPrompt.prompt()` and `loop()` internals
- Direct code inspection of `packages/cli/src/session/status.ts` - How idle events are emitted
- Direct code inspection of `packages/cli/src/cli/error.ts` - Existing error formatting infrastructure

### Secondary (MEDIUM confidence)
- [Bun runtime process module docs](https://bun.com/reference/node/process) - process.exit behavior
- [Bun uncaughtException support (issue #429)](https://github.com/oven-sh/bun/issues/429) - Historical context, resolved since Bun 1.1.8

### Tertiary (LOW confidence)
- [Node.js exit best practices](https://dev.to/leapcell/do-you-really-understand-nodejs-process-exit-27j1) - General patterns, not Bun-specific

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new libraries needed, all changes to existing code
- Architecture: HIGH - Direct code inspection, clear understanding of the error flow
- Pitfalls: HIGH - Identified through code analysis, particularly the event loop hang scenario

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable domain, low change velocity)
