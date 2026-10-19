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

## Bun version

The compiled binary embeds the Bun runtime that built it, so the Bun version is
part of the release. The root `package.json` `packageManager` field is the only
place it is set:

- CI and the publish workflow read it through `bun-version-file: package.json`.
- `.husky/pre-push` and `@aictrl/script` (imported by
  `packages/cli/script/build.ts`) reject a local Bun outside `^<version>`.
- `packages/containers/script/build.ts` passes it to the `bun-node` image as
  `BUN_VERSION`; the Dockerfile has no default.

Bump it deliberately, in its own PR, never as a side effect of another change.
Before merging the bump, build the binary with the old and the new Bun and
compare time to first response and RSS: run a one-turn `aictrl run` against a
stub model in a fresh, CPU- and memory-limited container, several times each.
Moving from Bun 1.3.10 to 1.4.3 alone changed them by about 85 ms and 85 MB.

## 0.5.1 candidate

- **Why a patch bump (0.5.1):** model-only support change. It restores the
  built-in `google` provider (Google AI Studio, `@ai-sdk/google`) that 0.5.0
  left out of the static catalog, so `google/<model>` works with only
  `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY` set.
- The catalog gains one provider and 22 models (18 → 19 providers, 1354 → 1376
  models); every other provider's entry is byte-identical to 0.5.0.
- No CLI flags, config schema or NDJSON events change. One config behaviour
  changes: a `provider.google` defined in `aictrl.json` on 0.5.0 now extends
  the built-in, so its models without `npm` use `@ai-sdk/google` again (as up
  to 0.4.8) and the built-in models are listed too. The CHANGELOG gives the
  `npm` + `whitelist` opt-out.

Publication and executor promotion are separate gates. Preparing this candidate
PR does not publish npm packages or deploy an executor image.
