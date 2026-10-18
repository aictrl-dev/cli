import { UI } from "../ui"
import { cmd } from "./cmd"

/**
 * Keeps a deleted command's name registered, hidden from help, so callers get a pointer to its
 * replacement instead of yargs' bare usage dump. Any arguments are accepted, and `--help` and
 * `--version` also reach the handler, so probing the old command never exits 0.
 */
export function RemovedCommand(name: string, replacement: string) {
  return cmd({
    command: `${name} [args..]`,
    describe: false,
    builder: (yargs) => yargs.strict(false).help(false).version(false),
    handler() {
      UI.error(`\`aictrl ${name}\` was removed. ${replacement}`)
      process.exitCode = 1
    },
  })
}
