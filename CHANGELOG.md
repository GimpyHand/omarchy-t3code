# Changelog

All notable user-visible changes are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-09-01

### Security

- Re-bound shell/thread state after every stream reducer event, not only initial
  snapshots; strip unbounded activity payloads and nested retained fields.
- Select newest shell rows without sorting unbounded remote arrays; cap NDJSON
  line length at the bridge launcher before Quickshell parses stdout.

## [1.0.1] - 2026-09-01

### Security

- Enforce application-level caps on retained T3 shell/thread snapshots and on
  bridge ↔ QML NDJSON payloads so hostile or oversized remote data cannot
  exhaust bridge or Quickshell memory.

## [1.0.0] - 2026-08-31

First public release of **T3 Command Center** by Bralyx Digital — a compact
Omarchy/Quickshell mini client for T3 Code. Plugin id: `bralyx.t3code`.

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
- Exact T3 protocol integration, standalone Linux packaging, license
  inventory, checksummed marketplace runtime, deploy scripts, and uninstaller
  (including `uninstall` inside the packaged plugin tree).

### Security

- Assistant Markdown image and raw-HTML neutralization with an external-link
  scheme allowlist.
- Secret-Service-backed client, callback, and DPoP material; inherited-pipe
  IPC; ordered requests; and non-replaying bridge restart behavior.
- Desktop callback registration limited to the active login window, then
  restored/cleared afterward.
- Native Clerk is the only auth path; CLI OAuth is not used (`UPSTREAM_OAUTH_DPOP_UNSUPPORTED`
  retained for Relay classification only).

### Compatibility

- Works with linked T3 environments over Relay; no specific local T3 desktop
  app version is required. Feature gates follow each environment's advertised
  capabilities.
- Omarchy 4.0+ (x86-64) with Quickshell plugins and Secret Service.

[1.0.0]: https://github.com/GimpyHand/omarchy-t3code/releases/tag/v1.0.0
