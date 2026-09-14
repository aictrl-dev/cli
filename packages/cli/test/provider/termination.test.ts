import { describe, expect, test } from "bun:test"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { OAuth2Client } from "google-auth-library"
import { streamText, wrapLanguageModel } from "ai"
import { ProviderTermination } from "../../src/provider/termination"

function response(
  reason = "MALFORMED_FUNCTION_CALL",
  message: unknown = "Invalid call: token=secret-value",
  request = "req_123",
  googleRequest = "",
) {
  return new Response(
    `data: ${JSON.stringify({
      candidates: [{ index: 0, finishReason: reason, finishMessage: message }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream", "x-request-id": request, "x-goog-request-id": googleRequest } },
  )
}

async function capture(
  options: {
    vertex?: boolean
    reason?: string
    message?: unknown
    request?: string
    googleRequest?: string
    npm?: string
  } = {},
) {
  const auth = new OAuth2Client()
  auth.setCredentials({ access_token: "synthetic-test-token", expiry_date: Date.now() + 3600000 })
  const fetcher = Object.assign(
    async () => response(options.reason, options.message, options.request, options.googleRequest),
    {
      preconnect: fetch.preconnect,
    },
  )
  const model = options.vertex
    ? createVertex({
        project: "fixture",
        location: "us-central1",
        googleAuthOptions: { authClient: auth },
        fetch: fetcher,
      })("gemini-2.5-flash")
    : createGoogleGenerativeAI({ apiKey: "fixture", fetch: fetcher })("gemini-2.5-flash")
  const result = streamText({
    model: wrapLanguageModel({
      model,
      middleware: ProviderTermination.middleware({
        providerID: "fixture",
        modelID: "gemini-2.5-flash",
        npm: options.npm ?? (options.vertex ? "@ai-sdk/google-vertex" : "@ai-sdk/google"),
      }),
    }),
    prompt: "Synthetic fixture",
    maxRetries: 0,
  })
  const chunks = await Array.fromAsync(result.fullStream)
  const finish = chunks.find((chunk) => chunk.type === "finish-step")
  expect(finish).toBeDefined()
  expect(chunks.some((chunk) => chunk.type === "raw")).toBe(false)
  return { chunks, termination: ProviderTermination.from(finish?.providerMetadata)! }
}

describe("provider termination diagnostics", () => {
  test.each([false, true])(
    "preserves observed raw reason through actual Google/Vertex adapter (Vertex=%s)",
    async (vertex) => {
      const { chunks, termination } = await capture({ vertex })
      expect(termination).toEqual({
        providerID: "fixture",
        modelID: "gemini-2.5-flash",
        normalizedReason: "error",
        rawReason: { status: "available", value: "MALFORMED_FUNCTION_CALL", truncated: false },
        requestID: { status: "redacted", truncated: false },
        diagnostic: { status: "redacted", truncated: false },
      })
      expect(JSON.stringify(chunks)).not.toContain("secret-value")
    },
  )

  test("suppresses full free-form diagnostics, bounds oversize values, and redacts credential-shaped IDs", async () => {
    const { chunks, termination } = await capture({
      message: "Bearer secret-token ".repeat(500),
      request: "sk-credential-value",
    })
    expect(termination.diagnostic).toEqual({ status: "redacted", truncated: true })
    expect(termination.requestID).toEqual({ status: "redacted", truncated: false })
    expect(JSON.stringify(chunks)).not.toContain("secret-token")
    expect(JSON.stringify(termination)).not.toContain("credential-value")
    expect(JSON.stringify(termination).length).toBeLessThan(1024)
  })

  test("reports absent diagnostics and unknown raw enums without fabricating details", async () => {
    const { termination } = await capture({ reason: "UNRECOGNIZED_REASON", message: null, request: "" })
    expect(termination.normalizedReason).toBe("unknown")
    expect(termination.rawReason).toEqual({ status: "redacted", truncated: false })
    expect(termination.requestID).toEqual({ status: "unavailable", truncated: false })
    expect(termination.diagnostic).toEqual({ status: "unavailable", truncated: false })
  })

  test.each(["google-request", "g".repeat(129)])(
    "falls back from an empty primary ID to a nonempty Google ID",
    async (googleRequest) => {
      const { termination } = await capture({ request: "", googleRequest })
      expect(termination.requestID).toEqual({ status: "redacted", truncated: googleRequest.length > 128 })
      expect(JSON.stringify(termination)).not.toContain(googleRequest)
    },
  )

  test("diagnostic schema accepts its declared bound while runtime text remains suppressed", async () => {
    const { termination } = await capture({ message: "x".repeat(2048) })
    expect(termination.diagnostic).toEqual({ status: "redacted", truncated: false })
    const allowed = { ...termination, diagnostic: { status: "available", value: "x".repeat(2048), truncated: false } }
    expect(ProviderTermination.from({ aictrl: { termination: allowed } })?.diagnostic.value).toHaveLength(2048)
    const excessive = { ...allowed, diagnostic: { ...allowed.diagnostic, value: "x".repeat(2049) } }
    expect(ProviderTermination.from({ aictrl: { termination: excessive } })).toBeUndefined()
    const oversize = await capture({ message: "x".repeat(2049) })
    expect(oversize.termination.diagnostic).toEqual({ status: "redacted", truncated: true })
    expect(
      ProviderTermination.from({ aictrl: { termination: { ...allowed, rawReason: allowed.diagnostic } } }),
    ).toBeUndefined()
  })

  test.each([
    "xoxb-slack-token",
    "xoxp-slack-token",
    "glpat-gitlab-token",
    "npm_registry_token",
    "0123456789abcdef0123456789abcdef",
    "cHJlZml4bGVzcy1zZWNyZXQ",
    "req_ordinary_request_id",
    "x".repeat(129),
  ])("does not persist arbitrary request ID values (%s)", async (request) => {
    const { termination } = await capture({ request })
    expect(termination.requestID).toEqual({ status: "redacted", truncated: request.length > 128 })
    expect(JSON.stringify(termination)).not.toContain(request)
  })

  test("ignores malformed metadata rather than replacing execution errors", () => {
    expect(ProviderTermination.from(null)).toBeUndefined()
    expect(ProviderTermination.from({ aictrl: { termination: { rawReason: "error" } } })).toBeUndefined()
  })

  test("supports adapters with only normalized finish metadata", async () => {
    const { termination } = await capture({ npm: "@ai-sdk/unsupported-fixture" })
    expect(termination.normalizedReason).toBe("error")
    expect(termination.rawReason).toEqual({ status: "unavailable", truncated: false })
    expect(termination.diagnostic).toEqual({ status: "unavailable", truncated: false })
  })

  test("preserves adapter errors without producing a false finish", async () => {
    const result = streamText({
      model: wrapLanguageModel({
        model: createGoogleGenerativeAI({
          apiKey: "fixture",
          fetch: Object.assign(
            async () =>
              new Response(
                JSON.stringify({ error: { code: 401, message: "synthetic unauthorized", status: "UNAUTHENTICATED" } }),
                { status: 401 },
              ),
            { preconnect: fetch.preconnect },
          ),
        })("gemini-2.5-flash"),
        middleware: ProviderTermination.middleware({
          providerID: "fixture",
          modelID: "gemini-2.5-flash",
          npm: "@ai-sdk/google",
        }),
      }),
      prompt: "Synthetic fixture",
      maxRetries: 0,
      onError() {},
    })
    const chunks = await Array.fromAsync(result.fullStream)
    const failure = chunks.find((chunk) => chunk.type === "error")
    expect(failure?.error).toMatchObject({ statusCode: 401, message: "synthetic unauthorized" })
    expect(chunks.some((chunk) => chunk.type === "finish-step")).toBe(false)
  })
})
