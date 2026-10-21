<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset=".github/logo.svg" />
    <img src=".github/logo.svg" alt="aictrl.dev" width="240" />
  </picture>
</p>

<h3 align="center">The headless agent harness for CI, cron jobs, and container workflows</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@aictrl/cli"><img src="https://img.shields.io/npm/v/@aictrl/cli" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@aictrl/cli"><img src="https://img.shields.io/npm/dm/@aictrl/cli" alt="npm downloads" /></a>
  <a href="https://github.com/aictrl-dev/cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/aictrl-dev/cli" alt="MIT license" /></a>
  <a href="https://aictrl.dev/agent?utm_source=github&utm_medium=readme&utm_campaign=headless-readme"><img src="https://img.shields.io/badge/docs-aictrl.dev%2Fagent-4c6ef5" alt="aictrl.dev/agent" /></a>
  <a href="https://aictrl.dev/blog/headless-coding-agent-cli-benchmark?utm_source=github&utm_medium=readme&utm_campaign=headless-readme"><img src="https://img.shields.io/badge/benchmark-6%20CLIs%20compared-15803d" alt="Headless CLI Benchmark" /></a>
</p>

---

**aictrl CLI** (`@aictrl/cli`) runs an AI coding agent as one non-interactive command in CI/CD pipelines, scheduled jobs, and isolated containers.

Interactive coding agents are built for a person at a terminal: in automation they can hang on permission prompts nobody is watching, exit `0` after a provider error, or bury structured answers in prose. **aictrl CLI has no interactive mode.** Permission prompts are rejected immediately, every run streams a versioned NDJSON event log (`EVENTS.md`), final results are validated against your JSON Schema with corrective turns, and exit codes tell your pipeline whether to proceed, retry, or fail.

## Why a dedicated headless harness?

Engineers running terminal-first coding agents in CI and batch workflows repeatedly hit the same failure modes:

| What breaks in automation                                                                    | How `aictrl run` handles it                                                                                                                                                                              |
| :------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Silent hangs** (`claude-code-action#865`, `goose#11164`)                                   | **No terminal UI or interactive prompts.** Any unpermitted tool request is rejected immediately; optional stream idle timeouts stop stalled model calls.                                                 |
| **False `exit 0` on failure** (`claude-code#79500`, `goose#11909`, `gemini-cli#1088`)        | **Distinct exit codes:** `0` accepted result, `1` provider/runtime/timeout error, `2` configuration error, `3` missing or schema-invalid result, `130`/`143` on `SIGINT`/`SIGTERM`.                      |
| **Unparseable prose or broken JSON** (`codex#19816`, `claude-code#18536`, `gemini-cli#4665`) | **Enforced JSON Schema (`--output-schema`)** with bounded corrective turns and atomic file output (`--output-result`). No prose fallback.                                                                |
| **`--dangerously-skip-permissions` in CI**                                                   | **Declarative per-tool allow/deny rules.** Tools denied for all patterns are stripped from the model request entirely, saving tokens and shrinking the attack surface. Subagents inherit caller denials. |
| **Cost & token blind spots** (`claude-code#8245`, `codex#13733`)                             | **608-token system prompt** and a [versioned NDJSON event stream](EVENTS.md) on stdout reporting per-call token usage, cost, tool timing, and permission decisions.                                      |
| **Background auto-updates & telemetry** (`claude-code-action#1290`)                          | **Zero telemetry, no auto-update, built-in model catalog.** Outbound traffic goes only to the model provider, MCP servers, and web tools you configure.                                                  |

## Install

```bash
npm i -g @aictrl/cli
```

## Quick Start

### 1. Validated JSON output in a terminal or container

```bash
export ANTHROPIC_API_KEY=<your-key> # or OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, etc.

# Stream NDJSON events and write a schema-validated result atomically
aictrl run --format json \
  --model anthropic/claude-sonnet-4-5 \
  --output-schema findings.schema.json \
  --output-result findings.json \
  "Review the changes on this branch and report security or reliability bugs"

# Explicitly append stdin to a prompt
git diff origin/main...HEAD | aictrl run --model openai/gpt-5 "Summarize breaking API changes" -
```

Stdin is read only when a standalone `-` is a message operand, or when no message operands are supplied and stdin is not a terminal. A supplied prompt proceeds without reading an unrelated open pipe. Existing pipelines that combine a prompt and piped context must add `-` as shown above.

The marker can appear before or after `--`; repeated markers still read stdin once. Markers are removed from the model message, command arguments and derived session title. `--` ends option parsing, so `run -- -` also selects stdin. An operand such as `"literal -"` remains ordinary text. An explicit empty operand (`run ""`) does not select implicit stdin. Selected stdin is read to EOF and appended after one actual newline. Ordinary prompt operands are joined with spaces without adding artificial quotes or backslash escapes; quotes, backslashes and whitespace inside an operand remain its text.

Required-value options own a separated hyphen: `--model -` and `--command -` do not select stdin, nor do their `=` forms. Optional `--port` leaves a separated `-` as the stdin operand (`--port -`). Use `--file=-` to attach a file literally named `-`; `--file -` is missing its required file value. Multiple file values and repeated `--skill` flags retain their existing behavior. Required option values are checked by the argument parser; explicit `--title ""` remains supported.

An explicit marker reads stdin even from a terminal. Any selected stream can wait for EOF indefinitely; this change adds no stdin timeout. Callers must close selected input or apply their own supervisor deadline.

### Command argument data

`--command` supplies structured arguments as `{ argv: string[], stdin?: string }`. Each normalized operand retains its exact value, including empty text, embedded quotes, tabs, newlines and Windows paths. An explicitly selected stream, even an empty stream, is preserved separately and becomes one final positional data operand. The highest numbered `$N` placeholder still consumes the remaining operands joined with spaces; missing positions remain empty.

`$ARGUMENTS`, command plugins and the executed-command event receive textual arguments derived as `argv.join(" ")` plus one newline and the exact stream when stdin was selected. Commands without argument placeholders append this text after two newlines. This projection preserves text but does not encode operand boundaries. Session titles keep their existing separate derivation. Legacy SDK callers may continue passing an `arguments` string; its existing quote-tokenization and positional rules remain unchanged. Raw `$ARGUMENTS` insertion now treats dollar replacement tokens as literal data.

Attached command execution requires a receiver that accepts this structured argument contract. This headless checkout does not include that HTTP receiver or capability negotiation, so attached compatibility is not established by the local implementation. Do not retry a rejected structured request by converting it to a legacy string: that can lose argument boundaries. Command-template shell preprocessing follows the separate authority and data-binding rules below.

### Command-template shell expansion

Only `!` followed by a backtick-delimited shell span already present in the resolved command template executes. Operands, selected stdin, appended fallback text and shell output are inserted as data; they cannot create additional shell spans or argument placeholders. Configured commands, skill commands and MCP-provided command templates keep their existing template authority. Treat executable templates from any of these sources as code you choose to trust. This preprocessing runs independently of model tool permissions; denying the model's Bash tool does not disable an original template's shell span.

Inside an original shell span, `$N` is one scalar data value. The highest numbered placeholder in the **whole original template**, including prose and shell spans, still consumes the remaining operands joined with spaces. Missing positions bind an empty scalar. `$ARGUMENTS` binds the decoded operand vector, including a selected stream as one final element. Unquoted vectors supply separate shell arguments; inside single or double quotes Bun binds the vector as one space-joined scalar. An empty unquoted vector supplies no argument; an explicitly empty element or missing numbered scalar remains an empty data argument. Quoting an empty vector binds an empty scalar. Outside shell spans, `$ARGUMENTS` continues using the textual projection described above.

These binding rules intentionally replace raw argument-to-shell-source interpolation. Trusted template operators, pipelines, substitutions and explicit interpreters remain available. An author may deliberately invoke an interpreter or `eval` that reinterprets data; binding is not a sandbox and cannot promise that arbitrary trusted programs preserve their inputs. Shell spans retain concurrent execution, captured stdout, nonthrowing exit handling and the existing execution-error text. The complete expanded template retains its final outer whitespace trim.

### 2. Drop-in GitHub Actions PR review (split-secret pattern)

Save as `.github/workflows/aictrl-review.yml`. No step holds both the model API key and the GitHub token, and the agent runs with read-only tools (`read`, `glob`, `grep` only—no `bash`, no `write`, no repo config or `AGENTS.md` instructions from the pull request):

```yaml
name: aictrl review

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: aictrl-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    # Fork pull requests get no secrets; never switch this to pull_request_target.
    if: github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      PR: ${{ github.event.pull_request.number }}
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false

      # 1. Fetch the diff with the GitHub token. The model key is not in this step.
      - run: gh pr diff "$PR" > pr.diff
        env:
          GH_TOKEN: ${{ github.token }}

      # Pin a version for reproducible runs; update it when you upgrade.
      - run: npm install -g @aictrl/cli@0.5.4

      # The harness loads AGENTS.md files as instructions, and the pull request can add them.
      # Remove them so the review follows only the prompt below.
      - run: find . -name AGENTS.md -not -path './.git/*' -delete

      # 2. Review with the model key only: no GitHub token, no shell, read-only tools,
      #    and no project config or plugins from the pull request.
      - name: Review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          MODEL: ${{ vars.AICTRL_MODEL || 'anthropic/claude-sonnet-4-5' }}
          AICTRL_DISABLE_PROJECT_CONFIG: "true"
          AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS: "300000"
          AICTRL_CONFIG_CONTENT: >-
            {"permission": {"*": "deny", "read": "allow", "glob": "allow", "grep": "allow"}}
        run: |
          aictrl run --format json --model "$MODEL" \
            "Review the change in pr.diff. Read files in this repository for context.
          Report bugs, security and reliability problems with file and line; skip style.
          Do not narrate your steps. Reply with the review only, in Markdown." > aictrl-events.jsonl
          # Join every text block: the review can come before a final tool call.
          jq -rs '[.[] | select(.type == "text") | .part.text | select(length > 0)] | if length == 0 then empty else join("\n\n") end' aictrl-events.jsonl > review.md
          test -s review.md

      # 3. Post with the GitHub token. The model key is not in this step.
      - run: gh pr comment "$PR" --body-file review.md --edit-last --create-if-none
        env:
          GH_TOKEN: ${{ github.token }}

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: aictrl-events
          path: aictrl-events.jsonl
          retention-days: 7
```

Notes on this example:

- The review is model output shaped by the pull request's contents, and the workflow posts it as written. Treat it as untrusted text, not as an approval.
- It posts Markdown rather than using `--output-schema`, because a schema result is a file the agent writes and this job denies `write`.
- `aictrl-events.jsonl` includes the output of every tool call, so the artifact holds the contents of the files the agent read. Reads are limited to the checkout, and the artifact has the repository's visibility; remove the upload step if you don't need the record.

## Headless CLI Benchmark (6 Harnesses Compared)

We benchmarked six coding-agent CLIs (`aictrl 0.5.4`, `pi 1.3.0`, `Goose 1.55.0`, `Codex 0.163.0`, `OpenCode 2.1.0`, and `Hermes 0.22.2`) in fresh 2-CPU Docker containers against a deterministic 50 ms local stub model to isolate harness overhead from remote LLM latency. Full runner, raw JSON captures, and methodology are open in [`aictrl-dev/skill-md-research`](https://github.com/aictrl-dev/skill-md-research/tree/main/experiments/headless-cli-benchmark) and analyzed in the [benchmark post](https://aictrl.dev/blog/headless-coding-agent-cli-benchmark?utm_source=github&utm_medium=readme&utm_campaign=headless-readme).

| Metric (lower is better, except coverage)       |          **aictrl 0.5.4** |            pi 1.3.0 |    Goose 1.55.0 |   Codex 0.163.0 |   OpenCode 2.1.0 |   Hermes 0.22.2 |
| :---------------------------------------------- | ------------------------: | ------------------: | --------------: | --------------: | ---------------: | --------------: |
| **First response, median** (ms)                 |                       579 |                 522 |   **392** (1st) |       471 (2nd) |              926 |           5,521 |
| **50-read session time, median** (s)            |            **4.27** (2nd) |      **3.98** (1st) |            7.22 |            5.57 |             6.03 |           12.76 |
| **Harness time per turn, median** (ms)          |              **12** (2nd) |         **9** (1st) |              72 |              45 |               32 |              64 |
| **Peak cgroup memory, median** (MiB)            |             **207** (2nd) |       **154** (1st) |             247 |           132\* |              424 |             344 |
| **Container image increment** (MiB)             |             **113** (2nd) |       **108** (1st) |             292 |             410 |              818 |             388 |
| **System prompt** (`o200k_base` tokens)         |                       608 |           601 (2nd) |   **563** (1st) |           4,047 |            1,857 |           1,053 |
| **First request total** (tokens, default tools) |           3,442 (9 tools) | **1,276** (4 tools) | 1,577 (6 tools) | 8,178 (9 tools) | 4,903 (12 tools) | 3,391 (8 tools) |
| **Short task, 4 calls** (tokens, default tools) | 15,209 (9,805 w/ 4 tools) |     **6,074** (1st) |     7,281 (2nd) |          34,078 |           21,489 |          15,562 |
| **NDJSON event stream coverage** (25 facts)     |                  **100%** |            **100%** |             68% |             40% |              80% |             72% |

_\*Codex's shell reader truncates each 800-line file to its first and last ~80 lines, holding ~1/5th of the file in context. `pi`, `Goose`, and `Hermes` ran without a subagent tool in the tested profile; restricting `aictrl` to `pi`'s 4 tools via permission config drops its first request from 3,442 to 2,091 tokens._

## Core Contracts for Automation

### Validated Final Results (`--output-schema`)

`aictrl run --output-schema <file>` validates the final JSON result.
Use `--output-schema-retries <n>` for additional corrective turns (0–10, default 2)
and `--output-result <file>` to atomically write the accepted value.
The agent writes the result to a JSON file in the working directory and calls
`StructuredOutput` with its path; the CLI validates and publishes that file.
Zero retries permits only the initial turn; N permits the initial turn and at
most N corrective turns. Serialized schemas are limited to 64 KiB, depth 64 and 10,000
nested objects.
Schema mode emits exactly one terminal `structured_output` event per prompt run;
a headless `aictrl run` has one prompt run.
Exit codes: **0** accepted, **2** configuration error, **3** missing or invalid result;
provider failures and stream timeouts use **1**, signals use **130**/**143**.
See the [full contract](packages/cli/README.md#validated-final-results)
and [JSON event reference](EVENTS.md).

### Versioned NDJSON Event Stream (`--format json`)

Passing `--format json` writes one JSON event per line to stdout (`schemaVersion: "1"`). The event types are:

- **Lifecycle and errors:** `invocation_start`, `session_start`, `retry`, `session_complete`, `session_error`, `error`, `invocation_error`, `invocation_complete`
- **Conversation:** `user_message`, `text`, `reasoning`, `step_start`, `step_finish`
- **Model & cost accounting:** `message_complete` and `subagent_message_complete` with input/output/reasoning/cache tokens, cost, and context-window utilization
- **Tools & permissions:** `tool_catalog`, `permission_granted`, `permission_rejected`, `tool_use` (with start/end timestamps), `skill_discovered`, `skill_loaded`, `skill_resource_loaded`
- **Subagents & results:** `subagent_start`, `subagent_complete`, `structured_output`, `structured_output_rejected`

```bash
aictrl run --format json "review this PR" | jq -c '{type, timestamp, tool: .part.tool}'
```

See [EVENTS.md](EVENTS.md) for the complete schema specification.

### Per-Tool Permissions & Restricting Dangerous Commands

In headless mode, `aictrl` automatically rejects any action that would prompt a human. You can scope permissions per tool or command pattern in `aictrl.json` or inline via `AICTRL_CONFIG_CONTENT`. Any tool denied for all patterns (e.g. `"webfetch": "deny"`, `"task": "deny"`) is omitted from the model request, saving tool-definition tokens on every turn.

Tool descriptions describe tools; they are not a security boundary. Block
dangerous commands with `permission.bash` rules, for example denying force
pushes, hook skipping, git config changes and `git -c` overrides (`"git -c *": "deny"`,
which also blocks harmless `-c` uses). The CLI ships no such rules by default. See the
[configuration reference](packages/cli/README.md#restricting-dangerous-commands)
for an example.

### Skill Scope (`--skill`)

`aictrl run` does not list skills from `~/.claude`, `~/.agents` or `~/.opencode`;
list them explicitly in config `skills.paths` (e.g. `["~/.claude/skills"]`) to use
them. Project skills, the global aictrl
config directories (`~/.config/aictrl`, `~/.aictrl`) and config
`skills.paths`/`skills.urls` are still listed. Pass `--skill <name>` (repeatable)
or set config `skills.allow` to list and load only the named skills.
See the [full contract](packages/cli/README.md#skill-scope).

### Model Stream Idle Timeout

Model stream idle timeouts are disabled by default. Set
`AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS` to a decimal integer of milliseconds from 1
through 2147483647 to enable one; for example, `300000` sets a five-minute timeout.
`0` disables it. Missing, empty, negative, fractional, non-decimal, non-numeric, or
unsupported values leave it disabled. The timer covers model stream setup and
resets after every stream event, so responses that keep making progress are unaffected.
Tool execution (local or provider-executed) uses a ceiling twelve times the
configured model timeout, capped at 2147483647 ms (one hour for a five-minute timeout).

### Models, MCP & Custom Tools

`aictrl` ships a built-in provider catalog supporting **Anthropic**, **OpenAI**, **Google**, **Amazon Bedrock**, **Google Vertex**, **Azure**, **OpenRouter**, and any OpenAI-compatible local or proxy endpoint (`--model provider/model`).

It also supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) and custom TypeScript tools in `.aictrl/tool/`:

```bash
# Register an MCP server
aictrl mcp add my-tool --url http://localhost:8080
```

## Programmatic SDK

Embed `aictrl` into TypeScript services via [`@aictrl/sdk`](packages/sdk):

```typescript
import { createAictrlClient } from "@aictrl/sdk"

const client = createAictrlClient({
  baseUrl: "http://localhost:4096",
})

const session = await client.session.create({
  title: "Automated PR Triage",
})
```

## Documentation & Links

- **[Headless Agent Harness Overview (`aictrl.dev/agent`)](https://aictrl.dev/agent?utm_source=github&utm_medium=readme&utm_campaign=headless-readme)** — architecture principles, interactive telemetry explorer, and CI patterns
- **[Headless Coding-Agent CLI Benchmark](https://aictrl.dev/blog/headless-coding-agent-cli-benchmark?utm_source=github&utm_medium=readme&utm_campaign=headless-readme)** — 6 CLIs measured on startup, turn overhead, memory, image footprint, and tokens
- **[NDJSON Event Stream Reference (`EVENTS.md`)](EVENTS.md)** — full specification of all versioned stdout events
- **[CLI Package & Configuration Reference (`packages/cli/README.md`)](packages/cli/README.md)** — detailed `--output-schema`, `--skill`, and permission contracts

## License

MIT License — see [LICENSE](LICENSE).
