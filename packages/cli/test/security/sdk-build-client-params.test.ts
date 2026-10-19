import { describe, expect, test } from "bun:test"
import { buildClientParams as v2BuildClientParams } from "@aictrl/sdk/v2/gen/client"
// The legacy client has no export that exposes buildClientParams (`@aictrl/sdk/client`
// only re-exports createAictrlClient and the types), so it is imported from source.
import { buildClientParams as legacyBuildClientParams } from "../../../sdk/src/gen/core/params.gen"

// GHSA-hhx9-57xq-r5rw: an unknown `$<slot>___proto__` key must not replace the
// prototype of the returned slot object, and must not reach Object.prototype.
type Slot = "body" | "headers" | "path" | "query"
type SlotParams = Partial<Record<Slot, Record<string, unknown>>>
type BuildParams = (args: unknown[], fields: { args: { in: Slot; key: string }[] }[]) => SlotParams

const generators: [string, BuildParams][] = [
  ["legacy @aictrl/sdk", legacyBuildClientParams as unknown as BuildParams],
  ["@aictrl/sdk/v2", v2BuildClientParams as unknown as BuildParams],
]

const slots: Slot[] = ["body", "headers", "path", "query"]

describe.each(generators)("%s buildClientParams", (_name, buildClientParams) => {
  test.each(slots)("$%s___proto__ does not substitute the slot prototype", (slot) => {
    const injected = { isAdmin: true }
    const params = buildClientParams(
      [{ q: "hello", [`$${slot}___proto__`]: injected }],
      [{ args: [{ in: slot, key: "q" }] }],
    )

    const target = params[slot]
    expect(target).toBeDefined()
    expect(Object.getPrototypeOf(target)).not.toBe(injected)
    expect(target?.isAdmin).toBeUndefined()
    expect([...forInKeys(target ?? {})]).not.toContain("isAdmin")
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty("isAdmin")
  })

  test("regular and prefixed keys still land in their slots", () => {
    const params = buildClientParams([{ q: "hello", $headers_trace: "abc" }], [{ args: [{ in: "query", key: "q" }] }])

    expect({ ...params.query }).toEqual({ q: "hello" })
    expect({ ...params.headers }).toEqual({ trace: "abc" })
    expect(params.path).toBeUndefined()
    expect(params.body).toBeUndefined()
  })

  test("an empty array body is kept, as in the 0.97.3 template", () => {
    const params = buildClientParams([[]], [{ in: "body" } as never])

    expect(params.body as unknown).toEqual([])
  })
})

function* forInKeys(value: object) {
  for (const key in value) yield key
}
