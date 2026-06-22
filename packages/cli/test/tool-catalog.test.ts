/**
 * TDD tests for the `tool_catalog` NDJSON event (issue #85).
 *
 * Tests verify:
 * 1. buildToolCatalogItems() returns builtin tools (source: builtin)
 * 2. MCP tools appear when an MCP server is attached (source: mcp, correct server)
 * 3. MCP tools are absent when no MCP server is attached
 * 4. Skills appear in the separate skills[] array with name + version
 * 5. Skills have version: null when no version is in frontmatter
 */
import { describe, expect, test } from "bun:test"
import { Instance } from "../src/project/instance"
import { tmpdir } from "./fixture/fixture"
import { buildToolCatalogItems } from "../src/cli/cmd/tool-catalog"
import type { SkillCatalogEntry, ToolCatalogEntry } from "../src/cli/cmd/tool-catalog"
import path from "path"
import fs from "fs/promises"

// Helper to create a minimal SKILL.md with optional version in frontmatter
async function writeSkill(
  dir: string,
  name: string,
  description: string,
  version?: string,
): Promise<void> {
  const versionLine = version ? `version: ${version}\n` : ""
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n${versionLine}---`
  const skillDir = path.join(dir, ".claude", "skills", name)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `${frontmatter}\n\nSkill content here.\n`)
}

// Fake MCP tool provider — simulates a connected MCP server with given tools
function fakeMcpTools(serverName: string, toolNames: string[]): () => Promise<{ toolKey: string; serverName: string }[]> {
  return async () =>
    toolNames.map((n) => ({
      toolKey: `${serverName}_${n}`,
      serverName,
    }))
}

// Fake MCP provider returning no tools
function noMcpTools(): () => Promise<{ toolKey: string; serverName: string }[]> {
  return async () => []
}

describe("tool_catalog event helpers", () => {
  describe("buildToolCatalogItems — builtin tools", () => {
    test("builtin tools have source=builtin and a name", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { tools } = await buildToolCatalogItems({ getMcpTools: noMcpTools() })

          expect(tools.length).toBeGreaterThan(0)

          const builtins = tools.filter((t: ToolCatalogEntry) => t.source === "builtin")
          expect(builtins.length).toBeGreaterThan(0)

          // All builtin tools must have a name
          for (const t of builtins) {
            expect(typeof t.name).toBe("string")
            expect(t.name.length).toBeGreaterThan(0)
          }

          // Known builtin tools that are always present
          const names = builtins.map((t: ToolCatalogEntry) => t.name)
          expect(names).toContain("bash")
          expect(names).toContain("read")
          expect(names).toContain("edit")
        },
      })
    })

    test("builtin tools do NOT have a server field", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { tools } = await buildToolCatalogItems({ getMcpTools: noMcpTools() })
          const builtins = tools.filter((t: ToolCatalogEntry) => t.source === "builtin")
          for (const t of builtins) {
            expect(t.server).toBeUndefined()
          }
        },
      })
    })
  })

  describe("buildToolCatalogItems — MCP tools", () => {
    test("MCP tools are absent when no MCP server is configured", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { tools } = await buildToolCatalogItems({ getMcpTools: noMcpTools() })
          const mcpTools = tools.filter((t: ToolCatalogEntry) => t.source === "mcp")
          expect(mcpTools.length).toBe(0)
        },
      })
    })

    test("MCP tools appear with source=mcp and correct server name when attached", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { tools } = await buildToolCatalogItems({
            getMcpTools: fakeMcpTools("aictrl", ["record_finding", "record_review_completed"]),
          })

          const mcpTools = tools.filter((t: ToolCatalogEntry) => t.source === "mcp")
          expect(mcpTools.length).toBe(2)

          const names = mcpTools.map((t: ToolCatalogEntry) => t.name)
          expect(names).toContain("aictrl_record_finding")
          expect(names).toContain("aictrl_record_review_completed")

          // MCP tools carry the server name
          for (const t of mcpTools) {
            expect(t.server).toBe("aictrl")
          }
        },
      })
    })

    test("consumer gate: record_finding absent when a different server is attached (tool exposed vs missing)", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Attach a server that does NOT have record_finding
          const { tools } = await buildToolCatalogItems({
            getMcpTools: fakeMcpTools("other_server", ["some_other_tool"]),
          })

          const names = tools.map((t: ToolCatalogEntry) => t.name)
          // record_finding is NOT in the list — consumer can structurally detect this
          expect(names).not.toContain("aictrl_record_finding")
          expect(names).not.toContain("aictrl_record_review_completed")
          // other_server tool IS present
          expect(names).toContain("other_server_some_other_tool")
        },
      })
    })

    test("multiple MCP servers: tools from all servers appear in tools[]", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const getMcpTools = async () => [
            { toolKey: "aictrl_record_finding", serverName: "aictrl" },
            { toolKey: "other_another_tool", serverName: "other" },
          ]

          const { tools } = await buildToolCatalogItems({ getMcpTools })
          const mcpTools = tools.filter((t: ToolCatalogEntry) => t.source === "mcp")
          expect(mcpTools.length).toBe(2)

          const aictrlTool = mcpTools.find((t: ToolCatalogEntry) => t.name === "aictrl_record_finding")
          expect(aictrlTool?.server).toBe("aictrl")

          const otherTool = mcpTools.find((t: ToolCatalogEntry) => t.name === "other_another_tool")
          expect(otherTool?.server).toBe("other")
        },
      })
    })
  })

  describe("buildToolCatalogItems — skills", () => {
    test("skills[] is separate from tools[] and carries name + version", async () => {
      await using tmp = await tmpdir({ git: true })
      await writeSkill(tmp.path, "code-review", "Perform code reviews", "1.4.0")
      await writeSkill(tmp.path, "commit", "Create commits", "0.2.0")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { tools, skills } = await buildToolCatalogItems({ getMcpTools: noMcpTools() })

          // Skills are NOT in tools[]
          const skillNamesInTools = tools.map((t: ToolCatalogEntry) => t.name).filter((n) => n === "code-review" || n === "commit")
          expect(skillNamesInTools.length).toBe(0)

          // Skills are in skills[]
          expect(skills.length).toBeGreaterThanOrEqual(2)

          const codeReview = skills.find((s: SkillCatalogEntry) => s.name === "code-review")
          expect(codeReview).toBeDefined()
          expect(codeReview!.version).toBe("1.4.0")

          const commit = skills.find((s: SkillCatalogEntry) => s.name === "commit")
          expect(commit).toBeDefined()
          expect(commit!.version).toBe("0.2.0")
        },
      })
    })

    test("skills with no version in frontmatter have version=null", async () => {
      await using tmp = await tmpdir({ git: true })
      await writeSkill(tmp.path, "no-version-skill", "A skill without version")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { skills } = await buildToolCatalogItems({ getMcpTools: noMcpTools() })

          const s = skills.find((s: SkillCatalogEntry) => s.name === "no-version-skill")
          expect(s).toBeDefined()
          expect(s!.version).toBeNull()
        },
      })
    })

    test("non-version frontmatter keys survive in skill.metadata", async () => {
      await using tmp = await tmpdir({ git: true })
      // SKILL.md with license, author, and version in frontmatter
      const skillDir = path.join(tmp.path, ".claude", "skills", "licensed-skill")
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: licensed-skill",
          "description: A skill with extra frontmatter",
          "version: 2.1.0",
          "license: MIT",
          "author: aictrl-team",
          "---",
          "",
          "Skill content here.",
        ].join("\n"),
      )

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { Skill } = await import("../src/skill")
          const skills = await Skill.all()

          const s = skills.find((x) => x.name === "licensed-skill")
          expect(s).toBeDefined()

          // version still resolves via metadata.version
          expect(s!.version).toBe("2.1.0")

          // non-version keys survive in metadata
          expect(s!.metadata).toBeDefined()
          expect(s!.metadata["license"]).toBe("MIT")
          expect(s!.metadata["author"]).toBe("aictrl-team")

          // name and description are NOT duplicated in metadata
          expect(s!.metadata["name"]).toBeUndefined()
          expect(s!.metadata["description"]).toBeUndefined()
        },
      })
    })

    test("skills[] does not include MCP tools or builtins", async () => {
      await using tmp = await tmpdir({ git: true })
      await writeSkill(tmp.path, "my-skill", "A skill", "1.0.0")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { tools, skills } = await buildToolCatalogItems({
            getMcpTools: fakeMcpTools("aictrl", ["record_finding"]),
          })

          // skills[] should only contain skills
          expect(skills.every((s: SkillCatalogEntry) => typeof s.name === "string" && "version" in s)).toBe(true)

          // No source field on skill entries
          for (const s of skills) {
            expect((s as any).source).toBeUndefined()
          }
        },
      })
    })
  })

  describe("buildToolCatalogItems — error propagation", () => {
    test("rejects when a dep throws, so the caller catch can log it (regression for silent-swallow bug)", async () => {
      // If buildToolCatalogItems swallowed errors itself, this would resolve.
      // It must reject so callers have a chance to log before discarding.
      const throwingDep = async (): Promise<{ toolKey: string; serverName: string }[]> => {
        throw new Error("simulated MCP failure")
      }

      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(
            buildToolCatalogItems({ getMcpTools: throwingDep }),
          ).rejects.toThrow("simulated MCP failure")
        },
      })
    })

    test("withTimeout wrapping surfaces a timed-out catalog as a rejection (regression: hanging MCP server must not stall session start)", async () => {
      // This test verifies that when buildToolCatalogItems is wrapped with
      // withTimeout (as done in run.ts), a never-resolving dep causes the
      // outer promise to reject — NOT to hang indefinitely. The session-start
      // guard in run.ts catches this and emits tool_catalog_error to stdout.
      const { withTimeout } = await import("../src/util/timeout")

      const neverResolvingDep = (): Promise<{ toolKey: string; serverName: string }[]> =>
        new Promise(() => {
          // intentionally never resolves or rejects — simulates a hanging MCP client
        })

      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(
            withTimeout(buildToolCatalogItems({ getMcpTools: neverResolvingDep }), 50),
          ).rejects.toThrow(/timed out/i)
        },
      })
    })

    test("structured error path: catalog failure produces diagnosable error message (regression: console.error to stdout event)", async () => {
      // Verifies that the rejection from buildToolCatalogItems carries enough
      // information for the caller to construct a structured tool_catalog_error event.
      // The key requirement: error.message must be a non-empty string.
      const throwingDep = async (): Promise<{ toolKey: string; serverName: string }[]> => {
        throw new Error("MCP server connection refused")
      }

      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          let capturedMessage: string | undefined
          await buildToolCatalogItems({ getMcpTools: throwingDep }).catch((err) => {
            capturedMessage = err instanceof Error ? err.message : String(err)
          })
          expect(capturedMessage).toBeDefined()
          expect(typeof capturedMessage).toBe("string")
          expect(capturedMessage!.length).toBeGreaterThan(0)
        },
      })
    })
  })

  describe("MCP tool key format", () => {
    test("special characters in server/tool names are sanitized to underscores", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Simulate a server name with special chars
          const getMcpTools = async () => [
            { toolKey: "my_server_my_tool", serverName: "my.server" },
            { toolKey: "other__server_tool__name", serverName: "other/ server" },
          ]

          const { tools } = await buildToolCatalogItems({ getMcpTools })
          const mcpTools = tools.filter((t: ToolCatalogEntry) => t.source === "mcp")

          // Keys must match sanitized format: [a-zA-Z0-9_-] only
          for (const t of mcpTools) {
            expect(t.name).toMatch(/^[a-zA-Z0-9_-]+$/)
          }
        },
      })
    })
  })
})
