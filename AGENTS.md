# Instructions for coding agents

These are repository invariants, not suggestions.

## Upstream and protocol

- Treat `t3-upstream.lock.json` plus the `upstream/t3code` submodule SHA as the
  only supported T3 revision. Never change one without the other.
- Inspect the pinned source before changing integration behavior. Do not infer
  contracts, RPC methods, lifecycle rules, or authentication from memory.
- Reuse `@t3tools/contracts`, `@t3tools/client-runtime`, and
  `@t3tools/shared`. Do not reimplement Effect RPC, relay discovery,
  WebSocket-ticket logic, DPoP semantics, shell/thread reducers, or lifecycle
  rules when pinned upstream code exists.
- Keep all direct T3-internal dependencies under `bridge/src/t3` (auth may use
  upstream Connect helpers). The rest of the project consumes our protocol
  DTOs and adapter APIs.
- QML must never depend on raw T3 RPC names or objects. Update the versioned
  local protocol and validation together when adding an operation.

## Authentication and security

- The default UX is T3's native Clerk browser sign-in + a loopback callback
  handoff + automatic `auth.completed` panel summon. It obtains the official
  `t3-relay` JWT template; never regress the default to the CLI OAuth token,
  copy/paste, pairing codes, or an out-of-band flow.
- T3 explicitly allow-lists packaged desktop callbacks at `t3code://app/`.
  Register this plugin's hidden handler only for the login window, forward the
  callback to literal loopback with a random Secret-Service-backed secret, and
  restore any previous scheme owner afterward.
- Validate the Clerk rotating-token nonce, close the loopback listener on
  every path, and keep native client tokens, callback values, Relay JWTs, and
  DPoP keys out of QML and logs.
- Use Secret Service for the Clerk client token, pending callback secret, and
  DPoP private material. Do not add plaintext credential fallback files or
  reuse/scrape another T3 client's session.
- The pinned public CLI OAuth token is still rejected by the relay DPoP-token
  exchange. Preserve `UPSTREAM_OAUTH_DPOP_UNSUPPORTED` for that non-default
  provider kind, while routing native Clerk session JWT failures separately.
  Update the source-evidence compatibility test if upstream changes.
- Keep local IPC on inherited stdin/stdout unless a verified Quickshell change
  makes it unreliable. Any network replacement must be loopback-only and use a
  random per-launch secret.

## State and UI

- The server is the source of truth. Settlement, snooze, pin, title, session,
  approval, and input state must come from T3 projections and commands—not
  parallel QML flags.
- Gate optional operations with advertised capabilities and enforce the gate
  again in the bridge.
- `Service.qml` owns the one persistent child process and cross-panel state.
  View QML handles presentation and user actions only.
- Keep Inbox as the authenticated home. Preserve automatic Inbox navigation on
  `auth.completed` and reconnect/resubscribe behavior for an open thread.
- This is a mini client. Do not add a terminal emulator, editor, file browser,
  full Git/diff UI, or embed T3's web app without an explicit scope change.

## Verification and updates

- Run `pnpm check` after behavior changes. Run `pnpm package` for packaging or
  bridge-entry changes.
- Add/adjust tests for protocol validation, actual pinned contract decoding,
  lifecycle mapping, streaming, reconnect, and QML state when those areas
  change.
- Use `scripts/update-t3-nightly`; do not point dependencies at a floating
  branch. A newer Nightly becomes supported only after the compatibility suite
  passes and a human reviews the pin change.
- Preserve T3's MIT notice and `THIRD_PARTY_NOTICES.md` in packaged artifacts.
