import { UI } from "../ui"
import { cmd } from "./cmd"

/**
 * Keeps a deleted command's name registered, hidden from help, so callers get a pointer to its
 * replacement instead of yargs' bare usage dump. Any arguments the old command took are accepted.
 */
export function RemovedCommand(name: string, replacement: string) {
  return cmd({
    command: `${name} [args..]`,
    describe: false,
    builder: (yargs) => yargs.strict(false),
    handler() {
      UI.error(`\`aictrl ${name}\` was removed. ${replacement}`)
      process.exitCode = 1
    },
  })
}
