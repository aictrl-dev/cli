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

## 0.5.3 candidate

- **Why a patch bump (0.5.3):** the range `v0.5.2..b95059eb3e` is one PR,
  #231, and it changes which npm packages are published, not what the CLI
  does. No CLI flag, command, config key or NDJSON event changes, and
  `schemaVersion` stays `"1"`. Wrappers up to 0.5.2 pin their own platform
  package versions, which stay on npm, so they keep working.
- **Published package set:** 7 platform packages instead of 11 (the table
  above). `@aictrl/cli-linux-x64`, `-linux-x64-musl`, `-darwin-x64` and
  `-windows-x64` get no 0.5.3. The linux packages declare `libc`. Every
  remaining name already exists on npm with 0.5.2, so no new package needs
  trusted publishing set up.
- **Wrapper:** a `files` allowlist ships `bin/aictrl`, `README.md`, `LICENSE`
  and `package.json` only. `bin/aictrl` drops AVX2 detection and the
  `bun run src/index.ts` fallback, and reads the libc from `/usr/bin/ldd`.
- **Publish workflow:** the manifest step copies `LICENSE` and exports the
  platform package list; the smoke job waits until every listed package is
  visible at the release version before the install check.
- **Bun:** the binary must embed `Bun v1.4.3`.
- Evidence, on the release commit with Bun 1.4.3:
  - step-2 regressions: 95 pass, 0 fail (8 files);
  - `bun test --timeout 30000` (packages/cli): 1784 pass, 6 skip, 0 fail
    (1790 tests, 147 files);
  - `bun turbo typecheck --force`: 6/6;
  - `AICTRL_VERSION=0.5.3 AICTRL_BUILD_SINGLE=true bun turbo build --force`
    (CI's build): 3/3 tasks, builds only `cli-linux-x64-baseline`;
    `aictrl --version` prints `0.5.3` and the binary embeds `Bun v1.4.3`;
  - the five binary-capable `aictrl run` suites with `AICTRL_TEST_BINARY` set
    to that binary: 21 pass, 0 fail;
  - `wrapper-binary-resolution`, the NDJSON schema tests (`run-schema-v1`,
    `events-command`, `run-user-message`, `run-event-race`) and
    `bun-version-pin`: 54 pass, 0 fail;
  - `AICTRL_VERSION=0.5.3 bun run build` builds the 7 targets. `npm pack` of
    each platform package gives `bin/aictrl` (`aictrl.exe` on windows),
    `bin/aictrl.map`, `LICENSE` and a `package.json` whose `os`, `cpu` and
    `libc` match the table. publish.yml's manifest step, run on a copy, writes
    exactly those 7 names at `0.5.3` into `optionalDependencies`; the wrapper
    tarball has 4 files, 18.3 kB unpacked;
  - the 8 tarballs published to a local verdaccio: publish.yml's visibility
    step passes on attempt 1. `npm install -g @aictrl/cli@0.5.3` in fresh
    `node:20-slim` and `node:20-alpine` containers (Node 20.20.2, npm 10.8.2)
    installs one platform package, `cli-linux-x64-baseline` (116,272 KiB in
    `@aictrl/`) or `cli-linux-x64-baseline-musl` (109,960 KiB). `aictrl
    --version` prints `0.5.3`, and a one-turn `aictrl run --format json`
    against a stub OpenAI-compatible endpoint exits 0 with 10 events,
    `schemaVersion` `"1"` and both terminal statuses `completed`. A local
    (non-global) install gives the same single package on both images.

Publication and executor promotion are separate gates. Preparing this candidate
PR does not publish npm packages or deploy an executor image.
