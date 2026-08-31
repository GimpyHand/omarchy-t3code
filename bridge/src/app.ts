import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";

import { NativeClerkProvider } from "./auth/nativeProvider.ts";
import { ConnectionCoordinator } from "./connection/coordinator.ts";
import { NdjsonChannel, type NdjsonHandler } from "./ipc/ndjson.ts";
import { event, failure, success } from "./protocol/output.ts";
import { PROTOCOL_VERSION, type BridgeRequest } from "./protocol/types.ts";
import { asBridgeError, BridgeError } from "./security/redact.ts";
import { MemorySecretStore, SecretServiceStore } from "./security/secretStore.ts";
import { T3Commands } from "./t3/commands.ts";
import { DpopKeyManager } from "./t3/dpop.ts";
import { T3RelayClient } from "./t3/relay.ts";
import { T3EnvironmentSession } from "./t3/session.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import upstreamLock from "../../t3-upstream.lock.json" with { type: "json" };

const UPSTREAM = upstreamLock;

export class BridgeApp implements NdjsonHandler {
  readonly channel: NdjsonChannel;
  private readonly auth: NativeClerkProvider;
  private readonly connection: ConnectionCoordinator;
  private readonly commands: T3Commands;
  private login: Promise<void> | null = null;
  private shuttingDown = false;

  constructor() {
    this.channel = new NdjsonChannel(this);
    const secrets = process.env.NODE_ENV === "test" && process.env.T3_MINI_TEST_MEMORY_SECRETS === "1"
      ? new MemorySecretStore()
      : new SecretServiceStore();
    const configuredClerkUrl = process.env.T3CODE_CLERK_URL
      ?? (process.env.T3CODE_CLERK_PUBLISHABLE_KEY
        ? clerkFrontendApiUrlFromPublishableKey(process.env.T3CODE_CLERK_PUBLISHABLE_KEY)
        : undefined);
    this.auth = new NativeClerkProvider({
      store: secrets,
      config: {
        ...(configuredClerkUrl ? { clerkUrl: configuredClerkUrl } : {}),
        ...(process.env.T3CODE_CLERK_JWT_TEMPLATE
          ? { jwtTemplate: process.env.T3CODE_CLERK_JWT_TEMPLATE }
          : {}),
      },
      onStatus: (status) => this.emit("auth.changed", status),
    });
    const keys = new DpopKeyManager(secrets);
    const relay = new T3RelayClient(
      this.auth,
      keys,
      process.env.T3CODE_RELAY_URL || "https://relay.t3.codes",
    );
    let coordinator!: ConnectionCoordinator;
    coordinator = new ConnectionCoordinator(
      this.auth,
      relay,
      (hooks) => new T3EnvironmentSession(hooks),
      {
        onThread: (thread) => this.emit("thread.snapshot", thread),
        onMessageDelta: (payload) => this.emit("message.delta", payload),
        onMessageCompleted: (payload) => this.emit("message.completed", payload),
        onApproval: (payload) => this.emit("approval.requested", payload),
        onInput: (payload) => this.emit("input.requested", payload),
      },
      {
        onConnection: (status) => this.emit("connection.changed", status),
        onEnvironment: (payload) => this.emit("environment.changed", payload),
        onInbox: (inbox) => this.emit("inbox.changed", inbox),
        onError: (error) => this.emitError(error),
      },
    );
    this.connection = coordinator;
    this.commands = new T3Commands((environmentId) => this.connection.requireSession(environmentId));
  }

  private emit(name: string, payload: unknown): void {
    this.channel.write(event(name, payload));
  }

  private emitError(error: unknown): void {
    const bridgeError = asBridgeError(error);
    this.emit("error", { code: bridgeError.code, message: bridgeError.message, retryable: bridgeError.retryable });
  }

  private emitUnexpectedConnectionError(error: unknown): void {
    const bridgeError = asBridgeError(error);
    // The coordinator already publishes this expected terminal state through
    // connection.changed. Emitting a second generic error only duplicates it.
    if (bridgeError.code !== "UPSTREAM_OAUTH_DPOP_UNSUPPORTED") this.emitError(bridgeError);
  }

  async start(): Promise<void> {
    this.channel.start();
    const auth = await this.auth.initialize();
    this.emit("bridge.ready", { protocolVersion: PROTOCOL_VERSION, bridgeVersion: packageMetadata.version, upstream: UPSTREAM });
    this.emit("connection.changed", this.connection.status());
    if (auth.phase === "signedIn") {
      void this.connection.discoverAndConnectPreferred().catch((error) => this.emitUnexpectedConnectionError(error));
    }
  }

  private beginLogin(): void {
    if (this.login !== null) return;
    this.login = (async () => {
      try {
        const status = await this.auth.login();
        this.emit("auth.completed", status);
        await this.connection.discoverAndConnectPreferred();
      } catch (error) {
        this.emitUnexpectedConnectionError(error);
      } finally {
        this.login = null;
      }
    })();
  }

  async handle(request: BridgeRequest): Promise<void> {
    try {
      let payload: unknown;
      switch (request.type) {
        case "bridge.ping":
          payload = { ready: true, protocolVersion: PROTOCOL_VERSION, upstream: UPSTREAM };
          break;
        case "bridge.shutdown":
          payload = { shuttingDown: true };
          this.channel.write(success(request.requestId, payload));
          await this.shutdown();
          return;
        case "auth.status":
          payload = this.auth.status();
          break;
        case "auth.login":
          this.beginLogin();
          payload = { started: true };
          break;
        case "auth.logout":
          await this.connection.disconnect();
          payload = await this.auth.logout();
          break;
        case "environment.list":
          payload = { environments: await this.connection.discover(), selected: this.connection.selectedId() };
          break;
        case "environment.select":
          await this.connection.select(String(request.payload.environmentId));
          payload = { selected: this.connection.selectedId() };
          break;
        case "inbox.get":
          if (this.connection.status().phase !== "connected" && this.connection.mergedInbox().projects.length === 0) {
            throw new BridgeError("ENVIRONMENT_REQUIRED", "Connect to a T3 environment first.");
          }
          payload = this.connection.mergedInbox();
          break;
        case "thread.open":
          await this.connection.openThread(String(request.payload.environmentId), String(request.payload.threadId));
          payload = { opening: request.payload.threadId };
          break;
        case "thread.close":
          await this.connection.closeThread();
          payload = {};
          break;
        default:
          payload = await this.commands.handle(request);
      }
      this.channel.write(success(request.requestId, payload));
    } catch (error) {
      const bridgeError = asBridgeError(error);
      this.channel.write(
        failure(request.requestId, bridgeError.code, bridgeError.message, bridgeError.retryable),
      );
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.commands.clearAttachments();
    await this.connection.disconnect().catch(() => undefined);
    this.channel.stop();
  }
}
