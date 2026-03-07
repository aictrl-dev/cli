# Gemini CLI Mandates for Aictrl

You are working on the core Aictrl Headless Engine. This is a high-integrity project.

## Development Workflow

- **PR-Only:** NEVER commit directly to the `main` branch. 
- **Branching:** Always create a new branch for every task using a descriptive name (e.g., `feat/telemetry-rework` or `fix/import-resolution`).
- **Pull Requests:** When a task is complete, use the `gh` CLI to create a pull request to `main`.
- **Atomic Changes:** Keep PRs focused on a single objective.

## Technical Standards

- **Headless First:** Ensure no UI-specific or server-specific dependencies (like `hono`) are reintroduced.
- **Type Safety:** Maintain 100% type-check passes. Avoid adding more `// @ts-nocheck` unless absolutely necessary for external legacy adapters.
- **Explicit Versions:** Use explicit versions (e.g., `0.1.0`) for cross-package dependencies in `package.json` to ensure NPM publication reliability.
