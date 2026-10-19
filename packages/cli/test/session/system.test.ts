import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import PROMPT_DEFAULT from "../../src/session/prompt/default.txt"
import type { Provider } from "../../src/provider/provider"

function model(id: string) {
  return { providerID: "zai-coding-plan", api: { id } } as Provider.Model
}

describe("SystemPrompt.base", () => {
  const prompt = SystemPrompt.base()

  // One prompt for every provider family; llm.test.ts checks that it reaches the OpenAI (GPT-5 and GPT-6 with an
  // API key), Anthropic, Google and OpenAI-compatible payloads.
  test("is the shared default prompt", () => {
    expect(prompt).toBe(PROMPT_DEFAULT)
  })

  // #214: losing the parallel-call nudge reduced batching on GLM.
  test("asks for independent tool calls in one message", () => {
    expect(prompt).toContain("send them together in a single message so they run in parallel")
  })

  // GPT-6 followed the old "prefer the Task tool for file search" line literally and spawned subagents for small searches.
  test("limits the Task tool to broad searches and delegation", () => {
    expect(prompt).toContain("Use the Task tool when a search is broad and open-ended, or when asked to delegate.")
  })

  // Headless runs reject unapproved calls; without this, Gemini investigated or explored around a denied call.
  test("says not to retry or work around rejected tool calls", () => {
    expect(prompt).toContain(
      "If a tool call is rejected by permissions, don't retry it or work around it; continue without it, or report that it is blocked.",
    )
  })

  // read.ts and prompt.ts inject <system-reminder> tags into tool results and user messages.
  test("explains system-reminder tags", () => {
    expect(prompt).toContain("Tool results and user messages may include <system-reminder> tags.")
  })

  test("keeps the no-comments rule", () => {
    expect(prompt).toContain("IMPORTANT: DO NOT ADD ***ANY*** COMMENTS unless asked")
  })
})

describe("SystemPrompt.environment", () => {
  test("sends the env block without an empty directories block", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const env = (await SystemPrompt.environment(model("glm-5.3"))).join("\n")
        expect(env).toContain(`Working directory: ${tmp.path}`)
        expect(env).toContain("Is directory a git repo: yes")
        expect(env.trimEnd().endsWith("</env>")).toBe(true)
        expect(env).not.toContain("<directories>")
      },
    })
  })
})
