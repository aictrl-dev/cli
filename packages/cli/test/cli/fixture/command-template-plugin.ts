import { appendFileSync } from "node:fs"
import type { Plugin } from "@aictrl/plugin"

const record = (data: unknown) =>
  appendFileSync(process.env.COMMAND_TEMPLATE_OBSERVATIONS!, JSON.stringify(data) + "\n")
export const CommandProjection: Plugin = async () => ({
  "command.execute.before": async (input) => {
    record({ kind: "before", input })
  },
  event: async ({ event }) => {
    if (event.type === "command.executed") record({ kind: "executed", event })
  },
})
