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

## 0.4.8 candidate

- **BREAKING for `--output-schema` callers (#142, closes #140):** `StructuredOutput`
  takes only `{ "path": "<file>" }`. The model writes its final result as JSON to a
  file in the working directory and passes the path. The CLI validates that file with
  Ajv and publishes the parsed file. Result objects passed as tool arguments are
  rejected. Callers must change prompts that say "call StructuredOutput with the
  result" to say "write a file and pass its path".
- Only `{ path }` reaches the provider, so provider schema conversion can no longer
  drop result fields. On 0.4.7, Gemini emptied map-typed fields (#139).
- The result file must:
  - resolve inside the working directory (symlinks are followed when checking, and a
    post-open inode re-check also covers swap races; `O_NOFOLLOW`/`O_NONBLOCK` are
    used where the platform defines them);
  - be a regular file of at most 2 MiB (reads are bounded).
- Every failure is a fixed, counted `structured_output_rejected` diagnostic; EVENTS.md
  lists them verbatim. The prose-only `missing` diagnostic and reminder now say
  "write the final result as JSON to a file in the working directory, then call
  StructuredOutput with its path".
- Evidence (#139 reproduction, 6-key map):
  - 0.4.7: Gemini 3.8 Flash published `elements: {}` 7/7 (silent on 2, exit 3 on 5).
  - #142 builds (POC and first PR head): Gemini 10/10 and GLM 4/4 published all 6 keys identically.
  - Gemini output + reasoning tokens fell from 2.5–3.9k to 1.0–1.8k.
- Executor adoption, in one aictrl PR:
  - bump the `docker/executor/Dockerfile` pin;
  - update the prompts that ask for the result as tool arguments: `prompt-builder.ts`
    structured paragraph, `pr-explanation-output-contract.ts`, and the `explain-change`
    skill step that says to call StructuredOutput "with the contents of `$RESULT`";
  - confirm `$RESULT` lies inside the CLI's `--dir`.

Publication and executor promotion are separate gates. Preparing this candidate
PR does not publish npm packages or deploy an executor image.
