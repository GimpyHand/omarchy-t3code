import type { AuthProvider } from "../auth/provider.ts";
import type { ConnectionStatusDto, EnvironmentDto, InboxDto } from "../protocol/types.ts";
import { BridgeError, redactText } from "../security/redact.ts";
import { readSelectedEnvironment, writeSelectedEnvironment } from "../state/preferences.ts";
import { emptyInbox, mergeInboxes } from "../t3/inboxMerge.ts";
import { T3RelayClient } from "../t3/relay.ts";
import { T3EnvironmentSession, type SessionCallbacks } from "../t3/session.ts";

export interface ConnectionCallbacks {
  onConnection(status: ConnectionStatusDto): void;
  onEnvironment(payload: { selected: string | null; environments: EnvironmentDto[] }): void;
  onInbox(inbox: InboxDto): void;
  onError(error: BridgeError): void;
}

type SessionHooks = Omit<SessionCallbacks, "onInbox" | "onClosed" | "onError">;

interface SessionEntry {
  session: T3EnvironmentSession;
  generation: number;
  retryTimer: NodeJS.Timeout | null;
  phase: ConnectionStatusDto["phase"];
  detail: string | null;
  attempt: number;
}

function stampLabel(inbox: InboxDto, label: string): InboxDto {
  const tag = <T extends { environmentLabel: string }>(items: T[]): T[] =>
    items.map((item) => ({ ...item, environmentLabel: label }));
  return {
    ...inbox,
    projects: tag(inbox.projects),
    pinned: tag(inbox.pinned),
    active: tag(inbox.active),
    snoozed: tag(inbox.snoozed),
    settled: tag(inbox.settled),
  };
}

export class ConnectionCoordinator {
  private environments: EnvironmentDto[] = [];
  private preferred: string | null = null;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly inboxes = new Map<string, InboxDto>();
  private openEnvironmentId: string | null = null;
  private statusValue: ConnectionStatusDto = {
    phase: "disconnected",
    environmentId: null,
    detail: null,
    attempt: 0,
  };

  constructor(
    private readonly auth: AuthProvider,
    private readonly relay: T3RelayClient,
    private readonly createSession: (hooks: SessionCallbacks) => T3EnvironmentSession,
    private readonly sessionHooks: SessionHooks,
    private readonly callbacks: ConnectionCallbacks,
  ) {}

  status(): ConnectionStatusDto {
    return this.statusValue;
  }

  list(): EnvironmentDto[] {
    return this.environments;
  }

  selectedId(): string | null {
    return this.preferred;
  }

  mergedInbox(): InboxDto {
    return mergeInboxes([...this.inboxes.values()]);
  }

  requireSession(environmentId: string): T3EnvironmentSession {
    const entry = this.entries.get(environmentId);
    if (!entry || entry.phase !== "connected") {
      throw new BridgeError("NOT_CONNECTED", "That T3 environment is not connected.", true);
    }
    return entry.session;
  }

  private environmentLabel(environmentId: string): string {
    return this.environments.find((entry) => entry.id === environmentId)?.label ?? environmentId;
  }

  private publish(status: ConnectionStatusDto): void {
    this.statusValue = status;
    this.callbacks.onConnection(status);
  }

  private publishEnvironments(): void {
    this.callbacks.onEnvironment({ selected: this.preferred, environments: this.environments });
  }

  private publishMergedInbox(): void {
    this.callbacks.onInbox(this.mergedInbox());
  }

  private publishAggregateStatus(): void {
    const entries = [...this.entries.values()];
    if (entries.length === 0) {
      this.publish({ phase: "disconnected", environmentId: this.preferred, detail: null, attempt: 0 });
      return;
    }
    if (entries.some((entry) => entry.phase === "connected")) {
      const attempt = Math.max(0, ...entries.map((entry) => entry.attempt));
      this.publish({ phase: "connected", environmentId: this.preferred, detail: null, attempt });
      return;
    }
    if (entries.some((entry) => entry.phase === "connecting" || entry.phase === "discovering")) {
      this.publish({ phase: "connecting", environmentId: this.preferred, detail: null, attempt: 0 });
      return;
    }
    if (entries.some((entry) => entry.phase === "reconnecting")) {
      const attempt = Math.max(1, ...entries.map((entry) => entry.attempt));
      this.publish({
        phase: "reconnecting",
        environmentId: this.preferred,
        detail: entries.find((entry) => entry.phase === "reconnecting")?.detail ?? null,
        attempt,
      });
      return;
    }
    if (entries.every((entry) => entry.phase === "blocked")) {
      this.publish({
        phase: "blocked",
        environmentId: this.preferred,
        detail: entries[0]?.detail ?? null,
        attempt: entries[0]?.attempt ?? 0,
      });
      return;
    }
    const errored = entries.find((entry) => entry.phase === "error");
    this.publish({
      phase: "error",
      environmentId: this.preferred,
      detail: errored?.detail ?? null,
      attempt: errored?.attempt ?? 0,
    });
  }

  private ensureEntry(environmentId: string): SessionEntry {
    const existing = this.entries.get(environmentId);
    if (existing) return existing;
    const entry: SessionEntry = {
      session: this.createSession({
        ...this.sessionHooks,
        onInbox: (inbox) => {
          this.inboxes.set(environmentId, stampLabel(inbox, this.environmentLabel(environmentId)));
          this.publishMergedInbox();
        },
        onThread: (thread) => {
          this.sessionHooks.onThread({
            ...thread,
            environmentLabel: this.environmentLabel(environmentId),
          });
        },
        onClosed: (error) => this.handleClosed(environmentId, error),
        onError: (error) => this.callbacks.onError(error),
      }),
      generation: 0,
      retryTimer: null,
      phase: "disconnected",
      detail: null,
      attempt: 0,
    };
    this.entries.set(environmentId, entry);
    return entry;
  }

  async discover(): Promise<EnvironmentDto[]> {
    const hadConnected = [...this.entries.values()].some((entry) => entry.phase === "connected");
    this.publish({ phase: "discovering", environmentId: this.preferred, detail: null, attempt: 0 });
    try {
      this.environments = await this.relay.listEnvironments();
      const known = new Set(this.environments.map((entry) => entry.id));
      if (this.preferred !== null && !known.has(this.preferred)) this.preferred = null;
      for (const [environmentId, entry] of this.entries) {
        if (known.has(environmentId)) continue;
        ++entry.generation;
        if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
        await entry.session.close();
        this.entries.delete(environmentId);
        this.inboxes.delete(environmentId);
        if (this.openEnvironmentId === environmentId) this.openEnvironmentId = null;
      }
      this.publishEnvironments();
      this.publish({
        phase: hadConnected && this.entries.size > 0 ? "connected" : "disconnected",
        environmentId: this.preferred,
        detail: null,
        attempt: 0,
      });
      this.publishMergedInbox();
      return this.environments;
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : new BridgeError("ENVIRONMENT_DISCOVERY_FAILED", redactText(error), true);
      this.publish({
        phase: hadConnected ? "connected" : "error",
        environmentId: this.preferred,
        detail: bridgeError.message,
        attempt: 0,
      });
      throw bridgeError;
    }
  }

  async discoverAndConnectAll(): Promise<void> {
    const environments = await this.discover();
    const remembered = await readSelectedEnvironment();
    this.preferred = environments.find((entry) => entry.id === remembered)?.id ?? environments[0]?.id ?? null;
    this.publishEnvironments();
    await Promise.all(environments.map(async (entry) => {
      try {
        await this.connectEnvironment(entry.id);
      } catch {
        // Per-environment phase already published; keep connecting the rest.
      }
    }));
  }

  /** @deprecated Prefer discoverAndConnectAll; kept as alias for call sites. */
  async discoverAndConnectPreferred(): Promise<void> {
    await this.discoverAndConnectAll();
  }

  async select(environmentId: string): Promise<void> {
    if (!this.environments.some((entry) => entry.id === environmentId)) {
      throw new BridgeError("ENVIRONMENT_NOT_FOUND", "Refresh environments and choose one of the linked T3 environments.");
    }
    this.preferred = environmentId;
    await writeSelectedEnvironment(environmentId);
    this.publishEnvironments();
    const entry = this.entries.get(environmentId);
    if (entry?.phase === "connected") {
      this.publishAggregateStatus();
      return;
    }
    await this.connectEnvironment(environmentId);
  }

  private async connectEnvironment(environmentId: string): Promise<void> {
    const entry = this.ensureEntry(environmentId);
    const generation = ++entry.generation;
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    await this.connectAttempt(environmentId, generation, 0);
  }

  private async connectAttempt(environmentId: string, generation: number, attempt: number): Promise<void> {
    const entry = this.entries.get(environmentId);
    if (!entry || generation !== entry.generation) return;
    entry.phase = attempt === 0 ? "connecting" : "reconnecting";
    entry.detail = null;
    entry.attempt = attempt;
    this.publishAggregateStatus();
    try {
      const prepared = await this.relay.prepareConnection(environmentId);
      if (generation !== entry.generation) return;
      const config = await entry.session.connect(prepared);
      const matched = this.environments.find((item) => item.id === environmentId);
      if (matched) matched.serverVersion = config.environment.serverVersion;
      entry.phase = "connected";
      entry.detail = null;
      entry.attempt = attempt;
      this.publishEnvironments();
      this.publishAggregateStatus();
    } catch (error) {
      if (generation !== entry.generation) return;
      const bridgeError = error instanceof BridgeError ? error : new BridgeError("ENVIRONMENT_CONNECT_FAILED", redactText(error), true);
      const blocked = bridgeError.code === "UPSTREAM_OAUTH_DPOP_UNSUPPORTED" || !bridgeError.retryable;
      entry.phase = blocked ? "blocked" : "error";
      entry.detail = bridgeError.message;
      entry.attempt = attempt;
      this.inboxes.delete(environmentId);
      this.publishMergedInbox();
      this.publishAggregateStatus();
      if (blocked) throw bridgeError;
      this.scheduleReconnect(environmentId, generation, attempt + 1);
      throw bridgeError;
    }
  }

  handleClosed(environmentId: string, error: unknown): void {
    const entry = this.entries.get(environmentId);
    if (!entry) return;
    const generation = entry.generation;
    const nextAttempt = Math.max(1, entry.attempt + 1);
    entry.phase = "reconnecting";
    entry.detail = redactText(error);
    entry.attempt = nextAttempt;
    this.publishAggregateStatus();
    this.scheduleReconnect(environmentId, generation, nextAttempt);
  }

  private scheduleReconnect(environmentId: string, generation: number, attempt: number): void {
    const entry = this.entries.get(environmentId);
    if (!entry) return;
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      void this.connectAttempt(environmentId, generation, attempt).catch((error) => {
        if (error instanceof BridgeError) this.callbacks.onError(error);
      });
    }, delay);
    entry.retryTimer.unref();
  }

  async openThread(environmentId: string, threadId: string): Promise<void> {
    if (this.openEnvironmentId !== null && this.openEnvironmentId !== environmentId) {
      const previous = this.entries.get(this.openEnvironmentId);
      if (previous) await previous.session.closeThread();
    }
    this.openEnvironmentId = environmentId;
    await this.requireSession(environmentId).openThread(threadId);
  }

  async closeThread(): Promise<void> {
    if (this.openEnvironmentId === null) return;
    const entry = this.entries.get(this.openEnvironmentId);
    this.openEnvironmentId = null;
    if (entry) await entry.session.closeThread();
  }

  async disconnect(): Promise<void> {
    for (const entry of this.entries.values()) {
      ++entry.generation;
      if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
      await entry.session.close();
      entry.phase = "disconnected";
      entry.detail = null;
      entry.attempt = 0;
    }
    this.entries.clear();
    this.inboxes.clear();
    this.openEnvironmentId = null;
    this.publish({ phase: "disconnected", environmentId: this.preferred, detail: null, attempt: 0 });
    this.publishMergedInbox();
  }
}
