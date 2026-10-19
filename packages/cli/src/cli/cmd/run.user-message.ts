import type { MessageV2 } from "../../session/message-v2"

type Emit = (type: string, data: Record<string, unknown>) => unknown

type BusEvent = { type: string; properties?: any }

type UserMessage = { info: MessageV2.User; parts: MessageV2.Part[] }

/** The session a bus event is about, or undefined for events that name no session. */
function eventSessionID(event: BusEvent) {
  const properties = event.properties ?? {}
  return properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
}

function eventMessageID(event: BusEvent) {
  if (event.type === "message.updated") return event.properties.info.id
  if (event.type === "message.part.updated") return event.properties.part.messageID
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

  function isNewUserMessage(event: BusEvent) {
    if (event.type !== "message.updated") return false
    const info = event.properties.info
    return info.role === "user" && info.sessionID === input.sessionID && !emitted.has(info.id)
  }

  function collect(event: BusEvent) {
    if (!pending) return
    if (event.type === "message.updated") pending.info = event.properties.info
    if (event.type === "message.part.updated") pending.parts = upsertPart(pending.parts, event.properties.part)
  }

  return {
    observe(event: BusEvent) {
      if (pending && eventMessageID(event) === pending.info.id) return collect(event)
      if (eventSessionID(event) === input.sessionID) flush()
      if (isNewUserMessage(event)) pending = { info: event.properties.info, parts: [] }
    },
    /** Emits a message still pending when the event stream ends. */
    flush,
  }
}
