import type { Argv } from "yargs"
import { cmd } from "./cmd"
import EVENTS_MD from "../../../../../EVENTS.md" with { type: "text" }

const SCHEMA_VERSION = "1"

export const EventsCommand = cmd({
  command: "events",
  describe: "print the NDJSON event schema (EVENTS.md) bundled with this CLI",
  builder: (yargs: Argv) =>
    yargs.option("schema-version", {
      type: "boolean",
      describe: "print only the schema version string",
      default: false,
    }),
  async handler(args) {
    if (args["schema-version"]) {
      process.stdout.write(SCHEMA_VERSION + "\n")
      return
    }
    process.stdout.write(EVENTS_MD as unknown as string)
  },
})
