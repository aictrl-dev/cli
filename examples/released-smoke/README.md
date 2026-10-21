# Released CLI consumer-contract smoke

A credential-free companion to the [real-provider PR review recipe](../../README.md#2-drop-in-github-actions-pr-review-split-secret-pattern). This runs published **0.5.4**, rather than building repository source. A scripted loopback provider requests a real file read and checks the returned bytes. It tests CLI integration, JSON events and failure handling; it does not measure model coding quality or establish safety for untrusted checkouts.

## Run locally

Use Node **20.20.2** and the published Linux x64 baseline native package. Package setup needs network access; package scripts are disabled:

```bash
CLI_DIR=$(mktemp -d)
npm install --prefix "$CLI_DIR" --ignore-scripts --no-audit --no-fund \
  @aictrl/cli@0.5.4 @aictrl/cli-linux-x64-baseline@0.5.4
node examples/released-smoke/smoke.mjs \
  --binary "$CLI_DIR/node_modules/@aictrl/cli-linux-x64-baseline/bin/aictrl" \
  --expected-sha256 f12a54259ae0d77d85fd6d0cfefe1dcc742b95a617ca71e48f4fdfb2575182ee \
  --evidence-dir "$CLI_DIR/evidence"
```

The runner verifies the native hash/version, two provider requests, an effective wire catalog containing only `read`, the completed read result, schema-version-1 NDJSON, successful terminal events and exit 0. A second invocation supplies invalid root schema `[]`: it must exit 2 with `OUTPUT_SCHEMA_CONFIG` before any additional model request. This is schema rejection, not successful structured output.

The CLI gets closed stdin, fresh HOME/XDG/workspace directories and an explicit environment allowlist without host credentials. Each subprocess has a 30-second deadline; the whole run has 60 seconds. Cleanup terminates POSIX process groups, escalates to SIGKILL after five seconds, and removes temporary state. A successful run prints `"status": "pass"`; a nonzero exit is failure. Evidence contains only the fixed inert fixture, public prompts and a placeholder key. Remove `CLI_DIR` after inspecting its evidence.

## GitHub Actions

The [active workflow](../../.github/workflows/released-smoke.yml) runs on changes to this directory or itself on `main` and the dedicated maintainer branch, plus manual dispatch. It has a five-minute job timeout, immutable action revisions, pinned Node/npm package versions and no user-managed secrets. `contents: read` follows the pinned checkout action's [recommended permissions](https://github.com/actions/checkout/blob/d23441a48e516b6c34aea4fa41551a30e30af803/README.md#recommended-permissions); credentials are not persisted or forwarded to the CLI. The [manual-only example](workflow.example.yml) can be copied to another trusted maintained branch with the recipe path preserved.

Neither workflow runs on `pull_request` or `pull_request_target`. The npm setup step uses network access; the CI job does not enforce no-egress isolation. The local transport binds only an ephemeral loopback port. Environment and tool restrictions are not an operating-system sandbox.

Released instruction discovery is imperfect ([#250](https://github.com/aictrl-dev/cli/issues/250)), so the runner rejects ancestor `AGENTS.md` and `.opencode/AGENTS.md` files before launching the CLI. Closed stdin avoids [#210](https://github.com/aictrl-dev/cli/issues/210). Ambient shell/config execution concerns remain [#245](https://github.com/aictrl-dev/cli/issues/245); use only this owned fixture, not an unknown PR checkout.

The runner passed local acceptance against the pinned released artifact. GitHub Actions execution must be checked separately; adding the workflow alone is not evidence of a successful CI run.
