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

## Platform packages

`packages/cli/script/build.ts` builds one binary per OS, CPU and libc, and the
publish workflow publishes each as a platform package. It then lists them in
the wrapper's `optionalDependencies`:

| Package | `os` | `cpu` | `libc` |
| --- | --- | --- | --- |
| `@aictrl/cli-linux-x64-baseline` | linux | x64 | glibc |
| `@aictrl/cli-linux-x64-baseline-musl` | linux | x64 | musl |
| `@aictrl/cli-linux-arm64` | linux | arm64 | glibc |
| `@aictrl/cli-linux-arm64-musl` | linux | arm64 | musl |
| `@aictrl/cli-darwin-x64-baseline` | darwin | x64 | |
| `@aictrl/cli-darwin-arm64` | darwin | arm64 | |
| `@aictrl/cli-windows-x64-baseline` | win32 | x64 | |

npm installs only the package that matches the host. Every x64 package is the
baseline (no AVX2) build: Bun ships the same binary for its baseline and AVX2
targets. The AVX2 names (`@aictrl/cli-linux-x64`, `-linux-x64-musl`,
`-darwin-x64`, `-windows-x64`) were last published with 0.5.2. Before adding
or renaming a platform package, update `bin/aictrl`'s `platformPackageNames`
and its tests. The smoke job waits until every package in this table is visible
on npm before it installs `@aictrl/cli`.

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

## 0.5.2 candidate

- **Why a patch bump (0.5.2):** only additive NDJSON events, fixes and
  internal changes. No CLI flag, command, config key or NDJSON event field is
  removed, and `schemaVersion` stays `"1"`. Range `v0.5.1..d4d9696dbc` (11 PRs):
  #222, #220, #217, #218, #224, #225, #221, #226, #219, #228, #229.
- **NDJSON additions:** `user_message` (#224) and `subagent_message_complete`
  (#221). `session_start.permissions` keeps its shape and now carries the full
  evaluated ruleset (#218). `user_message` takes numbers from the shared
  `sequenceNum` counter, so `text`, `reasoning` and `tool_use` numbers can have
  gaps; they stay monotonic.
- **Behaviour changes worth knowing:**
  - a retryable error asking for more than 5 minutes fails at once, for any
    status (#217);
  - a second prompt for a busy session fails with `Session <id> is busy`
    instead of queuing; only parallel `task` calls resuming one `task_id`
    reach it (#225);
  - `AICTRL_HEADLESS` is ignored (#219). A full-binary run that set it now
    gets the full environment block and the `AICTRL_CONFIG_DIR` / global
    `AGENTS.md` files. The production executor does not set it.
- **Prompt:** #229 trims the `bash` and `task` tool descriptions (about
  9.7k → 3.4k characters, first request −21.7% tokens on glm-5.3). Tool names
  and parameters are unchanged; its A/B passed 24/24 with no extra steps.
- **Database:** drizzle 1.0.0-beta.20 (#220) adds `name` and `applied_at` to
  `__drizzle_migrations` on first start; a database upgraded by 0.5.2 still
  opens with 0.5.1.
- **SDK:** #228 regenerates the v2 `@aictrl/sdk` client with
  `@hey-api/openapi-ts` 0.97.3 (GHSA-hhx9-57xq-r5rw) and hand-patches the
  legacy client's `buildClientParams`. The CLI uses only the legacy client
  (`--attach`, plugins), where only that helper changes. `@aictrl/sdk` is not
  bumped by this release.
- **Bun:** the first release built under the `packageManager` pin (#226). The
  binary must embed `Bun v1.4.3`.
- Evidence, on the release commit with Bun 1.4.3:
  - step-2 regressions: 88 pass, 0 fail (8 files);
  - `bun test --timeout 30000` (packages/cli): 1760 pass, 6 skip, 0 fail
    (1766 tests, 147 files);
  - `bun turbo typecheck --force`: 6/6;
  - `test/security/sdk-build-client-params.test.ts`: 12 pass, 0 fail;
  - `AICTRL_VERSION=0.5.2 AICTRL_BUILD_SINGLE=true bun turbo build --force`
    (CI's build): 3/3 tasks; `aictrl --version` prints `0.5.2` and the
    binary embeds `Bun v1.4.3`;
  - the five binary-capable `aictrl run` suites with `AICTRL_TEST_BINARY` set
    to that binary: 21 pass, 0 fail;
  - NDJSON schema tests (`run-schema-v1`, `events-command`, `run-user-message`,
    `run-event-race`) and `bun-version-pin`: 27 pass, 0 fail;
  - one-turn `aictrl run --format json` smoke runs of the binary against
    a stub OpenAI-compatible endpoint: exit 0, one model request, every line
    is JSON, `schemaVersion` `"1"`, `session_start.permissions` contains the
    config rule, `user_message` precedes `text`, `message_complete.status`
    `completed`, `invocation_complete.status` `completed`.

Publication and executor promotion are separate gates. Preparing this candidate
PR does not publish npm packages or deploy an executor image.
