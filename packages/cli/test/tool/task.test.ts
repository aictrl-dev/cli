import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { taskResultText } from "../../src/tool/task"

function result(input: { error?: MessageV2.Assistant["error"]; parts?: MessageV2.Part[] }): MessageV2.WithParts {
  return {
    info: {
      id: "message_1",
      sessionID: "child_1",
      role: "assistant",
      time: { created: 1 },
      error: input.error,
      parentID: "user_1",
      modelID: "model",
      providerID: "provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: input.parts ?? [],
  }
}

describe("task tool child result", () => {
  test("surfaces a child session error with child attribution", () => {
    expect(() =>
      taskResultText(
        result({
          error: new MessageV2.APIError({
            message: "provider unavailable",
            isRetryable: false,
          }).toObject(),
        }),
        "child_1",
      ),
    ).toThrow("Subagent failed (task_id: child_1): provider unavailable")
  })

  test("surfaces the last failed child tool instead of returning empty success", () => {
    expect(() =>
      taskResultText(
        result({
          parts: [
            {
              id: "part_1",
              sessionID: "child_1",
              messageID: "message_1",
              type: "tool",
              callID: "call_1",
              tool: "read",
              state: {
                status: "error",
                input: {},
                error: "permission denied",
                time: { start: 1, end: 2 },
              },
            },
          ],
        }),
        "child_1",
      ),
    ).toThrow("Subagent failed (task_id: child_1): permission denied")
  })

  test("returns the last child text when execution succeeds", () => {
    expect(
      taskResultText(
        result({
          parts: [
            {
              id: "part_1",
              sessionID: "child_1",
              messageID: "message_1",
              type: "text",
              text: "first",
            },
            {
              id: "part_2",
              sessionID: "child_1",
              messageID: "message_1",
              type: "text",
              text: "done",
            },
          ],
        }),
        "child_1",
      ),
    ).toBe("done")
  })
})
