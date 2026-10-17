import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { createRequire } from "module"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"

// Other files in test/mcp replace "@modelcontextprotocol/sdk/client/auth.js" with a stub via
// mock.module, which leaks across files in one `bun test` run. Load the real `auth()` from the
// SDK's CommonJS build, which resolves to a different module and is never stubbed.
type SdkAuth = typeof import("@modelcontextprotocol/sdk/client/auth.js")
const { auth } = createRequire(import.meta.url)("@modelcontextprotocol/sdk/client/auth.js") as SdkAuth

// GHSA-6qxp-vccf-f47h: an MCP server could point the OAuth client at an authorization server of
// its choosing and receive the credentials issued by another one. The SDK binds stored tokens and
// client information to the issuing authorization server via an `issuer` stamp, which only works
// if the provider persists that stamp.

const MCP_NAME = "__test_issuer_binding"
const SERVER_URL = "https://mcp.example.com/mcp"
const AS_A = "https://as-a.example.com"
const AS_B = "https://as-b.example.com"

const CONFIGURED = { clientId: "configured-client", clientSecret: "configured-secret" }

// `sent` is everything that could carry a credential: the body and a decoded Basic auth header.
type Recorded = { url: URL; sent: string }

function authServer(advertised: () => string) {
  const requests: Recorded[] = []
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const body = init?.body ? String(init.body) : ""
    const authorization = new Headers(init?.headers).get("authorization") ?? ""
    const basic = authorization.startsWith("Basic ") ? atob(authorization.slice(6)) : authorization
    requests.push({ url, sent: `${body}\n${basic}` })

    if (url.origin === new URL(SERVER_URL).origin && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: SERVER_URL, authorization_servers: [advertised()] })
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`,
        registration_endpoint: `${url.origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      })
    }
    if (url.pathname === "/token") {
      return Response.json({
        access_token: `access-from-${url.host}`,
        token_type: "Bearer",
        refresh_token: `refresh-from-${url.host}`,
        expires_in: 3600,
      })
    }
    if (url.pathname === "/register") {
      return Response.json({ client_id: `client-from-${url.host}`, redirect_uris: [] }, { status: 201 })
    }
    return new Response("not found", { status: 404 })
  }
  const sentTo = (origin: string) => requests.filter((r) => r.url.origin === origin)
  return { requests, sentTo, fetchFn }
}

function provider(redirects: URL[] = []) {
  return new McpOAuthProvider(MCP_NAME, SERVER_URL, {}, { onRedirect: (url) => void redirects.push(url) })
}

function configuredProvider() {
  return new McpOAuthProvider(MCP_NAME, SERVER_URL, CONFIGURED, { onRedirect: () => {} })
}

async function storeCredentials(issuer: string | undefined) {
  await McpAuth.set(
    MCP_NAME,
    {
      clientInfo: { clientId: "client-a", clientSecret: "secret-a", issuer },
      tokens: { accessToken: "access-a", refreshToken: "refresh-a", expiresAt: Date.now() / 1000 - 60, issuer },
      oauthState: "state",
    },
    SERVER_URL,
  )
}

beforeEach(() => McpAuth.remove(MCP_NAME))
afterEach(() => McpAuth.remove(MCP_NAME))

describe("McpOAuthProvider issuer binding", () => {
  test("persists the issuer stamped on tokens and client information", async () => {
    const p = provider()
    await p.saveClientInformation({ client_id: "client-a", client_secret: "secret-a", redirect_uris: [], issuer: AS_A })
    await p.saveTokens({ access_token: "access-a", token_type: "Bearer", refresh_token: "refresh-a", issuer: AS_A })

    expect((await p.clientInformation())?.issuer).toBe(AS_A)
    expect((await p.tokens())?.issuer).toBe(AS_A)
  })

  test("refreshes with the authorization server that issued the tokens", async () => {
    await storeCredentials(AS_A)
    const server = authServer(() => AS_A)

    expect(await auth(provider(), { serverUrl: SERVER_URL, fetchFn: server.fetchFn })).toBe("AUTHORIZED")

    const refresh = server.sentTo(AS_A).find((r) => r.url.pathname === "/token")
    expect(refresh?.sent).toContain("refresh_token=refresh-a")
    const stored = await McpAuth.get(MCP_NAME)
    expect(stored?.tokens?.accessToken).toBe("access-from-as-a.example.com")
    expect(stored?.tokens?.issuer).toBe(AS_A)
  })

  test("does not present credentials to a different authorization server", async () => {
    await storeCredentials(AS_A)
    const server = authServer(() => AS_B)
    const redirects: URL[] = []

    expect(await auth(provider(redirects), { serverUrl: SERVER_URL, fetchFn: server.fetchFn })).toBe("REDIRECT")

    const sentToB = server.sentTo(AS_B)
    expect(sentToB.some((r) => r.sent.includes("refresh-a"))).toBe(false)
    expect(sentToB.some((r) => r.sent.includes("secret-a"))).toBe(false)
    expect(sentToB.some((r) => r.url.pathname === "/token")).toBe(false)
    // A fresh registration with the new authorization server replaces the old binding.
    expect(redirects[0]?.searchParams.get("client_id")).toBe("client-from-as-b.example.com")
    const stored = await McpAuth.get(MCP_NAME)
    expect(stored?.clientInfo).toMatchObject({ clientId: "client-from-as-b.example.com", issuer: AS_B })
  })

  test("binds credentials stored by an earlier version on first successful use", async () => {
    await storeCredentials(undefined)
    const server = authServer(() => AS_A)

    expect(await auth(provider(), { serverUrl: SERVER_URL, fetchFn: server.fetchFn })).toBe("AUTHORIZED")

    const stored = await McpAuth.get(MCP_NAME)
    expect(stored?.clientInfo).toMatchObject({ clientId: "client-a", issuer: AS_A })
    expect(stored?.tokens?.issuer).toBe(AS_A)
  })
})

describe("McpOAuthProvider configured client binding", () => {
  async function storeConfiguredBinding(issuer: string) {
    await McpAuth.set(
      MCP_NAME,
      {
        clientInfo: { clientId: CONFIGURED.clientId, issuer },
        tokens: { accessToken: "access-a", refreshToken: "refresh-a", expiresAt: Date.now() / 1000 - 60, issuer },
        oauthState: "state",
      },
      SERVER_URL,
    )
  }

  test("binds configured credentials on first use without storing the secret", async () => {
    await McpAuth.set(
      MCP_NAME,
      { tokens: { accessToken: "access-a", refreshToken: "refresh-a", expiresAt: Date.now() / 1000 - 60 } },
      SERVER_URL,
    )
    const server = authServer(() => AS_A)

    expect(await auth(configuredProvider(), { serverUrl: SERVER_URL, fetchFn: server.fetchFn })).toBe("AUTHORIZED")

    expect(server.sentTo(AS_A).find((r) => r.url.pathname === "/token")?.sent).toContain(CONFIGURED.clientSecret)
    const stored = await McpAuth.get(MCP_NAME)
    expect(stored?.clientInfo).toEqual({ clientId: CONFIGURED.clientId, issuer: AS_A })
    expect((await configuredProvider().clientInformation())?.issuer).toBe(AS_A)
  })

  test("does not present configured credentials to a different authorization server", async () => {
    await storeConfiguredBinding(AS_A)
    const server = authServer(() => AS_B)

    // The SDK registers a throwaway client with the new server instead of using the configured one,
    expect(await auth(configuredProvider(), { serverUrl: SERVER_URL, fetchFn: server.fetchFn })).toBe("REDIRECT")
    // and the code exchange that would carry the configured secret is refused.
    await expect(
      auth(configuredProvider(), { serverUrl: SERVER_URL, authorizationCode: "code", fetchFn: server.fetchFn }),
    ).rejects.toThrow()

    const sentToB = server.sentTo(AS_B)
    expect(sentToB.some((r) => r.sent.includes(CONFIGURED.clientSecret))).toBe(false)
    expect(sentToB.some((r) => r.sent.includes("refresh-a"))).toBe(false)
    expect(sentToB.some((r) => r.url.pathname === "/token")).toBe(false)
    expect((await McpAuth.get(MCP_NAME))?.clientInfo).toEqual({ clientId: CONFIGURED.clientId, issuer: AS_A })
  })

  test("keeps the configured binding when the SDK invalidates credentials", async () => {
    await storeConfiguredBinding(AS_A)
    const p = configuredProvider()

    await p.invalidateCredentials("client")
    await p.invalidateCredentials("all")

    const stored = await McpAuth.get(MCP_NAME)
    expect(stored?.clientInfo).toEqual({ clientId: CONFIGURED.clientId, issuer: AS_A })
    expect(stored?.tokens).toBeUndefined()
    expect((await p.clientInformation())?.issuer).toBe(AS_A)
  })
})
