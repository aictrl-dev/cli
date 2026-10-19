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

## 0.5.4 candidate

- **Why a patch bump (0.5.4):** the range `v0.5.3..97cc5be868` is four PRs,
  #233, #234, #235 and the test-only #237. They change the system prompt and
  add the GPT-6 family, which CLAUDE.md treats as patch-level model support,
  and fix a flaky test. No CLI flag,
  command, config key or NDJSON event field is removed, and `schemaVersion`
  stays `"1"`. One model option is removed: with an API key, `gpt-6-astra`
  and `gpt-6.1-sol` no longer offer the `none` effort variant, which OpenAI
  rejects for them, so no working configuration loses it (#234).
- **System prompt:** every model except Codex sign-in sessions now gets one
  shared base prompt, `default.txt` (#233 trims it and renames it from
  `qwen.txt`; #235 removes `anthropic.txt`, `beast.txt`, `gemini.txt` and
  `trinity.txt`). Codex sign-in still sends `codex_header.txt` as
  `instructions`. Gemini, Claude and GPT were not re-validated on the final
  wording; only `zai-coding-plan/glm-5.3` was (see the CHANGELOG).
- **Defaults:** with nothing configured or recently used, an OpenAI-only setup
  defaults to `gpt-6.1-sol` (was `gpt-5.6-terra`), and the small model is
  `gpt-6-luna` (#234).
- **Published package set:** unchanged from 0.5.3 (the 7 packages above).
- **Bun:** the binary must embed `Bun v1.4.3`.
- Evidence, on the release commit with Bun 1.4.3 (on `e88ed7f432`; after the
  rebase onto #237 the full suite and step-2 list were run again):
  - step-2 regressions: 95 pass, 0 fail (8 files);
  - `bun test --timeout 30000` (packages/cli): 1809 pass, 6 skip, 0 fail
    (1815 tests, 148 files), the same after the rebase onto #237; the
    formerly flaky `handles filenames with # character` test (fixed by #237)
    also passes alone in a clean `env -i CI=true` environment;
  - `bun turbo typecheck --force`: 6/6;
  - `AICTRL_VERSION=0.5.4 AICTRL_BUILD_SINGLE=true bun turbo build --force`
    (CI's build): 3/3 tasks, builds only `cli-linux-x64-baseline`;
    `aictrl --version` prints `0.5.4` and the binary embeds `Bun v1.4.3`;
  - the five binary-capable `aictrl run` suites with `AICTRL_TEST_BINARY` set
    to that binary: 21 pass, 0 fail;
  - `wrapper-binary-resolution`, the NDJSON schema tests (`run-schema-v1`,
    `events-command`, `run-user-message`, `run-event-race`), `bun-version-pin`
    and the prompt tests (`system`, `llm`, `headless-prompt-budget`): 76 pass,
    0 fail;
  - a one-turn `aictrl run --format json` of that binary against a stub
    OpenAI-compatible endpoint, with isolated `HOME`/XDG dirs: exit 0, one
    model request, 10 events, `schemaVersion` `"1"`, both terminal statuses
    `completed`; the request's single system message starts with the trimmed
    `default.txt` (2,602 chars), including the new Task-tool and
    rejected-call lines, followed by the environment block;
  - `AICTRL_VERSION=0.5.4 bun run build` builds the 7 targets. `npm pack` of
    each platform package gives `bin/aictrl` (`aictrl.exe` on windows),
    `bin/aictrl.map`, `LICENSE` and a `package.json` whose `os`, `cpu` and
    `libc` match the table. publish.yml's manifest step, run on a copy, writes
    exactly those 7 names at `0.5.4` into `optionalDependencies`; the wrapper
    tarball has 4 files, 18.3 kB unpacked.
  - not repeated from 0.5.3: the local-registry (verdaccio) publish, the
    visibility step and the fresh-container installs. `bin/aictrl`,
    `script/build.ts` and `publish.yml` are unchanged in `v0.5.3..97cc5be868`,
    and the tarballs above match 0.5.3's except for the version, so those
    checks would exercise the same code. The publish workflow's visibility
    gate and install smoke, and the clean `npm install` in step 5, still check
    0.5.4 itself after merge.

Publication and executor promotion are separate gates. Preparing this candidate
PR does not publish npm packages or deploy an executor image.
