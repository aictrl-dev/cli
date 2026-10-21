import { test, expect } from "bun:test"
import { WellKnownAuth } from "../../src/auth/wellknown"

test("builds the well-known endpoint for https providers", () => {
  expect(WellKnownAuth.endpoint("https://auth.example.com")).toBe("https://auth.example.com/.well-known/aictrl")
})

test("allows plain http only for loopback hosts", () => {
  expect(WellKnownAuth.endpoint("http://localhost:4096")).toBe("http://localhost:4096/.well-known/aictrl")
  expect(WellKnownAuth.endpoint("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096/.well-known/aictrl")
  expect(WellKnownAuth.endpoint("http://[::1]:4096")).toBe("http://[::1]:4096/.well-known/aictrl")
})

test("rejects insecure or non-http provider URLs", () => {
  expect(() => WellKnownAuth.endpoint("http://auth.example.com")).toThrow("must use https")
  expect(() => WellKnownAuth.endpoint("file:///etc/passwd")).toThrow("must use https")
  expect(() => WellKnownAuth.endpoint("auth.example.com")).toThrow()
})

test("accepts a well-formed auth command", () => {
  const parsed = WellKnownAuth.Document.parse({ auth: { command: ["cli", "token"], env: "TOKEN" }, config: {} })
  expect(parsed.auth).toEqual({ command: ["cli", "token"], env: "TOKEN" })
})

test("rejects malformed auth commands", () => {
  expect(() => WellKnownAuth.Document.parse({ auth: { command: "cli token", env: "TOKEN" } })).toThrow()
  expect(() => WellKnownAuth.Document.parse({ auth: { command: [], env: "TOKEN" } })).toThrow()
  expect(() => WellKnownAuth.Document.parse({ auth: { command: ["cli"] } })).toThrow()
  expect(() => WellKnownAuth.Document.parse({})).toThrow()
})

test("appends the endpoint to the base path without query, fragment, or trailing slashes", () => {
  for (const suffix of ["", "/", "///", "?tenant=example", "/?tenant=example#login"]) {
    expect(WellKnownAuth.endpoint(`https://auth.example.com/base${suffix}`)).toBe(
      "https://auth.example.com/base/.well-known/aictrl",
    )
  }
})

test("malformed provider URLs have a minimal actionable message and retain the cause", () => {
  try {
    WellKnownAuth.endpoint("invalid-owned-url\nPRIVATE_DOCUMENT_MARKER")
    throw new Error("Expected an invalid URL error")
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Supply an absolute https URL")
    expect((error as Error).message).not.toContain("PRIVATE_DOCUMENT_MARKER")
    expect((error as Error).cause).toBeInstanceOf(Error)
  }
})

test("terminal display escapes controls while preserving exact values and argument boundaries", () => {
  const command = ["owned-cli", "two words", 'quote" and `literal`', "\x1b[2J\x07\r\n\t\0\x7f\x85\u2028\u2029\u202e"]
  const rendered = WellKnownAuth.display(command)
  expect(JSON.parse(rendered)).toEqual(command)
  expect(rendered).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202e]/)
  expect(rendered).toContain('"two words"')
  expect(rendered).toContain("\\u001b")
  expect(rendered).toContain("\\u202e")
  const provider = "https://auth.example.com/?hint=\x1b[2J\n\u2066"
  expect(JSON.parse(WellKnownAuth.display(provider))).toBe(provider)
  expect(WellKnownAuth.display(provider)).not.toMatch(/[\x00-\x1f\u2066]/)
})

test("fetches the canonical endpoint and returns only the validated auth command", async () => {
  const paths: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname)
      return Response.json({ auth: { command: ["owned-cli", "two words"], env: "OWNED_TOKEN" } })
    },
  })
  try {
    expect(await WellKnownAuth.fetchCommand(`${server.url}base///?tenant=example#login`)).toEqual({
      command: ["owned-cli", "two words"],
      env: "OWNED_TOKEN",
    })
    expect(paths).toEqual(["/base/.well-known/aictrl"])
  } finally {
    await server.stop(true)
  }
})

test("never follows an auth document redirect to another owned loopback server", async () => {
  let followed = 0
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      followed++
      return Response.json({ auth: { command: ["owned-cli"], env: "OWNED_TOKEN" } })
    },
  })
  const redirect = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.redirect(target.url),
  })
  try {
    await expect(WellKnownAuth.fetchCommand(redirect.url.toString())).rejects.toThrow("without redirects")
    expect(followed).toBe(0)
  } finally {
    await Promise.all([redirect.stop(true), target.stop(true)])
  }
})

for (const [name, response, message] of [
  ["HTTP error", () => new Response("PRIVATE_DOCUMENT_MARKER", { status: 503 }), "HTTP 503"],
  ["invalid JSON", () => new Response("PRIVATE_DOCUMENT_MARKER"), "not valid JSON"],
  ["invalid schema", () => Response.json({ auth: { command: "PRIVATE_DOCUMENT_MARKER" } }), "auth.command"],
] as const) {
  test(`${name} produces an actionable error with cause without echoing the document`, async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: response })
    try {
      let failure: Error | undefined
      try {
        await WellKnownAuth.fetchCommand(server.url.toString())
      } catch (error) {
        failure = error as Error
      }
      expect(failure).toBeInstanceOf(Error)
      expect(failure!.message).toContain(message)
      expect(failure!.message).not.toContain("PRIVATE_DOCUMENT_MARKER")
      expect(failure!.cause).toBeDefined()
    } finally {
      await server.stop(true)
    }
  })
}
