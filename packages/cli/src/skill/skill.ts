import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { NamedError } from "@aictrl/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { HeadlessRun } from "@/flag/headless-run"
import { Bus } from "@/bus"
import { Session } from "@/session"
import { Discovery } from "./discovery"
import { Glob } from "../util/glob"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
    /**
     * All frontmatter keys beyond `name`/`description`, with values
     * string-coerced. Retains arbitrary skill metadata (e.g. version, license,
     * author) without requiring per-field changes to the schema.
     *
     * NOTE: `metadata` and `version` below are TYPE-ONLY fields — they are NOT
     * validated by the `Info.pick({ name, description })` Zod parse in `addSkill`.
     * Both are populated manually from raw frontmatter after the parse succeeds
     * (see the `Object.fromEntries` block below). The schema fields exist solely
     * to give `Skill.Info` a correct TypeScript type; runtime coercion is
     * intentional to handle e.g. `version: 1.0` (YAML number) → `"1.0"` (string).
     */
    metadata: z.record(z.string(), z.string()).default({}),
    /**
     * Convenience accessor derived from `metadata.version`.
     * undefined when the frontmatter has no `version` key.
     * TYPE-ONLY — see note on `metadata` above.
     */
    version: z.string().optional(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  // External skill directories to search for (project-level and global)
  // These follow the directory layout used by Claude Code and other agents.
  const EXTERNAL_DIRS = [".claude", ".agents", ".opencode"]
  const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
  const AICTRL_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"

  /**
   * Invocation-level skill scope. `aictrl run` sets it before bootstrapping, so
   * the main session and every subagent share one scoped skill set.
   */
  export type Scope = {
    /** Only these skill names are listed and loadable; replaces config `skills.allow`. */
    allow?: string[]
  }

  let invocation: Scope = {}

  /** Applies to instances created afterwards; an instance keeps the scope it was discovered with. */
  export function setScope(next: Scope) {
    invocation = next
  }

  /**
   * Decides whether home-directory skills are scanned and which skill names are allowed.
   * Headless runs skip home-directory skills; config `skills.paths` can still list them explicitly.
   */
  function policy(config: Config.Info) {
    const allow = invocation.allow?.length ? invocation.allow : config.skills?.allow
    return {
      home: !HeadlessRun.enabled(),
      allow: allow && new Set(allow),
    }
  }

  /** ~/.claude, ~/.agents and ~/.opencode under both the configured and the symlink-resolved home path. */
  async function homeRoots() {
    const real = await fs.realpath(Global.Path.home).catch(() => Global.Path.home)
    return [...new Set([Global.Path.home, real])].flatMap((home) => EXTERNAL_DIRS.map((dir) => path.join(home, dir)))
  }

  export const state = Instance.state(async () => {
    const skills: Record<string, Info> = {}
    const dirs = new Set<string>()
    const config = await Config.get()
    const access = policy(config)
    const home = EXTERNAL_DIRS.map((dir) => path.join(Global.Path.home, dir))
    // Home skill roots to skip, however a scan reaches them, including through a symlink.
    const skipped = new Set(access.home ? [] : await homeRoots())
    const skip = async (root: string) => {
      if (skipped.size === 0) return false
      if (skipped.has(root)) return true
      return skipped.has(await fs.realpath(root).catch(() => root))
    }

    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return
      if (access.allow && !access.allow.has(parsed.data.name)) return

      // Warn on duplicate skill names
      if (skills[parsed.data.name]) {
        log.warn("duplicate skill name", {
          name: parsed.data.name,
          existing: skills[parsed.data.name].location,
          duplicate: match,
        })
      }

      dirs.add(path.dirname(match))

      // Build metadata from every frontmatter key except name/description,
      // string-coercing values (handles YAML numbers like `version: 1.0` → "1.0").
      // version is derived from metadata.version as a convenience accessor.
      const metadata: Record<string, string> =
        typeof md.data === "object" && md.data !== null
          ? Object.fromEntries(
              Object.entries(md.data)
                .filter(([k]) => k !== "name" && k !== "description")
                .map(([k, v]) => [k, String(v)]),
            )
          : {}

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
        metadata,
        version: metadata.version,
      }
    }

    const scanExternal = async (root: string, scope: "global" | "project") => {
      return Glob.scan(EXTERNAL_SKILL_PATTERN, {
        cwd: root,
        absolute: true,
        include: "file",
        dot: true,
        symlink: true,
      })
        .then((matches) => Promise.all(matches.map(addSkill)))
        .catch((error) => {
          log.error(`failed to scan ${scope} skills`, { dir: root, error })
        })
    }

    // Scan external skill directories (.claude/skills/, .agents/skills/, etc.)
    // Load global (home) first, then project-level (so project-level overwrites)
    for (const root of home) {
      if (await skip(root)) continue
      if (!(await Filesystem.isDir(root))) continue
      await scanExternal(root, "global")
    }

    // A non-git project's upward walk, or a symlinked project directory, can reach the home directories too.
    for await (const root of Filesystem.up({
      targets: EXTERNAL_DIRS,
      start: Instance.directory,
      stop: Instance.worktree,
    })) {
      if (await skip(root)) continue
      await scanExternal(root, "project")
    }

    // Scan .aictrl/skill/ directories (config directories include ~/.opencode)
    for (const dir of await Config.directories()) {
      if (await skip(dir)) continue
      const matches = await Glob.scan(AICTRL_SKILL_PATTERN, {
        cwd: dir,
        absolute: true,
        include: "file",
        symlink: true,
      })
      for (const match of matches) {
        await addSkill(match)
      }
    }

    // Scan additional skill paths from config
    for (const skillPath of config.skills?.paths ?? []) {
      const expanded = skillPath.startsWith("~/") ? path.join(Global.Path.home, skillPath.slice(2)) : skillPath
      const resolved = path.isAbsolute(expanded) ? expanded : path.join(Instance.directory, expanded)
      if (!(await Filesystem.isDir(resolved))) {
        log.warn("skill path not found", { path: resolved })
        continue
      }
      const matches = await Glob.scan(SKILL_PATTERN, {
        cwd: resolved,
        absolute: true,
        include: "file",
        symlink: true,
      })
      for (const match of matches) {
        await addSkill(match)
      }
    }

    // Download and load skills from URLs
    for (const url of config.skills?.urls ?? []) {
      const list = await Discovery.pull(url)
      for (const dir of list) {
        // Under an allowlist, addSkill records only the allowed skills' directories.
        if (!access.allow) dirs.add(dir)
        const matches = await Glob.scan(SKILL_PATTERN, {
          cwd: dir,
          absolute: true,
          include: "file",
          symlink: true,
        })
        for (const match of matches) {
          await addSkill(match)
        }
      }
    }

    for (const name of access.allow ?? []) {
      if (!skills[name]) log.warn("allowed skill not found", { name })
    }

    return {
      skills,
      dirs: Array.from(dirs),
      allow: access.allow && Array.from(access.allow),
    }
  })

  export async function get(name: string) {
    return state().then((x) => x.skills[name])
  }

  /** Skill names this invocation is restricted to, or undefined when every discovered skill is allowed. */
  export async function allowed() {
    return state().then((x) => x.allow)
  }

  export async function all() {
    return state().then((x) => Object.values(x.skills))
  }

  export async function dirs() {
    return state().then((x) => x.dirs)
  }
}
