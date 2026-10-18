import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { PartTable, SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

test("data written by the removed snapshot subsystem is ignored when a session loads (#181)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const user: MessageV2.User = {
        id: Identifier.ascending("message"),
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "fixture", modelID: "fixture" },
      }
      await Session.updateMessage(user)
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: user.id,
        type: "text",
        text: "Write out.txt.",
      })
      // Rows as versions before #181 stored them.
      const legacyParts = [
        { type: "patch", hash: "1".repeat(40), files: [`${tmp.path}/out.txt`] },
        { type: "snapshot", snapshot: "1".repeat(40) },
      ]
      for (const data of legacyParts) {
        Database.use((db) =>
          db
            .insert(PartTable)
            .values({
              id: Identifier.ascending("part"),
              message_id: user.id,
              session_id: session.id,
              time_created: Date.now(),
              time_updated: Date.now(),
              data: data as unknown as typeof PartTable.$inferInsert.data,
            })
            .run(),
        )
      }
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({
            summary_additions: 1,
            summary_deletions: 0,
            summary_files: 1,
            summary_diffs: [{ file: "out.txt", before: "", after: "out\n", additions: 1, deletions: 0 }],
            revert: { messageID: user.id, snapshot: "0".repeat(40) },
          })
          .where(eq(SessionTable.id, session.id))
          .run(),
      )

      expect((await MessageV2.parts(user.id)).map((part) => part.type)).toEqual(["text"])
      const messages = await Array.fromAsync(MessageV2.stream(session.id))
      expect(messages.flatMap((message) => message.parts.map((part) => part.type))).toEqual(["text"])
      const info = await Session.get(session.id)
      expect(info).not.toHaveProperty("revert")
      expect(info).not.toHaveProperty("summary")

      await Session.remove(session.id)
    },
  })
})
