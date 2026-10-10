import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionBlockedError,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RelayWebClientId, type RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

import * as UpstreamRemoteAuthorization from "../../../upstream/t3code/packages/client-runtime/src/authorization/service.ts";
import { appendOrchestrationProtocol } from "../../../upstream/t3code/packages/client-runtime/src/connection/compatibility.ts";
import { fetchEnvironmentThreadHistoryPage } from "../../../upstream/t3code/packages/client-runtime/src/state/threadHistoryHttp.ts";
import packageMetadata from "../../../package.json" with { type: "json" };

import type { AuthProvider } from "../auth/provider.ts";
import type { EnvironmentDto } from "../protocol/types.ts";
import { BridgeError, redactText } from "../security/redact.ts";
import type { DpopKeyManager } from "./dpop.ts";

const CLIENT_METADATA = {
  label: "Omarchy T3 Mini",
  deviceType: "desktop" as const,
  os: "linux",
  surface: "desktop" as const,
  appVersion: packageMetadata.version,
};

const OAUTH_DPOP_BLOCKED_MESSAGE =
  "Signed in successfully and loaded environments, but the deployed T3 Relay does not yet accept CLI OAuth at the exchange for a DPoP-bound access credential. Remote access requires upstream T3 PR #7483 (or an equivalent Relay change) to be deployed.";

function relayFailure(
  error: unknown,
  credentialKind: "oauth_token" | "clerk_session",
): BridgeError {
  const value = error as { _tag?: string; relayError?: { reason?: string } };
  if (
    value?._tag === "ManagedRelayRequestFailedError" &&
    value.relayError?.reason === "invalid_bearer"
  ) {
    if (credentialKind === "clerk_session") {
      return new BridgeError(
        "RELAY_AUTH_REJECTED",
        "T3 Connect rejected the Relay session credential. Sign out and sign in again.",
        false,
      );
    }
    return new BridgeError("UPSTREAM_OAUTH_DPOP_UNSUPPORTED", OAUTH_DPOP_BLOCKED_MESSAGE, false);
  }
  return new BridgeError("RELAY_UNAVAILABLE", redactText(error), true);
}

export class T3RelayClient {
  private relay: ManagedRelay.ManagedRelayClient["Service"] | null = null;
  private remote: Promise<
    UpstreamRemoteAuthorization.RemoteEnvironmentAuthorization["Service"]
  > | null = null;
  private scope: Scope.Closeable | null = null;
  private identity: ClientCapabilities.CloudSessionIdentity | null = null;
  private readonly environments = new Map<string, RelayClientEnvironmentRecord>();

  constructor(
    private readonly auth: AuthProvider,
    private readonly keys: DpopKeyManager,
    private readonly relayUrl = "https://relay.t3.codes",
  ) {}

  private async relayClient(): Promise<ManagedRelay.ManagedRelayClient["Service"]> {
    if (this.relay !== null) return this.relay;
    const effect = ManagedRelay.make({ relayUrl: this.relayUrl, clientId: RelayWebClientId }).pipe(
      Effect.provide(this.keys.signerLayer()),
      Effect.provide(FetchHttpClient.layer),
    );
    this.relay = await Effect.runPromise(effect);
    return this.relay;
  }

  private remoteAuthorization(): Promise<
    UpstreamRemoteAuthorization.RemoteEnvironmentAuthorization["Service"]
  > {
    if (this.remote === null) {
      const pending: Promise<
        UpstreamRemoteAuthorization.RemoteEnvironmentAuthorization["Service"]
      > = this.createRemoteAuthorization().catch(async (error: unknown) => {
        if (this.remote === pending) {
          this.remote = null;
          const scope = this.scope;
          this.scope = null;
          if (scope !== null) await Effect.runPromise(Scope.close(scope, Exit.void));
        }
        throw error;
      });
      this.remote = pending;
    }
    return this.remote;
  }

  private async createRemoteAuthorization(): Promise<
    UpstreamRemoteAuthorization.RemoteEnvironmentAuthorization["Service"]
  > {
    const memoryTokens = new Map<string, TokenStore.RemoteDpopAccessToken>();
    const tokenLayer = TokenStore.layer({
      get: (environmentId) => Effect.succeed(Option.fromNullishOr(memoryTokens.get(environmentId))),
      put: (token) => Effect.sync(() => void memoryTokens.set(token.environmentId, token)),
      remove: (environmentId) => Effect.sync(() => void memoryTokens.delete(environmentId)),
    });
    const presentationLayer = Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: CLIENT_METADATA,
      }),
    );
    const cloudLayer = Layer.succeed(ClientCapabilities.CloudSession, {
      identity: Effect.sync(() => {
        const accountId = this.auth.status().identity;
        if (this.auth.status().phase !== "signedIn" || accountId === null) {
          this.identity = null;
          return Option.none();
        }
        if (this.identity?.accountId !== accountId) this.identity = { accountId };
        return Option.some(this.identity);
      }),
      clerkToken: Effect.tryPromise({
        try: async () => (await this.auth.relayCredential()).token,
        catch: () =>
          new ConnectionBlockedError({
            reason: "authentication",
            detail: "T3 Connect sign-in is unavailable. Sign in again.",
          }),
      }),
    });
    const deviceLayer = Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
      deviceId: Effect.succeed(Option.none()),
    });
    const relay = await this.relayClient();
    this.scope = Effect.runSync(Scope.make());
    return Effect.runPromise(
      UpstreamRemoteAuthorization.make.pipe(
        Effect.provide(this.keys.signerLayer()),
        Effect.provide(tokenLayer),
        Effect.provide(presentationLayer),
        Effect.provide(cloudLayer),
        Effect.provide(deviceLayer),
        Effect.provideService(ManagedRelay.ManagedRelayClient, relay),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(Scope.Scope, this.scope),
      ),
    );
  }

  async listEnvironments(): Promise<EnvironmentDto[]> {
    const credential = await this.auth.relayCredential();
    const relay = await this.relayClient();
    let records: ReadonlyArray<RelayClientEnvironmentRecord>;
    try {
      records = await Effect.runPromise(relay.listEnvironments({ clerkToken: credential.token }));
    } catch (error) {
      throw relayFailure(error, credential.kind);
    }
    this.environments.clear();
    for (const entry of records) this.environments.set(entry.environmentId, entry);
    return records.map((entry) => ({
      id: entry.environmentId,
      label: entry.label,
      status: "linked",
      serverVersion: null,
      lastSeenAt: entry.linkedAt,
    }));
  }

  async prepareConnection(environmentId: string): Promise<PreparedConnection> {
    const record = this.environments.get(environmentId);
    if (!record)
      throw new BridgeError("ENVIRONMENT_NOT_FOUND", "Refresh environments and try again.");
    const remote = await this.remoteAuthorization();
    try {
      const authorized = await Effect.runPromise(
        remote.authorizeDpop({ expectedEnvironmentId: EnvironmentId.make(environmentId) }),
      );
      return {
        environmentId: authorized.environmentId,
        label: authorized.label,
        httpBaseUrl: authorized.httpBaseUrl,
        socketUrl: appendOrchestrationProtocol(authorized.socketUrl),
        httpAuthorization: authorized.httpAuthorization,
        target: {
          _tag: "RelayConnectionTarget",
          environmentId: EnvironmentId.make(environmentId),
          label: record.label,
        },
      };
    } catch (error) {
      const detail = redactText(error);
      const blocked = error instanceof ConnectionBlockedError;
      throw new BridgeError("ENVIRONMENT_CONNECT_FAILED", detail, !blocked);
    }
  }
  async loadThreadHistory(prepared: PreparedConnection, threadId: string, cursor: string) {
    const remoteAuthorization = Option.some(await this.remoteAuthorization());
    return Effect.runPromise(Effect.gen(function* () {
      const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
      return yield* fetchEnvironmentThreadHistoryPage({
        prepared, threadId: ThreadId.make(threadId), cursor, signer: Option.some(signer), remoteAuthorization,
      });
    }).pipe(Effect.provide(this.keys.signerLayer()), Effect.provide(FetchHttpClient.layer)));
  }

  async close(): Promise<void> {
    const pending = this.remote;
    this.remote = null;
    await pending?.catch(() => undefined);
    const scope = this.scope;
    this.scope = null;
    this.identity = null;
    if (scope !== null) await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}
