# Changelog

All notable user-visible changes are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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
- Exact T3 Nightly compatibility pin, standalone Linux packaging, license
  inventory, checksummed marketplace runtime, installer, and uninstaller
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

- T3 Code Nightly `v0.0.34-nightly.20260822.1160`
  (`2c4158f87a1b6a586d0aa5e0338f122cb7887c4f`).
- Omarchy 4.0+ (x86-64) with Quickshell plugins and Secret Service.

[1.0.0]: https://github.com/GimpyHand/omarchy-t3code/releases/tag/v1.0.0
