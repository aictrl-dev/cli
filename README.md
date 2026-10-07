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

`aictrl run --output-schema <file>` enforces a JSON Schema on the final result
while the agent can continue using tools. The schema root must be `type: "object"`.
Schemas use Ajv defaults (strict validation, draft-07); a declared draft 2020-12
schema uses Ajv2020. Invalid configuration exits before any model request.

```bash
aictrl run --output-schema result.schema.json --output-schema-retries 2 \
  --output-result result.json "review this change"
```

- `--output-schema <file>`: JSON Schema file, forwarded in local and `--attach` runs.
- `--output-schema-retries <n>`: additional corrective attempts, integer >= 0,
  default 2. Zero permits one attempt; N permits at most N+1 attempts.
- `--output-result <file>`: atomically write only the validated JSON value,
  indented with two spaces and a trailing newline. Failures preserve an existing
  file and leave an absent file absent. The destination directory must exist.

The retries and result flags require `--output-schema`. Without a result file,
formatted mode prints validated JSON at the end; `--format json` emits it in a
terminal `structured_output` event. Rejections emit `structured_output_rejected`
with bounded JSON-pointer diagnostics. See [EVENTS.md](EVENTS.md) for the contract.
No valid result means failure, including missing output and the agent step limit;
there is no prose fallback. Earlier tools are not replayed for corrective attempts.

Exit codes: **0** for accepted results, **2** for schema configuration errors,
**3** for exhausted attempts, missing output or a step limit without a result.
Provider failures and stream timeouts retain **1**; SIGINT/SIGTERM retain
**130**/**143**. Invocations without `--output-schema` keep their existing output.

### Non-Interactive Execution

In headless mode, Aictrl automatically rejects all interactive permission requests (like `question` or `plan_enter`), ensuring your pipelines never hang.

### CI/CD Integration

Set `AICTRL_HEADLESS=true` in your environment to force headless behavior even in pseudo-TTYs.

### Model Stream Idle Timeout

Model stream idle timeouts are disabled by default. Set
`AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS` to a decimal integer of milliseconds from 1
through 2147483647 to enable one; for example, `300000` sets a five-minute timeout.
`0` disables it. Missing, empty, negative, fractional, non-decimal, non-numeric, or
unsupported values leave it disabled. The timer covers model stream setup and
resets after every stream event, so responses that keep making progress are unaffected.
Tool execution (local or provider-executed) uses a ceiling twelve times the
configured model timeout, capped at 2147483647 ms (one hour for a five-minute timeout).

## GitHub Integration

Aictrl includes a specialized GitHub agent that can be installed into your repositories to automate PR reviews, issue triage, and code generation.

### Setup

```bash
# Install the GitHub agent in the current repo
aictrl github install
```

### Features

- **Auto-Push:** The agent can commit and push changes directly to your branches.
- **PR Creation:** It can automatically open Pull Requests for its changes.
- **Context Aware:** In GitHub Actions, it automatically fetches PR diffs, issue comments, and review history.
- **Social Cards:** Generates visual summaries of agent sessions.

## Developer Workflow

### PR Checkout

Engineers can quickly checkout a PR and import the associated agent session:

```bash
aictrl pr 123
```

This command will:

1. Fetch and checkout PR #123.
2. Detect if an Aictrl session was used to generate the PR.
3. Import that session locally so you can continue the conversation.

### MCP & Custom Tools

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
