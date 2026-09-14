#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../packages/cli"))

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "AictrlClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

// The headless generator writes v2 types; the legacy SDK client still refers to
// src/gen/types.gen.ts. Bridge this shared part to its canonical generated type
// so event unions in both SDK versions retain the same termination contract.
const legacy = Bun.file("./src/gen/types.gen.ts")
const source = await legacy.text()
const pattern =
  /^export type StepFinishPart = (?:\{[\s\S]*?^\}|import\("\.\.\/v2\/gen\/types\.gen\.js"\)\.StepFinishPart)$/m
if (!pattern.test(source)) throw new Error("Legacy StepFinishPart declaration not found; update the SDK schema bridge")
await legacy.write(
  source.replace(pattern, 'export type StepFinishPart = import("../v2/gen/types.gen.js").StepFinishPart'),
)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
