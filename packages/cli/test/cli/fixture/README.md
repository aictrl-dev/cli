# Command and stdin fixture controls

`stdin-guard.ts` observes `globalThis.fetch` in the preloaded CLI process. It logs
those calls and rejects origins other than the owned loopback fixture. It also
rejects `fetch.preconnect` and direct `Bun.spawn` calls whose first executable is
`bun` and whose next argument is exactly `install` or `add`.

These are partial observations, not complete network or installation accounting.
The ledger does not cover other network APIs, `Bun.spawnSync`, Node child-process
APIs, package-manager aliases, or programs launched through a shell. A clean
ledger proves only that the instrumented paths reported no rejected operation.
The fixtures use inert trusted commands and explicit child environments without
provider credentials. They are not an OS network sandbox and do not establish
safe execution of arbitrary code.

The command and stdin harnesses stop their owned listeners and child process
groups on success and failure, including failures during fixture-file setup.
They remove only their own `mkdtemp` directory after reading final observations
and checking results. Set `COMMAND_ARGUMENTS_EVIDENCE` or `STDIN_TEST_EVIDENCE`
for the respective harness to retain its raw directory as well as the requested
JSON evidence. Cleanup failures are reported separately; an existing setup or
capture error remains the primary error. A cleanup failure after an otherwise
successful run rejects the fixture.

Attached command tests demonstrate the client's wire shape against an owned
stub, not compatibility with an HTTP receiver. The structured-argument receiver
and release-coordination gate remain open as described in the root README.
