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
  export const shape = compile(PATH_SCHEMA)
  const MAX_FILE_BYTES = 2 * 1024 * 1024
  const OUTSIDE = "path must stay inside the working directory"

  function contains(base: string, target: string) {
    const relative = path.relative(base, target)
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
  }

  // Reads at most buffer.length bytes, however much the file grows while it is read.
  async function fill(handle: fs.FileHandle, buffer: Buffer, offset = 0): Promise<number> {
    if (offset === buffer.length) return offset
    const read = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (!read.bytesRead) return offset
    return fill(handle, buffer, offset + read.bytesRead)
  }

  // Every failure is a fixed diagnostic, so it counts as a rejection and never echoes OS error text.
  export async function file(
    root: string,
    input: string,
    validate: ReturnType<typeof compile>,
  ): Promise<{ value: unknown } | { errors: Diagnostic[] }> {
    const fail = (keyword: string, message: string) => ({ errors: [{ path: "", keyword, message }] })
    const base = await fs.realpath(root).catch(() => undefined)
    if (!base) return fail("file", "working directory unavailable")
    // realpath follows symlinks, so a link pointing outside the root is rejected too.
    const target = await fs.realpath(path.resolve(base, input)).catch(() => undefined)
    if (!target) return fail("file", "file not found")
    if (!contains(base, target)) return fail("file", OUTSIDE)
    // O_NOFOLLOW refuses a final component swapped for a symlink after the check (ELOOP).
    // O_NONBLOCK makes opening a FIFO return at once; fstat then rejects it as non-regular.
    const handle = await fs
      .open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      .catch((error: NodeJS.ErrnoException) => (error.code === "ELOOP" ? OUTSIDE : "file not readable"))
    if (typeof handle === "string") return fail("file", handle)
    try {
      // One handle for stat and read, so the checked file is the file read.
      const stat = await handle.stat().catch(() => undefined)
      if (!stat) return fail("file", "file not readable")
      if (!stat.isFile()) return fail("file", "path must be a regular file")
      // A parent directory swapped for a symlink after the check is followed by open, so the
      // opened file must still be the file the path resolves to inside the working directory.
      const again = await fs.realpath(target).catch(() => undefined)
      const current = again && contains(base, again) ? await fs.stat(again).catch(() => undefined) : undefined
      if (!current || current.dev !== stat.dev || current.ino !== stat.ino) return fail("file", OUTSIDE)
      const size = `file must not exceed ${MAX_FILE_BYTES} bytes`
      if (stat.size > MAX_FILE_BYTES) return fail("file", size)
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
      const length = await fill(handle, buffer).catch(() => undefined)
      if (length === undefined) return fail("file", "file not readable")
      if (length > MAX_FILE_BYTES) return fail("file", size)
      const value = (() => {
        try {
          return { parsed: JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown }
        } catch {
          return undefined
        }
      })()
      if (!value) return fail("parse", "file must contain complete, valid JSON")
      if (!validate(value.parsed)) return { errors: diagnostics(validate.errors) }
      return { value: value.parsed }
    } finally {
      await handle.close().catch(() => undefined)
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
