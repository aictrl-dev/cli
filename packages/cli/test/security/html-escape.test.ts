import { describe, expect, test } from "bun:test"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe("SEC-04: HTML escaping in OAuth error templates", () => {
  test("oauth-callback.ts HTML_ERROR escapes HTML entities", async () => {
    const source = await Bun.file(
      path.join(__dirname, "../../src/mcp/oauth-callback.ts"),
    ).text()

    expect(source).toContain("Bun.escapeHTML(error)")

    const htmlErrorStart = source.indexOf("const HTML_ERROR")
    const htmlErrorEnd = source.indexOf("</html>`", htmlErrorStart)
    const htmlErrorTemplate = source.slice(htmlErrorStart, htmlErrorEnd)

    expect(htmlErrorTemplate).toContain("Bun.escapeHTML(error)")
    const rawInterpolations = htmlErrorTemplate.match(/\$\{error\}/g)
    expect(rawInterpolations).toBeNull()
  })

  test("codex.ts HTML_ERROR escapes HTML entities", async () => {
    const source = await Bun.file(
      path.join(__dirname, "../../src/plugin/codex.ts"),
    ).text()

    expect(source).toContain("Bun.escapeHTML(error)")

    const htmlErrorStart = source.indexOf("const HTML_ERROR")
    const htmlErrorEnd = source.indexOf("</html>`", htmlErrorStart)
    const htmlErrorTemplate = source.slice(htmlErrorStart, htmlErrorEnd)

    expect(htmlErrorTemplate).toContain("Bun.escapeHTML(error)")
    const rawInterpolations = htmlErrorTemplate.match(/\$\{error\}/g)
    expect(rawInterpolations).toBeNull()
  })

  test("Bun.escapeHTML prevents script injection", () => {
    const malicious = '<script>alert("xss")</script>'
    const escaped = Bun.escapeHTML(malicious)

    expect(escaped).not.toContain("<script>")
    expect(escaped).toContain("&lt;script&gt;")
    expect(escaped).toContain("&lt;/script&gt;")
  })
})

describe("SEC-05: env var allowlist in config substitution", () => {
  test("paths.ts uses allowlist for env var substitution", async () => {
    const source = await Bun.file(
      path.join(__dirname, "../../src/config/paths.ts"),
    ).text()

    expect(source).toContain("isAllowedEnvVar")
    expect(source).toContain("ENV_ALLOWED_PREFIXES")

    const substituteStart = source.indexOf("async function substitute")
    const substituteEnd = source.indexOf("return text\n", source.indexOf("{env:", substituteStart))
    const substituteBody = source.slice(substituteStart, substituteEnd)
    expect(substituteBody).toContain("isAllowedEnvVar")
  })

  test("allowed env vars expand correctly via ConfigPaths.parseText", async () => {
    const { ConfigPaths } = await import("../../src/config/paths")

    process.env.AICTRL_TEST_VAR = "test-value"
    try {
      const result = await ConfigPaths.parseText(
        '{"key": "{env:AICTRL_TEST_VAR}"}',
        { source: "test.json", dir: "/tmp" },
        "empty",
      )
      expect(result.key).toBe("test-value")
    } finally {
      delete process.env.AICTRL_TEST_VAR
    }
  })

  test("blocked env vars expand to empty via ConfigPaths.parseText", async () => {
    const { ConfigPaths } = await import("../../src/config/paths")

    process.env.MY_SECRET_DATABASE_PASSWORD = "super-secret"
    try {
      const result = await ConfigPaths.parseText(
        '{"key": "{env:MY_SECRET_DATABASE_PASSWORD}"}',
        { source: "test.json", dir: "/tmp" },
        "empty",
      )
      expect(result.key).toBe("")
    } finally {
      delete process.env.MY_SECRET_DATABASE_PASSWORD
    }
  })

  test("standard system vars are allowed", async () => {
    const { ConfigPaths } = await import("../../src/config/paths")

    const homeVal = process.env.HOME
    if (homeVal) {
      const result = await ConfigPaths.parseText(
        '{"home": "{env:HOME}"}',
        { source: "test.json", dir: "/tmp" },
        "empty",
      )
      expect(result.home).toBe(homeVal)
    }
  })

  test("provider API key prefixes are allowed", async () => {
    const { ConfigPaths } = await import("../../src/config/paths")

    process.env.ANTHROPIC_TEST_KEY = "sk-test"
    process.env.OPENAI_TEST_KEY = "sk-test-2"
    try {
      const result = await ConfigPaths.parseText(
        '{"a": "{env:ANTHROPIC_TEST_KEY}", "b": "{env:OPENAI_TEST_KEY}"}',
        { source: "test.json", dir: "/tmp" },
        "empty",
      )
      expect(result.a).toBe("sk-test")
      expect(result.b).toBe("sk-test-2")
    } finally {
      delete process.env.ANTHROPIC_TEST_KEY
      delete process.env.OPENAI_TEST_KEY
    }
  })
})
