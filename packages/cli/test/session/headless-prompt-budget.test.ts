import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import z from "zod"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider/provider"
import { PermissionNext } from "../../src/permission/next"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { InstructionPrompt } from "../../src/session/instruction"
import { ToolRegistry } from "../../src/tool/registry"
import { HeadlessRun } from "../../src/flag/headless-run"
import { alibabaProvider } from "../fixture/providers"

/**
 * Characters in the fixed prefix (system prompt plus tool definitions) that a
 * headless `aictrl run` of the build agent sends on every step, before any
 * conversation content. Set just above the current size: lower it whenever a
 * change shrinks the prefix, and never raise it without a reason (#160).
 */
const HEADLESS_PREFIX_BUDGET = 15_000

type Piece = { name: string; chars: number }

/** System prompt pieces, assembled the way SessionPrompt and LLM.stream assemble them. */
async function systemPieces(model: Provider.Model): Promise<Piece[]> {
  const instructions = await InstructionPrompt.system()
  return [
    { name: "system: provider prompt", chars: SystemPrompt.provider(model).join("\n").length },
    { name: "system: environment", chars: (await SystemPrompt.environment(model)).join("\n").length },
    { name: "system: instructions", chars: instructions.join("\n").length },
  ]
}

/** Tool definitions the model receives: the registry list minus what LLM.stream drops. */
async function toolPieces(model: Provider.Model, agent: Agent.Info): Promise<Piece[]> {
  const tools = await ToolRegistry.tools({ providerID: model.providerID, modelID: model.api.id }, agent)
  const disabled = PermissionNext.disabled(
    tools.map((tool) => tool.id),
    agent.permission,
  )
  return tools
    .filter((tool) => tool.id !== "invalid" && !disabled.has(tool.id))
    .map((tool) => ({
      name: `tool: ${tool.id}`,
      chars: tool.id.length + tool.description.length + JSON.stringify(z.toJSONSchema(tool.parameters)).length,
    }))
}

function breakdown(pieces: Piece[]) {
  return pieces
    .toSorted((a, b) => b.chars - a.chars)
    .map((piece) => `  ${piece.name.padEnd(28)} ${String(piece.chars).padStart(6)} chars`)
    .join("\n")
}

describe("headless request prefix budget (#160)", () => {
  beforeAll(() => HeadlessRun.enable())
  afterAll(() => HeadlessRun.disable())

  test("system prompt plus tool definitions stay within the budget", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { ...alibabaProvider, options: { apiKey: "test-key" } } },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // The skill tool lists every discovered skill; the fixture must not find any.
        expect(await Skill.all()).toEqual([])

        const model = await Provider.getModel("alibaba", "qwen-plus")
        const agent = await Agent.get("build")
        const pieces = [...(await systemPieces(model)), ...(await toolPieces(model, agent))]
        const total = pieces.reduce((sum, piece) => sum + piece.chars, 0)

        const report = [
          `Headless request prefix is ${total} chars (~${Math.round(total / 4)} tokens); budget is ${HEADLESS_PREFIX_BUDGET}.`,
          breakdown(pieces),
        ].join("\n")
        if (total > HEADLESS_PREFIX_BUDGET) throw new Error(report)
        console.log(report)
      },
    })
  })
})
