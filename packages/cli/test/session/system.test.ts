import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import type { Provider } from "../../src/provider/provider"

function model(id: string) {
  return { providerID: "zai-coding-plan", api: { id } } as Provider.Model
}

describe("SystemPrompt.provider default prompt", () => {
  const prompt = SystemPrompt.provider(model("glm-5.3")).join("\n")

  test("is used for models without a dedicated prompt", () => {
    for (const id of ["qwen-plus", "deepseek-chat", "kimi-k2"]) {
      expect(SystemPrompt.provider(model(id)).join("\n")).toBe(prompt)
    }
  })

  // #214: losing the parallel-call nudge reduced batching on GLM.
  test("asks for independent tool calls in one message", () => {
    expect(prompt).toContain("send them together in a single message so they run in parallel")
  })

  test("keeps the Task tool file-search line", () => {
    expect(prompt).toContain("When doing file search, prefer to use the Task tool in order to reduce context usage.")
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
