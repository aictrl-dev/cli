The scripted protocol is adapted from the MIT-licensed
[aictrl public benchmark](https://github.com/aictrl-dev/skill-md-research/blob/cc47b1e5f5277de19c222f7216081110571c5504/experiments/headless-cli-benchmark/harness/token-stub.ts).
The vendored copy adds raw SSE response capture. `LICENSE` retains its notice.

Release comparisons use explicit local native binaries and an explicit existing
Linux amd64 fixture image. The image must provide Node, a fresh empty runner HOME,
UID10001 and `/workspace` containing the benchmark's 55 exact fixtures. The
controller verifies every file hash before a task. It never pulls or builds an
image, downloads an artifact, installs a dependency, or authenticates a provider.
Artifacts must be obtained and their publication/build provenance reviewed first.
`previous.provenance` is a pinned published npm wrapper/platform inspection
manifest containing `npmWrapperVersion`, `publishedPackage.version`, and
`installedPackages.platformPackages` binary version/hash. `current.provenance`
is a pinned completed build manifest with `complete`, `version`, `binarySha256`.
These records bind identity; reviewers still validate their authenticity and the
candidate's source/build relationship.

Input manifest (paths resolve relative to the manifest):

```json
{
  "fixtureImage": "sha256:<64 hex digits>",
  "repeats": 2,
  "current": {
    "path": "current-aictrl",
    "sha256": "<64 hex digits>",
    "version": "<candidate version>",
    "provenance": { "path": "current-build.json", "sha256": "<64 hex digits>" }
  },
  "previous": {
    "path": "previous-aictrl",
    "sha256": "<64 hex digits>",
    "version": "<previous published version>",
    "provenance": { "path": "previous-npm-inspection.json", "sha256": "<64 hex digits>" }
  }
}
```

The same fixture image, read-only binary bind, fresh HOME, UID10001, 2 CPU,
2 GiB memory, permissive tool permissions, non-GPT `fixture/fixture` model and
scripted short task apply to both versions. Host networking permits the loopback
stub; this is not an OS egress sandbox. The controller receives an allowlisted
process environment without provider credentials. No real inference occurs.
`--tools read,bash,edit,write` adds a minimal arm only when the binary's actual
`run --help` advertises `--tools`. Previous releases without it are explicitly
unsupported; permission configuration never substitutes for schema selection.

Each session must contain four ordered model requests, three actual exact
20-line Read results and native Done with exit0. Raw request JSON, raw SSE
responses, stdout, stderr, binary/help/fixture preflight and owned-container
cleanup remain in the new output directory, including failures. The shared
pinned offline `reference.py` counts canonical model-facing fields and all
request input/response output, including repeated history and auxiliary calls.
The comparison records first input, session input/output/total and default
current-minus-previous deltas. These are reference tokens, not provider billing,
cache, quality, reasoning or performance measurements. Review numerical release
deltas explicitly; the release gate does not silently accept an increase or
reuse CI budget thresholds as a cross-version claim.
