import { describe, expect, test } from "bun:test"
import path from "path"

// The compiled binary embeds the Bun that built it, so every toolchain entry
// point must take the version from the root package.json `packageManager`.
const root = path.resolve(import.meta.dir, "../../../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

type Step = { uses?: string; with?: Record<string, string> }
type Workflow = { jobs: Record<string, { uses?: string; steps?: Step[] }> }

const workflowFiles = Array.from(new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root })).sort()
const workflows = await Promise.all(
  workflowFiles.map(async (file) => ({ file, workflow: Bun.YAML.parse(await read(file)) as Workflow })),
)
const steps = (workflow: Workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
const isSetupBun = (step: Step) => step.uses?.startsWith("oven-sh/setup-bun@") ?? false
const bunWorkflows = workflows.filter(({ workflow }) => steps(workflow).some(isSetupBun))

test("packageManager pins an exact Bun version", async () => {
  const pkg = JSON.parse(await read("package.json"))
  expect(pkg.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/)
})

test("CI and release workflows install Bun", () => {
  expect(bunWorkflows.map(({ file }) => file)).toEqual(
    expect.arrayContaining([".github/workflows/ci.yml", ".github/workflows/publish.yml"]),
  )
})

describe.each(bunWorkflows)("$file", ({ workflow }) => {
  test("installs Bun from package.json", () => {
    for (const step of steps(workflow).filter(isSetupBun)) {
      expect(step.with).toEqual({ "bun-version-file": "package.json" })
    }
  })

  test("pins every action to a commit SHA", () => {
    const uses = [
      ...Object.values(workflow.jobs).flatMap((job) => (job.uses ? [job.uses] : [])),
      ...steps(workflow).flatMap((step) => (step.uses ? [step.uses] : [])),
    ]
    for (const ref of uses.filter((ref) => !ref.startsWith("./"))) {
      expect(ref).toMatch(/@[0-9a-f]{40}$/)
    }
  })
})

test("bun-node image has no Bun version of its own", async () => {
  const dockerfile = await read("packages/containers/bun-node/Dockerfile")
  expect(dockerfile).toMatch(/^ARG BUN_VERSION$/m)
  expect(dockerfile).not.toMatch(/^ARG\s+BUN_VERSION=/m)
  expect(dockerfile).toContain('"${BUN_VERSION:?')
})
