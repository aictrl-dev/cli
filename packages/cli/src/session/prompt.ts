import { OutputSchema } from "./output-schema"
import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, asSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { Plugin } from "../plugin"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { ToolRegistry } from "../tool/registry"
import { ToolGuidance } from "../tool/guidance"
import { MCP } from "../mcp"
import { ReadTool } from "../tool/read"
import { FileTime } from "../file/time"
import { ulid } from "ulid"
import { Command } from "../command"
import { $, fileURLToPath, pathToFileURL } from "bun"
import { ConfigMarkdown } from "../config/markdown"
import { NamedError } from "@aictrl/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { iife } from "@/util/iife"
import { Truncate } from "@/tool/truncation"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to submit your final response as a JSON file.

IMPORTANT:
- First write the final result as JSON to a file in the working directory, matching the schema below
- Then call this tool with that file's path; the file is validated and published as written
- If the file is rejected, fix the file and call this tool again with its path
- Complete all necessary research and tool calls BEFORE calling this tool`

const STRUCTURED_OUTPUT_MISSING =
  "write the final result as JSON to a file in the working directory, then call StructuredOutput with its path"

const STRUCTURED_OUTPUT_REJECTED = `a tool call was rejected; ${STRUCTURED_OUTPUT_MISSING}`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. Write your final result as JSON to a file in the working directory, then call the StructuredOutput tool with that file's path. Do NOT respond with plain text.`

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })

  export function hasToolCalls(parts: MessageV2.Part[]) {
    return parts.some(
      (part) =>
        part.type === "tool" &&
        part.metadata?.[MessageV2.PROVIDER_EXECUTED_METADATA_KEY] !== true &&
        (part.state.status === "completed" ||
          (part.state.status === "error" &&
            (part.state.error !== MessageV2.TOOL_EXECUTION_ABORTED ||
              part.metadata?.[MessageV2.PROVIDER_EXECUTED_METADATA_KEY] === false))),
    )
  }

  export function isModelFinished(finish?: string) {
    return !!finish && !["tool-calls", "unknown"].includes(finish)
  }

  export async function missingStructuredOutput(message: MessageV2.Assistant, load: () => Promise<MessageV2.Part[]>) {
    if (!isModelFinished(message.finish) || message.error) return false
    return !hasToolCalls(await load())
  }

  // A schema turn that stops without a result earns a corrective reminder: a
  // prose-only finish, or a rejected tool call (a permission auto-rejected in
  // headless mode, or a dismissed question; #135). The reminder names the
  // rejected tools, never their input.
  async function missingResult(processor: SessionProcessor.Info) {
    if (processor.blocked.length && !processor.message.error)
      return {
        diagnostic: { path: "", keyword: "rejected", message: STRUCTURED_OUTPUT_REJECTED },
        reminder: `Tool call rejected: ${processor.blocked.join(", ")}. Using what you already have, ${STRUCTURED_OUTPUT_MISSING}`,
      }
    if (await missingStructuredOutput(processor.message, () => MessageV2.parts(processor.message.id)))
      return {
        diagnostic: { path: "", keyword: "missing", message: STRUCTURED_OUTPUT_MISSING },
        reminder: STRUCTURED_OUTPUT_MISSING,
      }
  }

  // The abort controller of each session whose prompt is running.
  const state = Instance.state(
    () => {
      const data: Record<string, AbortController> = {}
      return data
    },
    async (current) => {
      for (const abort of Object.values(current)) abort.abort()
    },
  )

  export const PromptInput = z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message").optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    // Claim the session before writing the user message, so a second prompt
    // fails before it leaves a message for the running loop to pick up.
    const abort = start(input.sessionID)
    const message = await recordPrompt(input).catch((error) => {
      endBeforeLoop(input.sessionID, abort)
      throw error
    })

    if (input.noReply === true) {
      endBeforeLoop(input.sessionID, abort)
      return message
    }

    return run(input.sessionID, abort)
  })

  async function recordPrompt(input: PromptInput) {
    if (input.format?.type === "json_schema") OutputSchema.compile(input.format.schema)
    const session = await Session.get(input.sessionID)

    const message = await createUserMessage(input)
    await Session.touch(input.sessionID)

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.setPermission({ sessionID: session.id, permission: permissions })
    }

    return message
  }

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: pathToFileURL(filepath).href,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  // A session runs one prompt at a time. Messages are never queued for a
  // running loop, so a second prompt for a busy session is a caller bug.
  function start(sessionID: string) {
    const s = state()
    if (s[sessionID]) throw new Session.BusyError(sessionID)
    const controller = new AbortController()
    s[sessionID] = controller
    return controller.signal
  }

  // Only the prompt that claimed a session frees it, so a cancelled prompt that
  // is still unwinding can never free a newer prompt's claim.
  function release(sessionID: string, abort: AbortSignal) {
    const s = state()
    if (s[sessionID]?.signal === abort) delete s[sessionID]
  }

  // Ends a prompt that stops before its loop: a failed message write, or noReply.
  // A cancelled prompt publishes idle, because cancel() leaves that to the owner.
  // Otherwise no idle is published: run.ts sees the rejection instead.
  function endBeforeLoop(sessionID: string, abort: AbortSignal) {
    release(sessionID, abort)
    if (abort.aborted) SessionStatus.set(sessionID, { type: "idle" })
  }

  // Asks the running prompt to stop and returns false: the prompt that owns the
  // claim frees it and publishes idle. With no prompt running, publishes idle.
  export function cancel(sessionID: string) {
    log.info("cancel", { sessionID })
    const match = state()[sessionID]
    if (!match) {
      SessionStatus.set(sessionID, { type: "idle" })
      return true
    }
    match.abort()
    return false
  }

  export const LoopInput = z.object({
    sessionID: Identifier.schema("session"),
  })
  export const loop = fn(LoopInput, async (input) => run(input.sessionID, start(input.sessionID)))

  async function run(sessionID: string, abort: AbortSignal) {
    using _ = defer(() => {
      release(sessionID, abort)
      // Keep idle after processor persistence. Headless consumers use this as
      // the boundary after which all terminal message events have been queued.
      SessionStatus.set(sessionID, { type: "idle" })
    })

    // Structured output state
    // Note: On session resumption, state is reset but outputFormat is preserved
    // on the user message and will be retrieved from lastUser below
    let structuredOutput: unknown | undefined
    let attempts = 0
    let rejected = 0
    let reminder: string | undefined
    let user: string | undefined
    let contract:
      | {
          format: MessageV2.OutputFormat & { type: "json_schema" }
          validate: ReturnType<typeof OutputSchema.compile>
        }
      | undefined
    let outcome: OutputSchema.Outcome | undefined
    let failed = false

    let step = 0
    const session = await Session.get(sessionID)
    while (true) {
      SessionStatus.set(sessionID, { type: "busy" })
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

      let lastUser: MessageV2.User | undefined
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")
      const request = msgs.findLast(
        (msg) =>
          msg.info.role === "user" &&
          (!msg.parts.length ||
            !msg.parts.every(
              (part) =>
                part.type === "compaction" || part.type === "subtask" || (part.type === "text" && part.synthetic),
            )),
      )?.info as MessageV2.User | undefined
      if (request && user !== request.id) {
        user = request.id
        contract =
          request.format?.type === "json_schema"
            ? { format: request.format, validate: OutputSchema.compile(request.format.schema) }
            : undefined
        attempts = 0
        rejected = 0
        reminder = undefined
        structuredOutput = undefined
      }
      const lastAssistantMsg = msgs.findLast((msg) => msg.info.id === lastAssistant?.id)
      if (
        lastAssistant &&
        isModelFinished(lastAssistant.finish) &&
        !hasToolCalls(lastAssistantMsg?.parts ?? []) &&
        lastUser.id < lastAssistant.id &&
        !reminder
      ) {
        log.info("exiting loop", { sessionID })
        break
      }

      step++
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      if (step > maxSteps) {
        const error = contract
          ? new MessageV2.StructuredOutputError({
              message: "Agent step limit reached without structured output",
              retries: Math.max(0, attempts - 1),
            }).toObject()
          : new MessageV2.APIError({
              message: `Agent step limit (${maxSteps}) reached before a final response.`,
              isRetryable: false,
            }).toObject()
        if (contract) {
          outcome = { status: "failed", reason: "step_limit", attempts }
          if (lastAssistant) {
            delete lastAssistant.structured
            lastAssistant.error = error
            lastAssistant.time.completed = Date.now()
            await Session.updateMessage(lastAssistant)
          }
        }
        if (
          lastAssistant &&
          (lastAssistant.finish === "tool-calls" || lastAssistant.finish === "unknown") &&
          !lastAssistant.summary &&
          !msgs
            .find((msg) => msg.info.id === lastAssistant.id)
            ?.parts.some((part) => part.type === "tool" && part.tool === TaskTool.id)
        ) {
          lastAssistant.error = error
          lastAssistant.time.completed = Date.now()
          await Session.updateMessage(lastAssistant)
        }
        await Bus.publish(Session.Event.Error, { sessionID, error })
        break
      }
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        }).catch((e) => log.error("ensureTitle failed", { error: e }))

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID).catch((e) => {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${e.data.providerID}/${e.data.modelID}.${hint}`,
            }).toObject(),
          })
        }
        throw e
      })
      const task = tasks.pop()

      // pending subtask
      // TODO: centralize "invoke tool" logic
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
        const assistantMessage = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          usageStatus: "missing",
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        let part = (await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        }
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          { args: taskArgs },
        )
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        const taskCtx: Tool.Context = {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          messages: msgs,
          async metadata(input) {
            await Session.updatePart({
              ...part,
              type: "tool",
              state: {
                ...part.state,
                ...input,
              },
            } satisfies MessageV2.ToolPart)
          },
          async ask(req) {
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }
        const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        const attachments = result?.attachments?.map((attachment) => ({
          ...attachment,
          id: Identifier.ascending("part"),
          sessionID,
          messageID: assistantMessage.id,
        }))
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "task",
            sessionID,
            callID: part.id,
            args: taskArgs,
          },
          result,
        )
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: part.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserMsg: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: lastUser.model,
          }
          await Session.updateMessage(summaryUserMsg)
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }

        continue
      }

      // pending compaction
      if (task?.type === "compaction") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
        })
        if (result === "stop") {
          failed = true
          break
        }
        continue
      }

      // context overflow, needs compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model }))
      ) {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }

      // normal processing
      const isLastStep = step >= maxSteps
      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: Identifier.ascending("message"),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          usageStatus: "missing",
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })
      using _ = defer(() => InstructionPrompt.clear(processor.message.id))

      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
      })

      const rejection = async (errors: OutputSchema.Diagnostic[]) => {
        if (!contract) throw new Error("Missing output schema")
        attempts++
        rejected++
        await Bus.publish(Session.Event.StructuredOutputRejected, {
          sessionID,
          attempt: attempts,
          maxAttempts: contract.format.retryCount + 1,
          errors,
        })
        return OutputSchema.error(errors).message
      }

      const reject = (raw: string) => {
        if (!contract) throw new Error("Missing output schema")
        // Only the {path} arguments reach the SDK boundary; file content errors come from execute.
        return rejection(OutputSchema.parse(raw, OutputSchema.shape))
      }

      const available = !!contract && attempts < contract.format.retryCount + 1
      if (contract) {
        const format = contract.format
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: format.schema,
          validate: contract.validate,
          model,
          root: Instance.directory,
          onReject: rejection,
          async onSuccess(output) {
            if (structuredOutput !== undefined) return
            if (!available) throw new Error("StructuredOutput corrective turn budget exhausted")
            attempts++
            structuredOutput = output
          },
        })
      }

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

      // Build system prompt, adding structured output instruction if needed
      const system = [...(await SystemPrompt.environment(model)), ...(await InstructionPrompt.system())]

      if (contract) {
        system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
      }

      const prior = attempts
      const result = await processor.process({
        user: lastUser,
        agent,
        permission: session.permission,
        abort,
        sessionID,
        system,
        messages: [
          ...MessageV2.toModelMessages(msgs, model),
          ...(reminder
            ? [
                {
                  role: "user" as const,
                  content: `<system-reminder>${reminder}</system-reminder>`,
                },
              ]
            : []),
          ...(isLastStep
            ? [
                {
                  role: ProviderTransform.isGeminiTarget(model) ? ("user" as const) : ("assistant" as const),
                  content: MAX_STEPS,
                },
              ]
            : []),
        ],
        tools,
        model,
        toolChoice: contract ? (reminder ? { type: "tool", toolName: "StructuredOutput" } : "required") : undefined,
        structured: contract
          ? {
              reject,
              repairs: new Set<string>(),
              checkpoint() {
                const before = { attempts, rejected, structuredOutput }
                return () => {
                  attempts = before.attempts
                  rejected = before.rejected
                  structuredOutput = before.structuredOutput
                }
              },
            }
          : undefined,
      })

      failed = !!processor.message.error

      // If structured output was captured, save it and exit immediately
      // This takes priority because the StructuredOutput tool was called successfully
      if (
        structuredOutput !== undefined &&
        !processor.message.error &&
        !abort.aborted &&
        contract?.validate(structuredOutput)
      ) {
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await Session.updateMessage(processor.message)
        outcome = { status: "accepted", attempts, value: structuredOutput }
        break
      }
      structuredOutput = undefined

      if (result === "compact") {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }

      const missing = contract ? await missingResult(processor) : undefined
      reminder = missing?.reminder
      // A rejected StructuredOutput call in the same step already spent its attempt.
      const missed = missing !== undefined && attempts === prior
      if (missed) await rejection([missing.diagnostic])

      if (contract && !processor.message.error && rejected > contract.format.retryCount) {
        processor.message.error = new MessageV2.StructuredOutputError({
          message: missed
            ? "Model did not produce structured output"
            : "Structured output corrective attempts exhausted",
          retries: Math.max(0, attempts - 1),
        }).toObject()
        await Session.updateMessage(processor.message)
        await Bus.publish(Session.Event.Error, { sessionID, error: processor.message.error })
        outcome = { status: "failed", reason: missed ? "missing" : "exhausted", attempts }
        break
      }

      if (reminder) continue

      if (result === "stop") break
      continue
    }
    await SessionCompaction.prune({ sessionID })
    if (contract) {
      await Bus.publish(Session.Event.StructuredOutput, {
        sessionID,
        outcome: outcome ?? {
          status: "failed",
          reason: abort.aborted ? "aborted" : failed ? "error" : "missing",
          attempts,
        },
      })
    }
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      return item
    }
    throw new Error("Impossible")
  }

  async function lastModel(sessionID: string) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  /** @internal Exported for testing */
  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: MessageV2.WithParts[]
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}

    const context = (toolId: string, args: any, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
      agent: input.agent.name,
      messages: input.messages,
      metadata: async (val: { title?: string; metadata?: any }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          await Session.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
              time: {
                start: Date.now(),
              },
            },
          })
        }
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          metadata: {
            ...(req.metadata ?? {}),
            tool: (req.metadata as any)?.tool ?? toolId,
            input: (req.metadata as any)?.input ?? args,
          },
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
        })
      },
    })

    for (const item of await ToolRegistry.tools(
      { modelID: input.model.api.id, providerID: input.model.providerID },
      input.agent,
      input.session.id,
    )) {
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      const definition = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const ctx = context(item.id, args, options)
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            {
              args,
            },
          )
          const result = await item.execute(args, ctx)
          const output = {
            ...result,
            attachments: result.attachments?.map((attachment) => ({
              ...attachment,
              id: Identifier.ascending("part"),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
          }
          await Plugin.trigger(
            "tool.execute.after",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
              args,
            },
            output,
          )
          return output
        },
      })
      tools[item.id] = ToolGuidance.bind(definition, item.builtin, item.renderDescription)
    }

    for (const [key, item] of Object.entries(await MCP.tools())) {
      const execute = item.execute
      if (!execute) continue

      const transformed = ProviderTransform.schema(input.model, asSchema(item.inputSchema).jsonSchema)
      item.inputSchema = jsonSchema(transformed)
      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        const ctx = context(key, args, opts)

        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          {
            args,
          },
        )

        await ctx.ask({
          permission: key,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        const result = await execute(args, opts)

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
            args,
          },
          result,
        )

        const textParts: string[] = []
        const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []

        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            attachments.push({
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          } else if (contentItem.type === "resource") {
            const { resource } = contentItem
            if (resource.text) {
              textParts.push(resource.text)
            }
            if (resource.blob) {
              attachments.push({
                type: "file",
                mime: resource.mimeType ?? "application/octet-stream",
                url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                filename: resource.uri,
              })
            }
          }
        }

        const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
        const metadata = {
          ...(result.metadata ?? {}),
          truncated: truncated.truncated,
          ...(truncated.truncated && { outputPath: truncated.outputPath }),
        }

        return {
          title: "",
          metadata,
          output: truncated.content,
          attachments: attachments.map((attachment) => ({
            ...attachment,
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: input.processor.message.id,
          })),
          content: result.content, // directly return content to preserve ordering when outputting to model
        }
      }
      tools[key] = item
    }

    return tools
  }

  /** @internal Exported for testing */
  export function createStructuredOutputTool(input: {
    schema: Record<string, unknown>
    validate?: ReturnType<typeof OutputSchema.compile>
    model?: Provider.Model
    /** The tool takes {path} to the JSON result file, which must stay inside this directory (#140). */
    root: string
    /** Counts the rejection against the corrective budget and returns the feedback text. */
    onReject: (errors: OutputSchema.Diagnostic[]) => Promise<string>
    onSuccess: (output: unknown) => void | Promise<void>
  }): AITool & { id: "StructuredOutput" } {
    OutputSchema.canonical(input.schema)
    const validate = input.validate ?? OutputSchema.compile(input.schema)
    const schema = Object.fromEntries(Object.entries(input.schema).filter(([key]) => key !== "$schema"))
    const canonical = OutputSchema.canonical(schema)
    const description =
      canonical.bytes <= 8 * 1024
        ? `Canonical JSON Schema: ${canonical.text}`
        : `Canonical JSON Schema (truncated; the validator enforces the full schema): ${new TextDecoder().decode(Buffer.from(canonical.text).subarray(0, 8 * 1024))}`
    const result = tool({
      description: `${STRUCTURED_OUTPUT_DESCRIPTION}\n\n${description}`,
      // Only {path} reaches the provider, so provider schema conversion cannot drop result fields.
      inputSchema: jsonSchema<{ path: string }>(
        input.model ? ProviderTransform.schema(input.model, OutputSchema.PATH_SCHEMA) : OutputSchema.PATH_SCHEMA,
        {
          validate(value) {
            return OutputSchema.shape(value)
              ? { success: true, value: value as { path: string } }
              : { success: false, error: OutputSchema.error(OutputSchema.diagnostics(OutputSchema.shape.errors)) }
          },
        },
      ),
      async execute(args) {
        const loaded = await OutputSchema.file(input.root, args.path, validate)
        if ("errors" in loaded)
          throw new Error(
            `Fix the file at ${JSON.stringify(args.path)}, then call StructuredOutput again with its path. ${await input.onReject(loaded.errors)}`,
          )
        await input.onSuccess(loaded.value)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput(result) {
        return { type: "text", value: result.output }
      },
    })
    // Retain the internal identifier used by tool consumers.
    return Object.assign(result, { id: "StructuredOutput" as const })
  }

  // a client can still name an agent that no longer exists, such as the removed plan agent
  async function requireAgent(name: string, sessionID: string) {
    const agent = await Agent.get(name)
    if (agent) return agent
    const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
    const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
    const error = new NamedError.Unknown({ message: `Agent not found: "${name}".${hint}` })
    Bus.publish(Session.Event.Error, {
      sessionID,
      error: error.toObject(),
    })
    throw error
  }

  async function createUserMessage(input: PromptInput) {
    const agent = await requireAgent(input.agent ?? (await Agent.defaultAgent()), input.sessionID)

    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const full =
      !input.variant && agent.variant
        ? await Provider.getModel(model.providerID, model.modelID).catch(() => undefined)
        : undefined
    const variant = input.variant ?? (agent.variant && full?.variants?.[agent.variant] ? agent.variant : undefined)

    const info: MessageV2.Info = {
      id: input.messageID ?? Identifier.ascending("message"),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.name,
      model,
      system: input.system,
      format: input.format,
      variant,
    }
    using _ = defer(() => InstructionPrompt.clear(info.id))

    type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
    const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
      ...part,
      id: part.id ?? Identifier.ascending("part"),
    })

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<Draft<MessageV2.Part>[]> => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: Buffer.from(part.url, "base64url").toString(),
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:":
              log.info("file", { mime: part.mime })
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const s = Filesystem.stat(filepath)

              if (s?.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const start = parseInt(range.start)
                  const end = range.end ? parseInt(range.end) : undefined
                  offset = Math.max(start, 1)
                  if (end) {
                    limit = end - (offset - 1)
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      messages: [],
                      metadata: async () => {},
                      ask: async () => {},
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  messages: [],
                  metadata: async () => {},
                  ask: async () => {},
                }
                const result = await ReadTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              FileTime.read(input.sessionID, filepath)
              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  synthetic: true,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + (await Filesystem.readBytes(filepath)).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = PermissionNext.evaluate("task", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat().map(assign))

    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: info,
        parts,
      },
    )

    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }

    return {
      info,
      parts,
    }
  }

  export const CommandInput = z.object({
    messageID: Identifier.schema("message").optional(),
    sessionID: Identifier.schema("session"),
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    format: MessageV2.Format.optional(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  /** Whether a command runs as a subtask in a child session instead of in the calling session. */
  export function runsAsSubtask(command: Pick<Command.Info, "subtask">, agent: Pick<Agent.Info, "mode">) {
    return (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
  }

  export async function command(input: CommandInput) {
    log.info("command", input)
    const command = await Command.get(input.command)
    const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

    // If command doesn't explicitly handle arguments (no $N or $ARGUMENTS placeholders)
    // but user provided arguments, append them to the template
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const taskModel = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()

    try {
      await Provider.getModel(taskModel.providerID, taskModel.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = await requireAgent(agentName, input.sessionID)

    const templateParts = await resolvePromptParts(template)
    const isSubtask = runsAsSubtask(command, agent)
    const parts = isSubtask
      ? [
          {
            type: "subtask" as const,
            agent: agent.name,
            description: command.description ?? "",
            command: input.command,
            model: {
              providerID: taskModel.providerID,
              modelID: taskModel.modelID,
            },
            // TODO: how can we make task tool accept a more complex input?
            prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...templateParts, ...(input.parts ?? [])]

    const userAgent = isSubtask ? (input.agent ?? (await Agent.defaultAgent())) : agentName
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await lastModel(input.sessionID)
      : taskModel

    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      format: input.format,
      variant: input.variant,
    })) as MessageV2.WithParts

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: string
    modelID: string
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return

    // Find first non-synthetic user message
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return

    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return

    // Gather all messages up to and including the first real user message for context
    // This includes any shell/subtask executions that preceded the user's first prompt
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    const result = await LLM.stream({
      agent,
      user: firstRealUser.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : MessageV2.toModelMessages(contextMessages, model)),
      ],
    })
    const text = await result.text.catch((err) => log.error("failed to generate title", { error: err }))
    if (text) {
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return

      const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      return Session.setTitle({ sessionID: input.session.id, title })
    }
  }
}
