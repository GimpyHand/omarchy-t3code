import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

import type { InboxDto, ThreadDto } from "../protocol/types.ts";

/** Retained shell snapshot size before projection reducers run. */
export const MAX_SHELL_THREADS = 500;
export const MAX_SHELL_PROJECTS = 100;

/** Retained thread detail size before projection reducers run. */
export const MAX_STORED_THREAD_MESSAGES = 200;
export const MAX_THREAD_ACTIVITIES = 64;
export const MAX_THREAD_CHECKPOINTS = 50;
export const MAX_CHECKPOINT_FILES = 100;
export const MAX_MESSAGE_ATTACHMENTS = 8;

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

function head<T>(items: readonly T[], max: number): T[] {
  return items.length <= max ? [...items] : items.slice(0, max);
}

function byUpdatedAt<T extends { updatedAt: string; id: string }>(left: T, right: T): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id);
}

function boundMessage(message: OrchestrationMessage): OrchestrationMessage {
  return {
    ...message,
    text: truncateText(message.text, MAX_MESSAGE_TEXT_CHARS),
    attachments: tail(message.attachments ?? [], MAX_MESSAGE_ATTACHMENTS).map((attachment) => ({
      ...attachment,
      name: truncateText(attachment.name, MAX_FIELD_CHARS),
      mimeType: truncateText(attachment.mimeType, MAX_FIELD_CHARS),
    })),
  };
}

function boundCheckpoint(checkpoint: OrchestrationCheckpointSummary): OrchestrationCheckpointSummary {
  return {
    ...checkpoint,
    files: tail(checkpoint.files, MAX_CHECKPOINT_FILES).map((file) => ({
      ...file,
      path: truncateText(file.path, MAX_FIELD_CHARS),
    })),
  };
}

function boundActivity(activity: OrchestrationThreadActivity): OrchestrationThreadActivity {
  return {
    ...activity,
    kind: truncateText(activity.kind, MAX_FIELD_CHARS),
    summary: truncateText(activity.summary, MAX_FIELD_CHARS),
  };
}

function boundThreadShell(thread: OrchestrationThreadShell): OrchestrationThreadShell {
  return {
    ...thread,
    title: truncateText(thread.title, MAX_FIELD_CHARS),
    branch: boundOptionalText(thread.branch),
    worktreePath: boundOptionalText(thread.worktreePath),
    pinOrderKey: boundOptionalText(thread.pinOrderKey),
    planProgress: thread.planProgress
      ? {
          ...thread.planProgress,
          step: truncateText(thread.planProgress.step, MAX_FIELD_CHARS),
        }
      : thread.planProgress,
  };
}

export function boundThread(thread: OrchestrationThread): OrchestrationThread {
  return {
    ...thread,
    title: truncateText(thread.title, MAX_FIELD_CHARS),
    branch: boundOptionalText(thread.branch),
    worktreePath: boundOptionalText(thread.worktreePath),
    pinOrderKey: boundOptionalText(thread.pinOrderKey),
    messages: tail(thread.messages, MAX_STORED_THREAD_MESSAGES).map(boundMessage),
    activities: tail(thread.activities, MAX_THREAD_ACTIVITIES).map(boundActivity),
    checkpoints: tail(thread.checkpoints, MAX_THREAD_CHECKPOINTS).map(boundCheckpoint),
    proposedPlans: tail(thread.proposedPlans ?? [], 32).map((plan) => ({
      ...plan,
      planMarkdown: truncateText(plan.planMarkdown, MAX_MESSAGE_TEXT_CHARS),
    })),
    session: thread.session
      ? {
          ...thread.session,
          lastError: boundOptionalText(thread.session.lastError, MAX_MESSAGE_TEXT_CHARS),
        }
      : thread.session,
  };
}

export function boundShellSnapshot(snapshot: OrchestrationShellSnapshot): OrchestrationShellSnapshot {
  return {
    ...snapshot,
    projects: head([...snapshot.projects].sort(byUpdatedAt), MAX_SHELL_PROJECTS).map((project) => ({
      ...project,
      title: truncateText(project.title, MAX_FIELD_CHARS),
      workspaceRoot: truncateText(project.workspaceRoot, MAX_FIELD_CHARS),
      faviconPath: boundOptionalText(project.faviconPath),
    })),
    threads: head([...snapshot.threads].sort(byUpdatedAt), MAX_SHELL_THREADS).map(boundThreadShell),
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
    return {
      ...item,
      project: {
        ...item.project,
        title: truncateText(item.project.title, MAX_FIELD_CHARS),
        workspaceRoot: truncateText(item.project.workspaceRoot, MAX_FIELD_CHARS),
        faviconPath: boundOptionalText(item.project.faviconPath),
      },
    };
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
      questions: tail(input.questions, 16).map((question) => ({
        ...question,
        header: truncateText(question.header, MAX_FIELD_CHARS),
        question: truncateText(question.question, MAX_MESSAGE_TEXT_CHARS),
        options: tail(question.options, 32).map((option) => ({
          ...option,
          label: truncateText(option.label, MAX_FIELD_CHARS),
          description: truncateText(option.description, MAX_FIELD_CHARS),
        })),
      })),
    })),
    modelOptions: tail(thread.modelOptions, 32).map((option) => ({
      ...option,
      label: truncateText(option.label, MAX_FIELD_CHARS),
      description: boundOptionalText(option.description),
      currentValue: truncateText(option.currentValue, MAX_FIELD_CHARS),
      choices: tail(option.choices, 32).map((choice) => ({
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
