# Contributing

Thank you for improving Omarchy T3 Command Center. Read [AGENTS.md](AGENTS.md)
before changing code: its upstream, authentication, protocol, state,
and verification rules are repository invariants for human and automated
contributors alike.

## Development setup

```bash
git clone https://github.com/GimpyHand/omarchy-t3code.git
cd omarchy-t3code
node scripts/sync-t3.mjs
pnpm install
pnpm check
```

The T3 source clone is ignored by Git. Keep direct T3 integration code under
`bridge/src/t3`, keep credentials out of QML and logs, and update the local
protocol decoder and tests together when extending the QML/bridge boundary.

Behavior changes need focused tests plus `pnpm check`. Packaging, bridge-entry,
installer, or release-layout changes also need `pnpm package` and inspection of
the generated archive. Real-account testing follows
[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md); never place production credentials in
tests, issues, or fixtures.

`pnpm package` builds and self-tests the standalone bridge, then writes
`dist/plugin` and `dist/omarchy-t3code-plugin.tar.gz`. To install that result
from a source checkout on Omarchy, run `pnpm deploy:plugin`. The deploy script
atomically replaces the plugin, rescans the shell, enables the widget on first
install, preserves its position on updates, and retains at most one rollback
copy under the registry-ignored `.backups/` directory.

## Marketplace runtime provenance

The marketplace executable must be produced on Linux x64. `.node-version`
follows the latest Node release. `lib/runtime-build.json` records the source
commit, SDK versions, and Node builder used for the shipped payload.
`scripts/package.mjs` uses repository-relative SEA input
paths so checkout location does not affect the executable. After a source
build, `pnpm verify:marketplace-runtime` decompresses the tracked payload
without executing it and fails unless it byte-matches `dist/t3-mini-bridge`
and both share the tracked SHA-256.

To deliberately refresh the payload, use the current Node builder and run:

```bash
pnpm package
pnpm bundle:marketplace
```

Review the binary, checksum, build record, and licenses together. CI checks
current T3 main with latest Node and separately reproduces the recorded payload
with `node scripts/sync-t3.mjs --build-record` and its recorded Node builder;
the executable self-test is only a functional metadata check, not the
provenance proof.

## Upstream updates

Run `pnpm sync:t3` and `pnpm install` to fetch current main and align Effect
versions and patches with upstream. Inspect contract/runtime changes and run
`pnpm check` before packaging. Clerk SDK metadata comes from the source catalog.
There is no supported-release pin; the compatibility suite detects API drift.

For security problems, use the private channel in [SECURITY.md](SECURITY.md).
