import { expect, test } from "bun:test"
import path from "path"

test("generate publishes the termination schema used by SDK codegen", async () => {
  const proc = Bun.spawn(
    ["bun", "run", "--conditions=browser", path.resolve(import.meta.dir, "../../src/index.ts"), "generate"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exit, stderr).toBe(0)
  const spec = JSON.parse(stdout)
  const part = spec.components.schemas.StepFinishPart
  const diagnostic = spec.components.schemas.ProviderTermination
  expect(spec.openapi).toBe("3.1.1")
  expect(part.properties.termination).toEqual({ $ref: "#/components/schemas/ProviderTermination" })
  expect(part.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
  expect(diagnostic.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
  expect(part.id).toBeUndefined()
  expect(diagnostic.id).toBeUndefined()
  expect(part.$id).toBeUndefined()
  expect(diagnostic.$id).toBeUndefined()
  expect(part.properties.type.const).toBe("step-finish")
  expect(stdout).not.toMatch(/"ref"\s*:/)
  expect(stdout).not.toMatch(/"nullable"\s*:/)
  expect(part.required).not.toContain("termination")
  expect(diagnostic.required).toContain("normalizedReason")
  expect(diagnostic.properties.rawReason.properties.value.maxLength).toBe(128)
  expect(diagnostic.properties.diagnostic.properties.value.maxLength).toBe(2048)
  expect(diagnostic.properties.requestID.properties.status.enum).toEqual(["available", "unavailable", "redacted"])
})
