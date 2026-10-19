import type { MessageV2 } from "../../session/message-v2"

type Emit = (type: string, data: Record<string, unknown>) => unknown

/** A bus event as `run` receives it: from the local GlobalBus or an attached server's SSE stream, unvalidated. */
type StreamEvent = { type: string; properties?: Record<string, any> }

type UserMessage = { info: MessageV2.User; parts: MessageV2.Part[] }

/** The session a bus event is about, or undefined for events that name no session. */
function eventSessionID(event: StreamEvent): string | undefined {
  const properties = event.properties ?? {}
  return properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
}

/** The payload of a `message.updated` event (`MessageV2.Event.Updated`). */
function updatedMessage(event: StreamEvent): MessageV2.Info | undefined {
  if (event.type !== "message.updated") return
  return event.properties?.info
}

/** The payload of a `message.part.updated` event (`MessageV2.Event.PartUpdated`). */
function updatedPart(event: StreamEvent): MessageV2.Part | undefined {
  if (event.type !== "message.part.updated") return
  return event.properties?.part
}

function upsertPart(parts: MessageV2.Part[], part: MessageV2.Part) {
  if (!parts.some((existing) => existing.id === part.id)) return [...parts, part]
  return parts.map((existing) => (existing.id === part.id ? part : existing))
}

/**
 * Emits each primary-session user message once, as `user_message`.
 *
 * `Session.updateMessage` publishes the message info and `Session.updatePart`
 * then publishes each part; the bus has no "user message complete" event. The
 * message is complete when the session moves on: the first primary-session
 * event that is not about this message (the loop's `busy` status, the assistant
 * message it triggers, an error, or `idle`). Every assistant event follows one
 * of those, so a `user_message` always precedes the assistant events it causes.
 * Child-session user messages are not emitted, matching `text`.
 */
export function userMessages(input: { sessionID: string; emit: Emit; nextSeq: () => number }) {
  const emitted = new Set<string>()
  let pending: UserMessage | undefined

  function flush() {
    if (!pending) return
    const { info, parts } = pending
    pending = undefined
    emitted.add(info.id)
    input.emit("user_message", {
      messageID: info.id,
      agent: info.agent,
      model: info.model,
      parts,
      sequenceNum: input.nextSeq(),
    })
  }

  function newUserMessage(event: StreamEvent): MessageV2.User | undefined {
    const info = updatedMessage(event)
    if (info?.role !== "user" || info.sessionID !== input.sessionID || emitted.has(info.id)) return
    return info
  }

  /** Folds an update of the pending message into it; false when the event is about something else. */
  function collect(event: StreamEvent) {
    if (!pending) return false
    const info = updatedMessage(event)
    if (info?.role === "user" && info.id === pending.info.id) {
      pending.info = info
      return true
    }
    const part = updatedPart(event)
    if (part?.messageID === pending.info.id) {
      pending.parts = upsertPart(pending.parts, part)
      return true
    }
    return false
  }

  return {
    observe(event: StreamEvent) {
      if (collect(event)) return
      if (eventSessionID(event) === input.sessionID) flush()
      const info = newUserMessage(event)
      if (info) pending = { info, parts: [] }
    },
    /** Emits a message still pending when the event stream ends. */
    flush,
  }
}
