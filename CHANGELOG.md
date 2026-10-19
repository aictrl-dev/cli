# Changelog

## Unreleased

### Features

- **`user_message` NDJSON event** — `aictrl run --format json` now emits each primary-session user message once, with its `messageID`, `agent`, `model`, full `parts` as stored (including `synthetic` flags and `-f` file parts) and a `sequenceNum` on the per-session counter shared with `text`, `reasoning` and `tool_use`. It covers the prompt, the `--command` expansion and the user messages the loop creates (the compaction request, the compaction "continue" message and the subtask summary request), and always comes before the assistant events it triggers. Parts are not truncated, so consumers must accept large lines. The StructuredOutput corrective reminder is not stored, so it has no `user_message`. Subagent user messages are not emitted. The event is additive; `schemaVersion` stays `"1"`. (part of #223)

### Fixes

- **Messages written in the same millisecond keep their order** — Reading a session's messages now breaks `time_created` ties by message ID. Before, messages written in the same millisecond came back oldest first. A compaction writes its request, its summary and the continue message in quick succession, so the prompt loop could miss the finished summary and compact again, sending an extra model request. (#200)
- **Retry waits are bounded for every status** — No single wait between retries exceeds 5 minutes. A retryable error of any status whose `Retry-After` / `retry-after-ms` asks for longer is no longer retried: a 429 still fails as `usage_limit` (#174), and any other status (for example a 503 or 529 asking for `retry-after: 18000`, which used to sleep about 5 hours per attempt) fails at once with the provider error, `session_error.reason` from its status (`provider` for a 5xx) and exit 1, with no `retry` event. Exponential backoff without a retry hint now stops at 30 s even when the response has headers, as every AI SDK HTTP error does, so a hintless 429 or 5xx retries for about 3.5 minutes in all instead of about 34. A zero or negative `Retry-After` now counts as no hint and backs off, instead of retrying with no wait. With 10 retries the waits total at most 50 minutes. (closes #175)

### Security

- **drizzle-orm 1.0.0-beta.20** — `drizzle-orm` and `drizzle-kit` move from `1.0.0-beta.12-a5629fb` to `1.0.0-beta.20`, the first release patched for GHSA-gpj5-g38j-94v9 (SQL injection through improperly escaped SQL identifiers; the CLI never passed untrusted identifiers to drizzle). Existing databases open as before: on first start drizzle adds `name` and `applied_at` columns to `__drizzle_migrations` and fills in the names of the migrations already applied, without running them again. The upgraded database still opens with 0.5.1. (closes #61)

## 0.5.1 (2026-10-18)

### Fixes

- **Google AI Studio provider restored** — `google` (`@ai-sdk/google`) is built in again, so `aictrl run --model google/gemini-3.8-flash` works with only an API key instead of failing with model-not-found. 0.5.0 left it out of the static catalog. Set `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`, or store a key with `aictrl auth login`; when several are set, a stored key wins, then `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY`, and `provider.google.options.apiKey` in `aictrl.json` overrides all of them. The CLI now passes the key to the SDK itself, so `GEMINI_API_KEY` and `GOOGLE_API_KEY` also work for requests; up to 0.4.8 they loaded the provider but the SDK read only `GOOGLE_GENERATIVE_AI_API_KEY`. The catalog adds 22 Google models with the 0.5.0 filters, including `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.5-flash` and `gemini-3.1-pro-preview` (19 providers, 1376 models). Other providers' entries are unchanged. If you defined your own `provider.google` in `aictrl.json` on 0.5.0, it now extends the built-in: its models without an `npm` use `@ai-sdk/google` again (as up to 0.4.8) instead of `@ai-sdk/openai-compatible`, and the built-in Google models are listed next to yours. To keep an OpenAI-compatible endpoint under that id, set `"npm": "@ai-sdk/openai-compatible"` and a `whitelist` of your models, or give the provider another id. When any `google` model uses another SDK, the CLI does not pass the Google env key, so set `options.apiKey` for that endpoint.

## 0.5.0 (2026-10-18)

### Breaking changes

- **Static built-in model catalog replaces models.dev** — Built-in providers and models now ship inside the binary in `packages/cli/src/provider/catalog.json`. The CLI makes no network calls for model metadata at startup and no longer reads `~/.cache/aictrl/models.json`. The built-in set narrows from every models.dev provider to 18: `amazon-bedrock`, `anthropic`, `azure`, `azure-cognitive-services`, `cerebras`, `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `gitlab`, `google-vertex`, `google-vertex-anthropic`, `kilo`, `openai`, `openrouter`, `sap-ai-core`, `vercel`, `zai`, `zai-coding-plan` and `zenmux` (1354 models; deprecated models, models without tool calling, models without text input and output, and models released before 2025-06-01 are left out). Any other provider (for example `groq`, `google`, `mistral` or `deepseek`) must be defined under `provider` in `aictrl.json`; until it is, its models fail with the normal model-not-found error, which now says so. A config-only OpenAI-compatible provider that used to get its base URL from models.dev now needs `api` or `options.baseURL`, and fails with an error naming that fix. The `aictrl` provider (free models at an endpoint that never served requests) is removed. `aictrl models --refresh` and the `AICTRL_MODELS_URL`, `AICTRL_MODELS_PATH` and `AICTRL_DISABLE_MODELS_FETCH` variables are removed with no replacement; `provider` config is the extension mechanism. The config schema for `provider` is unchanged. (#202, closes #40)
- **GitHub Copilot provider removed** — `github-copilot` and `github-copilot-enterprise` are no longer providers. A `github-copilot/...` model fails with the standard model-not-found error, stored `github-copilot` credentials are ignored (`aictrl auth list` and `aictrl auth logout` still show and remove them), and a `GITHUB_TOKEN` in the environment no longer loads a provider. An `enterpriseUrl` left in `provider.*.options` still loads. (#193, closes #187)
- **`aictrl github`, `aictrl pr` and `aictrl acp` removed** — Each name stays registered, hidden from help, and prints a replacement hint and exits 1 for any arguments, including `--help` and `--version`: "`aictrl github` was removed. Run `aictrl run` in your own workflow instead." (the same for `pr`), and "`aictrl acp` was removed. aictrl is headless-only; drive it with `aictrl run` instead." Editors that drove aictrl over the Agent Client Protocol lose support. The top-level `github/` composite action is deleted too. (#192, closes #188; #204, closes #190)
- **LSP subsystem and `lsp` tool removed** — The CLI no longer downloads or runs language servers. `edit`, `write` and `apply_patch` no longer append `<diagnostics>` to their output or set `metadata.diagnostics`, and the `tool_catalog` event no longer lists `lsp`. `aictrl debug lsp` and the `AICTRL_DISABLE_LSP_DOWNLOAD`, `AICTRL_EXPERIMENTAL_LSP_TY` and `AICTRL_EXPERIMENTAL_LSP_TOOL` variables are removed, and `AICTRL_EXPERIMENTAL` no longer enables an `lsp` tool. The `lsp` config key and the `lsp` permission rule are deprecated no-ops (see below). Sessions whose history contains `lsp` calls or diagnostics still continue. (#191, closes #144)
- **Worktree snapshots, patch parts, session diffs and revert removed** — No session stages the worktree into a shadow git repo any more, and `step_start` / `step_finish` parts and NDJSON `step_finish` events no longer carry `snapshot`. #172 first skipped them in headless `aictrl run` (closes #146); #184 then deleted the subsystem, the `"snapshot": true` opt-in and `aictrl debug snapshot`. Sessions stored by older versions still load and continue: legacy `patch` and `snapshot` parts are skipped on read, and a revert marker an older version left behind is ignored, so those messages stay in history. (#184, closes #181)
- **Session sharing removed** — The CLI never sends session content to a share service. `aictrl run --share` fails validation with `INVOCATION_INVALID_ARGUMENTS` ("--share was removed: session sharing is no longer supported") before any model request; `--no-share` still runs. `aictrl import <http(s) url>` exits 1 without a request; importing a file is unchanged. `AICTRL_DISABLE_SHARE` is ignored. Stored share data is left in place and ignored. This version cannot revoke shares created by earlier versions, so unshare them with an earlier version before you upgrade. (#195, closes #189)
- **File watcher removed** — Plugins no longer receive `file.watcher.updated` or `vcs.branch.updated` events; `file.edited` still fires for every tool edit. The `watcher` config block is a deprecated no-op. (#204, closes #190)
- **`question` tool, `plan` agent and plan mode removed** — The `question`, `plan_enter` and `plan_exit` tools, the `plan` agent, the plan-mode reminders and the `AICTRL_ENABLE_QUESTION_TOOL` and `AICTRL_EXPERIMENTAL_PLAN_MODE` variables are gone, and `AICTRL_EXPERIMENTAL` no longer enables plan mode. `aictrl run --agent plan` fails with `INVOCATION_INVALID_ARGUMENTS` ("The plan agent was removed. For a read-only run, deny edit and bash through `permission` config.") instead of falling back to the default agent; for a read-only run, deny `edit` and `bash` in `permission`. A prompt naming a missing agent now fails with `Agent not found: "<name>". Available agents: ...` instead of a `TypeError`. A leftover `agent.plan` / `mode.plan` entry is ignored with a warning, and the `question`, `plan_enter` and `plan_exit` permission keys load with no effect. `session_start.permissions` for `run` no longer lists the three deny rules. Sessions whose history calls these tools still continue. (#162, closes #147, #168)
- **`todowrite` and `todoread` removed** — No session offers a todo tool. Callers who want plan tracking can add a custom tool or tell the agent to keep a plan file. `todowrite` / `todoread` keys in `tools` and `permission` (top level or per agent) load and do nothing, and sessions whose history calls `todowrite` still continue. #164 first dropped `todowrite` from headless `aictrl run` (closes #155). (#183, closes #182)
- **`bash` tool description has no git procedures or rules** — The description now covers only the tool itself. The commit procedure, the pull request procedure, the `gh` tip and the git safety rules are gone, which removes about 1.5k tokens from every request. The CLI ships no default deny rules: callers whose agents commit or open PRs supply their own procedure through a skill, `AGENTS.md` or `instructions`, and callers who want to block force pushes, `--no-verify`, `git config` or `git -c` add `permission.bash` deny rules (see "Restricting Dangerous Commands" in `packages/cli/README.md`). The Anthropic base prompt no longer mentions TodoWrite. (#161, closes #156; #183)
- **Headless runs do not discover home-directory skills** — `aictrl run` no longer lists skills under `~/.claude/skills`, `~/.agents/skills` or `~/.opencode/skills`, however discovery reaches them. Project skills, aictrl's own config directories and config `skills.paths` / `skills.urls` are unchanged; to keep home skills, list the folder in `skills.paths`, for example `["~/.claude/skills"]`. Other commands still scan home. (#165, closes #157)
- **Deprecated config keys are warned no-ops** — `lsp`, `permission.lsp`, `snapshot`, `share`, `autoshare`, `enterprise` and `watcher` are still accepted by the strict schema, have no effect and are kept when `Config.update` rewrites a file. Each config source that sets any of them (including `AICTRL_PERMISSION`) logs one warning: `deprecated config is ignored, its subsystem was removed: <keys>`. `autoupdate` is also kept and has no effect. `AICTRL_DISABLE_AUTOUPDATE` and `AICTRL_DISABLE_DEFAULT_PLUGINS` are ignored; they already had no effect. (#191, #184, #195, #204, #194)

### Features

- **Skill allowlist** — `aictrl run --skill <name>` (repeatable) or config `skills.allow` restricts a run to the named skills: only those are listed in the skill tool, loadable and readable as skill directories, and other names get `Skill "<name>" is not in the skill allowlist for this run`. `--skill` overrides `skills.allow`, `skills.allow: []` allows no skills, and `--skill` with `--attach` or an empty name fails with `INVOCATION_INVALID_ARGUMENTS`. `tool_catalog.skills[]`, `skill_discovered` and `skill_loaded` report only in-scope skills, and subagents get the same set. The allowlist scopes the prompt; it is not a trust boundary. (#165, closes #157)

### Fixes

- **Long-reset provider usage limits fail fast** — An HTTP 429 that asks for a wait longer than the 5-minute retry budget (`Retry-After` or `retry-after-ms`), or a Z.ai GLM Coding Plan quota (`1308`/`1310`, or a `Usage limit reached for <n> hour` message) that resets later than that, is no longer retried until the caller's deadline. The run emits no `retry`, stores a nonretryable error starting `Provider usage limit reached`, and exits 1 with `session_error` `reason: "usage_limit"`, `code: "PROVIDER_USAGE_LIMIT"` and, when the reset time is readable, `resetAt` (Unix ms; Z.ai reset text is read as UTC+8). Shorter or hintless 429s, 503s and 5xx errors retry as before; a `Retry-After` between 5 and about 34 minutes, which used to be waited out, now fails fast. The new reason, code and field are additive under NDJSON schema v1. (#174, closes #112)
- **Schema runs get a corrective turn after a permission rejection** — In `--output-schema` mode a step that stops on an auto-rejected tool call now counts as one attempt and gets the same corrective `StructuredOutput` turn as a prose-only finish, instead of ending `missing` with `attempts: 0`. It emits `structured_output_rejected` with the new diagnostic keyword `rejected`; the reminder names only the rejected tools. `--output-schema-retries` still bounds the loop, and non-schema runs still stop after a rejection. A rejection seen only in a stream discarded by a provider retry no longer stops the turn. (#179, closes #135)
- **Session denies reach requests and subagents** — The tool list sent to the model is filtered with the agent and session rules merged, the same ruleset tool calls are checked against, so session-denied tools are no longer offered. Subagent sessions inherit the caller session's deny rules (not its allows), and the `doom_loop` check uses the same merged ruleset. (#162, closes #147)
- **No title LLM call in `aictrl run`** — A new session without `--title` is titled from the prompt as typed (or `/<command> <args>` for `--command`), trimmed to 50 code points, so the extra unrecorded title request on every run is gone. `--title`, `--title ""`, `--continue`, `--session` and `--fork` are unchanged. (#154, closes #145)
- **npm wrapper runs only a platform binary of its own version** — `bin/aictrl` now skips `@aictrl/cli-<platform>` packages whose version differs from the wrapper's, instead of running the first one found in any ancestor `node_modules`. When none matches, it exits 1 naming the skipped packages and the pinned `npm install` fix. `AICTRL_BIN_PATH` still runs the chosen binary without a check. (#178, closes #137)
- **MCP SDK 1.32.1 with OAuth issuer binding** — `@modelcontextprotocol/sdk` moves from 1.29.0 to 1.32.1 (GHSA-6qxp-vccf-f47h), and the MCP OAuth provider now stores the issuer stamp, so once credentials are bound their refresh tokens and client secrets are not sent to a different authorization server. Credentials saved by earlier versions have no stamp: they are bound on first use without a new login, which trusts whichever authorization server the MCP server advertises at that moment. If you are unsure of a server, run `aictrl mcp logout <name>` after upgrading and log in again, and rotate any client secret that may have been exposed. Configured `oauth.clientId` / `clientSecret` are bound on first use; if the server later advertises another authorization server the flow aborts and names `aictrl mcp logout <name>`. HTTP transports now follow redirects only within the same origin. `turbo` and `@babel/core` advisories are also fixed. (#169, closes #50)

### Internal

- **Bash permission tests never execute dangerous commands** — The tests reject at the gating permission and stub `spawn`, so `curl … | sh` and `rm -rf /` variants no longer run on test machines, and a guard test flags unsafe commands in test sources. (#208, closes #201, #207)
- **Dead TUI leftovers removed** — pty, the IDE extension installer, background auto-update and the opentui/Solid build steps and dependencies are gone. The `upgrade` and `uninstall` commands are unchanged. (#194, closes #151)
- **Dispatch-only "Aictrl Review" workflow removed** — Its permission sandbox was written to a config filename the CLI no longer loads. (#176)

## 0.4.8 (2026-10-10)

### Breaking changes

- **StructuredOutput publishes the validated result file** — In `--output-schema` mode the `StructuredOutput` tool now takes only `{ "path": "<file>" }`. The model writes its final result as JSON to a file in the working directory and passes the path; the CLI follows symlinks, keeps the file inside the working directory, caps it at 2 MiB, validates it with Ajv and publishes the parsed file. Passing the result object as tool arguments is no longer accepted. Callers whose prompts say "call StructuredOutput with the result" must say to write a file and pass its path. Only `{ path }` reaches the provider, so provider schema conversion can no longer drop result fields (Gemini emptied map-typed fields, #139), and the model no longer re-emits the whole result as output tokens. Rejected files are counted corrective turns that ask the model to fix the file; their fixed diagnostics are listed in EVENTS.md. This ships as a patch because schema mode is used only by the aictrl executor, which pins exact versions; consumers on a caret range (`^0.4.x`) must update their schema-mode prompts to the file+path form before upgrading. The prose-only `missing` diagnostic and reminder now read "write the final result as JSON to a file in the working directory, then call StructuredOutput with its path". (#140)

## 0.4.4 (2026-09-30)

### Fixes

- **Provider error finishes fail headless execution** — Normal streams ending in `error` or `content-filter` now persist a structured provider failure, emit consistent failure events, and exit nonzero while retaining partial output and usage. Empty successful responses remain successful. (#108)

## 0.4.3 (2026-08-20)

### Features

- **GPT-5.6 Codex models** — Added OpenAI's Sol, Terra, and Luna models with API and subscription-backed reasoning effort variants, including the Codex-only `ultra` alias for Sol and Terra.
- **GLM-5.3 model support** — Added the latest Z.AI Coding Plan model with its 1M-token context window and native `low`, `high`, and `max` reasoning efforts.

## 0.4.1 (2026-07-21)

### Compatibility

- **NDJSON v1 terminal reasons are an open set** — `session_error.reason` now includes `interrupted` for `SIGINT` and `terminated` for `SIGTERM`, and `code` may contain the conventional signal-derived exit code (`130` or `143`). Schema v1 consumers should treat unknown event types, fields, and enum-like string values as forward-compatible additions.

Releases 0.3.3–0.4.7 not listed here (0.4.2 was never published) have notes on [GitHub Releases](https://github.com/aictrl-dev/cli/releases) only.

## 0.3.2 (2026-04-11)

### Fixes

- **Platform binary `optionalDependencies` regenerated at publish time** — `@aictrl/cli@0.3.0` and `@0.3.1` shipped with `@aictrl/cli-linux-x64` hard-pinned to `0.2.0`, so vanilla upgrades silently kept running the stale native binary. The publish workflow now publishes every platform binary the build produces (linux/darwin/windows × x64/arm64 × musl/baseline variants) and regenerates `@aictrl/cli`'s `optionalDependencies` from those manifests at release time, while preserving genuine runtime optionals (`@parcel/watcher`, `bun-pty`). (#46)

## 0.3.1 (2026-04-03)

### Fixes

- **GLM-5.1 model support** — Added `zai-coding-plan` provider with custom loader and thinking config, enabling `glm-5.1` which is currently only available via the ZhipuAI CodingPlan API.

## 0.2.0 (2026-03-10)

### Features

- **Progressive skill loading** — Skills are no longer injected into every LLM turn. Descriptions appear in the tool schema; full content loads only when the model invokes the skill tool. (#16)
- **Per-skill NDJSON events** — New granular events for `--format json` consumers: `skill_discovered`, `skill_loaded`, `skill_resource_loaded`, replacing the batch `skills_loaded` event. (#16)
- **EVENTS.md** — Added documentation for all NDJSON events emitted by `--format json`. (#16)
- **CI review via npm-installed CLI** — Code review workflow now uses the published `@aictrl/cli` package instead of building from source. (#11)

### Fixes

- **CLI reliability hardening** — 31 fixes across security, error handling, resource management, session reliability, data integrity, and operational quality. Includes path traversal prevention, symlink-aware containment, heredoc bypass detection, output buffer caps, MCP connection timeouts, OAuth file locking, and more. (#14)
- **CI review agent isolation** — Review agent now runs from an isolated git workspace to avoid interference with repo state. (#15)
- **LICENSE detection** — Made LICENSE file detectable by GitHub's license scanner.

### Tests

- **Skill event emission tests** — Coverage for `SkillDiscovered`, `SkillLoaded`, and `SkillResourceLoaded` event lifecycle. (#17)
- **Reliability regression tests** — 30 test files with 2,766 assertions covering all hardening fixes. (#14)

### Chore

- Removed OpenCode branding, rewritten README. (#13)
