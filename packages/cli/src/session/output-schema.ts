import Ajv, { type ErrorObject } from "ajv"
import Ajv2020 from "ajv/dist/2020"
import z from "zod"
import { createHash } from "crypto"

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
