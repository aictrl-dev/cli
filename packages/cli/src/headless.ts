import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { Log } from "./util/log"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { NamedError } from "@aictrl/util/error"
import { FormatError } from "./cli/error"
import { Filesystem } from "./util/filesystem"
import { McpCommand } from "./cli/cmd/mcp"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { SessionCommand } from "./cli/cmd/session"
import path from "path"
import { Global } from "./global"
import { JsonMigration } from "./storage/json-migration"
import { Database } from "./storage/db"

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
    stack: e instanceof Error ? e.stack : undefined,
  })
  process.exit(1)
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
    stack: e instanceof Error ? e.stack : undefined,
  })
  process.exit(1)
})

let cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("aictrl")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.VERSION)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .middleware(async (opts) => {
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    process.env.AGENT = "1"
    process.env.AICTRL_PID = String(process.pid)
    process.env.AICTRL_HEADLESS = "true"

    Log.Default.info("aictrl-headless", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })

    const storageDir = path.join(Global.Path.data, "storage")
    const migrationMarker = path.join(Global.Path.data, "json-migration-complete")

    // Only attempt JSON migration if:
    // 1. The legacy storage directory exists (there's data to migrate)
    // 2. The migration-complete marker does not exist (migration hasn't succeeded yet)
    if ((await Filesystem.exists(storageDir)) && !(await Filesystem.exists(migrationMarker))) {
      process.stderr.write("Performing one time database migration..." + EOL)
      try {
        await JsonMigration.run(Database.Client().$client, {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            process.stderr.write(`sqlite-migration:${percent}${EOL}`)
          },
        })
        // Write marker ONLY after successful migration
        await Filesystem.write(migrationMarker, String(Date.now()))
        process.stderr.write("Database migration complete." + EOL)
      } catch (error) {
        Log.Default.error("json migration failed", { error })
        process.stderr.write("Database migration failed. It will be retried on next launch." + EOL)
        // Don't write marker -- migration will retry on next launch.
      } finally {
        process.stderr.write(`sqlite-migration:done${EOL}`)
      }
    }
  })
  .usage("")
  .command(AcpCommand)
  .command(McpCommand)
  .command(RunCommand)
  .command(ModelsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(SessionCommand)

cli = cli
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp("log")
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  await cli.parse()
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write((e instanceof Error ? e.message : String(e)) + EOL)
  }
  process.exitCode = 1
} finally {
  process.exit()
}
