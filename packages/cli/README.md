# @aictrl/cli

Headless execution engine for AI agent skills.

## Features

- **Headless First:** Designed for automation, CI/CD, and server-side runtimes.
- **MCP Protocol:** First-class support for [Model Context Protocol](https://modelcontextprotocol.io).
- **GitHub Integration:** Built-in agent for GitHub PRs and Issues.
- **ACP Support:** Implements the [Agent Client Protocol](https://github.com/agentclientprotocol/specification).
- **Custom Tools:** Easy extensibility via TypeScript files.

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

### Auto-Reject Permissions

In headless mode, Aictrl automatically rejects permissions that would otherwise prompt a user.

## GitHub Agent

Install the GitHub agent into any repository:

```bash
aictrl github install
```

This adds a GitHub Action that can:
1. Commmit and push code changes.
2. Create and update PRs.
3. Respond to issue comments.
4. Review PR diffs.

## Developer Helpers

### Checkout PRs

```bash
aictrl pr <number>
```
Automatically fetches the PR branch and imports the agent session used to create it.

## Configuration

Aictrl reads config from `.aictrl/` (project) or `~/.config/aictrl/` (global).

### Models

| Provider | Env Var |
|----------|---------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GOOGLE_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

Use `--variant` to select provider-specific reasoning effort. For OpenAI-compatible
Ollama models, `--variant none` sends `reasoning_effort: "none"` to disable
thinking; model `options` can also set `reasoning_effort: "none"` directly.

## Local Development

```bash
bun install
bun run --conditions=browser src/index.ts
```

Build binaries:

```bash
bun run build --single
```
