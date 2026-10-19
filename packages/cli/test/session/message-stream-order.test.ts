import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const model = { providerID: "fixture", modelID: "fixture" }

function user(sessionID: string, created: number) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID,
    time: { created },
    agent: "build",
    model,
  })
}

function summary(sessionID: string, parentID: string, created: number) {
  return Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID,
    parentID,
    time: { created },
    summary: true,
    finish: "stop",
    mode: "compaction",
    agent: "compaction",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...model,
  })
}

// Compaction writes its user message, the summary and the continue message in
// quick succession, so they often share a millisecond. The stream must still
// return them newest first, or filterCompacted misses the finished compaction
// and the prompt loop runs it again.
test("messages created in the same millisecond stream newest first", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const created = Date.now()
      const prompt = await user(session.id, created - 1)
      const compaction = await user(session.id, created)
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: compaction.id,
        sessionID: session.id,
        type: "compaction",
        auto: true,
      })
      const summarized = await summary(session.id, compaction.id, created)
      const resumed = await user(session.id, created)

      const streamed: string[] = []
      for await (const msg of MessageV2.stream(session.id)) streamed.push(msg.info.id)
      expect(streamed).toEqual([resumed.id, summarized.id, compaction.id, prompt.id])

      const visible = await MessageV2.filterCompacted(MessageV2.stream(session.id))
      expect(visible.map((msg) => msg.info.id)).toEqual([compaction.id, summarized.id, resumed.id])
    },
  })
})
