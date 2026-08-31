import {
  RemoteEnvironmentAuthorization,
  TokenStore,
} from "@t3tools/client-runtime/authorization";
import { ConnectionBlockedError, type PreparedConnection } from "@t3tools/client-runtime/connection";
import { ClientPresentation } from "@t3tools/client-runtime/platform";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  RelayWebClientId,
  type RelayClientEnvironmentRecord,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";

import * as UpstreamRemoteAuthorization from "../../../upstream/t3code/packages/client-runtime/src/authorization/service.ts";
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
  if (value?._tag === "ManagedRelayRequestFailedError" && value.relayError?.reason === "invalid_bearer") {
    if (credentialKind === "clerk_session") {
      return new BridgeError(
        "RELAY_AUTH_REJECTED",
        "T3 Connect rejected the Relay session credential. Sign out and sign in again.",
        false,
      );
    }
    return new BridgeError(
      "UPSTREAM_OAUTH_DPOP_UNSUPPORTED",
      OAUTH_DPOP_BLOCKED_MESSAGE,
      false,
    );
  }
  return new BridgeError("RELAY_UNAVAILABLE", redactText(error), true);
}

export class T3RelayClient {
  private relay: ManagedRelay.ManagedRelayClient["Service"] | null = null;
  private remote: RemoteEnvironmentAuthorization["Service"] | null = null;
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

  private async remoteAuthorization(): Promise<RemoteEnvironmentAuthorization["Service"]> {
    if (this.remote !== null) return this.remote;
    const memoryTokens = new Map<string, TokenStore.RemoteDpopAccessToken>();
    const tokenLayer = TokenStore.layer({
      get: (environmentId) => Effect.succeed(Option.fromNullishOr(memoryTokens.get(environmentId))),
      put: (token) => Effect.sync(() => void memoryTokens.set(token.environmentId, token)),
      remove: (environmentId) => Effect.sync(() => void memoryTokens.delete(environmentId)),
    });
    const presentationLayer = Layer.succeed(
      ClientPresentation,
      ClientPresentation.of({
        metadata: CLIENT_METADATA,
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      }),
    );
    this.remote = await Effect.runPromise(
      UpstreamRemoteAuthorization.make.pipe(
        Effect.provide(this.keys.signerLayer()),
        Effect.provide(tokenLayer),
        Effect.provide(presentationLayer),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    return this.remote;
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
    const credential = await this.auth.relayCredential();
    const record = this.environments.get(environmentId);
    if (!record) throw new BridgeError("ENVIRONMENT_NOT_FOUND", "Refresh environments and try again.");
    const relay = await this.relayClient();
    const remote = await this.remoteAuthorization();
    let terminalAuthError: BridgeError | null = null;
    try {
      const authorized = await Effect.runPromise(
        remote.authorizeDpop({
          expectedEnvironmentId: EnvironmentId.make(environmentId),
          obtainBootstrap: relay
            .connectEnvironment({
              clerkToken: credential.token,
              scopes: [RelayEnvironmentConnectScope],
              environmentId: EnvironmentId.make(environmentId),
            })
            .pipe(
              Effect.mapError(
                (error) => {
                  const mapped = relayFailure(error, credential.kind);
                  if (!mapped.retryable) terminalAuthError = mapped;
                  return new ConnectionBlockedError({
                    reason: "authentication",
                    detail: mapped.message,
                  });
                },
              ),
            ),
        }),
      );
      return {
        environmentId: authorized.environmentId,
        label: authorized.label,
        httpBaseUrl: authorized.httpBaseUrl,
        socketUrl: authorized.socketUrl,
        httpAuthorization: authorized.httpAuthorization,
        target: {
          _tag: "RelayConnectionTarget",
          environmentId: EnvironmentId.make(environmentId),
          label: record.label,
        },
      } as PreparedConnection;
    } catch (error) {
      const detail = redactText(error);
      if (terminalAuthError !== null) throw terminalAuthError;
      throw new BridgeError("ENVIRONMENT_CONNECT_FAILED", detail, true);
    }
  }
}
