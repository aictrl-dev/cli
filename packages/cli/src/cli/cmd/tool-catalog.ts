/**
 * tool-catalog.ts — builds the resolved tool/skill inventory emitted in the
 * `tool_catalog` NDJSON event (issue #85).
 *
 * Exported as a standalone module so it can be unit-tested independently of
 * the full run.ts wiring.
 */
import { ToolRegistry } from "../../tool/registry"
import { MCP } from "../../mcp"
import { Skill } from "../../skill"

/** A single entry in the `tools[]` array of the `tool_catalog` event. */
export interface ToolCatalogEntry {
  /** Tool name as exposed to the model. Mirrors upstream ToolListItem.id. */
  name: string
  /** Whether the tool is a builtin (local) or an MCP tool. */
  source: "builtin" | "mcp"
  /**
   * The MCP server name for source=mcp tools (sanitized client name).
   * Omitted for builtin tools.
   */
  server?: string
}

/** A single entry in the `skills[]` array of the `tool_catalog` event. */
export interface SkillCatalogEntry {
  /** Skill name from SKILL.md frontmatter. */
  name: string
  /**
   * Skill version from SKILL.md frontmatter `version` field.
   * null when no version is declared in frontmatter.
   */
  version: string | null
}

/** Result of buildToolCatalogItems(). */
export interface ToolCatalogItems {
  tools: ToolCatalogEntry[]
  skills: SkillCatalogEntry[]
}

/**
 * Dependency injection shape, used for testing to avoid touching real MCP
 * state and the real filesystem.
 */
export interface ToolCatalogDeps {
  /**
   * Returns builtin tool IDs (the resolved set for the current instance).
   * Defaults to ToolRegistry.ids().
   */
  getBuiltinIds?: () => Promise<string[]>

  /**
   * Returns connected MCP tools as { toolKey, serverName } pairs.
   * toolKey = the combined `serverName_toolName` key given to the model.
   * Defaults to an internal implementation using MCP.clients() + listTools().
   */
  getMcpTools?: () => Promise<{ toolKey: string; serverName: string }[]>

  /**
   * Returns the list of resolved skills.
   * Defaults to Skill.all().
   */
  getSkills?: () => Promise<Skill.Info[]>
}

/**
 * Collects the resolved tool catalog and skill list for the current session.
 *
 * Uses ToolRegistry.ids() for builtins (the instance-level superset, without
 * model-specific filtering which only applies per-turn inside resolveTools).
 * Uses MCP connected clients for MCP tools.
 * Uses Skill.all() for skills with optional version from frontmatter.
 */
export async function buildToolCatalogItems(deps: ToolCatalogDeps = {}): Promise<ToolCatalogItems> {
  const getBuiltinIds = deps.getBuiltinIds ?? (() => ToolRegistry.ids())
  const getMcpTools = deps.getMcpTools ?? defaultGetMcpTools
  const getSkills = deps.getSkills ?? (() => Skill.all())

  const [builtinIds, mcpTools, skills] = await Promise.all([getBuiltinIds(), getMcpTools(), getSkills()])

  const tools: ToolCatalogEntry[] = [
    ...builtinIds.map(
      (name): ToolCatalogEntry => ({
        name,
        source: "builtin",
      }),
    ),
    ...mcpTools.map(
      ({ toolKey, serverName }): ToolCatalogEntry => ({
        name: toolKey,
        source: "mcp",
        server: serverName,
      }),
    ),
  ]

  const skillEntries: SkillCatalogEntry[] = skills.map((s) => ({
    name: s.name,
    version: s.version ?? null,
  }))

  return { tools, skills: skillEntries }
}

/**
 * Default MCP tool resolver: delegates to MCP.toolEntries() which queries
 * each connected client's tool list and returns { toolKey, serverName } pairs
 * (matching the key format used in SessionPrompt.resolveTools).
 */
async function defaultGetMcpTools(): Promise<{ toolKey: string; serverName: string }[]> {
  return MCP.toolEntries()
}
