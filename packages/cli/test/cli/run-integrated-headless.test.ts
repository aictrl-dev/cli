import { describe, expect, test } from "bun:test"
import { capture, userText } from "./fixture/integrated-capture"

const expected =
  'STATIC<INTEGRATED_STATIC> A<two words> B<quote" λ> C<late λ\n!`/usr/bin/printf ARG_LITERAL`> RAW<two words quote" λ\nlate λ\n!`/usr/bin/printf ARG_LITERAL`>'
const payload = "late λ\n!`/usr/bin/printf ARG_LITERAL`"
const full = ["bash", "edit", "glob", "grep", "read", "skill", "task", "webfetch", "write"]
function names(body: Record<string, unknown>) {
  return ((body.tools ?? []) as { function: { name: string } }[]).map((x) => x.function.name).sort()
}
function success(
  result: Awaited<ReturnType<typeof capture>>,
  catalog: string[],
  selection: string[] | null,
  read: boolean,
  enabled = false,
  mode: "profile" | "global" | "project" | "none" = "profile",
) {
  expect(result.code, result.stderr + result.stdout).toBe(0)
  expect(result.requests).toHaveLength(read ? 2 : 1)
  for (const request of result.requests) expect(names(request)).toEqual(catalog)
  const inventory = result.events.find((event: { type: string }) => event.type === "tool_catalog")
  expect(inventory?.tools.some((tool: { name: string }) => tool.name === "read")).toBe(true)
  // Registry inventory is not the effective provider catalog.
  expect(userText(result.requests[0])).toBe(expected)
  expect(result.sessions.map((x) => x.title)).toEqual(['/argumentprobe two words quote" λ'])
  const users = result.messages.filter((x) => x.data.role === "user")
  expect(users).toHaveLength(1)
  expect(users[0].data.toolSelection).toEqual({ version: 1, allowlist: selection })
  const first = JSON.stringify(result.requests[0]),
    all = JSON.stringify(result.requests)
  expect(first).toContain("EXPLICIT_CALLER_MARKER")
  if (mode !== "none")
    expect(first).toContain(
      mode === "profile"
        ? "TRUSTED_PROFILE_MARKER"
        : mode === "global"
          ? "TRUSTED_GLOBAL_MARKER"
          : "OPENCODE_AUTO_MARKER",
    )
  if (mode !== "global") expect(first).not.toContain("TRUSTED_GLOBAL_MARKER")
  if (mode !== "profile") expect(first).not.toContain("TRUSTED_PROFILE_MARKER")
  for (const marker of ["ROOT_AUTO_MARKER", "OPENCODE_AUTO_MARKER", "NESTED_AUTO_MARKER", "PROJECT_RULE_MARKER"]) {
    if (enabled && (marker !== "OPENCODE_AUTO_MARKER" || mode === "project")) expect(all).toContain(marker)
    else expect(all).not.toContain(marker)
  }
  if (read) {
    const tool = (result.requests[1].messages as { role: string; content: unknown }[]).filter((x) => x.role === "tool")
    expect(JSON.stringify(tool)).toContain("READ_FIXTURE_EXACT")
  }
  expect(result.firstBytesAt).toBeGreaterThan(90)
  expect(result.eofAt!).toBeGreaterThan(result.firstBytesAt!)
  expect(result.requestsBeforeEOF).toBe(0)
  const before = result.observations.filter((x: { kind: string }) => x.kind === "before"),
    executed = result.observations.filter((x: { kind: string }) => x.kind === "executed")
  expect(result.observations.filter((x: { kind: string }) => x.kind === "plugin-import")).toHaveLength(1)
  expect(result.observations.filter((x: { kind: string }) => x.kind === "plugin-init")).toHaveLength(1)
  expect(before).toHaveLength(1)
  expect(executed).toHaveLength(1)
  expect(before[0].input.arguments).toBe('two words quote" λ\n' + payload)
  expect(executed[0].event.properties.arguments).toBe('two words quote" λ\n' + payload)
}

describe("coupled selector stdin command and instruction acceptance", () => {
  for (const entry of ["index", "headless"] as const) {
    test(`${entry}: selected Read consumes exact command data and excludes discovered instructions`, async () => {
      const result = await capture({
        entry,
        name: "selected-read",
        tools: "read",
        operands: ["two words", "-", 'quote" λ'],
        stdin: payload,
        read: true,
      })
      success(result, ["read"], ["read"], true)
    }, 15000)
    test(`${entry}: explicit empty tools preserves command data title and events`, async () => {
      const result = await capture({
        entry,
        name: "empty-tools",
        tools: "",
        operands: ["two words", "-", 'quote" λ'],
        stdin: payload,
      })
      success(result, [], [], false)
    }, 15000)
  }
  for (const item of [
    { name: "default-nine", catalog: full, selection: null, read: true },
    { name: "config-read", configSelection: ["read"], catalog: ["read"], selection: ["read"], read: true },
    {
      name: "cli-replaces-empty-config",
      configSelection: [],
      tools: "read",
      catalog: ["read"],
      selection: ["read"],
      read: true,
    },
    { name: "config-empty", configSelection: [], catalog: [], selection: [], read: false },
    { name: "permissions-still-deny", tools: "read", denyRead: true, catalog: [], selection: ["read"], read: false },
    {
      name: "trusted-global-control",
      profile: false,
      catalog: ["read"],
      selection: ["read"],
      tools: "read",
      read: true,
    },
    {
      name: "opencode-enabled-control",
      profile: false,
      globalInstructions: false,
      disableProject: false,
      catalog: ["read"],
      selection: ["read"],
      tools: "read",
      read: true,
    },
    {
      name: "opencode-disabled-control",
      profile: false,
      globalInstructions: false,
      catalog: ["read"],
      selection: ["read"],
      tools: "read",
      read: true,
    },
    {
      name: "enabled-discovery-control",
      tools: "read",
      disableProject: false,
      catalog: ["read"],
      selection: ["read"],
      read: true,
    },
  ])
    test(
      item.name,
      async () => {
        const result = await capture({
          entry: "headless",
          ...item,
          operands: ["two words", "-", 'quote" λ'],
          stdin: payload,
        })
        success(
          result,
          item.catalog,
          item.selection,
          item.read,
          item.disableProject === false,
          item.name === "opencode-disabled-control"
            ? "none"
            : item.name === "opencode-enabled-control"
              ? "project"
              : item.name === "trusted-global-control"
                ? "global"
                : "profile",
        )
      },
      15000,
    )
  for (const item of [
    { name: "attach-explicit-empty-before-stdin", attach: true, tools: "" },
    { name: "malformed-tools-before-stdin", tools: " read" },
    { name: "repeated-tools-before-stdin", extraArgs: ["--tools", "read", "--tools", "bash"] },
    { name: "missing-tools-before-stdin", extraArgs: ["--tools"] },
  ])
    test(
      item.name,
      async () => {
        const result = await capture({ entry: "headless", ...item, operands: ["-"], open: true })
        expect(result.code, result.stderr + result.stdout).toBe(1)
        expect(result.http).toEqual([])
        expect(result.requests).toEqual([])
        expect(result.dbExists).toBe(false)
        expect(result.projectCacheExists).toBe(false)
        expect(result.observations).toEqual([])
      },
      15000,
    )
  test("actual coupled helper deadline never passes as a negative result", async () => {
    await expect(
      capture({ entry: "index", name: "forced-deadline", tools: "read", operands: ["-"], open: true, deadlineMs: 1 }),
    ).rejects.toThrow("deadline fired")
  }, 15000)
})

test("config-derived empty attach selection rejects after selected EOF without any receiver or local mutation", async () => {
  const result = await capture({
    entry: "headless",
    name: "attach-config-empty-late-EOF",
    attach: true,
    configSelection: [],
    operands: ["-"],
    stdin: "selected data stays local",
  })
  expect(result.firstBytesAt).toBeGreaterThan(90)
  expect(result.eofAt!).toBeGreaterThan(result.firstBytesAt!)
  expect(result.beforeEOF).toEqual({ http: [], dbExists: false, projectCacheExists: false, observations: "" })
  expect(result.code, result.stderr + result.stdout).toBe(1)
  expect(result.http).toEqual([])
  expect(result.requests).toEqual([])
  expect(result.dbExists).toBe(false)
  expect(result.projectCacheExists).toBe(false)
  expect(result.observations).toEqual([])
  const error = result.events.find((event: { type: string }) => event.type === "invocation_error")
  expect(error?.code).toBe("INVOCATION_INVALID_ARGUMENTS")
  expect(error?.phase).toBe("bootstrap")
  expect(result.stderr).toContain(
    "Work-tool selection is not supported with --attach: this client cannot verify server-side enforcement.",
  )
  expect(result.events.map((event: { type: string }) => event.type)).toEqual([
    "invocation_start",
    "invocation_error",
    "invocation_complete",
  ])
}, 15000)
