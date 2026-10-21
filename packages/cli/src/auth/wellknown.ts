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
    let url: URL
    try {
      url = new URL(providerURL)
    } catch (cause) {
      throw new Error("Invalid auth provider URL. Supply an absolute https URL.", { cause })
    }
    const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
    if (url.protocol !== "https:" && !loopback) {
      throw new Error("Auth provider URL must use https (except http on loopback hosts).")
    }
    url.search = ""
    url.hash = ""
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/.well-known/aictrl`
    return url.toString()
  }

  export function display(value: string | readonly string[]): string {
    return JSON.stringify(value).replace(
      /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
  }

  export async function fetchCommand(providerURL: string): Promise<Command> {
    const target = endpoint(providerURL)
    let response: Response
    try {
      response = await fetch(target, { redirect: "error" })
    } catch (cause) {
      throw new Error(
        "Failed to fetch auth provider config. Check connectivity and use a direct URL without redirects.",
        {
          cause,
        },
      )
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch auth provider config (HTTP ${response.status}). Check the provider URL.`, {
        cause: response,
      })
    }
    let document: unknown
    try {
      document = await response.json()
    } catch (cause) {
      throw new Error("Auth provider config is not valid JSON. Contact the provider to fix its well-known document.", {
        cause,
      })
    }
    try {
      return Document.parse(document).auth
    } catch (cause) {
      throw new Error(
        "Auth provider config must supply auth.command as a nonempty string array and auth.env as a string.",
        {
          cause,
        },
      )
    }
  }
}
