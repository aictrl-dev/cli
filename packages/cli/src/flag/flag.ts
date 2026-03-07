function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  export const AICTRL_AUTO_SHARE = truthy("AICTRL_AUTO_SHARE")
  export const AICTRL_GIT_BASH_PATH = process.env["AICTRL_GIT_BASH_PATH"]
  export const AICTRL_CONFIG = process.env["AICTRL_CONFIG"]
  export declare const AICTRL_TUI_CONFIG: string | undefined
  export declare const AICTRL_CONFIG_DIR: string | undefined
  export const AICTRL_CONFIG_CONTENT = process.env["AICTRL_CONFIG_CONTENT"]
  export const AICTRL_DISABLE_AUTOUPDATE = truthy("AICTRL_DISABLE_AUTOUPDATE")
  export const AICTRL_DISABLE_PRUNE = truthy("AICTRL_DISABLE_PRUNE")
  export const AICTRL_DISABLE_TERMINAL_TITLE = truthy("AICTRL_DISABLE_TERMINAL_TITLE")
  export const AICTRL_PERMISSION = process.env["AICTRL_PERMISSION"]
  export const AICTRL_DISABLE_DEFAULT_PLUGINS = truthy("AICTRL_DISABLE_DEFAULT_PLUGINS")
  export const AICTRL_DISABLE_LSP_DOWNLOAD = truthy("AICTRL_DISABLE_LSP_DOWNLOAD")
  export const AICTRL_ENABLE_EXPERIMENTAL_MODELS = truthy("AICTRL_ENABLE_EXPERIMENTAL_MODELS")
  export const AICTRL_DISABLE_AUTOCOMPACT = truthy("AICTRL_DISABLE_AUTOCOMPACT")
  export const AICTRL_DISABLE_MODELS_FETCH = truthy("AICTRL_DISABLE_MODELS_FETCH")
  export const AICTRL_DISABLE_CLAUDE_CODE = truthy("AICTRL_DISABLE_CLAUDE_CODE")
  export const AICTRL_DISABLE_CLAUDE_CODE_PROMPT =
    AICTRL_DISABLE_CLAUDE_CODE || truthy("AICTRL_DISABLE_CLAUDE_CODE_PROMPT")
  export const AICTRL_DISABLE_CLAUDE_CODE_SKILLS =
    AICTRL_DISABLE_CLAUDE_CODE || truthy("AICTRL_DISABLE_CLAUDE_CODE_SKILLS")
  export const AICTRL_DISABLE_EXTERNAL_SKILLS =
    AICTRL_DISABLE_CLAUDE_CODE_SKILLS || truthy("AICTRL_DISABLE_EXTERNAL_SKILLS")
  export declare const AICTRL_DISABLE_PROJECT_CONFIG: boolean
  export const AICTRL_FAKE_VCS = process.env["AICTRL_FAKE_VCS"]
  export declare const AICTRL_CLIENT: string
  export const AICTRL_SERVER_PASSWORD = process.env["AICTRL_SERVER_PASSWORD"]
  export const AICTRL_SERVER_USERNAME = process.env["AICTRL_SERVER_USERNAME"]
  export const AICTRL_ENABLE_QUESTION_TOOL = truthy("AICTRL_ENABLE_QUESTION_TOOL")

  // Experimental
  export const AICTRL_EXPERIMENTAL = truthy("AICTRL_EXPERIMENTAL")
  export const AICTRL_EXPERIMENTAL_FILEWATCHER = truthy("AICTRL_EXPERIMENTAL_FILEWATCHER")
  export const AICTRL_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("AICTRL_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const AICTRL_EXPERIMENTAL_ICON_DISCOVERY =
    AICTRL_EXPERIMENTAL || truthy("AICTRL_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["AICTRL_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const AICTRL_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("AICTRL_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const AICTRL_ENABLE_EXA =
    truthy("AICTRL_ENABLE_EXA") || AICTRL_EXPERIMENTAL || truthy("AICTRL_EXPERIMENTAL_EXA")
  export const AICTRL_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number("AICTRL_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS")
  export const AICTRL_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("AICTRL_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const AICTRL_EXPERIMENTAL_OXFMT = AICTRL_EXPERIMENTAL || truthy("AICTRL_EXPERIMENTAL_OXFMT")
  export const AICTRL_EXPERIMENTAL_LSP_TY = truthy("AICTRL_EXPERIMENTAL_LSP_TY")
  export const AICTRL_EXPERIMENTAL_LSP_TOOL = AICTRL_EXPERIMENTAL || truthy("AICTRL_EXPERIMENTAL_LSP_TOOL")
  export const AICTRL_DISABLE_FILETIME_CHECK = truthy("AICTRL_DISABLE_FILETIME_CHECK")
  export const AICTRL_EXPERIMENTAL_PLAN_MODE = AICTRL_EXPERIMENTAL || truthy("AICTRL_EXPERIMENTAL_PLAN_MODE")
  export const AICTRL_EXPERIMENTAL_MARKDOWN = truthy("AICTRL_EXPERIMENTAL_MARKDOWN")
  export const AICTRL_MODELS_URL = process.env["AICTRL_MODELS_URL"]
  export const AICTRL_MODELS_PATH = process.env["AICTRL_MODELS_PATH"]

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

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

// Dynamic getter for AICTRL_TUI_CONFIG
// This must be evaluated at access time, not module load time,
// because tests and external tooling may set this env var at runtime
Object.defineProperty(Flag, "AICTRL_TUI_CONFIG", {
  get() {
    return process.env["AICTRL_TUI_CONFIG"]
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
