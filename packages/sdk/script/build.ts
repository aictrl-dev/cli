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

// The headless OpenAPI has no paths, so it cannot regenerate legacy endpoints.
// Keep the legacy HTTP client's shared types aligned with canonical v2 schemas.
const legacy = Bun.file("./src/gen/types.gen.ts")
let source = await legacy.text()
for (const name of [
  "StepFinishPart",
  "AssistantMessage",
  "OutputFormat",
  "EventSessionStructuredOutput",
  "EventSessionStructuredOutputRejected",
]) {
  const pattern = new RegExp(
    `^export type ${name} = (?:\\{[\\s\\S]*?^\\}|import\\("\\.\\.\\/v2\\/gen\\/types\\.gen\\.js"\\)\\.${name})$`,
    "m",
  )
  const declaration = `export type ${name} = import("../v2/gen/types.gen.js").${name}`
  if (!pattern.test(source)) throw new Error(`Legacy ${name} declaration not found; update the SDK schema bridge`)
  source = source.replace(pattern, declaration)
}
for (const name of ["SessionPromptData", "SessionPromptAsyncData", "SessionCommandData"]) {
  const start = source.indexOf(`export type ${name} = {`)
  const end = source.indexOf("\n  path:", start)
  const next = source.indexOf("\nexport type ", start)
  if (start < 0 || end < 0 || (next >= 0 && end >= next))
    throw new Error(`Legacy ${name} declaration not found; update the SDK schema bridge`)
  const body = source.slice(start, end)
  if (!body.includes("format?: OutputFormat")) {
    if (!body.includes("  body?: {"))
      throw new Error(`Legacy ${name} body anchor not found; update the SDK schema bridge`)
    source =
      source.slice(0, start) + body.replace("  body?: {", "  body?: {\n    format?: OutputFormat") + source.slice(end)
  }
}
for (const name of ["EventSessionStructuredOutput", "EventSessionStructuredOutputRejected"]) {
  if (source.includes(`  | ${name}\n`)) continue
  if (!source.includes("export type Event =\n"))
    throw new Error("Legacy Event declaration not found; update the SDK schema bridge")
  source = source.replace("export type Event =\n", `export type Event =\n  | ${name}\n`)
}
await legacy.write(source)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
