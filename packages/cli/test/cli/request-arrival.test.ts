import { describe, expect, test } from "bun:test"
import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

// Exercise the actual owned handler bodies without starting a CLI or claiming
// that a CLI request has been reproduced before stdin EOF.
const fixtures = [
  ["template", "fixture/command-template-capture.ts", "/v1/chat/completions"],
  ["integrated", "fixture/integrated-capture.ts", "/v1/chat/completions"],
  ["stdin", "run-stdin.test.ts", "/session"],
] as const

describe("server-observed request arrival", () => {
  test.each(fixtures)("%s records arrival while JSON is incomplete", async (name, file, route) => {
    const source = ts.createSourceFile(
      file,
      await fs.readFile(path.join(import.meta.dir, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    )
    let handler: ts.MethodDeclaration | undefined
    const visit = (node: ts.Node) => {
      if (handler) return
      if (ts.isCallExpression(node) && node.expression.getText(source) === "Bun.serve") {
        const options = node.arguments[0]
        if (!options || !ts.isObjectLiteralExpression(options)) throw new Error("Fixture serve options changed")
        handler = options.properties.find(
          (property): property is ts.MethodDeclaration =>
            ts.isMethodDeclaration(property) && property.name.getText(source) === "fetch",
        )
        if (!handler) throw new Error("Fixture fetch handler missing")
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (!handler) throw new Error("Fixture server missing")
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
      `const fixture = { ${handler.getText(source)} }`,
    )
    const state = { requests: [] as Record<string, unknown>[], http: [] as Record<string, unknown>[] }
    const capture = new Function(
      "state",
      "path",
      `const requests = state.requests, http = state.http;
       let requestArrivals = 0, stream;
       const input = { read: false }, cwd = "/owned-arrival-control", sessionID = "ses_stdin_fixture";
       ${compiled}
       return { fetch: fixture.fetch, count: () => requestArrivals };`,
    )(state, path) as { fetch: (request: Request) => Promise<Response>; count: () => number }
    let enter: () => void = () => {}
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        enter()
        return capture.fetch(request)
      },
    })
    const body = JSON.stringify({ messages: [] })
    let client: http.ClientRequest | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const response = new Promise<number>((resolve, reject) => {
        client = http.request(
          new URL(route, server.url),
          {
            method: "POST",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          },
          (result) => {
            result.resume()
            result.once("end", () => resolve(result.statusCode ?? 0))
            result.once("error", reject)
          },
        )
        client.once("error", reject)
        client.write(body.slice(0, 1))
      })
      const failure = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Arrival control deadline")), 3000)
      })
      await Promise.race([
        entered,
        response.then(() => {
          throw new Error("Response completed before the incomplete-body observation")
        }),
        failure,
      ])
      // Handler entry is explicit; the remaining JSON bytes are still withheld.
      expect(capture.count()).toBe(1)
      expect(state.requests).toHaveLength(0)
      if (name === "integrated") {
        expect(state.http).toHaveLength(1)
        expect(state.http[0]).toEqual({ method: "POST", path: route, body: undefined })
      }
      client!.end(body.slice(1))
      expect(await Promise.race([response, failure])).toBe(200)
      expect(state.requests).toHaveLength(1)
      expect(capture.count()).toBe(1)
    } finally {
      clearTimeout(deadline)
      client?.destroy()
      await server.stop(true)
    }
  })
})
