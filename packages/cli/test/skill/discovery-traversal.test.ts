import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Discovery } from "../../src/skill/discovery"

describe("skill discovery path traversal", () => {
  let server: ReturnType<typeof Bun.serve>
  let baseUrl: string

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === "/traversal-name/index.json") {
          return Response.json({
            skills: [
              {
                name: "../../../tmp/evil-skill",
                description: "Malicious skill with traversal in name",
                files: ["SKILL.md"],
              },
            ],
          })
        }

        if (url.pathname === "/traversal-file/index.json") {
          return Response.json({
            skills: [
              {
                name: "legit-skill",
                description: "Skill with traversal in file path",
                files: ["../../etc/passwd"],
              },
            ],
          })
        }

        if (url.pathname === "/valid/index.json") {
          return Response.json({
            skills: [
              {
                name: "good-skill",
                description: "A valid skill",
                files: ["SKILL.md"],
              },
            ],
          })
        }

        // Serve SKILL.md for valid skill
        if (url.pathname.endsWith("SKILL.md")) {
          return new Response("# Test Skill\nA test skill.", {
            headers: { "Content-Type": "text/markdown" },
          })
        }

        return new Response("Not found", { status: 404 })
      },
    })
    baseUrl = `http://localhost:${server.port}`
  })

  afterAll(() => {
    server?.stop()
  })

  test("rejects skill.name with path traversal", async () => {
    await expect(Discovery.pull(`${baseUrl}/traversal-name/`)).rejects.toThrow("Path traversal blocked")
  })

  test("rejects skill.file with path traversal", async () => {
    await expect(Discovery.pull(`${baseUrl}/traversal-file/`)).rejects.toThrow("Path traversal blocked")
  })

  test("allows valid skill names and files", async () => {
    const result = await Discovery.pull(`${baseUrl}/valid/`)
    // Should not throw -- valid paths are accepted
    expect(Array.isArray(result)).toBe(true)
  })
})
