import { describe, expect, spyOn, test } from "bun:test"
import { APICallError } from "ai"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { tmpdir } from "../fixture/fixture"

describe("processor terminal error publication", () => {
  test.each([false, true])("waits for subscribers before returning (retryable=%s)", async (retryable) => {
    await using tmp = await tmpdir({
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
        const session = await Session.create({})
        const model = await Provider.getModel("fixture", "gemini-fixture")
        const agent = await Agent.get("build")
        const abort = new AbortController().signal
        const user: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: model.providerID, modelID: model.id },
        }
        const message: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          parentID: user.id,
          role: "assistant",
          time: { created: Date.now() },
          agent: agent.name,
          mode: agent.name,
          modelID: model.id,
          providerID: model.providerID,
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        await Session.updateMessage(user)
        await Session.updateMessage(message)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const unsub = Bus.subscribe(Session.Event.Error, async () => {
          entered.resolve()
          await release.promise
        })
        const stream = spyOn(LLM, "stream").mockRejectedValue(
          new APICallError({
            url: "https://fixture.invalid",
            requestBodyValues: {},
            message: "fixture provider error",
            statusCode: retryable ? 500 : 400,
            isRetryable: retryable,
          }),
        )
        const sleep = spyOn(SessionRetry, "sleep").mockResolvedValue()
        let finished = false
        const processing = SessionProcessor.create({ assistantMessage: message, sessionID: session.id, model, abort })
          .process({ user, sessionID: session.id, model, agent, abort, system: [], messages: [], tools: {} })
          .then((result) => {
            finished = true
            return result
          })
        try {
          await entered.promise
          // Give the processor time to return if it accidentally fire-and-forgets the subscriber.
          await Bun.sleep(30)
          expect(finished).toBe(false)
          release.resolve()
          await processing
          expect(message.error).toBeDefined()
          expect(stream).toHaveBeenCalledTimes(retryable ? SessionRetry.MAX_RETRY_ATTEMPTS + 1 : 1)
        } finally {
          release.resolve()
          await processing
          stream.mockRestore()
          sleep.mockRestore()
          unsub()
        }
      },
    })
  })
})
