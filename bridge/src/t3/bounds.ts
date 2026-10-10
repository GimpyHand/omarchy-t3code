import {
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadProjection,
  type OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

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
export const MAX_IPC_QUEUE_MESSAGES = 16;
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

function compareUpdatedAt<T extends { updatedAt: string | DateTime.Utc; id: string }>(
  left: T,
  right: T,
): number {
  return (
    (typeof left.updatedAt === "string"
      ? Date.parse(left.updatedAt)
      : DateTime.toEpochMillis(left.updatedAt)) -
      (typeof right.updatedAt === "string"
        ? Date.parse(right.updatedAt)
        : DateTime.toEpochMillis(right.updatedAt)) || left.id.localeCompare(right.id)
  );
}

/** Keep the newest `limit` items without sorting an unbounded remote array. */
export function selectNewestByUpdatedAt<T extends { updatedAt: string | DateTime.Utc; id: string }>(
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

const collectionLimits: Readonly<Record<string, number>> = {
  threads: MAX_SHELL_THREADS,
  archivedThreads: MAX_SHELL_THREADS,
  projects: MAX_SHELL_PROJECTS,
  messages: MAX_STORED_THREAD_MESSAGES,
  turnItems: MAX_STORED_THREAD_MESSAGES,
  visibleTurnItems: MAX_STORED_THREAD_MESSAGES,
  runtimeRequests: MAX_THREAD_ACTIVITIES,
  checkpoints: MAX_THREAD_CHECKPOINTS,
  files: MAX_CHECKPOINT_FILES,
  attachments: MAX_MESSAGE_ATTACHMENTS,
  scripts: MAX_PROJECT_SCRIPTS,
  questions: MAX_ACTIVITY_QUESTIONS,
  options: MAX_ACTIVITY_OPTIONS,
};

// The RPC schema already strips unknown fields. Preserve DateTime values and
// bound retained collections/text before reducers keep them between events.
function boundProjectionValue(value: unknown, key = "", depth = 0): unknown {
  if (DateTime.isDateTime(value)) return value;
  if (typeof value === "string")
    return truncateText(
      value,
      key === "text" || key === "markdown" ? MAX_MESSAGE_TEXT_CHARS : MAX_FIELD_CHARS,
    );
  if (value === null || typeof value !== "object") return value;
  if (depth >= 16) return null;
  if (key === "input" || key === "output" || key === "nativeMetadata") return null;
  if (Array.isArray(value))
    return tail(value, collectionLimits[key] ?? MAX_STORED_THREAD_MESSAGES).map((item) =>
      boundProjectionValue(item, "", depth + 1),
    );
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 64)
      .map(([name, item]) => [name, boundProjectionValue(item, name, depth + 1)]),
  );
}

export function boundThread(
  thread: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return Schema.decodeUnknownSync(OrchestrationV2ThreadProjection)(boundProjectionValue(thread));
}

export function boundShellSnapshot(
  snapshot: OrchestrationV2ShellSnapshot,
): OrchestrationV2ShellSnapshot {
  return Schema.decodeUnknownSync(OrchestrationV2ShellSnapshot)(
    boundProjectionValue({
      ...snapshot,
      projects: selectNewestByUpdatedAt(snapshot.projects, MAX_SHELL_PROJECTS),
      threads: selectNewestByUpdatedAt(snapshot.threads, MAX_SHELL_THREADS),
      archivedThreads: selectNewestByUpdatedAt(snapshot.archivedThreads, MAX_SHELL_THREADS),
    }),
  );
}

export function boundShellStreamItem(
  item: OrchestrationV2ShellStreamItem,
): OrchestrationV2ShellStreamItem {
  if (item.kind === "snapshot") return { ...item, snapshot: boundShellSnapshot(item.snapshot) };
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
    queue: {
      ...thread.queue,
      messages: thread.queue.messages.slice(0, MAX_IPC_QUEUE_MESSAGES).map((message) => ({
        ...message,
        text: truncateText(message.text, MAX_IPC_MESSAGE_TEXT_CHARS),
        editable: message.editable && message.text.length <= MAX_IPC_MESSAGE_TEXT_CHARS,
      })),
    },
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
