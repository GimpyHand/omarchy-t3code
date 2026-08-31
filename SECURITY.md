# Security

## Trust boundaries

Omarchy plugins execute unsandboxed QML inside the long-lived shell process.
Treat the installed plugin and bridge binary as trusted local code. T3 thread
content, remote errors, and environment metadata are untrusted data.

The QML/bridge boundary is an inherited pair of pipes. No Unix/TCP/WebSocket
listener is created for local IPC, and no LAN interface can receive bridge
commands. Any code already executing inside the shell can write to the child
process and therefore shares the shell's trust level.

## Credentials and DPoP

- The plugin-owned native Clerk client token is stored with the desktop Secret
  Service via `secret-tool`; values are passed on stdin, never process
  arguments. Short-lived `t3-relay` template JWTs are kept in bridge memory.
- The pending loopback port and a random 256-bit callback secret are stored in
  Secret Service only for the active browser login window.
- The P-256 DPoP private JWK is also stored in Secret Service. Only its public
  JWK and thumbprint enter proofs.
- Credentials, proofs, WebSocket tickets, authorization headers, and raw T3
  objects never enter QML or local protocol payloads.
- The only filesystem state is the selected environment preference. Its
  directory is created as `0700`, its temporary file as `0600`, and replacement
  is atomic.
- Logout disconnects first and removes native Clerk credentials (and any
  residual `t3-connect-oauth` Secret Service item). The DPoP device key remains
  stable, matching T3 client behavior; remove the Secret Service item
  `relay-dpop-proof-key` to rotate it deliberately.

## Browser authentication

The production provider uses T3's native Clerk path, the same credential class
as its packaged desktop client. Clerk owns the provider OAuth transaction. The
bridge creates its own Clerk client and never reads another T3 application's
session. T3 explicitly allow-lists `t3code://app/` for packaged native clients;
the plugin uses that callback only as a handoff into a local listener.

The callback boundary:

- binds an ephemeral port on literal `127.0.0.1`;
- generates a 32-byte random callback secret and stores it in Secret Service;
- accepts the callback only through an authenticated local `POST` from the
  packaged desktop handler;
- validates the exact `t3code://app/` origin, Clerk failure state, and non-empty
  rotating-token nonce;
- has a ten-minute timeout and closes in every completion/failure path;
- serves the provider chooser with `Cache-Control: no-store`, a restrictive
  CSP, and no-sniff headers;
- activates the hidden URI handler immediately before browser launch and
  restores any previous T3 scheme owner afterward;
- creates the hidden desktop entry only for that login window and removes it
  after owner restoration succeeds;
- uses no pairing code, clipboard code, out-of-band code, or plaintext callback
  state.

## Input, output, and logging

NDJSON requests are size-limited and structurally validated before dispatch.
IDs, dates, modes, decisions, and prompt limits are checked. Upstream commands
are decoded again with the pinned `ClientOrchestrationCommand` schema before
Effect RPC dispatch.

Pasted screenshots are read from `wl-paste` with a timeout and the pinned T3
10 MB limit. Their bytes remain in bridge memory under random, thread-bound
IDs until sent, removed, expired, or shutdown; they are never written to a
temporary file or log. QML receives only the attachment metadata and data-URL
preview needed to present the draft.

Bridge errors are reduced to code/message/retryability. Redaction removes JWTs,
Bearer/DPoP headers, and sensitive-key values. stderr presented to QML is a
generic internal-error notice. Production tokens and credentials are not used
in automated tests.

Assistant Markdown neutralizes every Markdown image form and escapes raw HTML
before rendering, which prevents thread content from causing automatic external
resource requests. Links open only after an explicit click and only for
`https`, `http`, or `mailto` URLs; local files, custom schemes, data URLs, and
script URLs are rejected.

## Supply chain and packaging

The T3 source is a Git submodule pinned to a full commit and the release tag is
separately locked. pnpm's lockfile and the exact upstream Effect patch make
builds repeatable. Packaged artifacts include the T3 notice, the exact Node
runtime notice, and all dependency notices discovered from the bundle source
map; they exclude the upstream repository, source maps, tests, credentials,
and development files.

The standalone executable is derived from the pinned source with the official
Linux x64 Node version in `.node-version`, pnpm from `packageManager`, the
locked dependency graph, and repository-relative SEA input paths. CI performs
a fresh build, decompresses the tracked marketplace payload without executing
it, and fails unless the two executables are byte-for-byte identical and share
the tracked SHA-256. The embedded self-test remains a functional version/pin
check; it is not used as the provenance proof.

The root marketplace plugin carries that x86-64 executable as a compressed
local payload. Its launcher verifies the CI-bound uncompressed checksum before
atomically placing an executable under the checkout's ignored, owner-written
`lib/.runtime/` directory. It downloads nothing and requests no elevated
privileges. The repository and release package both carry the Node, T3, and
bundled dependency license inventory. Archive metadata and gzip headers are
normalized for reproducibility. Verify release checksums when distributing
binaries.

## Relay credential boundary

The public CLI OAuth token is not accepted by the deployed Relay's DPoP-token
exchange at the pinned Nightly. The production provider therefore asks Clerk
for the official `t3-relay` session JWT accepted by that endpoint. It does not
substitute token types, scrape or steal another client's session, or fall back
to pairing. CLI OAuth failures remain separately classified as
`UPSTREAM_OAUTH_DPOP_UNSUPPORTED`; native-session rejection is treated as a
fresh-login error. See [UPSTREAM.md](UPSTREAM.md) for exact source evidence.

## Reporting

Report suspected vulnerabilities privately through the repository's
[GitHub Security Advisories](https://github.com/GimpyHand/omarchy-t3code/security/advisories/new).
Do not open a public issue first. Do not include tokens, callback URLs containing
authorization codes, Secret Service output, or DPoP private JWKs. Include the
lock-file tag and commit, bridge error code, Omarchy version, and sanitized
reproduction steps.

To completely remove the local trust material, run `uninstall` from the
installed marketplace checkout, the packaged `./uninstall`, or
`pnpm uninstall:plugin` from a source checkout. `--keep-secrets` is available
only when deliberately preserving the native session and DPoP identity for a
later reinstall.
