/** Process-launch policy for the native Bash implementation, never project configuration. */
export namespace BashEnvPolicy {
  export type Policy = Readonly<{ mode: "inherit" }> | Readonly<{ mode: "allowlist"; names: readonly string[] }>

  // yargs exposes these runtime parser details; @types/yargs omits getOptions.
  export type Parser = {
    getOptions(): { __(message: string, value: string): string }
    parsed?: false | { aliases: Record<string, string[]> }
  }

  export class ConfigError extends Error {
    readonly code = "BASH_ENV_CONFIGURATION"

    constructor(
      message: string,
      readonly field = "bash-env-allowlist",
      readonly index?: number,
    ) {
      super(message)
      this.name = "BashEnvConfigurationError"
    }
  }

  const inheritance: Policy = Object.freeze({ mode: "inherit" })
  let policy: Policy | undefined

  export function explicit(options: Record<string, unknown>) {
    return Object.hasOwn(options, "bash-env-allowlist") || Object.hasOwn(options, "bashEnvAllowlist")
  }

  /** Pure parsing: never reads argv, environment, configuration or process state. */
  export function parse(input: unknown, platform: "posix" | "win32" = "posix"): Policy {
    if (input === undefined) return inheritance
    if (typeof input !== "string") {
      throw new ConfigError("Use --bash-env-allowlist once with one JSON array of variable names.")
    }
    const value: unknown = (() => {
      try {
        return JSON.parse(input)
      } catch {
        // JSON errors include supplied text on some runtimes. Do not retain their cause.
        throw new ConfigError("--bash-env-allowlist must be a JSON array of variable names.")
      }
    })()
    if (!Array.isArray(value)) {
      throw new ConfigError("--bash-env-allowlist must be a JSON array of variable names.")
    }
    const names: string[] = []
    const seen = new Set<string>()
    for (const [index, name] of value.entries()) {
      if (typeof name !== "string" || !name || /[\0=*?\[\]{}]/u.test(name)) {
        throw new ConfigError(
          "--bash-env-allowlist contains an invalid variable name at item " + index + ".",
          undefined,
          index,
        )
      }
      const identity = platform === "win32" ? name.toUpperCase() : name
      if (seen.has(identity)) continue
      seen.add(identity)
      names.push(name)
    }
    return Object.freeze({ mode: "allowlist", names: Object.freeze(names) })
  }

  /** Call before Instance/bootstrap, using the actual parsed CLI options or trusted host input. */
  export function initialize(options: Record<string, unknown>): Policy {
    const present = explicit(options)
    if (present && Object.hasOwn(options, "attach")) {
      throw new ConfigError("--bash-env-allowlist is not supported with --attach.", "attach")
    }
    const input = Object.hasOwn(options, "bash-env-allowlist")
      ? options["bash-env-allowlist"]
      : options.bashEnvAllowlist
    if (present && input === undefined) {
      throw new ConfigError("--bash-env-allowlist requires one JSON array of variable names.")
    }
    const next = parse(input, process.platform === "win32" ? "win32" : "posix")
    if (policy && JSON.stringify(policy) !== JSON.stringify(next)) {
      throw new ConfigError("The Bash environment launch policy is already initialized.")
    }
    policy ??= next
    return policy
  }

  /** Ordinary in-process hosts that never initialize retain inheritance. */
  export function current(): Policy {
    return policy ?? inheritance
  }

  /** Select an exact native environment; never mutate or implicitly extend the parent. */
  export function select(
    launch: Extract<Policy, { mode: "allowlist" }>,
    parent: Record<string, unknown>,
    overrides: unknown = {},
    platform: "posix" | "win32" = "posix",
  ): Record<string, string> {
    if (
      typeof overrides !== "object" ||
      overrides === null ||
      (Object.getPrototypeOf(overrides) !== Object.prototype && Object.getPrototypeOf(overrides) !== null)
    ) {
      throw new ConfigError("The shell.env hook must return an environment record.", "shell.env")
    }
    const entries = Reflect.ownKeys(overrides)
      .map((key, index) => {
        if (typeof key !== "string" || !key || /[\0=]/u.test(key)) {
          throw new ConfigError(
            "The shell.env hook contains an invalid environment name at item " + index + ".",
            "shell.env",
            index,
          )
        }
        const value: unknown = (overrides as Record<string, unknown>)[key]
        if (typeof value !== "string" || value.includes("\0")) {
          throw new ConfigError(
            "The shell.env hook contains an invalid environment value at item " + index + ".",
            "shell.env",
            index,
          )
        }
        return [key, value] as const
      })
      .filter(([key]) => Object.prototype.propertyIsEnumerable.call(overrides, key))
    const identity = (name: string) => (platform === "win32" ? name.toUpperCase() : name)
    const selected = new Set(launch.names.map(identity))
    const values = new Map<string, readonly [string, unknown]>()
    // Node uses the first lexicographic key for case-colliding Windows env names.
    for (const key of Object.keys(parent).sort()) {
      const name = identity(key)
      if (!selected.has(name) || values.has(name)) continue
      values.set(name, [key, parent[key]])
    }
    const hooks = new Set<string>()
    for (const entry of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const name = identity(entry[0])
      if (!selected.has(name) || hooks.has(name)) continue
      hooks.add(name)
      values.set(name, entry)
    }
    const result: Record<string, string> = Object.create(null)
    for (const [index, [key, value]] of [...values.values()].entries()) {
      if (value === undefined) continue
      if (typeof value !== "string" || value.includes("\0")) {
        throw new ConfigError(
          "A selected parent environment value is invalid at item " + index + ".",
          "parent.env",
          index,
        )
      }
      result[key] = value
    }
    return result
  }

  export function parserError(parser: Parser, message: unknown) {
    const key = "bash-env-allowlist"
    const names = [key, ...(parser.parsed ? (parser.parsed.aliases[key] ?? []) : [])]
    // Compare the owned option's diagnostic using this actual parser's locale.
    // Missing nargs values have no property in parsed.argv; never scan raw argv.
    if (names.some((name) => message === parser.getOptions().__("Not enough arguments following: %s", name))) {
      return new ConfigError("--bash-env-allowlist requires one JSON array of variable names.")
    }
  }

  export function format(error: unknown) {
    if (error instanceof ConfigError) return error.code + ": " + error.message
  }
}
