import type { Argv } from "yargs"
import type { Message, Part } from "@aictrl/sdk/v2"
import { Session } from "../../session"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Database } from "../../storage/db"
import { SessionTable, MessageTable, PartTable } from "../../session/session.sql"
import { Instance } from "../../project/instance"
import { EOL } from "os"
import { Filesystem } from "../../util/filesystem"
import { UI } from "../ui"

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from a JSON file",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to JSON file",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    // Importing from a share URL was removed with session sharing (#189).
    if (args.file.startsWith("http://") || args.file.startsWith("https://")) {
      UI.error("Importing from a share URL was removed: session sharing is no longer supported")
      process.exitCode = 1
      return
    }

    await bootstrap(process.cwd(), async () => {
      const exportData = await Filesystem.readJson<{
        info: Session.Info
        messages: Array<{ info: Message; parts: Part[] }>
      }>(args.file).catch(() => undefined)
      if (!exportData) {
        process.stdout.write(`File not found: ${args.file}`)
        process.stdout.write(EOL)
        return
      }

      Database.use((db) => db.insert(SessionTable).values(Session.toRow(exportData.info)).onConflictDoNothing().run())

      for (const msg of exportData.messages) {
        Database.use((db) =>
          db
            .insert(MessageTable)
            .values({
              id: msg.info.id,
              session_id: exportData.info.id,
              time_created: msg.info.time?.created ?? Date.now(),
              data: msg.info,
            })
            .onConflictDoNothing()
            .run(),
        )

        for (const part of msg.parts) {
          Database.use((db) =>
            db
              .insert(PartTable)
              .values({
                id: part.id,
                message_id: msg.info.id,
                session_id: exportData.info.id,
                data: part,
              })
              .onConflictDoNothing()
              .run(),
          )
        }
      }

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})
