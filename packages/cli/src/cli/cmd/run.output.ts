import path from "path"
import fs from "fs/promises"
import { OutputSchema } from "../../session/output-schema"

export const OUTPUT_CONFIG_EXIT = 2
export const OUTPUT_FAILED_EXIT = 3

export async function outputSchema(input: { schema?: string; retries?: number; result?: string }) {
  if (!input.schema) {
    if (input.retries !== undefined || input.result !== undefined)
      throw new Error("--output-schema-retries and --output-result require --output-schema")
    return
  }
  if (input.retries !== undefined && (!Number.isSafeInteger(input.retries) || input.retries < 0))
    throw new Error(`${input.schema}: --output-schema-retries must be an integer >= 0`)
  const text = await Bun.file(input.schema)
    .text()
    .catch(() => {
      throw new Error(`${input.schema}: cannot read schema file`)
    })
  const schema: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${input.schema}: invalid JSON`)
    }
  })()
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error(`${input.schema}: schema root must have type "object"`)
  const canonical = schema as Record<string, unknown>
  const validate = (() => {
    try {
      return OutputSchema.compile(canonical)
    } catch (error) {
      throw new Error(`${input.schema}: ${error instanceof Error ? error.message : "cannot compile schema"}`)
    }
  })()
  return { format: { type: "json_schema" as const, schema: canonical, retryCount: input.retries ?? 2 }, validate }
}

export async function outputResult(file: string, value: unknown, aborted = () => false) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  try {
    await Bun.write(temp, JSON.stringify(value, null, 2) + "\n", { createPath: false })
    if (aborted()) throw new Error("Structured output cancelled")
    await fs.rename(temp, file)
  } finally {
    await fs.rm(temp, { force: true })
  }
}
