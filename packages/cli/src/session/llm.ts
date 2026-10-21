import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { OutputSchema } from "./output-schema"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  type ToolChoice,
  tool,
  jsonSchema,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"
import { ProviderTermination } from "@/provider/termination"
import { ToolSelection } from "@/tool/selection"
import { ToolGuidance } from "@/tool/guidance"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    // session rules layered over the agent's, e.g. the denies the task tool gives subagent sessions
    permission?: PermissionNext.Ruleset
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: ToolChoice<ToolSet>
    structured?: { reject: (input: string) => Promise<string>; checkpoint: () => () => void; repairs: Set<string> }
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export async function stream(input: StreamInput) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"
    const selected = await resolveTools(input)
    const names = ToolGuidance.capabilities(selected)
    const tools = ToolGuidance.render(selected, names)

    const system = []
    system.push(
      [
        ...leadPrompt(input.agent, isCodex, names),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions(names)
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens = isCodex ? undefined : ProviderTransform.maxOutputTokens(input.model)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = ToolGuidance.bindProtocol(
        tool({
          description:
            "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        }),
      )
    }

    return streamText({
      onError(error) {
        l.error("stream error", {
          error: input.structured ? OutputSchema.summary(error.error) : error,
        })
      },
      async experimental_repairToolCall(failed) {
        if (failed.toolCall.toolName === "StructuredOutput" && input.structured) {
          input.structured.repairs.add(failed.toolCall.toolCallId)
          const error = await input.structured.reject(failed.toolCall.input)
          if (!tools.invalid || !ToolGuidance.isProtocol(tools.invalid)) return null
          return {
            ...failed.toolCall,
            toolName: "invalid",
            input: JSON.stringify({ tool: "StructuredOutput", error }),
          }
        }
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        // A user tool with this name is work, never a repair destination.
        if (!tools.invalid || !ToolGuidance.isProtocol(tools.invalid)) return null
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((name) => name !== "invalid" || !ToolGuidance.isProtocol(tools[name])),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(input.model.providerID !== "anthropic"
          ? {
              "User-Agent": `aictrl/${Installation.VERSION}`,
            }
          : undefined),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: wrapLanguageModel({
        model: language,
        middleware: [
          ProviderTermination.middleware({
            providerID: input.model.providerID,
            modelID: input.model.id,
            npm: input.model.api.npm,
          }),
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  /**
   * The prompt that opens the system message: the agent's own prompt, else the shared base prompt.
   * Codex sign-in sessions send no base prompt here, because they send the Codex header as `options.instructions`.
   */
  function leadPrompt(agent: Agent.Info, isCodex: boolean, tools: ReadonlySet<string>) {
    const prompt = Agent.renderPrompt(agent, tools)
    if (prompt) return [prompt]
    if (isCodex) return []
    return [SystemPrompt.base(tools)]
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
    // same ruleset tool calls are checked against, so a denied tool is never offered to the model
    const ruleset = PermissionNext.merge(input.agent.permission, input.permission ?? [])
    const tools = { ...input.tools }
    const disabled = PermissionNext.disabled(Object.keys(tools), ruleset)
    const selection = ToolSelection.restore(input.user.toolSelection)
    for (const tool of Object.keys(tools)) {
      if (
        input.user.tools?.[tool] === false ||
        disabled.has(tool) ||
        (!ToolGuidance.isProtocol(tools[tool]) && selection.allowlist !== null && !selection.allowlist.includes(tool))
      ) {
        delete tools[tool]
      }
    }
    return tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
