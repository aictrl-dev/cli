import { $, semver } from "bun"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  AICTRL_CHANNEL: process.env["AICTRL_CHANNEL"],
  AICTRL_BUMP: process.env["AICTRL_BUMP"],
  AICTRL_VERSION: process.env["AICTRL_VERSION"],
  AICTRL_RELEASE: process.env["AICTRL_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.AICTRL_CHANNEL) return env.AICTRL_CHANNEL
  if (env.AICTRL_BUMP) return "latest"
  if (env.AICTRL_VERSION && !env.AICTRL_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.AICTRL_VERSION) return env.AICTRL_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const version = await fetch("https://registry.npmjs.org/@aictrl/aictrl/latest")
    .then((res) => {
      if (!res.ok) return "0.0.0"
      return res.json().then((data: any) => data.version)
    })
    .catch(() => "0.0.0")
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.AICTRL_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

const bot = ["actions-user", "aictrl", "aictrl-agent[bot]"]
const team: string[] = [...bot]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.AICTRL_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`aictrl script`, JSON.stringify(Script, null, 2))
