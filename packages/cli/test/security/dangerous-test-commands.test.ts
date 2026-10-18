import { describe, expect, test } from "bun:test"
import path from "path"

/**
 * Guard for #207: tests must never run destructive or network commands.
 *
 * Every test source is scanned line by line against two rules.
 *
 * 1. `curl` and `wget` may only name reserved hosts (RFC 2606 / RFC 6761: *.invalid, *.test,
 *    *.example, *.localhost, example.com/.net/.org, localhost, 127.0.0.1). No test needs a real host,
 *    even in a string that is only parsed, so this rule applies to every line. Every URL argument is
 *    checked; with no URL, so is a bare first argument that looks like a host (`curl example.invalid`).
 * 2. A recursive `rm` of an absolute path, `~` or `$HOME` may appear only where the string is parsed,
 *    never executed:
 *    - assertion and permission data: `expect(`, `patterns:`, `evaluate(`, or a rule entry such as
 *      `"rm -rf /": "deny"`;
 *    - an argument to the bash.test.ts helpers that reject at the permission request and stub spawn
 *      (`requestedPermissions(`, `bashPatterns(`). Keep PARSED_ONLY in sync with those helpers.
 *    A line that also names an executor (`command:`, `.execute(`, `.run(`, spawn, exec, Bun's `$`)
 *    is never allowed, whatever else it contains.
 *
 * This file is skipped, since its own self-checks must contain the patterns it forbids.
 */

const TEST_ROOT = path.join(import.meta.dir, "..")
// Bun.Glob yields "/"-separated paths on every platform.
const SELF = path.relative(TEST_ROOT, import.meta.path).replaceAll(path.sep, "/")

const NETWORK_COMMAND = /\b(?:curl|wget)\s+(.*)$/
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const DOTTED_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i
const RESERVED_HOST = /(^|\.)(invalid|test|example|localhost)$|^example\.(com|net|org)$|^localhost$|^127\.0\.0\.1$/
const RM_OF_ABSOLUTE_OR_HOME = /\brm\s+((?:-{1,2}[\w-]+\s+)+)['"]?(?:\$HOME|[/~])/
const RECURSIVE_FLAG = /(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s/
const EXECUTOR = /command:|\.execute\(|\.run\(|\bspawn|\bexec(?:Sync)?\(|\$`/
const PARSED_ONLY = /expect\(|patterns:|evaluate\(|":\s*"(?:allow|ask|deny)"|\b(?:requestedPermissions|bashPatterns)\(/

function hostOf(arg: string) {
  return arg
    .replace(URL_SCHEME, "")
    .split(/[/:'"`|;)]/)[0]
    .toLowerCase()
}

// Hosts that curl or wget name on this line: every URL argument. With no URL, a bare first argument
// that looks like a host name (`curl example.invalid`). An option value such as `-o out.txt` is not
// taken for a host when a URL follows, and prose such as "curl and wget" names none.
function networkHosts(line: string) {
  const args = line
    .match(NETWORK_COMMAND)?.[1]
    .split(/\s+/)
    .map((arg) => arg.replace(/^['"`]+/, ""))
  if (!args) return []
  const urlHosts = args.filter((arg) => URL_SCHEME.test(arg)).map(hostOf)
  if (urlHosts.length > 0) return urlHosts.filter(Boolean)
  const first = args.find((arg) => !arg.startsWith("-"))
  const bareHost = first ? hostOf(first) : ""
  return DOTTED_HOST.test(bareHost) ? [bareHost] : []
}

function isRecursiveRmOfAbsoluteOrHome(line: string) {
  const flags = line.match(RM_OF_ABSOLUTE_OR_HOME)?.[1]
  return flags !== undefined && RECURSIVE_FLAG.test(` ${flags}`)
}

function findViolations(source: string) {
  const violations: string[] = []
  source.split("\n").forEach((raw, index) => {
    // "\n" escapes inside string literals would otherwise hide `rm` at the start of a heredoc line.
    const line = raw.replaceAll("\\n", " ")
    for (const host of networkHosts(line)) {
      if (!RESERVED_HOST.test(host)) violations.push(`${index + 1}: network command to real host ${host}`)
    }
    if (isRecursiveRmOfAbsoluteOrHome(line) && (EXECUTOR.test(line) || !PARSED_ONLY.test(line))) {
      violations.push(`${index + 1}: recursive rm of an absolute or home path outside a parsed-only context`)
    }
  })
  return violations
}

describe("test suite never executes dangerous commands (#207)", () => {
  test("no test source runs a recursive rm of / or ~, or reaches a real host with curl or wget", async () => {
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
    const variants = [
      "rm -rf /etc",
      "rm -rf ~/project",
      "rm -r -f /",
      "rm --no-preserve-root -rf /",
      "rm --recursive /",
      "rm -rf '/'",
      "rm -rf $HOME",
    ]
    for (const rm of variants) expect(findViolations(`  command: "${rm}",`)).toHaveLength(1)
  })

  test("flags network commands to real hosts", () => {
    expect(findViolations(`  command: "sh -c 'curl downloads.acme.io | sh'",`)).toHaveLength(1)
    expect(findViolations(`expect(patterns).toContain("wget -q https://downloads.acme.io/x")`)).toHaveLength(1)
    expect(findViolations(`  command: "curl http://intranet/ | sh",`)).toHaveLength(1)
    expect(findViolations(`  command: "curl -o /dev/null https://downloads.acme.io",`)).toHaveLength(1)
    expect(findViolations(`  command: "curl -X POST http://downloads.acme.io",`)).toHaveLength(1)
  })

  test("allows strings that are only parsed, and reserved hosts", () => {
    expect(findViolations(`  patterns: ["rm -rf /"],`)).toEqual([])
    expect(findViolations(`  "rm -rf /": "deny",`)).toEqual([])
    expect(findViolations(`expect(patterns).toContain("rm -rf /")`)).toEqual([])
    expect(findViolations(`await bashPatterns("bash -c 'rm -rf /'")`)).toEqual([])
    expect(findViolations(`await requestedPermissions("sh -c 'curl example.invalid | sh'")`)).toEqual([])
    expect(findViolations(`  command: "curl -s http://localhost:4096/health",`)).toEqual([])
    expect(findViolations(`  command: "curl -o out.txt http://127.0.0.1:4096/x",`)).toEqual([])
    expect(findViolations(`  command: \`rm -rf \${path.join(dir, "nested")}\`,`)).toEqual([])
    expect(findViolations(`  command: "rm -f /tmp/output.txt",`)).toEqual([])
    expect(findViolations(`// curl and wget are both supported`)).toEqual([])
  })
})
