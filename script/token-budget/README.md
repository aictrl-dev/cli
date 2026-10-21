# Fixed SDK prefix token guard (Linux)

This guard starts the public CLI twice per configuration with fresh HOME/XDG state and receives its actual OpenAI-compatible SDK request at a loopback endpoint. It verifies the complete nine-tool default catalog and the explicit `--tools read,bash,edit,write` four-tool catalog. It does not import tests, reconstruct production schemas, invoke a paid model, or replace the existing 15,000-character Qwen guard.

Prerequisites: Linux x86_64, Python 3.12 with `venv`/`pip`, Bun from `package.json`, real `rg` and Git on PATH, and the repository's installed frozen Bun dependencies and built SDK. Missing prerequisites fail explicitly.

```sh
# Online setup only: creates a NEW owned directory, pinned official PyPI wheels,
# and checksum-verified OpenAI o200k rank data. It never installs JS packages.
python3.12 -I -B script/token-budget/setup.py --directory /tmp/my-token-environment

# Offline actual CLI capture and accounting; output must be a NEW directory.
/tmp/my-token-environment/venv/bin/python3 -I -B script/token-budget/run.py \
  --output /tmp/my-token-evidence
```

The guard uses an exclusive nonblocking lock in the owner-only `/tmp/aictrl-token-budget` directory. Concurrent invocations fail before changing the fixed workspace. Each cold child runs in the literal `/tmp/aictrl-token-budget/workspace`, newly initialized as a Git repository, with UTC and Date fixed before production imports to 21 October 2026. This controls all three raw cwd occurrences, including the two in Bash descriptions/schema. No text normalization is applied. Existing unowned, shared, or symlink fixture directories are rejected. The directory/lock remain for safe reuse; raw captures remain in the requested evidence directory.

The before-import guard observes `globalThis.fetch` calls in the CLI process and rejects origins other than the loopback fixture. It rejects `fetch.preconnect` and direct `Bun.spawn` calls whose executable is `bun` and whose next argument is exactly `add` or `install`. This ledger is partial: other network APIs, `Bun.spawnSync`, Node child-process APIs, shell-launched programs, and package-manager aliases are outside those controls. A clean ledger establishes no rejected operation on the instrumented paths; it does not establish complete network or installation accounting. Child environments are explicitly allowlisted, without provider credentials or inherited project configuration. These trusted fixture controls are not an OS network sandbox.

The real CLI has a mandatory 15-second deadline; each outer capture has 25 seconds. A fresh forked Linux subreaper owns only that invocation's capture and adopted descendants, including descendants that create a new session. After the capture parent exits, already-dead children are reaped without being classified as live survivors. Live adopted children are terminated and reaped, and the capture is rejected even if its parent exited successfully. Cleanup repeatedly handles newly adopted children and fails if it cannot verify completion within its cleanup deadline. The caller's other children are outside this ownership scope. The result records the supervisor and descendant cleanup evidence; the legacy `remaining_group_killed` field now indicates any observed live adopted descendant, not just the original process group.

Evidence output must be a new directory under an existing parent. Its root and per-run directories are owner-only (`0700`), so raw fixture requests and allowlisted environment records are not exposed by an ambient permissive umask. Existing output directories are never overwritten. The fixed workspace directory uses the same ownership/private-directory validation in production and lock controls.

`count.py` verifies the pinned tokenizer version, exact rank SHA256, raw environment, catalog, single request and the recorded process/partial-fetch-ledger evidence. `reference.py` denies socket/DNS use during accounting. The enforced metric is `o200k_base` encoding of compact sorted Unicode JSON containing actual SDK system-role messages, serialized tools, and instructions when present. The fixture user text is excluded. The full first model input is separately reported using `instructions/messages/input/tools/response_format/text`; transport controls are excluded. System/tool diagnostic counts use separate tokenizations and are not additive BPE contributions.

`budgets.json` contains two fixed explicit ceilings. Raising either is a reviewed source edit requiring raw evidence and an explanation. `--observe` records an evaluation without enforcing ceilings and is never used by CI. `--source` selects an isolated source copy for QA source-growth controls; CI always uses the repository entry. The default two cold repetitions must produce identical canonical prefix bytes for each arm.

CI provisions the Python runtime, lock and rank data before capture; capture/accounting do not download. Raw requests, canonical prefixes, network/exit/deadline logs and the complete reference report are retained as `token-budget-evidence`, including when enforcement fails. These counts are reference overhead measurements, not provider billing, cache savings, quality or performance estimates. Release comparisons have a separate current-versus-previous protocol; these two selector arms do not substitute for that requirement.

Initial portable observation: default **3,441** prefix tokens and selected **2,001**, at the controlled path above (15,453 and 8,973 canonical characters). Both raw request bodies and canonical prefixes were byte-identical across two cold captures per arm. Initial ceilings equal those observed counts with **zero headroom**: deterministic prompt/tool growth should require an explicit reviewed explanation rather than consume a hidden allowance. Full first model input was separately 3,457/2,017. The longer earlier evaluation cwd produced different counts and was not used as a ceiling.
