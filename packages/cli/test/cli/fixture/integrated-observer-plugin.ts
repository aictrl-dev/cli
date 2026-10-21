import { appendFileSync } from "node:fs"
import type { Plugin } from "@aictrl/plugin"
const record = (data: unknown) =>
  appendFileSync(process.env.COMMAND_TEMPLATE_OBSERVATIONS!, JSON.stringify(data) + "\n")
record({ kind: "plugin-import" })
export const IntegratedObserver: Plugin = async () => {
  record({ kind: "plugin-init" })
  return {
    "command.execute.before": async (input) => {
      record({ kind: "before", input })
    },
    event: async ({ event }) => {
      if (event.type === "command.executed") record({ kind: "executed", event })
    },
  }
}
