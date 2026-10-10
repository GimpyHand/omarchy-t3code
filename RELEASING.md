# Releasing

1. Run `pnpm sync:t3`, `pnpm install`, and `pnpm check`. Inspect upstream API
   changes and complete [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) using a non-critical
   account thread. Never give CI production credentials.
2. Update the root package, bridge package, and manifest versions together,
   and describe user-facing changes in `CHANGELOG.md`.
3. On Linux x64 with current Node and pnpm, run `pnpm package` and
   `pnpm bundle:marketplace`. Commit the runtime, checksum, build record,
   lockfile, and license inventory together. Check a clean marketplace tree
   with `omarchy plugin validate`.
4. Push the release commit through the repository's normal review process.
   Tagging `v<version>` triggers the release workflow, which reproduces the
   tagged payload's source and Node builder, verifies its archive, and publishes
   it to GitHub Releases.

Development tracks main without a supported-release pin. Marketplace CI
reproduces the recorded artifact separately from current-main compatibility.
Release packaging reproduces the tagged artifact and includes its build record
inside the archive. A source API break must be fixed before preparing a release.
