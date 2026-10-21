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

Only loopback fixture HTTP is allowed by the before-import fetch/preconnect/install guard reused from the selector fixture. Child environments are explicitly allowlisted, without provider credentials or inherited project configuration. The real CLI has a mandatory 15-second deadline; the outer owned process group has 25 seconds and rejects surviving descendants even if its parent exits successfully. These fixture controls are not an OS network sandbox.

`count.py` verifies the pinned tokenizer version, exact rank SHA256, raw environment, catalog, single request and clean process/network evidence. `reference.py` denies socket/DNS use during accounting. The enforced metric is `o200k_base` encoding of compact sorted Unicode JSON containing actual SDK system-role messages, serialized tools, and instructions when present. The fixture user text is excluded. The full first model input is separately reported using `instructions/messages/input/tools/response_format/text`; transport controls are excluded. System/tool diagnostic counts use separate tokenizations and are not additive BPE contributions.

`budgets.json` contains two fixed explicit ceilings. Raising either is a reviewed source edit requiring raw evidence and an explanation. `--observe` records an evaluation without enforcing ceilings and is never used by CI. `--source` selects an isolated source copy for QA source-growth controls; CI always uses the repository entry. The default two cold repetitions must produce identical canonical prefix bytes for each arm.

CI provisions the Python runtime, lock and rank data before capture; capture/accounting do not download. Raw requests, canonical prefixes, network/exit/deadline logs and the complete reference report are retained as `token-budget-evidence`, including when enforcement fails. These counts are reference overhead measurements, not provider billing, cache savings, quality or performance estimates. Release comparisons have a separate current-versus-previous protocol; these two selector arms do not substitute for that requirement.

Initial portable observation: default **3,441** prefix tokens and selected **2,001**, at the controlled path above (15,453 and 8,973 canonical characters). Both raw request bodies and canonical prefixes were byte-identical across two cold captures per arm. Initial ceilings equal those observed counts with **zero headroom**: deterministic prompt/tool growth should require an explicit reviewed explanation rather than consume a hidden allowance. Full first model input was separately 3,457/2,017. The longer earlier evaluation cwd produced different counts and was not used as a ceiling.
