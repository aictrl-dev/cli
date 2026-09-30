import type { LanguageModelV2Middleware } from "@ai-sdk/provider"
import z from "zod"

export namespace ProviderTermination {
  const VALUE_LIMIT = 128
  const DIAGNOSTIC_LIMIT = 2048
  function Field(limit: number) {
    return z.object({
      status: z.enum(["available", "unavailable", "redacted"]),
      value: z.string().max(limit).optional(),
      truncated: z.boolean(),
    })
  }
  type Field = z.infer<ReturnType<typeof Field>>

  export const Info = z
    .object({
      providerID: z.string(),
      modelID: z.string(),
      normalizedReason: z.string(),
      rawReason: Field(VALUE_LIMIT),
      requestID: Field(VALUE_LIMIT),
      diagnostic: Field(DIAGNOSTIC_LIMIT),
    })
    .meta({ ref: "ProviderTermination" })
  export type Info = z.infer<typeof Info>

  const reasons = new Set([
    "FINISH_REASON_UNSPECIFIED",
    "STOP",
    "MAX_TOKENS",
    "SAFETY",
    "RECITATION",
    "LANGUAGE",
    "OTHER",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "MALFORMED_FUNCTION_CALL",
    "IMAGE_SAFETY",
    "UNEXPECTED_TOOL_CALL",
    "NO_IMAGE",
    "IMAGE_PROHIBITED_CONTENT",
    "IMAGE_OTHER",
    "IMAGE_RECITATION",
  ])

  function field(value: unknown, allowed: (value: string) => boolean, limit = VALUE_LIMIT): Field {
    if (typeof value !== "string" || !value) return { status: "unavailable", truncated: false }
    if (value.length > limit || !allowed(value)) return { status: "redacted", truncated: value.length > limit }
    return { status: "available", value, truncated: false }
  }

  function record(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return
    return value as Record<string, unknown>
  }

  export function middleware(input: { providerID: string; modelID: string; npm: string }): LanguageModelV2Middleware {
    const google = input.npm === "@ai-sdk/google" || input.npm === "@ai-sdk/google-vertex"
    return {
      async transformParams({ type, params }) {
        return type === "stream" && google ? { ...params, includeRawChunks: true } : params
      },
      async wrapStream({ doStream }) {
        const result = await doStream()
        let rawReason = field(undefined, () => false)
        let diagnostic = field(undefined, () => false)
        const headers = result.response?.headers
        // A provider/proxy can echo arbitrary credentials into an ID header.
        // Format allowlists cannot distinguish an opaque ID from an opaque key.
        const requestID = field(headers?.["x-request-id"] || headers?.["x-goog-request-id"], () => false)
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                if (chunk.type === "raw") {
                  if (google) {
                    const candidates = record(chunk.rawValue)?.candidates
                    const candidate = Array.isArray(candidates) ? record(candidates[0]) : undefined
                    if (candidate?.finishReason != null) {
                      rawReason = field(candidate.finishReason, (value) => reasons.has(value))
                      // Provider messages can contain prompts or tool arguments. Retain only
                      // presence/size information; do not collect their free-form contents.
                      diagnostic = field(candidate.finishMessage, () => false, DIAGNOSTIC_LIMIT)
                    }
                  }
                  // Raw payloads must never escape this boundary to stream consumers.
                  return
                }
                if (chunk.type !== "finish") {
                  controller.enqueue(chunk)
                  return
                }
                const termination: Info = {
                  providerID: input.providerID,
                  modelID: input.modelID,
                  normalizedReason: chunk.finishReason,
                  rawReason,
                  requestID,
                  diagnostic,
                }
                controller.enqueue({
                  ...chunk,
                  providerMetadata: {
                    ...chunk.providerMetadata,
                    aictrl: { ...chunk.providerMetadata?.aictrl, termination },
                  },
                })
              },
            }),
          ),
        }
      },
    }
  }

  export function from(metadata: unknown): Info | undefined {
    const result = Info.safeParse(record(record(metadata)?.aictrl)?.termination)
    return result.success ? result.data : undefined
  }
}
