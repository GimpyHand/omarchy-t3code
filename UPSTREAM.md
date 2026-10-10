# T3 orchestration V2 integration

This integration follows [T3 Code main](https://github.com/pingdotgg/t3code).
Run `pnpm sync:t3` and `pnpm install` to refresh the ignored source checkout.
Effect versions and patches follow that source catalog; Clerk SDK metadata is
read at build time. No supported-release lock or submodule pin is required.

`lib/runtime-build.json` identifies the source and Node builder of the shipped
marketplace payload. `--build-record` reproduces that historical artifact only.
CI checks current main separately, so the artifact record does not constrain
which source revisions can be built.

The bridge consumes upstream contracts, Effect RPC, relay authorization, DPoP,
and the V2 shell and thread projection reducers. QML receives the plugin's
validated DTOs and keeps the existing inbox and chat interface.

## API changes

- New threads use the atomic `orchestration.launchThread` operation.
- Messages use `message.dispatch`; screenshots are persisted through the
  asset API before their references are sent.
- Approvals and questions use `runtime-request.respond`.
- Stop targets a V2 run. Model selection and thread metadata have distinct
  command types.
- Settlement is server-owned. Snooze and pin precedence follow upstream's
  presentation helpers.
- Bounded thread snapshots retain their history watermark when applying live
  events. Replayed sequences are ignored; retained snapshots and IPC remain
  bounded.

## Authentication and runtime

Native Clerk browser sign-in still obtains the official `t3-relay` JWT through
a temporary, secret-authenticated desktop callback handler. The relay's DPoP
exchange continues to require that session JWT, rather than a CLI OAuth token.
Credentials and DPoP key material remain in Secret Service.

The V2 runtime uses Effect 4 and upstream's matching patches, including its RPC
ping-timeout support. Authorization services own a closeable scope that is
released on disconnect and retried if construction fails.

## Validation

Run `pnpm check`, `pnpm package`, and `pnpm bundle:marketplace` after updating
the source. The compatibility suite decodes the actual upstream contracts and
covers V2 lifecycle state, commands, streaming, requests, screenshots, and
retained-state bounds. Complete account testing follows
[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).
