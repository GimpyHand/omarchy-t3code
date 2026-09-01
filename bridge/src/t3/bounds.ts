import type {
  ModelSelection,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationSession,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  ProjectScript,
} from "@t3tools/contracts";

import type { InboxDto, ThreadDto } from "../protocol/types.ts";

/** Retained shell snapshot size after projection reducers run. */
export const MAX_SHELL_THREADS = 500;
export const MAX_SHELL_PROJECTS = 100;

/** Single-pass selection ceiling before bounding retained shell arrays. */
export const MAX_INCOMING_SHELL_THREADS = 2_000;
export const MAX_INCOMING_SHELL_PROJECTS = 400;

/** Retained thread detail size after projection reducers run. */
export const MAX_STORED_THREAD_MESSAGES = 200;
export const MAX_THREAD_ACTIVITIES = 64;
export const MAX_THREAD_CHECKPOINTS = 50;
export const MAX_CHECKPOINT_FILES = 100;
export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_PROJECT_SCRIPTS = 16;
export const MAX_MODEL_OPTIONS = 32;
export const MAX_ACTIVITY_QUESTIONS = 16;
export const MAX_ACTIVITY_OPTIONS = 32;

/** String and IPC payload caps for bridge ↔ QML NDJSON. */
export const MAX_MESSAGE_TEXT_CHARS = 32_768;
export const MAX_FIELD_CHARS = 4_096;
export const MAX_MESSAGE_DELTA_CHARS = 8_192;
export const MAX_INBOX_THREADS_PER_SECTION = 200;
export const MAX_INBOX_SUMMARY_TITLE_CHARS = 256;
export const MAX_IPC_THREAD_MESSAGES = 64;
export const MAX_IPC_MESSAGE_TEXT_CHARS = 4_096;
export const MAX_IPC_JSON_BYTES = 512 * 1024;
export const MAX_IPC_LINE_CHARS = MAX_IPC_JSON_BYTES;

export function truncateText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function boundOptionalText(value: string | null | undefined, max = MAX_FIELD_CHARS): string | null {
  if (value === null || value === undefined) return null;
  return truncateText(value, max);
}

function tail<T>(items: readonly T[], max: number): T[] {
  return items.length <= max ? [...items] : items.slice(items.length - max);
}

function compareUpdatedAt<T extends { updatedAt: string; id: string }>(left: T, right: T): number {
  return Date.parse(left.updatedAt) - Date.parse(right.updatedAt) || left.id.localeCompare(right.id);
}

/** Keep the newest `limit` items without sorting an unbounded remote array. */
export function selectNewestByUpdatedAt<T extends { updatedAt: string; id: string }>(
  items: readonly T[],
  limit: number,
): T[] {
  if (items.length <= limit) {
    return [...items].sort((left, right) => compareUpdatedAt(right, left));
  }
  const selected = items.slice(0, limit).map((item) => item);
  for (let index = limit; index < items.length; index++) {
    const candidate = items[index]!;
    let oldestIdx = 0;
    for (let slot = 1; slot < selected.length; slot++) {
      if (compareUpdatedAt(selected[slot]!, selected[oldestIdx]!) < 0) oldestIdx = slot;
    }
    if (compareUpdatedAt(candidate, selected[oldestIdx]!) > 0) {
      selected[oldestIdx] = candidate;
    }
  }
  return selected.sort((left, right) => compareUpdatedAt(right, left));
}

function boundModelOptions(
  options: NonNullable<ModelSelection["options"]>,
): NonNullable<ModelSelection["options"]> {
  return tail(options, MAX_MODEL_OPTIONS).map((option) => ({
    id: truncateText(option.id, MAX_FIELD_CHARS),
    value:
      typeof option.value === "boolean"
        ? option.value
        : truncateText(option.value, MAX_FIELD_CHARS),
  }));
}

function boundModelSelection(selection: ModelSelection): ModelSelection {
  return {
    instanceId: truncateText(selection.instanceId, MAX_FIELD_CHARS) as ModelSelection["instanceId"],
    model: truncateText(selection.model, MAX_FIELD_CHARS),
    ...(selection.options !== undefined
      ? { options: boundModelOptions(selection.options) }
      : {}),
  };
}

function boundProjectScript(script: ProjectScript): ProjectScript {
  return {
    id: truncateText(script.id, MAX_FIELD_CHARS),
    name: truncateText(script.name, MAX_FIELD_CHARS),
    command: truncateText(script.command, MAX_FIELD_CHARS),
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    ...(script.previewUrl !== undefined
      ? { previewUrl: truncateText(script.previewUrl, MAX_FIELD_CHARS) }
      : {}),
    ...(script.autoOpenPreview !== undefined ? { autoOpenPreview: script.autoOpenPreview } : {}),
  };
}

function boundSession(session: OrchestrationSession): OrchestrationSession {
  return {
    threadId: session.threadId,
    status: session.status,
    providerName: boundOptionalText(session.providerName),
    ...(session.providerInstanceId !== undefined
      ? {
          providerInstanceId: truncateText(session.providerInstanceId, MAX_FIELD_CHARS) as NonNullable<
            OrchestrationSession["providerInstanceId"]
          >,
        }
      : {}),
    runtimeMode: session.runtimeMode,
    activeTurnId: session.activeTurnId,
    lastError: boundOptionalText(session.lastError, MAX_MESSAGE_TEXT_CHARS),
    updatedAt: session.updatedAt,
  };
}

function boundActivityPayload(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  const bounded: Record<string, unknown> = {};
  if (typeof source.requestId === "string") {
    bounded.requestId = truncateText(source.requestId, MAX_FIELD_CHARS);
  }
  if (typeof source.requestKind === "string") {
    bounded.requestKind = truncateText(source.requestKind, MAX_FIELD_CHARS);
  }
  if (typeof source.requestType === "string") {
    bounded.requestType = truncateText(source.requestType, MAX_FIELD_CHARS);
  }
  if (typeof source.detail === "string") {
    bounded.detail = truncateText(source.detail, MAX_MESSAGE_TEXT_CHARS);
  }
  if (Array.isArray(source.questions)) {
    bounded.questions = tail(source.questions, MAX_ACTIVITY_QUESTIONS).flatMap((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string"
        || typeof question.header !== "string"
        || typeof question.question !== "string"
        || !Array.isArray(question.options)
      ) return [];
      return [{
        id: truncateText(question.id, MAX_FIELD_CHARS),
        header: truncateText(question.header, MAX_FIELD_CHARS),
        question: truncateText(question.question, MAX_MESSAGE_TEXT_CHARS),
        multiSelect: question.multiSelect === true,
        options: tail(question.options, MAX_ACTIVITY_OPTIONS).flatMap((option) => {
          if (option === null || typeof option !== "object" || Array.isArray(option)) return [];
          const row = option as Record<string, unknown>;
          return typeof row.label === "string" && typeof row.description === "string"
            ? [{
                label: truncateText(row.label, MAX_FIELD_CHARS),
                description: truncateText(row.description, MAX_FIELD_CHARS),
              }]
            : [];
        }),
      }];
    });
  }
  return Object.keys(bounded).length > 0 ? bounded : null;
}

function boundMessage(message: OrchestrationMessage): OrchestrationMessage {
  return {
    id: message.id,
    role: message.role,
    text: truncateText(message.text, MAX_MESSAGE_TEXT_CHARS),
    ...(message.attachments !== undefined
      ? {
          attachments: tail(message.attachments, MAX_MESSAGE_ATTACHMENTS).map((attachment) => ({
            type: attachment.type,
            id: truncateText(attachment.id, MAX_FIELD_CHARS),
            name: truncateText(attachment.name, MAX_FIELD_CHARS),
            mimeType: truncateText(attachment.mimeType, MAX_FIELD_CHARS),
            sizeBytes: attachment.sizeBytes,
          })),
        }
      : {}),
    turnId: message.turnId,
    streaming: message.streaming,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function boundCheckpoint(checkpoint: OrchestrationCheckpointSummary): OrchestrationCheckpointSummary {
  return {
    turnId: checkpoint.turnId,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    status: checkpoint.status,
    files: tail(checkpoint.files, MAX_CHECKPOINT_FILES).map((file) => ({
      path: truncateText(file.path, MAX_FIELD_CHARS),
      kind: truncateText(file.kind, MAX_FIELD_CHARS),
      additions: file.additions,
      deletions: file.deletions,
    })),
    assistantMessageId: checkpoint.assistantMessageId,
    completedAt: checkpoint.completedAt,
  };
}

function boundActivity(activity: OrchestrationThreadActivity): OrchestrationThreadActivity {
  return {
    id: activity.id,
    tone: activity.tone,
    kind: truncateText(activity.kind, MAX_FIELD_CHARS),
    summary: truncateText(activity.summary, MAX_FIELD_CHARS),
    payload: boundActivityPayload(activity.payload),
    turnId: activity.turnId,
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    createdAt: activity.createdAt,
  };
}

function boundThreadShell(thread: OrchestrationThreadShell): OrchestrationThreadShell {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: truncateText(thread.title, MAX_FIELD_CHARS),
    modelSelection: boundModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: boundOptionalText(thread.branch),
    worktreePath: boundOptionalText(thread.worktreePath),
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    snoozedUntil: thread.snoozedUntil,
    snoozedAt: thread.snoozedAt,
    pinnedAt: thread.pinnedAt,
    pinOrderKey: boundOptionalText(thread.pinOrderKey),
    titleRegeneration: thread.titleRegeneration,
    session: thread.session ? boundSession(thread.session) : thread.session,
    latestUserMessageAt: thread.latestUserMessageAt,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    backgroundLiveness: thread.backgroundLiveness,
    planProgress: thread.planProgress
      ? {
          ...thread.planProgress,
          step: truncateText(thread.planProgress.step, MAX_FIELD_CHARS),
        }
      : thread.planProgress,
  };
}

function boundRepositoryIdentity(
  identity: Exclude<OrchestrationProjectShell["repositoryIdentity"], undefined>,
): Exclude<OrchestrationProjectShell["repositoryIdentity"], undefined> {
  if (identity === null) return null;
  return {
    canonicalKey: truncateText(identity.canonicalKey, MAX_FIELD_CHARS),
    locator: {
      source: identity.locator.source,
      remoteName: truncateText(identity.locator.remoteName, MAX_FIELD_CHARS),
      remoteUrl: truncateText(identity.locator.remoteUrl, MAX_FIELD_CHARS),
    },
    ...(identity.rootPath != null
      ? { rootPath: truncateText(identity.rootPath, MAX_FIELD_CHARS) }
      : {}),
    ...(identity.displayName != null
      ? { displayName: truncateText(identity.displayName, MAX_FIELD_CHARS) }
      : {}),
    ...(identity.provider != null
      ? { provider: truncateText(identity.provider, MAX_FIELD_CHARS) }
      : {}),
    ...(identity.owner != null ? { owner: truncateText(identity.owner, MAX_FIELD_CHARS) } : {}),
    ...(identity.name != null ? { name: truncateText(identity.name, MAX_FIELD_CHARS) } : {}),
  };
}

function boundProjectShell(project: OrchestrationProjectShell): OrchestrationProjectShell {
  return {
    id: project.id,
    title: truncateText(project.title, MAX_FIELD_CHARS),
    workspaceRoot: truncateText(project.workspaceRoot, MAX_FIELD_CHARS),
    ...(project.repositoryIdentity !== undefined
      ? { repositoryIdentity: boundRepositoryIdentity(project.repositoryIdentity) }
      : {}),
    defaultModelSelection: project.defaultModelSelection
      ? boundModelSelection(project.defaultModelSelection)
      : project.defaultModelSelection,
    defaultThreadEnvMode: project.defaultThreadEnvMode,
    faviconPath: boundOptionalText(project.faviconPath),
    scripts: tail(project.scripts, MAX_PROJECT_SCRIPTS).map(boundProjectScript),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function boundThread(thread: OrchestrationThread): OrchestrationThread {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: truncateText(thread.title, MAX_FIELD_CHARS),
    modelSelection: boundModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: boundOptionalText(thread.branch),
    worktreePath: boundOptionalText(thread.worktreePath),
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    snoozedUntil: thread.snoozedUntil,
    snoozedAt: thread.snoozedAt,
    pinnedAt: thread.pinnedAt,
    pinOrderKey: boundOptionalText(thread.pinOrderKey),
    titleRegeneration: thread.titleRegeneration,
    deletedAt: thread.deletedAt,
    messages: tail(thread.messages, MAX_STORED_THREAD_MESSAGES).map(boundMessage),
    proposedPlans: tail(thread.proposedPlans ?? [], 32).map((plan) => ({
      id: plan.id,
      turnId: plan.turnId,
      planMarkdown: truncateText(plan.planMarkdown, MAX_MESSAGE_TEXT_CHARS),
      implementedAt: plan.implementedAt,
      implementationThreadId: plan.implementationThreadId,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    })),
    activities: tail(thread.activities, MAX_THREAD_ACTIVITIES).map(boundActivity),
    checkpoints: tail(thread.checkpoints, MAX_THREAD_CHECKPOINTS).map(boundCheckpoint),
    session: thread.session ? boundSession(thread.session) : thread.session,
  };
}

export function boundShellSnapshot(snapshot: OrchestrationShellSnapshot): OrchestrationShellSnapshot {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    updatedAt: snapshot.updatedAt,
    projects: selectNewestByUpdatedAt(snapshot.projects, MAX_SHELL_PROJECTS).map(boundProjectShell),
    threads: selectNewestByUpdatedAt(snapshot.threads, MAX_SHELL_THREADS).map(boundThreadShell),
  };
}

export function boundShellStreamItem(item: OrchestrationShellStreamItem): OrchestrationShellStreamItem {
  if (item.kind === "snapshot") {
    return { kind: "snapshot", snapshot: boundShellSnapshot(item.snapshot) };
  }
  if (item.kind === "thread-upserted") {
    return { ...item, thread: boundThreadShell(item.thread) };
  }
  if (item.kind === "project-upserted") {
    return { ...item, project: boundProjectShell(item.project) };
  }
  return item;
}

function boundThreadSummaries<T extends InboxDto["pinned"][number]>(items: readonly T[]): T[] {
  return tail(items, MAX_INBOX_THREADS_PER_SECTION).map((item) => ({
    ...item,
    title: truncateText(item.title, MAX_INBOX_SUMMARY_TITLE_CHARS),
    project: truncateText(item.project, MAX_INBOX_SUMMARY_TITLE_CHARS),
    branch: boundOptionalText(item.branch, MAX_INBOX_SUMMARY_TITLE_CHARS),
    environmentLabel: truncateText(item.environmentLabel, MAX_FIELD_CHARS),
  }));
}

export function boundInboxDto(inbox: InboxDto): InboxDto {
  return {
    ...inbox,
    projects: tail(inbox.projects, MAX_SHELL_PROJECTS).map((project) => ({
      ...project,
      title: truncateText(project.title, MAX_FIELD_CHARS),
      projectKey: truncateText(project.projectKey, MAX_FIELD_CHARS),
      environmentLabel: truncateText(project.environmentLabel, MAX_FIELD_CHARS),
    })),
    models: tail(inbox.models, 64),
    pinned: boundThreadSummaries(inbox.pinned),
    active: boundThreadSummaries(inbox.active),
    snoozed: boundThreadSummaries(inbox.snoozed),
    settled: boundThreadSummaries(inbox.settled),
  };
}

export function boundThreadDto(thread: ThreadDto): ThreadDto {
  return {
    ...thread,
    title: truncateText(thread.title, MAX_FIELD_CHARS),
    project: truncateText(thread.project, MAX_FIELD_CHARS),
    branch: boundOptionalText(thread.branch),
    environmentLabel: truncateText(thread.environmentLabel, MAX_FIELD_CHARS),
    sessionError: boundOptionalText(thread.sessionError, MAX_MESSAGE_TEXT_CHARS),
    messages: tail(thread.messages, MAX_IPC_THREAD_MESSAGES).map((message) => ({
      ...message,
      text: truncateText(message.text, MAX_IPC_MESSAGE_TEXT_CHARS),
      attachments: tail(message.attachments, MAX_MESSAGE_ATTACHMENTS).map((attachment) => ({
        ...attachment,
        name: truncateText(attachment.name, MAX_FIELD_CHARS),
        mimeType: truncateText(attachment.mimeType, MAX_FIELD_CHARS),
      })),
    })),
    diffs: tail(thread.diffs, MAX_THREAD_CHECKPOINTS).map((diff) => ({
      ...diff,
      files: tail(diff.files, MAX_CHECKPOINT_FILES).map((file) => ({
        ...file,
        path: truncateText(file.path, MAX_FIELD_CHARS),
        kind: truncateText(file.kind, MAX_FIELD_CHARS),
      })),
    })),
    approvals: tail(thread.approvals, MAX_THREAD_ACTIVITIES).map((approval) => ({
      ...approval,
      detail: boundOptionalText(approval.detail, MAX_MESSAGE_TEXT_CHARS),
    })),
    inputs: tail(thread.inputs, MAX_THREAD_ACTIVITIES).map((input) => ({
      ...input,
      questions: tail(input.questions, MAX_ACTIVITY_QUESTIONS).map((question) => ({
        ...question,
        header: truncateText(question.header, MAX_FIELD_CHARS),
        question: truncateText(question.question, MAX_MESSAGE_TEXT_CHARS),
        options: tail(question.options, MAX_ACTIVITY_OPTIONS).map((option) => ({
          ...option,
          label: truncateText(option.label, MAX_FIELD_CHARS),
          description: truncateText(option.description, MAX_FIELD_CHARS),
        })),
      })),
    })),
    modelOptions: tail(thread.modelOptions, MAX_MODEL_OPTIONS).map((option) => ({
      ...option,
      label: truncateText(option.label, MAX_FIELD_CHARS),
      description: boundOptionalText(option.description),
      currentValue: truncateText(option.currentValue, MAX_FIELD_CHARS),
      choices: tail(option.choices, MAX_MODEL_OPTIONS).map((choice) => ({
        ...choice,
        label: truncateText(choice.label, MAX_FIELD_CHARS),
        description: boundOptionalText(choice.description),
      })),
    })),
  };
}

export function boundMessageDelta(payload: {
  threadId: string;
  messageId: string;
  delta: string;
}): typeof payload {
  return {
    threadId: truncateText(payload.threadId, MAX_FIELD_CHARS),
    messageId: truncateText(payload.messageId, MAX_FIELD_CHARS),
    delta: truncateText(payload.delta, MAX_MESSAGE_DELTA_CHARS),
  };
}

export function boundIpcEvent(eventName: string, payload: unknown): unknown {
  switch (eventName) {
    case "inbox.changed":
      return boundInboxDto(payload as InboxDto);
    case "thread.snapshot":
      return boundThreadDto(payload as ThreadDto);
    case "message.delta":
      return boundMessageDelta(payload as { threadId: string; messageId: string; delta: string });
    default:
      return payload;
  }
}

export function ipcJsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function fitsIpcPayload(value: unknown, maxBytes = MAX_IPC_JSON_BYTES): boolean {
  return ipcJsonByteLength(value) <= maxBytes;
}
