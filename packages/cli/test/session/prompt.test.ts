import path from "path"
import { describe, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "url"
import { Identifier } from "../../src/id/id"
import type { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { alibabaProvider } from "../fixture/providers"

Log.init({ print: false })

describe("session.prompt missing file", () => {
  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "does-not-exist.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "still-missing.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      // The prompt names no model, so it falls back to the default model. Declare the only
      // provider here instead of relying on credentials that earlier test files left behind.
      config: {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { ...alibabaProvider, options: { apiKey: "test-key" } } },
      },
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await SessionPrompt.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "aictrl", modelID: "kimi-k2.5-free" },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: "openai", modelID: "gpt-5.2" })
          expect(match.info.variant).toBe("xhigh")

          const override = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

describe("session.prompt session permission", () => {
  test("passes the session's permission rules to the model request", async () => {
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
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const permission: PermissionNext.Ruleset = [{ permission: "webfetch", action: "deny", pattern: "*" }]
        const session = await Session.create({ title: "Session permission", permission })
        const requests: LLM.StreamInput[] = []
        const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
          requests.push(input)
          return {
            fullStream: (async function* () {
              yield { type: "start-step" }
              yield { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
            })(),
          } as unknown as Awaited<ReturnType<typeof LLM.stream>>
        })
        try {
          await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: "fixture", modelID: "gemini-fixture" },
            parts: [{ type: "text", text: "Finish the task" }],
          })
          const turns = requests.filter((request) => request.agent.name === "build")
          expect(turns).toHaveLength(1)
          expect(turns[0].permission).toEqual(permission)
        } finally {
          stream.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  })
})

describe("session.prompt unknown agent", () => {
  test("names the missing agent when a client still asks for the removed plan agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await expect(
          SessionPrompt.prompt({
            sessionID: session.id,
            agent: "plan",
            noReply: true,
            parts: [{ type: "text", text: "Plan the change" }],
          }),
        ).rejects.toMatchObject({
          data: { message: expect.stringContaining('Agent not found: "plan". Available agents:') },
        })
        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt removed tools", () => {
  test("continues a session whose history calls the removed question and plan tools", async () => {
    const requests: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push((await request.json()) as Record<string, unknown>)
        const chunks = [
          { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] },
          { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Done" } }] },
          {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]
        const body = chunks
          .map((chunk) => `data: ${JSON.stringify(chunk)}`)
          .concat("data: [DONE]")
          .join("\n\n")
        return new Response(body + "\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } })
      },
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          enabled_providers: ["alibaba"],
          provider: {
            alibaba: { ...alibabaProvider, options: { apiKey: "test-key", baseURL: `${server.url.origin}/v1` } },
          },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const model = { providerID: "alibaba", modelID: "qwen-plus" }
          const session = await Session.create({ title: "Session from an older release" })
          const user = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "plan",
            model,
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: user.id,
            type: "text",
            text: "Plan the change",
          })
          const assistant = await Session.updateMessage({
            id: Identifier.ascending("message"),
            sessionID: session.id,
            parentID: user.id,
            role: "assistant",
            mode: "plan",
            agent: "plan",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.modelID,
            providerID: model.providerID,
            finish: "stop",
            time: { created: Date.now(), completed: Date.now() },
          })
          const calls = [
            { tool: "question", error: undefined },
            { tool: "plan_enter", error: "The user dismissed this question" },
            { tool: "plan_exit", error: undefined },
          ]
          for (const call of calls) {
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: assistant.id,
              type: "tool",
              callID: `call_${call.tool}`,
              tool: call.tool,
              state: call.error
                ? { status: "error", input: {}, error: call.error, time: { start: 1, end: 2 } }
                : {
                    status: "completed",
                    input: {},
                    output: "User answered",
                    title: call.tool,
                    metadata: {},
                    time: { start: 1, end: 2 },
                  },
            })
          }

          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            parts: [{ type: "text", text: "Continue" }],
          })

          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") throw new Error("expected assistant message")
          expect(result.info.error).toBeUndefined()
          expect(requests).toHaveLength(1)
          const history = JSON.stringify(requests[0].messages)
          for (const call of calls) expect(history).toContain(`call_${call.tool}`)
          const tools = (requests[0].tools as Array<{ function: { name: string } }>).map((item) => item.function.name)
          expect(tools).toContain("read")
          expect(tools).not.toContain("question")
          expect(tools).not.toContain("plan_enter")
          expect(tools).not.toContain("plan_exit")
          await Session.remove(session.id)
        },
      })
    } finally {
      server.stop()
    }
  }, 15_000)
})
