import { randomUUID } from "node:crypto";

import type { ModelSelection, OrchestrationV2ThreadShell, RuntimeMode } from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import type { BridgeRequest, CapabilitiesDto } from "../protocol/types.ts";
import { BridgeError } from "../security/redact.ts";
import { T3ImageAttachmentStore } from "./attachments.ts";
import { T3EnvironmentSession } from "./session.ts";
import { deriveThreadQueueWorkflowState } from "../../../upstream/t3code/packages/client-runtime/src/state/threadWorkflows.ts";

type Payload = Record<string, unknown>;

const string = (payload: Payload, key: string): string => String(payload[key]);
const id = (): string => randomUUID();
const runtimeModes = new Set<RuntimeMode>([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

function modelSelection(payload: Payload, current?: ModelSelection): ModelSelection | null {
  if (typeof payload.providerInstanceId !== "string" || typeof payload.model !== "string")
    return null;
  const requested = {
    instanceId: payload.providerInstanceId,
    model: payload.model,
  } as ModelSelection;
  return current?.instanceId === requested.instanceId && current.model === requested.model
    ? createModelSelection(current.instanceId, current.model, current.options)
    : requested;
}

function modelOptionSelections(payload: Payload): Array<{ id: string; value: string }> | null {
  if (payload.modelOptions === undefined) return null;
  if (!Array.isArray(payload.modelOptions)) {
    throw new BridgeError("INVALID_MODEL_OPTIONS", "Model options must be an array.");
  }
  return payload.modelOptions.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new BridgeError(
        "INVALID_MODEL_OPTIONS",
        "Each model option must contain an id and value.",
      );
    }
    const option = entry as Record<string, unknown>;
    if (typeof option.id !== "string" || typeof option.value !== "string") {
      throw new BridgeError(
        "INVALID_MODEL_OPTIONS",
        "Each model option must contain an id and value.",
      );
    }
    return { id: option.id, value: option.value };
  });
}

function applyModelOptions(
  session: T3EnvironmentSession,
  selection: ModelSelection,
  payload: Payload,
): ModelSelection {
  const requested = modelOptionSelections(payload);
  if (requested === null || requested.length === 0) return selection;

  const provider = session.projection.config?.providers.find(
    (entry) => entry.instanceId === selection.instanceId,
  );
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  if (!model?.capabilities) {
    throw new BridgeError(
      "MODEL_OPTIONS_UNAVAILABLE",
      "The selected model does not advertise configurable options.",
    );
  }

  const descriptors = getProviderOptionDescriptors({ caps: model.capabilities });
  for (const requestedOption of requested) {
    const descriptor = descriptors.find((entry) => entry.id === requestedOption.id);
    if (
      !descriptor ||
      descriptor.type !== "select" ||
      descriptor.promptInjectedValues?.includes(requestedOption.value)
    ) {
      throw new BridgeError(
        "MODEL_OPTION_UNSUPPORTED",
        "The selected model does not advertise that option.",
      );
    }
    if (!descriptor.options.some((choice) => choice.id === requestedOption.value)) {
      throw new BridgeError(
        "MODEL_OPTION_INVALID",
        "The selected model does not advertise that value.",
      );
    }
  }

  const selectedDescriptors = getProviderOptionDescriptors({
    caps: model.capabilities,
    selections: requested,
  });
  return createModelSelection(
    selection.instanceId,
    selection.model,
    buildProviderOptionSelectionsFromDescriptors(selectedDescriptors),
  );
}

function runtimeMode(payload: Payload): RuntimeMode {
  if (payload.runtimeMode === undefined) return "approval-required";
  const value = String(payload.runtimeMode) as RuntimeMode;
  if (!runtimeModes.has(value)) {
    throw new BridgeError("RUNTIME_MODE_INVALID", "The requested access level is invalid.");
  }
  return value;
}

function capability(
  session: T3EnvironmentSession,
  key: keyof Pick<CapabilitiesDto, "settlement" | "snooze" | "pinning">,
): void {
  const config = session.projection.config;
  if (!config) throw new BridgeError("NOT_CONNECTED", "Connect to a T3 environment first.");
  const map = {
    settlement: config.environment.capabilities.threadSettlement === true,
    snooze: config.environment.capabilities.threadSnooze === true,
    pinning: config.environment.capabilities.threadPinning === true,
  };
  if (!map[key])
    throw new BridgeError("CAPABILITY_UNSUPPORTED", `This T3 environment does not support ${key}.`);
}

function shell(session: T3EnvironmentSession, threadId: string): OrchestrationV2ThreadShell {
  const thread = session.projection.shell?.threads.find((entry) => entry.id === threadId);
  if (!thread) throw new BridgeError("THREAD_NOT_FOUND", "The thread is not in the current Inbox.");
  return thread;
}

export class T3Commands {
  constructor(
    private readonly resolveSession: (environmentId: string) => T3EnvironmentSession,
    private readonly attachments = new T3ImageAttachmentStore(),
  ) {}

  private session(payload: Payload): T3EnvironmentSession {
    return this.resolveSession(string(payload, "environmentId"));
  }

  async pasteClipboardImage(payload: Payload) {
    this.session(payload);
    return this.attachments.pasteClipboard(string(payload, "threadId"));
  }

  discardAttachment(payload: Payload): Record<string, never> {
    this.session(payload);
    this.attachments.discard(string(payload, "threadId"), string(payload, "attachmentId"));
    return {};
  }

  async create(payload: Payload): Promise<{ threadId: string }> {
    const session = this.session(payload);
    const projectId = string(payload, "projectId");
    const prompt = string(payload, "prompt");
    const project = session.projection.shell?.projects.find((entry) => entry.id === projectId);
    if (!project)
      throw new BridgeError(
        "PROJECT_NOT_FOUND",
        "Choose a project from the connected environment.",
      );
    let selection = modelSelection(payload) ?? project.defaultModelSelection;
    if (selection === null) {
      const advertised =
        session.projection.models().find((entry) => entry.available && entry.isDefault) ??
        session.projection.models().find((entry) => entry.available);
      if (!advertised)
        throw new BridgeError("MODEL_REQUIRED", "No available T3 provider/model was advertised.");
      selection = { instanceId: advertised.instanceId, model: advertised.model } as ModelSelection;
    }
    selection = applyModelOptions(session, selection, payload);
    const threadId = id();
    const title =
      (typeof payload.title === "string" && payload.title.trim()) ||
      prompt.trim().split(/\r?\n/u)[0]?.slice(0, 100) ||
      "New thread";
    const selectedRuntimeMode = runtimeMode(payload);
    const interactionMode =
      typeof payload.interactionMode === "string" ? payload.interactionMode : "default";
    const result = await session.launch({
      commandId: id(),
      threadId,
      projectId,
      title,
      generateTitle: true,
      creationSource: "web",
      modelSelection: selection,
      runtimeMode: selectedRuntimeMode,
      interactionMode,
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: id(), text: prompt, attachments: [] },
    });
    return { threadId: result.threadId };
  }

  async send(payload: Payload): Promise<{ sequence: number }> {
    const session = this.session(payload);
    const threadId = string(payload, "threadId");
    const attachmentIds = Array.isArray(payload.attachmentIds)
      ? payload.attachmentIds.map((attachmentId) => String(attachmentId))
      : [];
    const thread = shell(session, threadId);
    const text = string(payload, "text");
    const uploads = this.attachments.resolve(threadId, attachmentIds);
    const messageId = id();
    const detailed = session.projection.thread?.thread;
    const current = detailed?.id === threadId ? detailed.modelSelection : thread.modelSelection;
    const selected = modelSelection(payload, current);
    if (typeof payload.runtimeMode === "string" && payload.runtimeMode !== thread.runtimeMode)
      await this.setRuntime(payload);
    if (
      typeof payload.interactionMode === "string" &&
      payload.interactionMode !== thread.interactionMode
    )
      await this.setInteraction(payload);
    const attachments = await session.persistAttachments(threadId, messageId, uploads);
    const result = await session.dispatch({
      type: "message.dispatch",
      commandId: id(),
      threadId,
      messageId,
      text,
      attachments,
      createdBy: "user",
      creationSource: "web",
      ...(selected ? { modelSelection: selected } : {}),
      ...(session.projection.config?.environment.capabilities.serverResolvedCommandContext === true
        ? { deliveryIntent: "auto" }
        : {}),
      dispatchMode:
        session.projection.config?.environment.capabilities.serverResolvedCommandContext === true ||
        thread.activeRunId === null
          ? { type: "start_immediately" }
          : { type: "queue_after_active" },
    });
    this.attachments.consume(threadId, attachmentIds);
    return result;
  }

  async interrupt(payload: Payload): Promise<{ sequence: number }> {
    const session = this.session(payload);
    const thread = shell(session, string(payload, "threadId"));
    const runId = thread.activeRunId ?? thread.latestRunId;
    if (runId === null) throw new BridgeError("NO_ACTIVE_RUN", "This thread has no run to stop.");
    return session.dispatch({
      type: "run.interrupt",
      commandId: id(),
      threadId: thread.id,
      runId,
      holdQueue: true,
    });
  }

  async manageQueue(payload: Payload, action: "resume" | "cancel" | "edit"): Promise<{ sequence: number }> {
    const session = this.session(payload);
    const threadId = string(payload, "threadId");
    if (session.projection.config?.environment.orchestrationProtocolVersion !== 2) {
      throw new BridgeError("CAPABILITY_UNSUPPORTED", "This environment does not support queue controls.");
    }
    const projection = session.projection.thread;
    if (!projection || projection.thread.id !== threadId) {
      throw new BridgeError("THREAD_NOT_READY", "Open this thread and wait for it to synchronize.", true);
    }
    const queue = deriveThreadQueueWorkflowState(projection);
    if (action === "resume") {
      if (!queue.isHeld) throw new BridgeError("QUEUE_NOT_HELD", "The queue is no longer paused.");
      return session.dispatch({ type: "queue.resume", commandId: id(), threadId });
    }
    const runId = string(payload, "runId");
    const queued = queue.queuedRuns.find((entry) => entry.run.id === runId);
    if (!queued) throw new BridgeError("QUEUED_RUN_NOT_FOUND", "That message is no longer queued.");
    if (action === "cancel") {
      return session.dispatch({ type: "queued-run.cancel", commandId: id(), threadId, runId });
    }
    const text = string(payload, "text");
    if (!text.trim()) {
      throw new BridgeError("EMPTY_MESSAGE", "Enter message text to save this edit.");
    }
    // Omit attachments/context so text edits preserve the original message's context.
    return session.dispatch({ type: "queued-run.edit", commandId: id(), threadId, runId, text });
  }

  async settle(payload: Payload): Promise<{ sequence: number }> {
    const session = this.session(payload);
    capability(session, "settlement");
    return session.dispatch({
      type: "thread.settle",
      commandId: id(),
      threadId: string(payload, "threadId"),
    });
  }

  async unsettle(payload: Payload): Promise<{ sequence: number }> {
    const session = this.session(payload);
    capability(session, "settlement");
    return session.dispatch({
      type: "thread.unsettle",
      commandId: id(),
      threadId: string(payload, "threadId"),
      reason: "user",
    });
  }

  async snooze(payload: Payload): Promise<{ sequence: number }> {
    const session = this.session(payload);
    capability(session, "snooze");
    return session.dispatch({
      type: "thread.snooze",
      commandId: id(),
      threadId: string(payload, "threadId"),
      snoozedUntil: string(payload, "until"),
    });
  }

  async unsnooze(payload: Payload): Promise<{ sequence: number }> {
    const session = this.session(payload);
    capability(session, "snooze");
    return session.dispatch({
      type: "thread.unsnooze",
      commandId: id(),
      threadId: string(payload, "threadId"),
      reason: "user",
    });
  }

  async pin(payload: Payload): Promise<{ sequence: number }> {
    const session = this.session(payload);
    capability(session, "pinning");
    return session.dispatch({
      type: "thread.pin",
      commandId: id(),
      threadId: string(payload, "threadId"),
    });
  }

  async unpin(payload: Payload): Promise<{ sequence: number }> {
    const session = this.session(payload);
    capability(session, "pinning");
    return session.dispatch({
      type: "thread.unpin",
      commandId: id(),
      threadId: string(payload, "threadId"),
    });
  }

  async setModel(payload: Payload): Promise<{ sequence: number }> {
    return this.session(payload).dispatch({
      type: "thread.model-selection.set",
      commandId: id(),
      threadId: string(payload, "threadId"),
      modelSelection: {
        instanceId: string(payload, "providerInstanceId"),
        model: string(payload, "model"),
      },
    });
  }

  async setModelOption(payload: Payload): Promise<{ sequence: number }> {
    const session = this.session(payload);
    const threadId = string(payload, "threadId");
    const shellThread = shell(session, threadId);
    const detailed = session.projection.thread?.thread;
    const selection =
      detailed?.id === threadId ? detailed.modelSelection : shellThread.modelSelection;
    const provider = session.projection.config?.providers.find(
      (entry) => entry.instanceId === selection.instanceId,
    );
    const model = provider?.models.find((entry) => entry.slug === selection.model);
    if (!model?.capabilities) {
      throw new BridgeError(
        "MODEL_OPTIONS_UNAVAILABLE",
        "The selected model does not advertise configurable options.",
      );
    }

    const optionId = string(payload, "optionId");
    const value = string(payload, "value");
    const descriptors = getProviderOptionDescriptors({
      caps: model.capabilities,
      selections: selection.options,
    });
    const target = descriptors.find((descriptor) => descriptor.id === optionId);
    if (!target || target.type !== "select") {
      throw new BridgeError(
        "MODEL_OPTION_UNSUPPORTED",
        "The selected model does not advertise that option.",
      );
    }
    if (target.promptInjectedValues?.includes(value)) {
      throw new BridgeError("MODEL_OPTION_UNSUPPORTED", "That option is controlled by the prompt.");
    }
    if (!target.options.some((choice) => choice.id === value)) {
      throw new BridgeError(
        "MODEL_OPTION_INVALID",
        "The selected model does not advertise that value.",
      );
    }

    const nextDescriptors = descriptors.map((descriptor) =>
      descriptor.id === optionId && descriptor.type === "select"
        ? { ...descriptor, currentValue: value }
        : descriptor,
    );
    return session.dispatch({
      type: "thread.model-selection.set",
      commandId: id(),
      threadId,
      modelSelection: createModelSelection(
        selection.instanceId,
        selection.model,
        buildProviderOptionSelectionsFromDescriptors(nextDescriptors),
      ),
    });
  }

  async rename(payload: Payload): Promise<{ sequence: number }> {
    return this.session(payload).dispatch({
      type: "thread.metadata.update",
      commandId: id(),
      threadId: string(payload, "threadId"),
      title: string(payload, "title").trim(),
    });
  }

  async regenerateTitle(payload: Payload): Promise<{ sequence: number }> {
    const session = this.session(payload);
    const config = session.projection.config;
    if (!config?.environment.capabilities.threadTitleRegeneration) {
      throw new BridgeError(
        "CAPABILITY_UNSUPPORTED",
        "This T3 environment does not support title regeneration.",
      );
    }
    return session.dispatch({
      type: "thread.metadata.update",
      commandId: id(),
      threadId: string(payload, "threadId"),
      regenerateTitle: true,
    });
  }

  async setRuntime(payload: Payload): Promise<{ sequence: number }> {
    return this.session(payload).dispatch({
      type: "thread.runtime-mode.set",
      commandId: id(),
      threadId: string(payload, "threadId"),
      runtimeMode: string(payload, "runtimeMode"),
    });
  }

  async setInteraction(payload: Payload): Promise<{ sequence: number }> {
    return this.session(payload).dispatch({
      type: "thread.interaction-mode.set",
      commandId: id(),
      threadId: string(payload, "threadId"),
      interactionMode: string(payload, "interactionMode"),
    });
  }

  async respondApproval(payload: Payload): Promise<{ sequence: number }> {
    return this.session(payload).dispatch({
      type: "runtime-request.respond",
      commandId: id(),
      threadId: string(payload, "threadId"),
      requestId: string(payload, "requestId"),
      decision: string(payload, "decision"),
    });
  }

  async respondInput(payload: Payload): Promise<{ sequence: number }> {
    return this.session(payload).dispatch({
      type: "runtime-request.respond",
      commandId: id(),
      threadId: string(payload, "threadId"),
      requestId: string(payload, "requestId"),
      answers: payload.answers,
    });
  }

  async handle(request: BridgeRequest): Promise<unknown> {
    switch (request.type) {
      case "attachment.clipboard.read":
        return this.pasteClipboardImage(request.payload);
      case "attachment.discard":
        return this.discardAttachment(request.payload);
      case "thread.create":
        return this.create(request.payload);
      case "thread.send":
        return this.send(request.payload);
      case "thread.interrupt":
        return this.interrupt(request.payload);
      case "thread.queue.resume":
        return this.manageQueue(request.payload, "resume");
      case "thread.history.load":
        return this.session(request.payload).loadEarlier(string(request.payload, "threadId"));
      case "thread.history.latest":
        return this.session(request.payload).showLatest(string(request.payload, "threadId"));
      case "thread.queue.cancel":
        return this.manageQueue(request.payload, "cancel");
      case "thread.queue.edit":
        return this.manageQueue(request.payload, "edit");
      case "thread.settle":
        return this.settle(request.payload);
      case "thread.unsettle":
        return this.unsettle(request.payload);
      case "thread.snooze":
        return this.snooze(request.payload);
      case "thread.unsnooze":
        return this.unsnooze(request.payload);
      case "thread.pin":
        return this.pin(request.payload);
      case "thread.unpin":
        return this.unpin(request.payload);
      case "thread.model.set":
        return this.setModel(request.payload);
      case "thread.model.option.set":
        return this.setModelOption(request.payload);
      case "thread.rename":
        return this.rename(request.payload);
      case "thread.title.regenerate":
        return this.regenerateTitle(request.payload);
      case "thread.runtime.set":
        return this.setRuntime(request.payload);
      case "thread.interaction.set":
        return this.setInteraction(request.payload);
      case "approval.respond":
        return this.respondApproval(request.payload);
      case "input.respond":
        return this.respondInput(request.payload);
      default:
        throw new BridgeError("UNKNOWN_COMMAND", `Unsupported command ${request.type}.`);
    }
  }

  clearAttachments(): void {
    this.attachments.clear();
  }
}
