import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { HeadlessRun } from "../../src/flag/headless-run"
import { tmpdir, writeSkill as skill } from "../fixture/fixture"

async function git(dir: string) {
  await $`git init`.cwd(dir).quiet()
  await $`git -c user.email=test@example.com -c user.name=test commit --allow-empty -m root`.cwd(dir).quiet()
}

// Home with one skill per home-level source, plus a git project with its own skill.
async function fixture() {
  const tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  const project = path.join(tmp.path, "project")
  await skill(path.join(home, ".claude", "skills"), "home-claude")
  await skill(path.join(home, ".agents", "skills"), "home-agents")
  await skill(path.join(home, ".opencode", "skills"), "home-opencode")
  await skill(path.join(home, ".aictrl", "skills"), "home-aictrl")
  await skill(path.join(project, ".claude", "skills"), "project-claude")
  await skill(path.join(project, ".aictrl", "skills"), "project-aictrl")
  await git(project)
  process.env.AICTRL_TEST_HOME = home
  return { home, project }
}

async function discover(directory: string, scope: Skill.Scope & { headless?: boolean }) {
  if (scope.headless) HeadlessRun.enable()
  else HeadlessRun.disable()
  Skill.setScope({ allow: scope.allow })
  return Instance.provide({
    directory,
    fn: async () => {
      const names = (await Skill.all()).map((s) => s.name).sort()
      const dirs = await Skill.dirs()
      await Instance.dispose()
      return { names, dirs }
    },
  })
}

describe("skill scope", () => {
  const env = { home: process.env.AICTRL_TEST_HOME }

  afterEach(() => {
    Skill.setScope({})
    HeadlessRun.disable()
    if (env.home === undefined) delete process.env.AICTRL_TEST_HOME
    else process.env.AICTRL_TEST_HOME = env.home
  })

  test("headless runs skip ~/.claude, ~/.agents and ~/.opencode skills", async () => {
    const { project } = await fixture()
    const result = await discover(project, { headless: true })
    expect(result.names).toEqual(["home-aictrl", "project-aictrl", "project-claude"])
  })

  test("config skills.paths with ~/ lists home skills explicitly in headless runs", async () => {
    const { project } = await fixture()
    await Bun.write(path.join(project, "aictrl.json"), JSON.stringify({ skills: { paths: ["~/.claude/skills"] } }))
    const result = await discover(project, { headless: true })
    expect(result.names).toEqual(["home-aictrl", "home-claude", "project-aictrl", "project-claude"])
  })

  test("non-headless invocations keep scanning home directories", async () => {
    const { project } = await fixture()
    const result = await discover(project, {})
    expect(result.names).toContain("home-claude")
    expect(result.names).toContain("home-agents")
    expect(result.names).toContain("home-opencode")
  })

  test("headless runs in a non-git directory under home do not reach home skills by walking up", async () => {
    const { home } = await fixture()
    const work = path.join(home, "work")
    await skill(path.join(work, ".claude", "skills"), "work-claude")
    const result = await discover(work, { headless: true })
    expect(result.names).toContain("work-claude")
    expect(result.names).not.toContain("home-claude")
    expect(result.names).not.toContain("home-agents")
    expect(result.names).not.toContain("home-opencode")
  })

  test("headless runs skip home skills reached through a symlinked home path", async () => {
    const { home } = await fixture()
    const alias = path.join(path.dirname(home), "home-alias")
    await fs.symlink(home, alias)
    process.env.AICTRL_TEST_HOME = alias
    const result = await discover(path.join(home, ".aictrl"), { headless: true })
    expect(result.names).not.toContain("home-claude")
    expect(result.names).not.toContain("home-agents")
    expect(result.names).not.toContain("home-opencode")
  })

  test("headless runs skip a project directory that symlinks to a home skill root", async () => {
    const { home } = await fixture()
    const linked = path.join(path.dirname(home), "linked")
    await fs.mkdir(linked, { recursive: true })
    await fs.symlink(path.join(home, ".claude"), path.join(linked, ".claude"))
    await git(linked)
    const result = await discover(linked, { headless: true })
    expect(result.names).not.toContain("home-claude")
  })

  test("config skills.allow: [] allows no skills", async () => {
    const { project } = await fixture()
    await Bun.write(path.join(project, "aictrl.json"), JSON.stringify({ skills: { allow: [] } }))
    expect((await discover(project, { headless: true })).names).toEqual([])
  })

  test("an allowlist limits listed skills and their directories", async () => {
    const { project } = await fixture()
    const result = await discover(project, { headless: true, allow: ["project-claude"] })
    expect(result.names).toEqual(["project-claude"])
    expect(result.dirs).toEqual([path.join(project, ".claude", "skills", "project-claude")])
  })

  test("an allowlist does not bring back home-directory skills", async () => {
    const { project } = await fixture()
    const result = await discover(project, { headless: true, allow: ["home-claude", "project-claude"] })
    expect(result.names).toEqual(["project-claude"])
  })

  test("config skills.allow scopes skills and --skill overrides it", async () => {
    const { project } = await fixture()
    await Bun.write(path.join(project, "aictrl.json"), JSON.stringify({ skills: { allow: ["project-aictrl"] } }))
    expect((await discover(project, { headless: true })).names).toEqual(["project-aictrl"])
    expect((await discover(project, { headless: true, allow: ["project-claude"] })).names).toEqual(["project-claude"])
  })

  test("config skills.paths keep loading in headless runs", async () => {
    const { project } = await fixture()
    const extra = path.join(path.dirname(project), "extra")
    await skill(extra, "extra-skill")
    await Bun.write(path.join(project, "aictrl.json"), JSON.stringify({ skills: { paths: [extra] } }))
    const result = await discover(project, { headless: true })
    expect(result.names).toContain("extra-skill")
  })
})
