# Architecture

## System boundary

```text
Omarchy / Quickshell
  BarWidget.qml ─┐
  Panel + views ─┼─ persistent stdin/stdout NDJSON (protocol v1)
  Service.qml ───┘
                         │
                  t3-mini-bridge
                  ├─ native Clerk auth + Secret Service
                  ├─ custom-scheme → loopback callback handoff
                  ├─ relay + persistent DPoP key
                  ├─ remote environment authorization
                  ├─ upstream Effect RPC session
                  └─ upstream shell/thread reducers
                         │
                  T3 Connect / environment
```

QML is a presentation client. It has no Clerk/OAuth token, DPoP key, relay
credential, WebSocket ticket, T3 RPC client, or raw upstream object. All T3
internals are isolated beneath `bridge/src/t3`; other bridge code speaks the
local protocol types in `bridge/src/protocol`.

## Omarchy audit and plugin lifecycle

The implementation was checked against Omarchy `4.0.0-1` (upstream tag
`v4.0.0`, commit `f0020448ca87329199de7cb12f2015ebc4a3e5e7`) and Quickshell
`0.3.0`, revision `28771c7c74b42e20afca0b1b63980cb46515537c`.

The current manifest schema is version 1. The plugin declares `service` and
`bar-widget` entry points with `keepLoaded: true`:

- `Service.qml` is the singleton background state and owns one persistent
  bridge process.
- `BarWidget.qml` obtains the service through `shell.serviceFor(pluginId)`,
  shows connection plus attention state, and owns the native Omarchy
  `KeyboardPanel` modal.
- `Panel.qml` is modal content only and loads Login, Inbox, or Thread views. It
  does not create a top-level window.

Omarchy's plugin host exposes `shell.summon(id, payloadJson)`. On
`auth.completed`, the background service first emits the state transition and
then calls it with `{ "route": "inbox" }`. Omarchy routes that summon to the
bar-owned modal, so the browser flow returns to a visible Inbox even if the
user closed it while authenticating.

## Local protocol

Quickshell's current `Process` type provides `stdinEnabled`, `write()`, and a
persistent `SplitParser` for stdout. That made inherited stdin/stdout NDJSON
the smallest and safest IPC: no socket path, listening port, or local auth
secret is necessary.

Requests have:

```json
{"protocolVersion":1,"requestId":"qml-…","type":"thread.settle","payload":{"threadId":"…"}}
```

Responses echo `requestId`; events carry `event` and a typed payload. Requests
are handled sequentially, preserving the order of state mutations followed by
sends. Input is limited to 1 MiB, operation payloads are validated, unknown versions and
commands are rejected, and malformed lines produce an error response instead
of terminating either process.

The stable command surface covers auth, environments, Inbox, open/create/send,
interrupt, model/model-option/runtime/interaction modes, settle, snooze, pin, rename,
approvals, user input, and clipboard screenshot staging. Screenshot bytes stay
in bridge memory under random, thread-bound attachment IDs; QML receives a
data-URL preview and sends only those IDs back with the turn. The T3 adapter
resolves them to the pinned upload contract immediately before dispatch and
consumes them only after a successful command. QML never references an upstream
RPC method name.

## Authentication and connection

`NativeClerkProvider` follows the working native desktop credential path:

1. Initialize a private native Clerk client against `clerk.t3.codes`; persist
   its rotating client token in Secret Service.
2. Bind an ephemeral listener to literal `127.0.0.1`, create a 256-bit callback
   secret, and place that secret plus the port in Secret Service.
3. Create a hidden callback entry for T3's allow-listed `t3code://app/` scheme
   and temporarily register it, preserving any previous desktop owner.
4. Open a local no-store login page. Google/GitHub selection creates Clerk's
   native OAuth sign-in and redirects the browser to the provider.
5. The hidden desktop handler passes the resulting custom URI to a short-lived
   bridge invocation, which validates the URI and forwards it to loopback with
   the callback secret.
6. Validate Clerk's rotating-token nonce, finish the native sign-in, close the
   listener, clear callback state, restore the previous URI handler, and remove
   the temporary desktop entry.
7. Request the `t3-relay` JWT template for the active Clerk session. That
   correctly-audienced JWT enters upstream `ManagedRelay`, which performs Relay
   DPoP exchange, environment bootstrap, environment DPoP exchange, WebSocket
   ticketing, and Effect RPC.
8. Emit `auth.completed` and summon Inbox automatically.

This is not credential scraping: the plugin creates and owns its own Clerk
client. The previous CLI PKCE provider remains isolated behind `AuthProvider`
for compatibility evidence, but it is not the production default because the
deployed Relay does not accept CLI OAuth at the DPoP exchange.

## Upstream runtime reuse

The root pnpm workspace includes exactly the pinned source workspaces for
`@t3tools/contracts`, `@t3tools/client-runtime`, and `@t3tools/shared`. esbuild
bundles their used dependency graph into the bridge.

Directly reused behavior includes:

- Clerk frontend discovery and the public T3 Connect configuration.
- DPoP proof construction, access-token hashing, and JWK thumbprints.
- `ManagedRelay` and remote authorization flows.
- `RpcSessionFactory`, Effect WebSocket transport, method contracts, and
  command schemas.
- shell and thread stream reducers.
- settlement/snooze eligibility and effective lifecycle helpers.
- pinned-order sorting and contract decoders.

Pending approval and input derivation is a small, behavior-matched adapter to
the pinned web client's `session-logic.ts`. That app-private module cannot be
consumed directly under NodeNext without pulling in the web build's resolver;
compatibility tests cover the adapter's event shapes and ordering. Bundled
upstream code remains MIT-licensed and notices ship with the plugin.

## State and synchronization

The server is authoritative. The bridge subscribes to the shell projection,
reduces updates with upstream reducers, then sends a bounded DTO to QML. Inbox
partition order matches the official web client: effective snooze, pin,
effective settle, then active. Pinned keys, static active creation order,
soonest snooze wake, and settlement timestamps use upstream behavior.

Opening a thread starts the upstream detail stream. QML considers a subscription
active only after its first matching server snapshot. Complete snapshots keep
QML recoverable; delta/completion events reduce perceived latency. Pending
approvals and questions are re-derived after every activity update. A dropped
connection or unexpectedly completed shell/thread stream reconnects with
bounded exponential backoff and re-subscribes the previously open thread after
the shell snapshot returns. Writes queued for a bridge process are failed and
discarded if that process exits, so mutations are never replayed into a
replacement process without user intent.

Every lifecycle control is capability-gated for presentation and checked again
in the bridge before dispatch. No settle, snooze, or pin is represented by a
local flag.

## Packaging

The public repository root is itself the single supported Omarchy plugin:
`manifest.json` maps directly to `qml/Service.qml` and `qml/BarWidget.qml`.
That is the layout cloned and validated by `omarchy plugin add`; there is no
nested or second manifest and no symlink in the tracked tree. Development
sources can coexist at the root because Omarchy loads only advertised entry
points.

esbuild produces ESM and CommonJS bridge bundles. `scripts/package.mjs` uses
Node's current single-executable support (or the legacy postject path on Node
24), with repository-relative SEA input paths. It runs an embedded self-test
and copies only the plugin, bundled bridge, documentation, and license notices.
Archive entries are sorted and normalized to epoch timestamps, numeric root
ownership, and deterministic gzip headers. The T3 source submodule is a build
input, not part of the installed plugin.

The root marketplace layout stores the x86-64 executable as a compressed,
checksum-bound local payload. CI rebuilds it with the `.node-version`-pinned
official Linux x64 Node distribution and fails unless the tracked decompressed
payload byte-matches the fresh source build. The launcher expands it atomically
inside the plugin checkout on first use and replaces it when a future payload
checksum changes. Release packages instead carry the executable directly and
retain the ESM bundle only as a diagnostic fallback when a compatible `node`
is already available. The service owns process startup, restart, SIGTERM shutdown, and
therefore leaves no separately managed daemon or systemd unit. The bridge
creates its hidden freedesktop callback entry only for sign-in and restores an
existing `t3code` scheme owner before removing it. The archive includes
matching install and uninstall entry points; installation keeps at most one
rollback copy.
