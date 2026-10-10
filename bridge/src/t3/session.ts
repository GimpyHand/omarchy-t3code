import {
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
  MessageId,
  type UploadChatImageAttachment,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WS_METHODS,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadHistoryPage,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  ConnectionBlockedError,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

import * as RpcSessionUpstream from "../../../upstream/t3code/packages/client-runtime/src/rpc/session.ts";
import type { InboxDto, ThreadDto } from "../protocol/types.ts";
import { BridgeError, redactText } from "../security/redact.ts";
import { boundMessageDelta } from "./bounds.ts";
import { T3Projection } from "./projection.ts";

type RuntimeFiber = Fiber.Fiber<unknown, unknown>;
type HistoryPageLoader = (prepared: PreparedConnection, threadId: string, cursor: string) => Promise<OrchestrationV2ThreadHistoryPage>;

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

const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

function bridgeCommand(value: unknown) {
  try {
    return decodeCommand(value);
  } catch (error) {
    throw new BridgeError(
      "COMMAND_INVALID",
      `The command does not match current T3 contracts: ${redactText(error)}`,
    );
  }
}

function commandError(error: unknown): BridgeError {
  const candidate = error as { _tag?: string; message?: string };
  if (candidate?._tag === "EnvironmentAuthorizationError") {
    return new BridgeError(
      "ENVIRONMENT_AUTHORIZATION_FAILED",
      candidate.message ?? "Environment authorization failed.",
    );
  }
  if (candidate?._tag === "OrchestrationV2DispatchCommandError") {
    return new BridgeError("COMMAND_REJECTED", candidate.message ?? "T3 rejected the command.");
  }
  return new BridgeError("RPC_FAILED", redactText(error), true);
}

function messageMap(
  thread: OrchestrationV2ThreadProjection | null,
): Map<string, OrchestrationV2ConversationMessage> {
  return new Map((thread?.messages ?? []).map((message) => [message.id, message]));
}

export function deriveMessageStreamEvents(
  beforeThread: OrchestrationV2ThreadProjection | null,
  afterThread: OrchestrationV2ThreadProjection,
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
    if (
      message.streaming &&
      prior &&
      message.text.startsWith(prior.text) &&
      message.text.length > prior.text.length
    ) {
      deltas.push(
        boundMessageDelta({
          threadId,
          messageId: message.id,
          delta: message.text.slice(prior.text.length),
        }),
      );
    } else if (message.streaming && !prior && message.text.length > 0) {
      deltas.push(boundMessageDelta({ threadId, messageId: message.id, delta: message.text }));
    }
    if (!message.streaming && prior?.streaming === true)
      completed.push({ threadId, messageId: message.id });
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
  private threadSubscribePending: number | null = null;
  private prepared: PreparedConnection | null = null;
  private threadGeneration = 0;

  constructor(private readonly callbacks: SessionCallbacks, private readonly loadHistoryPage?: HistoryPageLoader) {}

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
    if (this.session === null)
      throw new BridgeError("NOT_CONNECTED", "Connect to a T3 environment first.", true);
    return this.session.client;
  }

  async connect(connection: PreparedConnection): Promise<ServerConfig> {
    await this.teardown(false);
    this.expectedClose = false;
    this.failureReported = false;
    this.environmentId = connection.environmentId;
    this.prepared = connection;
    this.projection.reset();

    const factoryLayer = RpcSessionUpstream.layer({}).pipe(
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
        if (this.session === session)
          this.reportUnexpectedClose("RPC_DISCONNECTED", redactText(error));
      });
      return config;
    } catch (error) {
      await this.teardown(false);
      throw new BridgeError(
        "RPC_CONNECT_FAILED",
        redactText(error),
        !(error instanceof ConnectionBlockedError),
      );
    }
  }

  private startShellStream(): void {
    const client = this.requireClient();
    const stream = client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
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
              if (this.projection.thread !== null)
                this.callbacks.onThread(this.projection.threadDto(this.environmentId));
              if (
                this.requestedThreadId !== null &&
                this.threadFiber === null &&
                this.threadSubscribePending === null
              ) {
                const requested = this.requestedThreadId;
                void this.subscribeThread(requested)
                  .catch((error) =>
                    this.callbacks.onError(
                      error instanceof BridgeError
                        ? error
                        : new BridgeError("THREAD_STREAM_FAILED", redactText(error), true),
                    ),
                  );
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
      () => {
        this.shellFiber = null;
      },
    );
  }

  async openThread(threadId: string): Promise<void> {
    this.requestedThreadId = threadId;
    await this.subscribeThread(threadId);
  }

  private async subscribeThread(threadId: string): Promise<void> {
    const generation = ++this.threadGeneration;
    this.threadSubscribePending = generation;
    try { await this.startThreadSubscription(threadId, generation); }
    finally {
      if (this.threadSubscribePending === generation) this.threadSubscribePending = null;
    }
  }

  private async startThreadSubscription(threadId: string, generation: number): Promise<void> {
    // Keep same-thread controls usable until the replacement socket snapshot arrives.
    if (this.projection.thread?.thread.id !== threadId) this.projection.clearThread();
    if (this.threadFiber !== null) {
      const previous = this.threadFiber;
      this.threadFiber = null;
      await Effect.runPromise(Fiber.interrupt(previous));
    }
    const client = this.requireClient();
    if (generation !== this.threadGeneration) return;
    // The socket supplies the bounded window and cursor before live events.
    const stream = client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
      threadId: ThreadId.make(threadId),
      ...(this.projection.config?.threadResumeCompletionMarker === true
        ? { requestCompletionMarker: true as const }
        : {}),
      ...(this.projection.config?.threadSnapshotPagination === true
        ? { acceptBoundedSnapshot: true }
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
                : this.projection
                    .threadDto(this.environmentId!)
                    .approvals.map((entry) => entry.requestId),
            );
            const beforeInputs = new Set(
              this.projection.thread === null
                ? []
                : this.projection
                    .threadDto(this.environmentId!)
                    .inputs.map((entry) => entry.requestId),
            );
            if (
              !this.projection.applyThread(item) ||
              this.environmentId === null ||
              this.projection.thread === null
            )
              return;
            const dto = this.projection.threadDto(this.environmentId);
            const messageEvents = deriveMessageStreamEvents(
              beforeThread,
              this.projection.thread,
              threadId,
            );
            for (const delta of messageEvents.deltas) this.callbacks.onMessageDelta(delta);
            for (const completed of messageEvents.completed)
              this.callbacks.onMessageCompleted(completed);
            for (const approval of dto.approvals) {
              if (!beforeApprovals.has(approval.requestId))
                this.callbacks.onApproval({ threadId, ...approval });
            }
            for (const input of dto.inputs) {
              if (!beforeInputs.has(input.requestId))
                this.callbacks.onInput({ threadId, ...input });
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
      () => {
        this.threadFiber = null;
      },
    );
  }

  async closeThread(): Promise<void> {
    ++this.threadGeneration;
    this.threadSubscribePending = null;
    this.projection.clearThread();
    this.requestedThreadId = null;
    const threadFiber = this.threadFiber;
    this.threadFiber = null;
    if (threadFiber !== null) await Effect.runPromise(Fiber.interrupt(threadFiber));
  }

  async loadEarlier(threadId: string): Promise<{ loaded: boolean }> {
    const projection = this.projection.thread;
    if (!projection || projection.thread.id !== threadId || this.environmentId === null) {
      throw new BridgeError("THREAD_NOT_READY", "Open this thread and wait for it to synchronize.", true);
    }
    const history = this.projection.history;
    const request = history.begin(projection);
    this.callbacks.onThread(this.projection.threadDto(this.environmentId));
    if (request === null) return { loaded: false };
    if (request.cursor === null) return { loaded: true };
    try {
      if (this.projection.config?.threadSnapshotPagination !== true || !this.prepared || !this.loadHistoryPage) {
        throw new BridgeError("CAPABILITY_UNSUPPORTED", "This environment does not support loading older history.");
      }
      const page = await this.loadHistoryPage(this.prepared, threadId, request.cursor);
      const current = this.projection.thread;
      if (!current || current.thread.id !== threadId) return { loaded: false };
      const loaded = history.complete(request, page, current, this.projection.currentThreadSequence);
      if (loaded && this.environmentId !== null) this.callbacks.onThread(this.projection.threadDto(this.environmentId));
      return { loaded };
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError("HISTORY_LOAD_FAILED", "Older messages could not be loaded. Try again.", true);
      if (!history.fail(request, failure.message)) return { loaded: false };
      if (this.environmentId !== null && this.projection.thread?.thread.id === threadId) {
        this.callbacks.onThread(this.projection.threadDto(this.environmentId));
      }
      throw failure;
    }
  }

  async showLatest(threadId: string): Promise<Record<string, never>> {
    if (this.projection.thread?.thread.id !== threadId || this.environmentId === null) {
      throw new BridgeError("THREAD_NOT_READY", "Open this thread and wait for it to synchronize.", true);
    }
    this.projection.history.latest();
    this.callbacks.onThread(this.projection.threadDto(this.environmentId));
    // Refresh the window/cursor after long browsing sessions through the socket.
    await this.subscribeThread(threadId);
    return {};
  }

  async dispatch(value: unknown): Promise<{ sequence: number }> {
    const client = this.requireClient();
    try {
      return await Effect.runPromise(
        client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](bridgeCommand(value)),
      );
    } catch (error) {
      throw commandError(error);
    }
  }

  async launch(value: unknown) {
    let input: typeof OrchestrationV2ThreadLaunchInput.Type;
    try {
      input = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput)(value);
    } catch (error) {
      throw new BridgeError(
        "COMMAND_INVALID",
        `The launch does not match current T3 contracts: ${redactText(error)}`,
      );
    }
    try {
      return await Effect.runPromise(
        this.requireClient()[ORCHESTRATION_V2_WS_METHODS.launchThread](input),
      );
    } catch (error) {
      throw commandError(error);
    }
  }

  async persistAttachments(
    threadId: string,
    messageId: string,
    attachments: UploadChatImageAttachment[],
  ) {
    if (attachments.length === 0) return [];
    const result = await Effect.runPromise(
      this.requireClient()[WS_METHODS.assetsPersistChatAttachments]({
        threadId: ThreadId.make(threadId),
        messageId: MessageId.make(messageId),
        attachments,
      }),
    );
    return result.attachments;
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
    ++this.threadGeneration;
    this.threadSubscribePending = null;
    this.projection.clearThread();
    this.expectedClose = true;
    const threadFiber = this.threadFiber;
    const shellFiber = this.shellFiber;
    this.threadFiber = null;
    this.shellFiber = null;
    if (threadFiber !== null) await Effect.runPromise(Fiber.interrupt(threadFiber));
    if (shellFiber !== null) await Effect.runPromise(Fiber.interrupt(shellFiber));
    if (this.scope !== null) await Effect.runPromise(Scope.close(this.scope, Exit.void));
    this.scope = null;
    this.session = null;
    this.environmentId = null;
    this.prepared = null;
    this.projection.reset();
    if (resetThreadSelection) this.requestedThreadId = null;
  }

  async close(): Promise<void> {
    await this.teardown(true);
  }
}
