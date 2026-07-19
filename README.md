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

### Non-Interactive Execution
In headless mode, Aictrl automatically rejects all interactive permission requests (like `question` or `plan_enter`), ensuring your pipelines never hang.

### CI/CD Integration
Set `AICTRL_HEADLESS=true` in your environment to force headless behavior even in pseudo-TTYs.

Model streams have a five-minute idle timeout by default. Every stream event resets
the timer, so long-running responses that continue making progress are unaffected.
Set `AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS` to a positive number of milliseconds to
override the timeout, or `0` to disable it. Missing, empty, negative, fractional, and
non-numeric values use the 300000 ms default.

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
  baseUrl: "http://localhost:4096"
})

const session = await client.session.create({
  title: "My Automation Task"
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
[aictrl.dev](https://aictrl.dev)
