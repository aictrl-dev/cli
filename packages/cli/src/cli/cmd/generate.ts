import type { CommandModule } from "yargs"
import z from "zod"
import { MessageV2 } from "@/session/message-v2"
import { ProviderTermination } from "@/provider/termination"

export const GenerateCommand = {
  command: "generate",
  handler: async () => {
    // Keep OpenAPI component identities separate from legacy Zod metadata.
    const registry = z.registry<{ id: string }>()
    registry.add(MessageV2.StepFinishPart, { id: "StepFinishPart" })
    registry.add(ProviderTermination.Info, { id: "ProviderTermination" })
    const components = z.toJSONSchema(registry, {
      metadata: z.registry(),
      target: "draft-2020-12",
      uri: (id) => `#/components/schemas/${id}`,
    })
    // Component JSON pointers are references, not standalone schema resource IDs.
    for (const schema of Object.values(components.schemas)) delete schema.$id
    const specs = {
      openapi: "3.1.1",
      info: {
        title: "aictrl",
        version: "1.0.0",
      },
      paths: {},
      components,
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
