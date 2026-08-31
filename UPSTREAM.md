# T3 Code Nightly compatibility

## Supported revision

The supported upstream is the exact Nightly that passed compatibility review
for this release:

| Field | Value |
|---|---|
| Channel | `nightly` |
| Tag | `v0.0.34-nightly.20260822.1160` |
| Commit | `2c4158f87a1b6a586d0aa5e0338f122cb7887c4f` |
| Published | `2026-08-22T15:18:35Z` |

`t3-upstream.lock.json` is authoritative and `upstream/t3code` must resolve to
the same SHA. Neither builds nor tests use a floating `main` branch.

Initialize that submodule with `git submodule update --init upstream/t3code`,
without `--recursive`. This pinned upstream tree contains an unrelated
`.repos/alchemy-effect/.vendor/alchemy` gitlink but no `.gitmodules` entry for
it; this client neither consumes nor initializes that gitlink.

## Architecture audit

The audit covered the requested areas at that exact revision:

- `packages/contracts`: orchestration read models, commands, relay contracts,
  capabilities, RPC methods, attachments, approvals, and user-input schemas.
- `packages/client-runtime`: managed relay, DPoP authorization, remote token
  exchange, WebSocket tickets, Effect RPC sessions, shell/thread reducers,
  lifecycle helpers, pinned ordering, and reconnect behavior.
- `packages/shared`: Connect OAuth URLs, loopback redirects, OAuth scopes,
  Clerk frontend discovery, DPoP hashes/thumbprints, and relay helpers.
- `apps/web`: Inbox partition/order, thread detail, pending approval/input
  derivation, composer behavior, and thread action menus.
- `apps/mobile`: remote relay/session usage and native-client state patterns.
- `apps/desktop`: desktop hosting and packaged client boundaries.
- `apps/server`: `CliTokenManager` OAuth/PKCE implementation, credential
  refresh/storage, environment RPC and orchestration command handling.
- `infra/relay`: public bearer verification, DPoP token exchange, environment
  discovery/connect, and client-ID policy.
- `docs/internals`: orchestration and connection design notes.

The bridge depends on source workspaces through the root pnpm workspace, then
bundles only reachable modules. The adapter boundary is `bridge/src/t3`. No
upstream source is copied into QML, and the installed package does not contain
the T3 repository.

## Authentication spike and working credential path

The first spike correctly implemented the public CLI flow from
[`connectAuth.ts`](https://github.com/pingdotgg/t3code/blob/2c4158f87a1b6a586d0aa5e0338f122cb7887c4f/packages/shared/src/connectAuth.ts)
and
[`CliTokenManager.ts`](https://github.com/pingdotgg/t3code/blob/2c4158f87a1b6a586d0aa5e0338f122cb7887c4f/apps/server/src/cloud/CliTokenManager.ts#L266):
hosted authorization, S256 PKCE, loopback state validation, token exchange, and
refresh. That token authenticates general Relay client routes because
`verifyRelayClientBearerToken` includes Clerk's `oauth_token` verifier.

The pinned DPoP exchange is narrower. Its
[`exchangeDpopAccessToken`](https://github.com/pingdotgg/t3code/blob/2c4158f87a1b6a586d0aa5e0338f122cb7887c4f/infra/relay/src/http/Api.ts#L697-L721)
handler calls only `verifyClerkBearerToken` and checks the `t3-code-relay`
audience. Consequently, a CLI OAuth token can list environments but receives
`invalid_bearer` before environment bootstrap. Compatibility tests preserve
that source fact and `UPSTREAM_OAUTH_DPOP_UNSUPPORTED` remains the classification
for the non-default CLI provider.

The missing working path was identified in an earlier Omarchy Quickshell
native-Clerk module (historical local experiment at commit `6aa0744`; not this
product). That module creates its own native Clerk session, requests the
`t3-relay` JWT template, and gives the resulting correctly-audienced session
JWT to the existing Relay DPoP exchange. It does not try to make the CLI token
look like a session token.

This client now uses that credential strategy while retaining its own security
and upstream-runtime boundaries:

1. Create a plugin-owned native Clerk client and store its rotating client
   token in Secret Service.
2. Start Google/GitHub sign-in with the public native Clerk API metadata pinned
   by T3 Nightly (`@clerk/electron` 0.0.34 and Clerk JS 6.29.2).
3. Receive T3's allow-listed packaged callback at `t3code://app/`, then forward
   it through a random-secret-authenticated loopback listener. T3 documents
   this production scheme in
   [`docs/internals/t3-connect.md`](https://github.com/pingdotgg/t3code/blob/2c4158f87a1b6a586d0aa5e0338f122cb7887c4f/docs/internals/t3-connect.md#desktop-oauth-redirect-allowlist).
4. Finish the Clerk sign-in with the rotating-token nonce and request
   `/v1/client/sessions/<session>/tokens/t3-relay`.
5. Pass only that short-lived JWT into upstream `ManagedRelay`; upstream code
   continues to own Relay DPoP exchange, environment authorization, WebSocket
   tickets, and Effect RPC.

The hidden freedesktop handler is activated only during sign-in and restores
an existing T3 desktop handler afterward. No session is read from T3 Code's
desktop storage, no pairing fallback exists, and no Relay protocol was copied
from the reference module.

A production-account acceptance run on 2026-08-23 completed this path through
authenticated Effect RPC, loaded the selected environment's Inbox, and
reconnected from the Secret-Service-backed native session after restarting
Omarchy Shell.

Upstream [PR #7483](https://github.com/pingdotgg/t3code/pull/7483) would also
allow the simpler public CLI OAuth credential at the DPoP exchange. It remains
useful, but is no longer required for this client's native-session path.

## Changes that would clean up this client

Any one of these upstream-supported designs could remove the custom native
adapter:

1. Merge and deploy the OAuth-aware DPoP verifier so the existing PKCE loopback
   provider works end to end.
2. Register a dedicated Omarchy/native public OAuth client and loopback
   redirect, then document its permitted Relay scopes.
3. Publish a non-Electron native Clerk adapter or native-client exchange API
   that returns the Relay-audienced session credential.

Additional improvements would reduce internal coupling:

- publish `@t3tools/contracts` and the remote subset of
  `@t3tools/client-runtime` as a versioned SDK;
- export the shell/thread reducers and official Inbox/pending projections from
  stable package entry points;
- publish a generic secure-store-backed Node DPoP signer;
- expose a capability/handshake field declaring supported remote auth token
  kinds and native client IDs;
- provide a documented third-party loopback OAuth registration process.

Two projection APIs would also remove remaining behavioral compromises:

- include the user's effective automatic-settlement preferences (and any PR
  merge state used by the official clients) in the remote shell snapshot; and
- expose an official paginated thread-history helper so compact clients can
  load older turns without importing private runtime modules.

## Checking and updating Nightly

```bash
scripts/check-t3-nightly
scripts/check-t3-nightly --json
scripts/check-t3-nightly --fail-on-update
scripts/update-t3-nightly --dry-run
scripts/update-t3-nightly
```

The check queries published GitHub releases, resolves the latest Nightly tag
to a full commit, compares it with the lock, and reports changed files in
contracts/runtime/shared/client/server/relay internals.

The updater refuses a tracked dirty worktree, fetches and checks out the exact
tag commit in the submodule, rewrites the lock and its documentation references,
installs dependencies, then runs the complete `pnpm check` suite. That includes
repository/pin consistency, type checking, contract compatibility, bridge
tests, QML validation, and the build. A failure leaves the candidate changes
available for diagnosis and clearly reports that nothing was published.
Passing only means the revision is ready for human review; publication remains
manual, including review of native Clerk metadata and source-sensitive adapter
changes.

CI tests the supported pin on every change. `pnpm check:t3-nightly` reports a
newer published candidate without changing the supported revision; the pin is
updated only through the reviewed updater workflow above.
