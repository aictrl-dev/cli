import { expect, test } from "bun:test"
import path from "path"

// The compiled binary embeds the Bun that built it, so every toolchain entry
// point must take the version from the root package.json `packageManager`.
const root = path.resolve(import.meta.dir, "../../../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

test("packageManager pins an exact Bun version", async () => {
  const pkg = JSON.parse(await read("package.json"))
  expect(pkg.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/)
})

test.each([".github/workflows/ci.yml", ".github/workflows/publish.yml"])(
  "%s installs Bun from package.json",
  async (file) => {
    const workflow = Bun.YAML.parse(await read(file)) as {
      jobs: Record<string, { steps: { uses?: string; with?: Record<string, string> }[] }>
    }
    const setups = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .filter((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    expect(setups.length).toBeGreaterThan(0)
    for (const step of setups) {
      expect(step.with).toEqual({ "bun-version-file": "package.json" })
    }
  },
)

test("bun-node image has no Bun version of its own", async () => {
  const dockerfile = await read("packages/containers/bun-node/Dockerfile")
  expect(dockerfile).toMatch(/^ARG BUN_VERSION$/m)
})
