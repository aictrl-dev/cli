function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  export const AICTRL_MODEL_STREAM_IDLE_TIMEOUT_DEFAULT = 5 * 60 * 1000
  export const AICTRL_GIT_BASH_PATH = process.env["AICTRL_GIT_BASH_PATH"]
  export const AICTRL_CONFIG = process.env["AICTRL_CONFIG"]
  export declare const AICTRL_CONFIG_DIR: string | undefined
  export const AICTRL_CONFIG_CONTENT = process.env["AICTRL_CONFIG_CONTENT"]
  export const AICTRL_DISABLE_AUTOUPDATE = truthy("AICTRL_DISABLE_AUTOUPDATE")
  export const AICTRL_DISABLE_PRUNE = truthy("AICTRL_DISABLE_PRUNE")
  export const AICTRL_PERMISSION = process.env["AICTRL_PERMISSION"]
  export const AICTRL_DISABLE_DEFAULT_PLUGINS = truthy("AICTRL_DISABLE_DEFAULT_PLUGINS")
  export const AICTRL_DISABLE_LSP_DOWNLOAD = truthy("AICTRL_DISABLE_LSP_DOWNLOAD")
  export const AICTRL_ENABLE_EXPERIMENTAL_MODELS = truthy("AICTRL_ENABLE_EXPERIMENTAL_MODELS")
  export const AICTRL_DISABLE_AUTOCOMPACT = truthy("AICTRL_DISABLE_AUTOCOMPACT")
  export const AICTRL_DISABLE_MODELS_FETCH = truthy("AICTRL_DISABLE_MODELS_FETCH")
  export declare const AICTRL_DISABLE_PROJECT_CONFIG: boolean
  export const AICTRL_FAKE_VCS = process.env["AICTRL_FAKE_VCS"]
  export declare const AICTRL_CLIENT: string
  export const AICTRL_ENABLE_QUESTION_TOOL = truthy("AICTRL_ENABLE_QUESTION_TOOL")
  export declare const AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS: number

  // Experimental
  export const AICTRL_EXPERIMENTAL = truthy("AICTRL_EXPERIMENTAL")
  export const AICTRL_ENABLE_EXA =
    truthy("AICTRL_ENABLE_EXA") || AICTRL_EXPERIMENTAL || truthy("AICTRL_EXPERIMENTAL_EXA")
  export const AICTRL_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("AICTRL_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const AICTRL_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("AICTRL_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const AICTRL_EXPERIMENTAL_OXFMT = AICTRL_EXPERIMENTAL || truthy("AICTRL_EXPERIMENTAL_OXFMT")
  export const AICTRL_EXPERIMENTAL_LSP_TY = truthy("AICTRL_EXPERIMENTAL_LSP_TY")
  export const AICTRL_EXPERIMENTAL_LSP_TOOL = AICTRL_EXPERIMENTAL || truthy("AICTRL_EXPERIMENTAL_LSP_TOOL")
  export const AICTRL_DISABLE_FILETIME_CHECK = truthy("AICTRL_DISABLE_FILETIME_CHECK")
  export const AICTRL_EXPERIMENTAL_PLAN_MODE = AICTRL_EXPERIMENTAL || truthy("AICTRL_EXPERIMENTAL_PLAN_MODE")
  export const AICTRL_MODELS_URL = process.env["AICTRL_MODELS_URL"]
  export const AICTRL_MODELS_PATH = process.env["AICTRL_MODELS_PATH"]

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS.
// Evaluated at access time so environment overrides take effect for each model stream.
Object.defineProperty(Flag, "AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS", {
  get() {
    const value = process.env["AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS"]
    if (value === undefined || value.trim() === "") return Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_DEFAULT
    const parsed = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN
    return Number.isSafeInteger(parsed) ? parsed : Flag.AICTRL_MODEL_STREAM_IDLE_TIMEOUT_DEFAULT
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for AICTRL_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "AICTRL_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("AICTRL_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for AICTRL_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "AICTRL_CONFIG_DIR", {
  get() {
    return process.env["AICTRL_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for AICTRL_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "AICTRL_CLIENT", {
  get() {
    return process.env["AICTRL_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
