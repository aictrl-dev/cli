<p align="center">
  <img src=".github/logo.svg" alt="aictrl.dev" width="240" />
</p>

<h3 align="center">Headless execution engine for AI agent skills</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@aictrl/cli"><img src="https://img.shields.io/npm/v/@aictrl/cli" alt="npm" /></a>
  <a href="https://github.com/aictrl-dev/cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/aictrl-dev/cli" alt="license" /></a>
</p>

---

Aictrl is a headless, server-side runtime for autonomous AI agent workflows. It is designed for engineers who want to automate complex tasks using agentic models in CI/CD pipelines, cron jobs, or embedded within other applications.

## Install

```bash
npm i -g @aictrl/cli
```

## Quick Start

```bash
# Run a one-off task
aictrl run "analyze the security of this repository"

# Use a specific model
aictrl run --model anthropic/claude-3-5-sonnet-latest "refactor the auth module"
```

## Automation & Headless Usage

Aictrl is "headless first". When run in a non-TTY environment, it automatically switches to a mode optimized for automation.

### Stdin Piping

You can pipe content directly into `aictrl`. This is useful for processing logs, code, or command output.

```bash
cat logs.txt | aictrl run "summarize these errors"
```

### JSON Output

For programmatic consumption, use `--format json` to get raw events.

```bash
aictrl run --format json "review this PR" | jq '.type'
```

### Validated Final Results

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
With `--output-schema`, `--deadline <ISO-8601 with offset | epoch-ms>` gives the
agent one forced final turn to submit before that instant; if it passes without a
valid result, the run ends `failed / deadline` (exit **3**) instead of being killed
externally. Without `--output-schema`, `--deadline` only stops the run at that
instant (`session_error` reason `deadline`, exit **1**).
Exit codes: **0** accepted, **2** configuration error, **3** missing or invalid result
or a passed deadline; provider failures and stream timeouts use **1**, signals use **130**/**143**.
See the [full contract](packages/cli/README.md#validated-final-results)
and [JSON event reference](EVENTS.md).

### Non-Interactive Execution

In headless mode, Aictrl automatically rejects all interactive permission requests (like `question` or `plan_enter`), ensuring your pipelines never hang.

`aictrl run` does not offer the `todowrite` tool: its definition adds about 2.4k tokens to
every request, and a one-shot run has nobody following a todo list. To track a plan, instruct
the agent to keep one in a file.

### Skill Scope

`aictrl run` does not list skills from `~/.claude`, `~/.agents` or `~/.opencode`;
list them explicitly in config `skills.paths` (e.g. `["~/.claude/skills"]`) to use
them. Project skills, the global aictrl
config directories (`~/.config/aictrl`, `~/.aictrl`) and config
`skills.paths`/`skills.urls` are still listed. Pass `--skill <name>` (repeatable)
or set config `skills.allow` to list and load only the named skills.
See the [full contract](packages/cli/README.md#skill-scope).

### CI/CD Integration

Set `AICTRL_HEADLESS=true` in your environment to force headless behavior even in pseudo-TTYs.

### Restricting Dangerous Commands

Tool descriptions describe tools; they are not a security boundary. Block
dangerous commands with `permission.bash` rules, for example denying force
pushes, hook skipping, git config changes and `git -c` overrides (`"git -c *": "deny"`,
which also blocks harmless `-c` uses). The CLI ships no such rules by default. See the
[configuration reference](packages/cli/README.md#restricting-dangerous-commands)
for an example.

### Model Stream Idle Timeout

Model stream idle timeouts are disabled by default. Set
`AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS` to a decimal integer of milliseconds from 1
through 2147483647 to enable one; for example, `300000` sets a five-minute timeout.
`0` disables it. Missing, empty, negative, fractional, non-decimal, non-numeric, or
unsupported values leave it disabled. The timer covers model stream setup and
resets after every stream event, so responses that keep making progress are unaffected.
Tool execution (local or provider-executed) uses a ceiling twelve times the
configured model timeout, capped at 2147483647 ms (one hour for a five-minute timeout).

## MCP & Custom Tools

Aictrl supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

```bash
# Add an MCP server
aictrl mcp add my-tool --url http://localhost:8080

# Add custom TypeScript tools
# Just drop them in .aictrl/tool/
```

## Programmatic SDK

Embed Aictrl directly into your TypeScript applications.

```typescript
import { createAictrlClient } from "@aictrl/sdk"

const client = createAictrlClient({
  baseUrl: "http://localhost:4096",
})

const session = await client.session.create({
  title: "My Automation Task",
})
```

## Agent Client Protocol (ACP)

Aictrl implements the [Agent Client Protocol](https://github.com/agentclientprotocol/specification), allowing other ACP-compatible agents to communicate with Aictrl headlessly.

```bash
aictrl acp
```

## Attribution

Aictrl is a fork of the [OpenCode](https://opencode.ai) project and is licensed under the MIT License.

---

[aictrl.dev](https://aictrl.dev/?utm_medium=referral&utm_source=github&utm_campaign=cli&utm_content=readme)
