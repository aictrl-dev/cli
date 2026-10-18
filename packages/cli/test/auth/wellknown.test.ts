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
