# Changelog

## Unreleased

### Features

- **GLM-5.3 model support** — Added the latest Z.AI Coding Plan model with its 1M-token context window and native `low`, `high`, and `max` reasoning efforts.

### Compatibility

- **NDJSON v1 terminal reasons are an open set** — `session_error.reason` now includes `interrupted` for `SIGINT` and `terminated` for `SIGTERM`, and `code` may contain the conventional signal-derived exit code (`130` or `143`). Schema v1 consumers should treat unknown event types, fields, and enum-like string values as forward-compatible additions.

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
