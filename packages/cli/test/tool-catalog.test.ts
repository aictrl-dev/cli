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
})
