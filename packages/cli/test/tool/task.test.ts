import { describe, expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import type { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { Plugin } from "../../src/plugin"
import { TaskTool, completeTask, taskResultText } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

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

  test("falls back to the child error name when data is absent or malformed", () => {
    for (const data of [undefined, null, "bad data"]) {
      expect(() =>
        taskResultText(
          result({ error: { name: "ChildFailed", data } as unknown as MessageV2.Assistant["error"] }),
          "child_1",
        ),
      ).toThrow("Subagent failed (task_id: child_1): ChildFailed")
    }
  })

  test("notifies plugins before propagating a child failure", async () => {
    const events: string[] = []
    const trigger = spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
      events.push(name)
      return output
    })
    try {
      await expect(
        completeTask(
          result({ error: { name: "ChildFailed" } as unknown as MessageV2.Assistant["error"] }),
          "child_1",
          "parent_1",
        ),
      ).rejects.toThrow("Subagent failed (task_id: child_1): ChildFailed")
      expect(events).toEqual(["agent.subtask.complete"])
      expect(trigger).toHaveBeenCalledWith(
        "agent.subtask.complete",
        { subagentSessionID: "child_1", parentSessionID: "parent_1" },
        { result: "" },
      )
    } finally {
      trigger.mockRestore()
    }
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

describe("task tool subagent session", () => {
  test("applies the caller session's rules to the subagent, beneath the subagent denies", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          fixture: {
            npm: "@ai-sdk/google",
            options: { apiKey: "fixture" },
            models: { "gemini-fixture": { name: "fixture", limit: { context: 100000, output: 1000 } } },
          },
        },
        experimental: { primary_tools: ["websearch"] },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const inherited: PermissionNext.Ruleset = [
          { permission: "webfetch", action: "deny", pattern: "*" },
          { permission: "task", action: "allow", pattern: "*" },
        ]
        const parent = await Session.create({ title: "Caller", permission: inherited })
        const caller = await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: Identifier.ascending("message"),
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "gemini-fixture",
          providerID: "fixture",
          time: { created: Date.now() },
          sessionID: parent.id,
        })
        const requests: LLM.StreamInput[] = []
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          requests.push(input)
          return {
            fullStream: (async function* () {
              yield { type: "start-step" }
              yield { type: "text-start" }
              yield { type: "text-delta", text: "done" }
              yield { type: "text-end" }
              yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        try {
          const tool = await TaskTool.init()
          const result = await tool.execute(
            { description: "Explore", prompt: "Look around", subagent_type: "general" },
            {
              sessionID: parent.id,
              messageID: caller.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { bypassAgentCheck: true },
              messages: [],
              metadata() {},
              async ask() {},
            },
          )
          const child = await Session.get(result.metadata.sessionId)
          const subagent = requests.filter((request) => request.sessionID === child.id)
          expect(subagent).toHaveLength(1)
          expect(subagent[0].permission).toEqual([
            ...inherited,
            { permission: "todowrite", action: "deny", pattern: "*" },
            { permission: "todoread", action: "deny", pattern: "*" },
            { permission: "task", action: "deny", pattern: "*" },
            // primary-only tools stay unavailable to subagents
            { permission: "websearch", action: "deny", pattern: "*" },
          ])
        } finally {
          stream.mockRestore()
          await Session.remove(parent.id)
        }
      },
    })
  })
})
