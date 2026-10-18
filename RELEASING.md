# Releasing aictrl CLI

1. Prepare a PR against `main` with the fixes, the version bump in
   `packages/cli/package.json`, and the matching `packages/cli` workspace
   version in `bun.lock`. Run `bun install --frozen-lockfile`. In `CHANGELOG.md`,
   retitle `## Unreleased` to `## <version> (<date>)`.
2. Run the release regressions from `packages/cli`:

   ```bash
   bun test test/cli/run-mcp-discovery.test.ts test/mcp/discovery-recovery.test.ts test/cli/publish-workflow.test.ts test/cli/run-provider-finish.test.ts test/cli/run-signal-cancellation.test.ts test/cli/classify-session-error.test.ts test/session/idle.test.ts test/session/processor-idle.test.ts
   ```

   Wait for CI build, workspace typecheck and tests to pass and address reviews.

3. Merge the approved PR and record the resulting `main` commit SHA. Confirm
   its package version matches the intended tag. Publish the release against
   that exact commit, using reviewed notes:

   ```bash
   gh release create v<version> --repo aictrl-dev/cli --target <merged-main-SHA> --title v<version> --notes-file <notes-file>
   gh run list --repo aictrl-dev/cli --workflow publish.yml --limit 3
   ```

   Do not use the legacy `script/release` or `script/publish.ts`; they refer to
   retired branches/workflows and do not implement these gates.

4. Require the **Publish to npm** workflow to be green. It checks the tag
   against the wrapper package version before building, publishes the platform
   packages and wrapper, then retries npm installation through its propagation
   window and verifies the installed binary version. If publishing partially
   succeeds, inspect the failure before rerunning: npm versions are immutable.
5. Independently install `@aictrl/cli@<version>` in a temporary directory and
   verify `./node_modules/.bin/aictrl --version` equals `<version>`.
6. In a separate aictrl application PR, update `docker/executor/Dockerfile` to
   the published version. Build the executor image and rerun the headless
   discovery and idle-stream fixtures against its binary. Promote through
   `sandbox` before `main`; verify a sandbox review persists MCP findings and
   a stalled stream reports a timeout rather than waiting for the job limit.

## 0.5.0 candidate

- **Why a minor bump (0.5.0):** the release removes public surface rather than
  adding models. Caret ranges on `^0.4.x` do not pick it up; consumers opt in.
- **Breaking:**
  - The built-in provider set narrows to the 18 providers in
    `packages/cli/src/provider/catalog.json`, shipped in the binary; models.dev
    is no longer fetched or cached (#202). Other providers must be defined under
    `provider` in `aictrl.json`. GitHub Copilot is removed (#193).
  - Commands removed: `github`, `pr` (#192) and `acp` (#204) print a
    replacement hint and exit 1; `debug lsp`, `debug snapshot` and
    `models --refresh` are gone; `run --share` and `import <url>` fail (#195);
    `run --agent plan` fails (#162).
  - Subsystems and tools removed: LSP (#191), snapshots/revert/session diffs
    (#184), session sharing (#195), the file watcher (#204), `question` and
    plan mode (#162), `todowrite`/`todoread` (#183).
  - Prompt changes: the `bash` description has no git procedures or rules, and
    no default deny rules ship; callers use `permission.bash` (#161). Headless
    runs no longer discover `~/.claude`, `~/.agents` or `~/.opencode` skills
    (#165).
  - Config keys `lsp`, `permission.lsp`, `snapshot`, `share`, `autoshare`,
    `enterprise` and `watcher` still load as warned no-ops.
- **NDJSON v1 additions:** `session_error` reason `usage_limit`, code
  `PROVIDER_USAGE_LIMIT` and `resetAt` (#174); `structured_output_rejected`
  keyword `rejected` (#179).
- Stored sessions from 0.4.x still load and continue (covered by e2e tests in
  #183, #184, #191, #195).

Publication and executor promotion are separate gates. Preparing this candidate
PR does not publish npm packages or deploy an executor image.
