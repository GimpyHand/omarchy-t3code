# Releasing

1. Run `pnpm check:t3-nightly`. If adopting a candidate, use
   `scripts/update-t3-nightly`, inspect the pinned source and all compatibility
   changes, and obtain human approval of both the lock and submodule SHA.
2. Update `CHANGELOG.md`. Set the same semantic version in `package.json`,
   `bridge/package.json`, and root `manifest.json`; `pnpm validate:repo`
   enforces consistency.
3. Use the official Linux x64 Node version pinned in `.node-version` and pnpm
   from `packageManager`. Run `pnpm install --frozen-lockfile`, `pnpm package`,
   then `pnpm bundle:marketplace` to refresh and byte-verify the root compressed
   runtime. Copy the newly generated `dist/plugin/licenses` inventory to root
   `licenses`, inspect both changes, and rerun `pnpm check`, `pnpm package`, and
   `pnpm verify:marketplace-runtime`.
4. Verify the root contains exactly one `manifest.json`, no tracked symlinks,
   a valid `preview.png`, README install/removal instructions, the full license
   inventory, and a tracked runtime that byte-matches the fresh pinned source
   build. Treat `bin/t3-mini-bridge --self-test` only as a functional metadata
   check for the release version and pinned T3 commit. Validate a clean Git
   checkout with `omarchy plugin validate` and test `omarchy plugin add`, update, login,
   disable/re-enable, shell restart, and complete uninstall.
5. Verify `dist/omarchy-t3code-plugin.tar.gz.sha256`, inspect archive ownership
   and contents, install into temporary XDG roots, and execute the complete
   [acceptance checklist](docs/ACCEPTANCE.md).
6. Run the current Omarchy Marketplace submission validator and automated
   security baseline against the exact public commit. New listings require the
   repository owner to approve the marketplace issue checklist and preview
   asset rights before submission.
7. Commit the reviewed tree, tag it as `v<version>`, and push the tag. The
   release workflow rebuilds on Node 24, validates the standalone executable,
   and attaches the Linux x64 archive and checksum to the GitHub release.

No release workflow may update the T3 pin automatically or receive a real T3
credential.
