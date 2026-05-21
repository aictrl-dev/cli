import path from "path"
import { describe, expect, test } from "bun:test"

const RUN_SRC = path.resolve(import.meta.dir, "../../src/cli/cmd/run.ts")

// Regression lock for aictrl-dev/cli#70:
//   `aictrl run` was exiting 0 even when the provider rejected authentication.
//   Root cause: the run-command's `session.error` event handler logged the
//   error but did not set `process.exitCode`, so the subsequent
//   `session.status: idle` broke the loop into the success branch and the
//   process terminated with code 0 — masking broken CI workflows wrapping it.
describe("run.ts session.error → non-zero exit (#70)", () => {
  test("session.error handler sets process.exitCode for the primary session", async () => {
    const source = await Bun.file(RUN_SRC).text()
    const handlerIdx = source.indexOf('if (event.type === "session.error")')
    expect(handlerIdx).toBeGreaterThan(-1)

    // Bound the block to the next `if (event.type === ` so we only inspect
    // this handler — not whatever happens to follow it in source.
    const after = source.slice(handlerIdx + 1)
    const nextHandlerOffset = after.indexOf('if (event.type === "')
    const handlerBlock =
      nextHandlerOffset === -1 ? after : after.slice(0, nextHandlerOffset)

    // The handler must mark the process as failed. Either form is acceptable:
    //   - process.exitCode = N (preferred — lets loop drain cleanly)
    //   - process.exit(N)
    const setsExitCode =
      /process\.exitCode\s*=\s*[1-9]/.test(handlerBlock) ||
      /process\.exit\s*\(\s*[1-9]/.test(handlerBlock)
    expect(setsExitCode).toBe(true)
  })

  test("exit propagation is gated on the primary session, not subagents", async () => {
    // A subagent's session.error must NOT take the whole process down;
    // only the primary session's failure should propagate to the exit code.
    const source = await Bun.file(RUN_SRC).text()
    const handlerIdx = source.indexOf('if (event.type === "session.error")')
    const after = source.slice(handlerIdx + 1)
    const nextHandlerOffset = after.indexOf('if (event.type === "')
    const handlerBlock =
      nextHandlerOffset === -1 ? after : after.slice(0, nextHandlerOffset)

    // The block must reference the primary `sessionID` check before exit propagation —
    // the existing handler already gates the local `error` string on
    // `props.sessionID === sessionID`, and the exit propagation must use the
    // same gate.
    expect(handlerBlock).toContain("props.sessionID === sessionID")
  })
})
