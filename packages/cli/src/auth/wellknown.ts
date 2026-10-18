import z from "zod"

export namespace WellKnownAuth {
  const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

  export const Document = z.object({
    auth: z.object({
      command: z.array(z.string().min(1)).min(1),
      env: z.string().min(1),
    }),
  })
  export type Command = z.infer<typeof Document>["auth"]

  // The provider dictates a local command, so plain http is only allowed for local development.
  export function endpoint(providerURL: string): string {
    const url = new URL(providerURL)
    const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
    if (url.protocol !== "https:" && !loopback) {
      throw new Error(`Auth provider URL must use https: ${providerURL}`)
    }
    return `${providerURL}/.well-known/aictrl`
  }

  export async function fetchCommand(providerURL: string): Promise<Command> {
    const response = await fetch(endpoint(providerURL))
    if (!response.ok) {
      throw new Error(`Failed to fetch auth provider config from ${providerURL}: ${response.status}`)
    }
    return Document.parse(await response.json()).auth
  }
}
