import path from "path"
// Bun content I/O preserves createPath: false; fs/promises supplies metadata and atomic rename/removal.
import fs from "fs/promises"
import { OutputSchema } from "@/session/output-schema"

export const OUTPUT_SCHEMA_CONFIG = "OUTPUT_SCHEMA_CONFIG"
export const OUTPUT_CONFIG_EXIT = 2
export const OUTPUT_FAILED_EXIT = 3

export async function outputSchema(input: { schema?: string; retries?: number; result?: string }) {
  if (!input.schema) {
    if (input.retries !== undefined || input.result !== undefined)
      throw new Error("--output-schema-retries and --output-result require --output-schema")
    return
  }
  if (input.retries !== undefined && (!Number.isSafeInteger(input.retries) || input.retries < 0 || input.retries > 10))
    throw new Error("--output-schema-retries must be an integer between 0 and 10")
  // Relative paths resolve against --dir (run changes into it first), like --file.
  // Report the resolved path so a misplaced relative path is obvious.
  const file = path.resolve(input.schema)
  const text = await Bun.file(file)
    .text()
    .catch(() => {
      throw new Error(`${file}: cannot read schema file`)
    })
  const schema: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${file}: invalid JSON`)
    }
  })()
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error(`${file}: schema root must be a JSON object`)
  const canonical = schema as Record<string, unknown>
  const validate = (() => {
    try {
      return OutputSchema.compile(canonical)
    } catch (error) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : "cannot compile schema"}`)
    }
  })()
  if (input.result) {
    const result = path.resolve(input.result)
    const directory = path.dirname(result)
    const writable = await fs
      .stat(directory)
      .then(async (stat) => {
        if (!stat.isDirectory()) return false
        await fs.access(directory, fs.constants.W_OK | fs.constants.X_OK)
        return true
      })
      .catch(() => false)
    if (!writable) throw new Error(`${result}: output-result parent directory must exist and be writable`)
  }
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
