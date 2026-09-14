import type { CommandModule } from "yargs"
import z from "zod"
import { MessageV2 } from "@/session/message-v2"
import { ProviderTermination } from "@/provider/termination"

export const GenerateCommand = {
  command: "generate",
  handler: async () => {
    const specs = {
      openapi: "3.1.1",
      info: {
        title: "aictrl",
        version: "1.0.0",
      },
      paths: {},
      components: {
        schemas: {
          StepFinishPart: z.toJSONSchema(MessageV2.StepFinishPart, { target: "openapi-3.0" }),
          ProviderTermination: z.toJSONSchema(ProviderTermination.Info, { target: "openapi-3.0" }),
        },
      },
    }
    const json = JSON.stringify(specs, null, 2)

    // Wait for stdout to finish writing before process.exit() is called
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(json, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  },
} satisfies CommandModule
