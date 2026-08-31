import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_METHODS,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ServerConfig,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { INITIAL_THREAD_USER_TURN_LIMIT } from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import * as RpcSessionUpstream from "../../../upstream/t3code/packages/client-runtime/src/rpc/session.ts";
import type { InboxDto, ThreadDto } from "../protocol/types.ts";
import { BridgeError, redactText } from "../security/redact.ts";
import { T3Projection } from "./projection.ts";

type RuntimeFiber = Fiber.Fiber<unknown, unknown>;

export interface SessionCallbacks {
  onInbox(inbox: InboxDto): void;
  onThread(thread: ThreadDto): void;
  onMessageDelta(payload: { threadId: string; messageId: string; delta: string }): void;
  onMessageCompleted(payload: { threadId: string; messageId: string }): void;
  onApproval(payload: ThreadDto["approvals"][number] & { threadId: string }): void;
  onInput(payload: ThreadDto["inputs"][number] & { threadId: string }): void;
  onClosed(error: unknown): void;
  onError(error: BridgeError): void;
}

const decodeCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);

function bridgeCommand(value: unknown) {
  try {
    return decodeCommand(value);
  } catch (error) {
    throw new BridgeError("COMMAND_INVALID", `The command does not match pinned T3 contracts: ${redactText(error)}`);
  }
}

function commandError(error: unknown): BridgeError {
  const candidate = error as { _tag?: string; message?: string };
  if (candidate?._tag === "EnvironmentAuthorizationError") {
    return new BridgeError("ENVIRONMENT_AUTHORIZATION_FAILED", candidate.message ?? "Environment authorization failed.");
  }
  if (candidate?._tag === "OrchestrationDispatchCommandError") {
    return new BridgeError("COMMAND_REJECTED", candidate.message ?? "T3 rejected the command.");
  }
  return new BridgeError("RPC_FAILED", redactText(error), true);
}

function messageMap(thread: OrchestrationThread | null): Map<string, OrchestrationMessage> {
  return new Map((thread?.messages ?? []).map((message) => [message.id, message]));
}

export function deriveMessageStreamEvents(
  beforeThread: OrchestrationThread | null,
  afterThread: OrchestrationThread,
  threadId: string,
): {
  deltas: Array<{ threadId: string; messageId: string; delta: string }>;
  completed: Array<{ threadId: string; messageId: string }>;
} {
  const before = messageMap(beforeThread);
  const deltas: Array<{ threadId: string; messageId: string; delta: string }> = [];
  const completed: Array<{ threadId: string; messageId: string }> = [];
  for (const message of afterThread.messages) {
    const prior = before.get(message.id);
    if (message.streaming && prior && message.text.startsWith(prior.text) && message.text.length > prior.text.length) {
      deltas.push({ threadId, messageId: message.id, delta: message.text.slice(prior.text.length) });
    } else if (message.streaming && !prior && message.text.length > 0) {
      deltas.push({ threadId, messageId: message.id, delta: message.text });
    }
    if (!message.streaming && prior?.streaming === true) completed.push({ threadId, messageId: message.id });
  }
  return { deltas, completed };
}

export class T3EnvironmentSession {
  readonly projection = new T3Projection();
  private scope: Scope.Closeable | null = null;
  private session: RpcSessionUpstream.RpcSession | null = null;
  private shellFiber: RuntimeFiber | null = null;
  private threadFiber: RuntimeFiber | null = null;
  private expectedClose = false;
  private failureReported = false;
  private environmentId: string | null = null;
  private requestedThreadId: string | null = null;
  private threadSubscribePending = false;

  constructor(private readonly callbacks: SessionCallbacks) {}

  private reportUnexpectedClose(code: string, detail: string): void {
    if (this.expectedClose || this.failureReported) return;
    this.failureReported = true;
    this.callbacks.onClosed(new BridgeError(code, detail, true));
  }

  private observeStreamFiber(
    fiber: RuntimeFiber,
    code: string,
    label: string,
    isCurrent: () => boolean,
    clear: () => void,
  ): void {
    void Effect.runPromise(Fiber.await(fiber)).then(
      (exit) => {
        if (!isCurrent()) return;
        clear();
        const detail = Exit.isFailure(exit)
          ? redactText(Cause.squash(exit.cause))
          : `${label} stream ended unexpectedly.`;
        this.reportUnexpectedClose(code, detail);
      },
      (error) => {
        if (!isCurrent()) return;
        clear();
        this.reportUnexpectedClose(code, redactText(error));
      },
    );
  }

  private requireClient(): WsRpcProtocolClient {
    if (this.session === null) throw new BridgeError("NOT_CONNECTED", "Connect to a T3 environment first.", true);
    return this.session.client;
  }

  private currentShell(threadId: string): OrchestrationThreadShell {
    const thread = this.projection.shell?.threads.find((entry) => entry.id === threadId);
    if (!thread) throw new BridgeError("THREAD_NOT_FOUND", "The thread is not in the current Inbox.");
    return thread;
  }

  async connect(connection: PreparedConnection): Promise<ServerConfig> {
    await this.teardown(false);
    this.expectedClose = false;
    this.failureReported = false;
    this.environmentId = connection.environmentId;
    this.projection.reset();

    const factoryLayer = RpcSessionUpstream.layer.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    );
    const factory = await Effect.runPromise(
      RpcSessionUpstream.RpcSessionFactory.pipe(Effect.provide(factoryLayer)),
    );
    const scope = Effect.runSync(Scope.make());
    this.scope = scope;
    try {
      const session = await Effect.runPromise(
        factory.connect(connection).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      this.session = session;
      await Effect.runPromise(session.ready);
      const config = await Effect.runPromise(session.initialConfig);
      this.projection.config = config;
      this.startShellStream();
      void Effect.runPromise(session.closed).catch((error) => {
        if (this.session === session) this.reportUnexpectedClose("RPC_DISCONNECTED", redactText(error));
      });
      return config;
    } catch (error) {
      await this.teardown(false);
      throw new BridgeError("RPC_CONNECT_FAILED", redactText(error), true);
    }
  }

  private startShellStream(): void {
    const client = this.requireClient();
    const stream = client[ORCHESTRATION_WS_METHODS.subscribeShell]({
      ...(this.projection.config?.threadResumeCompletionMarker === true
        ? { requestCompletionMarker: true as const }
        : {}),
    });
    const fiber = Effect.runFork(
      stream.pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            if (this.projection.applyShell(item) && this.environmentId !== null) {
              this.callbacks.onInbox(this.projection.inbox(this.environmentId));
              if (this.projection.thread !== null) this.callbacks.onThread(this.projection.threadDto(this.environmentId));
              if (this.requestedThreadId !== null && this.threadFiber === null && !this.threadSubscribePending) {
                const requested = this.requestedThreadId;
                this.threadSubscribePending = true;
                void this.subscribeThread(requested).catch((error) => this.callbacks.onError(
                  error instanceof BridgeError ? error : new BridgeError("THREAD_STREAM_FAILED", redactText(error), true),
                )).finally(() => { this.threadSubscribePending = false; });
              }
            }
          }),
        ),
      ),
    );
    this.shellFiber = fiber;
    this.observeStreamFiber(
      fiber,
      "SHELL_STREAM_FAILED",
      "Inbox",
      () => this.shellFiber === fiber,
      () => { this.shellFiber = null; },
    );
  }

  async openThread(threadId: string): Promise<void> {
    this.requestedThreadId = threadId;
    await this.subscribeThread(threadId);
  }

  private async subscribeThread(threadId: string): Promise<void> {
    if (this.threadFiber !== null) {
      const previous = this.threadFiber;
      this.threadFiber = null;
      await Effect.runPromise(Fiber.interrupt(previous));
    }
    this.projection.thread = null;
    const client = this.requireClient();
    const stream = client[ORCHESTRATION_WS_METHODS.subscribeThread]({
      threadId: ThreadId.make(threadId),
      ...(this.projection.config?.threadResumeCompletionMarker === true
        ? { requestCompletionMarker: true as const }
        : {}),
      ...(this.projection.config?.threadSnapshotPagination === true
        ? { turnLimit: INITIAL_THREAD_USER_TURN_LIMIT }
        : {}),
    });
    const fiber = Effect.runFork(
      stream.pipe(
        Stream.runForEach((item) =>
          Effect.sync(() => {
            const beforeThread = this.projection.thread;
            const beforeApprovals = new Set(
              this.projection.thread === null
                ? []
                : this.projection.threadDto(this.environmentId!).approvals.map((entry) => entry.requestId),
            );
            const beforeInputs = new Set(
              this.projection.thread === null
                ? []
                : this.projection.threadDto(this.environmentId!).inputs.map((entry) => entry.requestId),
            );
            if (!this.projection.applyThread(item) || this.environmentId === null || this.projection.thread === null) return;
            const dto = this.projection.threadDto(this.environmentId);
            const messageEvents = deriveMessageStreamEvents(beforeThread, this.projection.thread, threadId);
            for (const delta of messageEvents.deltas) this.callbacks.onMessageDelta(delta);
            for (const completed of messageEvents.completed) this.callbacks.onMessageCompleted(completed);
            for (const approval of dto.approvals) {
              if (!beforeApprovals.has(approval.requestId)) this.callbacks.onApproval({ threadId, ...approval });
            }
            for (const input of dto.inputs) {
              if (!beforeInputs.has(input.requestId)) this.callbacks.onInput({ threadId, ...input });
            }
            this.callbacks.onThread(dto);
          }),
        ),
      ),
    );
    this.threadFiber = fiber;
    this.observeStreamFiber(
      fiber,
      "THREAD_STREAM_FAILED",
      "Thread",
      () => this.threadFiber === fiber,
      () => { this.threadFiber = null; },
    );
  }

  async closeThread(): Promise<void> {
    this.requestedThreadId = null;
    const threadFiber = this.threadFiber;
    this.threadFiber = null;
    if (threadFiber !== null) await Effect.runPromise(Fiber.interrupt(threadFiber));
    this.projection.thread = null;
  }

  async dispatch(value: unknown): Promise<{ sequence: number }> {
    const client = this.requireClient();
    try {
      return await Effect.runPromise(
        client[ORCHESTRATION_WS_METHODS.dispatchCommand](bridgeCommand(value)),
      );
    } catch (error) {
      throw commandError(error);
    }
  }

  async probe(): Promise<void> {
    const client = this.requireClient();
    try {
      await Effect.runPromise(client[WS_METHODS.serverProbe]({}));
    } catch (error) {
      throw commandError(error);
    }
  }

  private async teardown(resetThreadSelection: boolean): Promise<void> {
    this.expectedClose = true;
    const threadFiber = this.threadFiber;
    const shellFiber = this.shellFiber;
    this.threadFiber = null;
    this.shellFiber = null;
    if (threadFiber !== null) await Effect.runPromise(Fiber.interrupt(threadFiber));
    if (shellFiber !== null) await Effect.runPromise(Fiber.interrupt(shellFiber));
    this.threadSubscribePending = false;
    if (this.scope !== null) await Effect.runPromise(Scope.close(this.scope, Exit.void));
    this.scope = null;
    this.session = null;
    this.environmentId = null;
    this.projection.reset();
    if (resetThreadSelection) this.requestedThreadId = null;
  }

  async close(): Promise<void> {
    await this.teardown(true);
  }
}
