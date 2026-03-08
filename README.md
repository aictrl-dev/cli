<p align="center">
  <img src=".github/logo.svg" alt="aictrl.dev" width="240" />
</p>

<h3 align="center">Headless execution engine for AI agent skills</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/@aictrl/cli"><img src="https://img.shields.io/npm/v/@aictrl/cli" alt="npm" /></a>
  <a href="https://github.com/aictrl-dev/cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/aictrl-dev/cli" alt="license" /></a>
</p>

---

Aictrl is a headless, server-side runtime for autonomous AI agent workflows. Run agent skills in CI/CD pipelines, Cloud Run, or any environment — no terminal UI required.

## Install

```bash
npm i -g @aictrl/cli
```

## Usage

### Run a task

```bash
aictrl run "analyze the security of this repository"
```

### Use a specific model

```bash
aictrl run --model anthropic/claude-sonnet-4-20250514 "refactor the auth module"
```

### JSON output for pipelines

```bash
aictrl run --format json "review this PR" | jq '.type'
```

### Attach files

```bash
aictrl run --file screenshot.png "what's wrong with this UI?"
```

## Configuration

Aictrl reads configuration from `.aictrl/` directories (project-level and `~/.config/aictrl/` global).

### Models

Any model from any supported provider. Set the API key as an env var:

| Provider | Env Var | Example Model |
|----------|---------|---------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-20250514` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4o` |
| Google | `GOOGLE_API_KEY` | `google/gemini-2.5-pro` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter/...` |
| ZhipuAI | `ZHIPU_API_KEY` | `zai-coding-plan/glm-5` |

Run `aictrl models` for the full list.

### Skills

Skills are modular agent capabilities defined as `SKILL.md` files. Place them in:

- `.aictrl/skills/` (project-level)
- `~/.config/aictrl/skills/` (global)

### MCP Servers

Configure MCP servers for external tool integration:

```bash
aictrl mcp add my-server --url http://localhost:8080
```

### Custom Tools

Drop TypeScript files in `.aictrl/tool/` or `.aictrl/tools/` to register custom tools.

## Commands

| Command | Description |
|---------|-------------|
| `aictrl run <message>` | Execute a task headlessly |
| `aictrl models` | List available models |
| `aictrl mcp` | Manage MCP servers |
| `aictrl session` | Manage sessions |
| `aictrl upgrade` | Upgrade the CLI |
| `aictrl pr` | PR workflow helpers |

## SDK

For programmatic use:

```typescript
import { createAictrl } from "@aictrl/sdk"

const client = await createAictrl()
```

## Monorepo

| Package | Description |
|---------|-------------|
| `@aictrl/cli` | The CLI and headless runtime |
| `@aictrl/sdk` | Programmatic SDK for embedding |
| `@aictrl/plugin` | Plugin authoring utilities |
| `@aictrl/util` | Shared utilities |

## Development

```bash
bun install
bun run --conditions=browser packages/cli/src/index.ts
```

Build platform binaries:

```bash
cd packages/cli && bun run build --single
```

## Attribution

Aictrl is a fork of the [OpenCode](https://opencode.ai) project and is licensed under the MIT License.

---
[aictrl.dev](https://aictrl.dev)
