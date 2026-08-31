# Changelog

All notable user-visible changes are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-08-31

Initial public release of **T3 Command Center** by Bralyx Digital — an
independent Omarchy/Quickshell mini client for T3 Code. Derived from earlier
omarchy-t3code work; this repository, plugin id, and product identity are
standalone.

### Added

- Native Clerk browser sign-in with secret-authenticated callback handoff and
  automatic Inbox summon on `auth.completed`.
- Merged Inbox across linked T3 systems, with system and cross-system project
  filters (git repository identity, title fallback).
- Streamed threads, lifecycle commands, model/runtime controls, approvals,
  user input, screenshot attachments, and changed-file summaries in an Omarchy
  bar modal.
- Bar status color dot (offline / ready / working / attention) beside the T3
  mark.
- Exact T3 Nightly compatibility pin, standalone Linux packaging, license
  inventory, checksummed marketplace runtime, installer, and uninstaller with
  legacy-id migration.

### Changed

- Product branding to T3 Command Center; plugin id
  `bralyx.t3code`.
- Create-form label vs value contrast; phase labels aligned with popup text
  color; richer thread metadata chips (system, project, branch, model, time).
- Removed unused CLI loopback OAuth provider; native Clerk remains the only
  auth path (`UPSTREAM_OAUTH_DPOP_UNSUPPORTED` kept for Relay classification).
- Thread composer model list filtered to the open thread's system.
- Packaged plugin includes `uninstall` so archive installs match the README
  path.

### Security

- Assistant Markdown image and raw-HTML neutralization with an external-link
  scheme allowlist.
- Secret-Service-backed client, callback, and DPoP material; inherited-pipe
  IPC; ordered requests; and non-replaying bridge restart behavior.
- Desktop callback registration limited to the active login window, then
  restored/cleared afterward.

[0.1.0]: https://github.com/GimpyHand/omarchy-t3code/releases/tag/v0.1.0
