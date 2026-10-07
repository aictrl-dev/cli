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
- `--output-schema-retries <n>`: additional corrective turns, integer from 0 to 10,
  default 2. Zero permits one model request; N permits at most N+1 corrective
  requests. Each rejected call is counted, including multiple calls in one step.
- `--output-result <file>`: atomically write only the validated JSON value,
  indented with two spaces and a trailing newline. Failures preserve an existing
  file and leave an absent file absent. The destination directory must exist.

Ajv strict mode rejects unknown schema keywords and unregistered `format`
values such as `date-time` and `uri` as configuration errors (exit **2**).
The result parent directory must exist and be writable at configuration time.

The retries and result flags require `--output-schema`. Without a result file,
formatted mode prints validated JSON at the end; `--format json` emits it in a
terminal `structured_output` event, exactly one per prompt run. A headless
`aictrl run` has one prompt run. Rejections emit `structured_output_rejected`
with bounded JSON-pointer diagnostics. See [EVENTS.md](../../EVENTS.md) for the contract.
No valid result means failure, including missing output and the agent step limit;
there is no prose fallback. A prose-only finish consumes one attempt and receives
a reminder to call StructuredOutput while retries remain. Earlier tools are not
replayed for corrective attempts.

Exit codes: **0** for accepted results, **2** for schema configuration errors,
**3** for exhausted attempts, missing output or a step limit without a result.
Provider failures and stream timeouts retain **1**; SIGINT/SIGTERM retain
**130**/**143**. Invocations without `--output-schema` keep their existing output.

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
