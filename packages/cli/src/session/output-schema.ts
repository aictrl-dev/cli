import Ajv, { type ErrorObject } from "ajv"
import Ajv2020 from "ajv/dist/2020"
import z from "zod"
import { createHash } from "crypto"
import path from "path"
import fs from "fs/promises"

export namespace OutputSchema {
  export const Diagnostic = z.object({ path: z.string(), keyword: z.string(), message: z.string() })
  export const Outcome = z.discriminatedUnion("status", [
    z.object({ status: z.literal("accepted"), attempts: z.number(), value: z.unknown() }),
    z.object({
      status: z.literal("failed"),
      reason: z.enum(["exhausted", "missing", "step_limit", "aborted", "error"]),
      attempts: z.number(),
    }),
  ])
  export type Outcome = z.infer<typeof Outcome>
  export type Diagnostic = z.infer<typeof Diagnostic>

  // Share the canonical validator across CLI preflight, tool execution and final
  // acceptance, including schemas cloned by Zod or loaded from session storage.
  const cache = new Map<string, ReturnType<Ajv["compile"]>>()

  // Ajv codegen recurses per nesting level: ~2,000 levels fit in 16 KB yet overflow
  // the stack, so bound structure as well as bytes. Iterative, so the check itself
  // cannot overflow.
  const MAX_DEPTH = 64
  const MAX_NODES = 10_000
  function bound(schema: unknown) {
    const stack: [unknown, number][] = [[schema, 0]]
    let nodes = 0
    while (stack.length) {
      const [value, depth] = stack.pop()!
      if (!value || typeof value !== "object") continue
      if (depth > MAX_DEPTH) throw new Error(`schema nesting must not exceed ${MAX_DEPTH} levels`)
      if (++nodes > MAX_NODES) throw new Error(`schema must not exceed ${MAX_NODES} nested objects`)
      for (const child of Object.values(value)) stack.push([child, depth + 1])
    }
  }

  export function canonical(schema: Record<string, unknown>) {
    bound(schema)
    const text = JSON.stringify(schema)
    const bytes = Buffer.byteLength(text)
    if (bytes > 64 * 1024) throw new Error("serialized schema must not exceed 64 KiB")
    return { text, bytes }
  }

  export function compile(schema: Record<string, unknown>) {
    if (schema.type !== "object") throw new Error('schema root must have type "object"')
    const key = createHash("sha256").update(canonical(schema).text).digest("hex")
    const cached = cache.get(key)
    if (cached) return cached
    const ajv =
      typeof schema.$schema === "string" &&
      /^https:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(schema.$schema)
        ? Ajv2020
        : Ajv
    const validate = new ajv({ allErrors: true }).compile(schema)
    if (cache.size >= 32) cache.delete(cache.keys().next().value!)
    cache.set(key, validate)
    return validate
  }

  export function diagnostics(errors?: ErrorObject[] | null): Diagnostic[] {
    return (errors ?? []).slice(0, 10).reduce<Diagnostic[]>((result, error) => {
      const item = {
        path: error.instancePath
          .split("/")
          .map((segment) => segment.slice(0, 64))
          .join("/")
          .slice(0, 96),
        keyword: error.keyword.slice(0, 32),
        message: (error.message ?? "invalid value").slice(0, 96),
      }
      // Bound the encoded bytes too: Unicode and JSON escaping can expand text.
      return Buffer.byteLength(JSON.stringify([...result, item])) < 1600 ? [...result, item] : result
    }, [])
  }

  export function parse(input: string, validate: ReturnType<typeof compile>) {
    try {
      const value: unknown = JSON.parse(input)
      if (validate(value)) return []
      return diagnostics(validate.errors)
    } catch {
      // JSON parser errors can echo the entire submitted input.
      return [{ path: "", keyword: "parse", message: "arguments must be complete, valid JSON" }]
    }
  }

  // Path form (#140): the model writes its result to a file and passes the path, so the
  // published value is the file it validated, never a provider-schema-constrained re-emission.
  export const PATH_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
      path: {
        type: "string",
        maxLength: 1024,
        description: "Path of the JSON result file, relative to the working directory",
      },
    },
    required: ["path"],
    additionalProperties: false,
  }
  const MAX_FILE_BYTES = 2 * 1024 * 1024

  export async function file(
    root: string,
    input: string,
    validate: ReturnType<typeof compile>,
  ): Promise<{ value: unknown } | { errors: Diagnostic[] }> {
    const fail = (keyword: string, message: string) => ({ errors: [{ path: "", keyword, message }] })
    const base = await fs.realpath(root)
    // realpath follows symlinks, so a link pointing outside the root is rejected too.
    const target = await fs.realpath(path.resolve(base, input)).catch(() => undefined)
    if (!target) return fail("file", "file not found")
    const relative = path.relative(base, target)
    if (relative.startsWith("..") || path.isAbsolute(relative))
      return fail("file", "path must stay inside the working directory")
    // One handle for stat and read, so the checked file is the file read.
    const handle = await fs.open(target, "r").catch(() => undefined)
    if (!handle) return fail("file", "file not readable")
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) return fail("file", "path must be a regular file")
      if (stat.size > MAX_FILE_BYTES) return fail("file", `file must not exceed ${MAX_FILE_BYTES} bytes`)
      const text = await handle.readFile("utf8")
      const value = (() => {
        try {
          return { parsed: JSON.parse(text) as unknown }
        } catch {
          return undefined
        }
      })()
      if (!value) return fail("parse", "file must contain complete, valid JSON")
      if (!validate(value.parsed)) return { errors: diagnostics(validate.errors) }
      return { value: value.parsed }
    } finally {
      await handle.close()
    }
  }

  export function summary(error: unknown) {
    const value = error && typeof error === "object" ? error : {}
    return {
      message: "Structured output stream failed",
      ...("name" in value && typeof value.name === "string" ? { name: value.name.slice(0, 96) } : {}),
      ...("statusCode" in value && typeof value.statusCode === "number" && Number.isFinite(value.statusCode)
        ? { statusCode: value.statusCode }
        : {}),
      ...("isRetryable" in value && typeof value.isRetryable === "boolean" ? { isRetryable: value.isRetryable } : {}),
    }
  }

  export function error(errors: Diagnostic[]) {
    return new Error(`StructuredOutput rejected: ${JSON.stringify(errors)}`)
  }
}
