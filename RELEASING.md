# Releasing aictrl CLI

1. Prepare a PR against `main` with the fixes, the version bump in
   `packages/cli/package.json`, and the matching `packages/cli` workspace
   version in `bun.lock`. Run `bun install --frozen-lockfile`.
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

## 0.4.6 candidate

- `aictrl run --output-schema <file>` enforces a JSON Schema on the final
  result with bounded corrective retries (`--output-schema-retries`, default 2)
  and writes only the validated value to `--output-result <file>` (#129).
  Exit 2 is a schema configuration error; exit 3 is a structured-output failure.
  New NDJSON events `structured_output_rejected` and a terminal
  `structured_output` are additive (schema "1"). Runs without a schema are
  unchanged.
- `--attach` request shapes are fixed for the legacy SDK client (#129).
- A stalled models.dev catalog body no longer surfaces as an unhandled
  `TimeoutError` (#129).
- Executor adoption (pin bump plus entrypoint flags) is tracked separately in
  application #5960.

Publication and executor promotion are separate gates. Preparing this candidate
PR does not publish npm packages or deploy an executor image.
