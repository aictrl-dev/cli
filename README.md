<p align="center">
  <img src=".github/logo.svg" alt="aictrl.dev" width="240" />
</p>

<h3 align="center">The Lightweight Headless Runtime for AI Agent Skills</h3>

---

Aictrl CLI is a 100% headless, server-side execution harness designed for autonomous agentic workflows. It provides a secure, modular environment to run, measure, and scale agent skills without the bloat of a desktop or terminal UI.

## Key Features

- **Headless First:** Built specifically for server-side automation, Cloud Run, and CI/CD pipelines.
- **Skill-Native:** Native support for the `SKILL.md` format for modular procedural knowledge.
- **Agent Teams:** Robust support for subagent delegation and parallel execution.
- **Deep Telemetry:** Instrumented with granular hooks for measuring skill usage and subagent lifecycles.
- **Vendor Agnostic:** Compatible with Anthropic, OpenAI, Gemini, and local models via Ollama.
- **MCP Support:** Seamless integration with Model Context Protocol servers.

## Installation

```bash
npm i -g @aictrl/cli
```

## Quick Start

Run a task headlessly:

```bash
aictrl run "analyze the security of this repository"
```

## Attribution

Aictrl is a fork of the [OpenCode](https://opencode.ai) project by [anomalyco](https://github.com/anomalyco/opencode) and is licensed under the MIT License.

---
© 2026 [aictrl.dev](https://aictrl.dev)
