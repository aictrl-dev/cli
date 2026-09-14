import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import type { MessageV2 } from "../../src/session/message-v2"

function tool(input: {
  status?: "pending" | "running" | "completed" | "error"
  providerExecuted?: boolean
  interrupted?: boolean
}) {
  const status = input.status ?? "completed"
  return {
    id: "part_1",
    sessionID: "session_1",
    messageID: "message_1",
    type: "tool",
    callID: "call_1",
    tool: "read",
    metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
    state:
      status === "pending"
        ? { status, input: {}, raw: "{}" }
        : status === "running"
          ? { status, input: {}, time: { start: 1 } }
          : status === "completed"
            ? {
                status,
                input: {},
                output: "ok",
                title: "read",
                metadata: {},
                time: { start: 1, end: 2 },
              }
            : {
                status,
                input: {},
                error: "failed",
                metadata: input.interrupted ? { interrupted: true } : undefined,
                time: { start: 1, end: 2 },
              },
  } as MessageV2.ToolPart
}

describe("session prompt tool-call continuation", () => {
  test("detects non-provider-executed tool calls that require another model turn", () => {
    expect(SessionPrompt.hasToolCalls([tool({ status: "pending" })])).toBe(true)
    expect(SessionPrompt.hasToolCalls([tool({ status: "completed" })])).toBe(true)
    expect(SessionPrompt.hasToolCalls([tool({ status: "error" })])).toBe(true)
  })

  test("ignores provider-executed and cleanup-interrupted tool calls", () => {
    expect(SessionPrompt.hasToolCalls([tool({ providerExecuted: true })])).toBe(false)
    expect(SessionPrompt.hasToolCalls([tool({ status: "error", interrupted: true })])).toBe(false)
  })
})
