# Changelog

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
