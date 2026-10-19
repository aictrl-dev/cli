#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

import { Script } from "@aictrl/script"
import pkg from "../package.json"
import { readMigrationJournal } from "../src/storage/migration-journal"

const singleFlag = process.argv.includes("--single") || process.env.AICTRL_BUILD_SINGLE === "true"
const liteFlag = process.argv.includes("--lite")

const migrations = readMigrationJournal(path.join(dir, "migration"))
console.log(`Loaded ${migrations.length} migrations`)

// One package per OS, CPU and libc. Every x64 target is the baseline (no AVX2)
// build: Bun ships the same binary for its baseline and AVX2 targets, so a
// second x64 package per OS only doubled the download. Linux targets declare
// their libc, so npm installs only the glibc or the musl package.
const allTargets: {
  os: string
  arch: "arm64" | "x64"
  libc?: "glibc" | "musl"
}[] = [
  { os: "linux", arch: "arm64", libc: "glibc" },
  { os: "linux", arch: "x64", libc: "glibc" },
  { os: "linux", arch: "arm64", libc: "musl" },
  { os: "linux", arch: "x64", libc: "musl" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "win32", arch: "x64" },
]

// A single build (CI, local) is the host's glibc package.
const targets = singleFlag
  ? allTargets.filter(
      (item) => item.os === process.platform && item.arch === process.arch && item.libc !== "musl",
    )
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.arch === "x64" ? "baseline" : undefined,
    item.libc === "musl" ? "musl" : undefined,
    liteFlag ? "lite" : undefined,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    sourcemap: "external",
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace("-lite", "").replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/aictrl`,
      execArgv: [`--user-agent=aictrl/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    entrypoints: [liteFlag ? "./src/headless.ts" : "./src/index.ts"],
    define: {
      AICTRL_VERSION: `'${Script.version}'`,
      AICTRL_MIGRATIONS: JSON.stringify(migrations),
      AICTRL_CHANNEL: `'${Script.channel}'`,
    },
  })

  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        os: [item.os],
        cpu: [item.arch],
        ...(item.libc ? { libc: [item.libc] } : {}),
        license: pkg.license,
        repository: {
          type: "git",
          url: "https://github.com/aictrl-dev/cli",
        },
      },
      null,
      2,
    ),
  )
  await $`cp ../../LICENSE dist/${name}/LICENSE`
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
