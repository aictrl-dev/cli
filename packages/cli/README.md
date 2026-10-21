# @aictrl/cli

The headless agent harness for CI, cron jobs, and container workflows.

- **[Overview & CI Quickstart (`aictrl.dev/agent`)](https://aictrl.dev/agent?utm_source=npmjs&utm_medium=readme&utm_campaign=headless-readme)**
- **[Headless CLI Benchmark (6 CLIs compared)](https://aictrl.dev/blog/headless-coding-agent-cli-benchmark?utm_source=npmjs&utm_medium=readme&utm_campaign=headless-readme)**
- **[NDJSON Event Reference (`EVENTS.md`)](https://github.com/aictrl-dev/cli/blob/main/EVENTS.md)**

## Features

- **Headless Only:** Built for non-interactive runs in CI/CD, scheduled jobs, and containers—no terminal UI, no hanging permission prompts, and distinct exit codes (`0` accepted, `1` provider/runtime/timeout error, `2` config error, `3` missing/invalid schema result).
- **Schema-Validated Results:** Pass `--output-schema` and `--output-result` to enforce a JSON Schema with corrective turns and atomic file output.
- **Versioned NDJSON Event Stream:** `--format json` streams every lifecycle step, tool call, permission decision, and per-call token/cost count to stdout.
- **Declarative Permissions:** Per-tool allow/deny rules (`permission` config); tools denied everywhere are stripped from the model request to save tokens.
- **Skills & MCP:** Progressive skill loading (`--skill`) and first-class [Model Context Protocol](https://modelcontextprotocol.io) support.

## Select work tools for one run

Use exact registered names to choose an independent work-tool allowlist:

```bash
aictrl run --tools read,glob,grep "Find the configuration entry points"
aictrl run --tools '' "Answer using only the supplied prompt"
```

Omitting `--tools` uses the final config's optional `tool_allowlist` preference;
without either input, normal tools remain available. For example,
`"tool_allowlist": ["read", "grep"]` sets a default, and `[]` selects no work
tools. Later config sources replace the whole array, including an empty array.
The CLI replaces that preference for the current invocation. It does not change
the next invocation's default, including on reused or forked sessions.

Names are case-sensitive and exact: `read`, `write`, and `edit` are independent;
no aliases or automatic dependencies are added. Exact duplicates are removed in
first-seen order. Whitespace-only names, surrounding whitespace, empty comma
elements and unknown or model/flag-unavailable names fail before model inference.
A selected tool that permissions deny remains denied. Existing permission
aliases, path checks and last-match rules still apply.

Start with a toolset that matches the task and the model's available catalog:

| Task                                  | `--tools` value                   |
| ------------------------------------- | --------------------------------- |
| Review code                           | `read,glob,grep`                  |
| Explain supplied code or a known file | `read`                            |
| Fix code with an edit/write catalog   | `read,glob,grep,edit,write,bash`  |
| Fix code with an apply_patch catalog  | `read,glob,grep,apply_patch,bash` |

Use the fix variant supported by the selected model; unavailable names fail.
Include `bash` only when the task needs shell commands such as tests. The review
and explain examples select registered work tools; existing permission checks
still apply.

The saved user invocation retains its resolved selection for continuation and
compaction. When selection is active, delegated tasks (including resumed task
sessions) inherit a ceiling from the parent's effective tools; child config,
model and permissions can narrow it. Batch validates its whole group against the
same request catalog before executing any call. Recursive Batch and MCP tools
remain unsupported inside Batch. Custom tools retain their actual identity when
replacing a built-in name. Explicit caller-directed command subtasks keep their
existing Task authorization exception; an active selection still requires the
eligible native Task tool to be selected, without adding permission allow rules.

`StructuredOutput`, invalid-call repair and LiteLLM's compatibility placeholder
are protocol/control tools, outside the work allowlist. Schema mode still needs
permission to call `StructuredOutput`; selecting work tools never grants that
permission. An empty work allowlist can therefore coexist with an explicitly
permitted StructuredOutput protocol tool. Custom tools with protocol-like names
remain work tools, except that an active output schema reserves the
`StructuredOutput` wire name for the harness-created protocol tool. A custom
`StructuredOutput` is selectable as work only outside schema mode.

Custom tools can use the optional typed `context.selection` facade to inspect
`names`/`restricted`, assert availability, or call
`await context.selection.execute("read", { filePath: "/path/to/file" })`.
Dispatch is bound to the actual caller context, checks the same catalog and
permissions before hooks, and validates captured registry parameters. Omitting a
tool or denying it in permissions also prevents this supported nested dispatch.
The facade and names are immutable; arbitrary plugin host code remains trusted.

Selection applies to harness-dispatched model work. Caller `--file`/`@file`
attachments and configured command-template shell expansion are input preparation
and keep their existing behavior. This is not an operating-system sandbox for
selected Bash commands or arbitrary plugin host code. Independent debug-tool
commands do not inherit `run` selection.

**Attach:** this headless checkout has no owned server or verified server-side
selection capability. Any explicit or locally configured selection, including an
empty list, fails with `--attach` before receiver API calls, remote session
creation/fork/prompt/command or model inference. An explicit CLI selector fails
before configuration discovery. With the CLI selector omitted, read-only
configuration discovery preserves normal config precedence and can fetch
well-known configuration; this configuration HTTP is distinct from attach
receiver calls. It performs no plugin/dependency setup, config rewrites, legacy
TOML migration or token refresh. Invalid local configuration can therefore fail
before attach. Valid configuration without a selector retains the existing
attach transport and contents. Successful remote selection requires a future
supporting receiver and is not provided by this option.

## Automation Usage

Aictrl is built to be used in non-interactive environments.

### Stdin Piping

```bash
cat diff.txt | aictrl run "review this code change"
```

### JSON Events

For programmatic pipes:

```bash
aictrl run --format json "scan for secrets" | jq '.properties.part.text'
```

### Validated Final Results

`aictrl run --output-schema <file>` enforces a JSON Schema on the final result
while the agent can continue using tools. The schema root must be `type: "object"`.
Schemas use Ajv defaults (strict validation, draft-07); a declared draft 2020-12
schema uses Ajv2020. Invalid configuration exits before any model request.
Serialized schemas are limited to 64 KiB, depth 64 and 10,000 nested objects.

```bash
aictrl run --output-schema result.schema.json --output-schema-retries 2 \
  --output-result result.json "review this change"
```

- `--output-schema <file>`: JSON Schema file, forwarded in local and `--attach` runs.
  The file is trusted instruction input: annotations (`description`, `title`,
  `examples`) are shown to the model in the StructuredOutput tool description.
- `--output-schema-retries <n>`: additional corrective turns, integer from 0 to 10,
  default 2. Zero permits only the initial turn; N permits the initial turn and
  at most N corrective turns. Each rejected call is counted, including multiple
  calls in one step.
- `--output-result <file>`: atomically write only the validated JSON value,
  indented with two spaces and a trailing newline. Failures preserve an existing
  file and leave an absent file absent. The destination directory must exist.

Relative `--output-schema` and `--output-result` paths resolve against `--dir` when
it is given (as `--file` paths do); configuration errors print the resolved path.

**StructuredOutput contract (#140).** The model writes its final result as JSON
to a file in the working directory (`--dir`, or the attached server's session
directory), then calls `StructuredOutput` with
`{ "path": "<file>" }`. The tool takes only that argument; the canonical schema is
text in the tool description, so provider schema conversion cannot drop result
fields. The CLI reads the file and publishes its parsed contents, not a re-emitted
copy. The file must:

- resolve inside the working directory after following symlinks (relative paths
  resolve against it; absolute paths inside it are accepted);
- be a regular file of at most 2 MiB;
- contain complete JSON that the schema accepts.

A file that fails any of these is a counted rejection. The model is told to fix the
file at that path and call `StructuredOutput` again with its path. Calling
`StructuredOutput` with the result object as arguments is no longer supported.
Callers whose prompts say to pass the result as tool arguments must say to write a
file and pass its path instead.

Ajv strict mode rejects unknown schema keywords and unregistered `format`
values such as `date-time` and `uri` as configuration errors (exit **2**).
The result parent directory must exist and be writable at configuration time.

The retries and result flags require `--output-schema`. Without a result file,
formatted mode prints validated JSON at the end; `--format json` emits it in a
terminal `structured_output` event, exactly one per prompt run. A headless
`aictrl run` has one prompt run. Rejections emit `structured_output_rejected`
with bounded JSON-pointer diagnostics. See [EVENTS.md](https://github.com/aictrl-dev/cli/blob/main/EVENTS.md) for the contract.
No valid result means failure, including missing output and the agent step limit;
there is no prose fallback. A prose-only finish consumes one attempt and receives
a reminder to call StructuredOutput while retries remain. Earlier tools are not
replayed for corrective turns.

Exit codes: **0** for accepted results, **2** for schema configuration errors,
**3** for exhausted corrective turns, missing output or a step limit without a result.
Provider failures and stream timeouts retain **1**; SIGINT/SIGTERM retain
**130**/**143**. Invocations without `--output-schema` keep their existing output.

### Auto-Reject Permissions

In headless mode, Aictrl automatically rejects permissions that would otherwise prompt a user.

### Skill Scope

`aictrl run` lists project skills (`.aictrl/skill(s)/`, and `.claude/skills/`,
`.agents/skills/` or `.opencode/skills/` from the working directory up to the
repository root), skills in the global config directory (`~/.config/aictrl/`,
`~/.aictrl/`) and config `skills.paths`/`skills.urls`. It does **not** scan
`~/.claude/skills/`, `~/.agents/skills/` or `~/.opencode/skills/`, so the skill
list does not depend on what happens to be in `$HOME`. To use home skills, list
their folder explicitly in config `skills.paths` (`~/` expands to the home directory):

```json
{ "skills": { "paths": ["~/.claude/skills"] } }
```

To limit a run to the skills it needs, pass `--skill <name>` (repeatable) or set
config `skills.allow`. Only those skills are then listed in the `skill` tool,
loadable by it, and reported in `tool_catalog`/`skill_discovered` events, for the
main session and every subagent. An allowlist filters discovered skills; it does
not bring back home-directory skills. `skills.allow: []` allows no skills.

An allowlist matches skill **names**, not where a skill comes from. When several
sources define the same name, the later source wins (project over home, config
`skills.paths`/`skills.urls` last), so in a repository you do not control, the
content under an allowed name can come from that repository.

`skills.allow` follows normal config precedence, so a project config can replace
a global value. It applies to every command that reads config, not only
`aictrl run`. `--skill` replaces `skills.allow` for a single `aictrl run`.

With `--attach`, the attached server discovers skills: its own skill discovery
applies, and `--skill` is rejected.

```bash
aictrl run --skill code-review "review this PR"
```

## Configuration

Aictrl reads config from `.aictrl/` (project) or `~/.config/aictrl/` (global).

### Models

| Provider         | Env Var                                                              |
| ---------------- | -------------------------------------------------------------------- |
| Anthropic        | `ANTHROPIC_API_KEY`                                                  |
| OpenAI           | `OPENAI_API_KEY`                                                     |
| Google AI Studio | `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| OpenRouter       | `OPENROUTER_API_KEY`                                                 |

Use `--variant` to select provider-specific reasoning effort. For OpenAI-compatible
Ollama models, `--variant none` sends `reasoning_effort: "none"` to disable
thinking; model `options` can also set `reasoning_effort: "none"` directly.

### Restricting Dangerous Commands

Prompt text is not a security boundary, so the `bash` tool description does not
carry git policy or a commit/PR procedure. Block dangerous commands with
`permission.bash` rules in `aictrl.json` (or inline via `AICTRL_CONFIG_CONTENT`):

```json
{
  "permission": {
    "bash": {
      "git push *--force*": "deny",
      "git push -f*": "deny",
      "git push * -f*": "deny",
      "git * --no-verify*": "deny",
      "git config *": "deny",
      "git -c *": "deny"
    }
  }
}
```

- `git push *--force*` also denies `--force-with-lease`, on purpose.
- `git -c *` closes overrides such as `git -c core.hooksPath=/dev/null commit`,
  which would otherwise skip hooks without `--no-verify`. It also blocks harmless
  `-c` uses.

Each command in a bash call (including each part of `a && b`) is matched against
the patterns. `*` matches any text, and a trailing ` *` also matches the bare
command (`git config *` matches `git config`). When several rules match, the last
one in the config wins. Commands that match no rule keep the agent's default
(`allow` for `bash` in the default `build` agent).

Patterns match the command text. They fail closed on false positives, so
`git commit -m "remove --no-verify"` is denied too. They also cannot catch every
spelling, for example a script that runs git.

If your agents should commit or open PRs, supply your own procedure through a
skill, `AGENTS.md` or the `instructions` config, and run the CLI in an isolated
environment with credentials scoped to what the task needs.

## Local Development

```bash
bun install
bun run --conditions=browser src/index.ts
```

Build binaries:

```bash
bun run build --single
```
