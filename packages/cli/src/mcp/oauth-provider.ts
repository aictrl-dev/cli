import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { McpAuth } from "./auth"
import { Log } from "../util/log"

const log = Log.create({ service: "mcp.oauth" })

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
}

export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    private mcpName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Aictrl",
      client_uri: "https://aictrl.ai",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    // Check config first (pre-registered client)
    if (this.config.clientId) return this.configuredClientInformation(this.config.clientId)

    // Check stored client info (from dynamic registration)
    // Use getForUrl to validate credentials are for the current server URL
    const entry = await McpAuth.getForUrl(this.mcpName, this.serverUrl)
    if (entry?.clientInfo) {
      // Check if client secret has expired
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        log.info("client secret expired, need to re-register", { mcpName: this.mcpName })
        return undefined
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
        issuer: entry.clientInfo.issuer,
      }
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    if (this.config.clientId) return this.bindConfiguredClient(this.config.clientId, info)

    await McpAuth.updateClientInfo(
      this.mcpName,
      {
        clientId: info.client_id,
        clientSecret: info.client_secret,
        clientIdIssuedAt: info.client_id_issued_at,
        clientSecretExpiresAt: info.client_secret_expires_at,
        issuer: info.issuer,
      },
      this.serverUrl,
    )
    log.info("saved dynamically registered client", {
      mcpName: this.mcpName,
      clientId: info.client_id,
    })
  }

  /**
   * Configured credentials, stamped with the authorization server they were first accepted by.
   * The SDK refuses to present a stamped client secret to any other authorization server.
   */
  private async configuredClientInformation(clientId: string): Promise<OAuthClientInformation> {
    const entry = await McpAuth.getForUrl(this.mcpName, this.serverUrl)
    const binding = entry?.clientInfo?.clientId === clientId ? entry.clientInfo.issuer : undefined
    return {
      client_id: clientId,
      client_secret: this.config.clientSecret,
      issuer: binding,
    }
  }

  /**
   * Stores only the authorization-server binding of configured credentials; the secret stays
   * in config. A different client_id is a registration with another authorization server,
   * which the configured client never uses, so it is not stored.
   */
  private async bindConfiguredClient(clientId: string, info: OAuthClientInformationFull): Promise<void> {
    if (info.client_id !== clientId) {
      log.warn("configured OAuth client is bound to another authorization server; not using it", {
        mcpName: this.mcpName,
        advertisedIssuer: info.issuer,
        hint: `run \`aictrl mcp logout ${this.mcpName}\` if the authorization server has moved`,
      })
      return
    }
    await McpAuth.updateClientInfo(this.mcpName, { clientId, issuer: info.issuer }, this.serverUrl)
    log.info("bound configured client to authorization server", { mcpName: this.mcpName, issuer: info.issuer })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Use getForUrl to validate tokens are for the current server URL
    const entry = await McpAuth.getForUrl(this.mcpName, this.serverUrl)
    if (!entry?.tokens) return undefined

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
      issuer: entry.tokens.issuer,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await McpAuth.updateTokens(
      this.mcpName,
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
        scope: tokens.scope,
        issuer: tokens.issuer,
      },
      this.serverUrl,
    )
    log.info("saved oauth tokens", { mcpName: this.mcpName })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info("redirecting to authorization", { mcpName: this.mcpName, url: authorizationUrl.toString() })
    await this.callbacks.onRedirect(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await McpAuth.updateCodeVerifier(this.mcpName, codeVerifier)
  }

  async codeVerifier(): Promise<string> {
    const entry = await McpAuth.get(this.mcpName)
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    return entry.codeVerifier
  }

  async saveState(state: string): Promise<void> {
    await McpAuth.updateOAuthState(this.mcpName, state)
  }

  async state(): Promise<string> {
    const entry = await McpAuth.get(this.mcpName)
    if (!entry?.oauthState) {
      throw new Error(`No OAuth state saved for MCP server: ${this.mcpName}`)
    }
    return entry.oauthState
  }

  async invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
    log.info("invalidating credentials", { mcpName: this.mcpName, type })
    const entry = await McpAuth.get(this.mcpName)
    if (!entry) {
      return
    }

    // The binding of configured credentials outlives invalidation: the secret is still in
    // config, and dropping the binding would let the next authorization server receive it.
    const keepBinding = Boolean(this.config.clientId)
    switch (type) {
      case "all":
        if (keepBinding) {
          await McpAuth.set(this.mcpName, { clientInfo: entry.clientInfo, serverUrl: entry.serverUrl })
          break
        }
        await McpAuth.remove(this.mcpName)
        break
      case "client":
        if (keepBinding) break
        delete entry.clientInfo
        await McpAuth.set(this.mcpName, entry)
        break
      case "tokens":
        delete entry.tokens
        await McpAuth.set(this.mcpName, entry)
        break
    }
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }
