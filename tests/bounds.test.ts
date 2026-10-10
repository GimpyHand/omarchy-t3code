import { ThreadId } from "@t3tools/contracts";
import assert from "node:assert/strict";
import test from "node:test";
import * as DateTime from "effect/DateTime";
import { T3Projection } from "../bridge/src/t3/projection.ts";
import type { InboxDto, ThreadDto } from "../bridge/src/protocol/types.ts";
import { event } from "../bridge/src/protocol/output.ts";
import {
  boundInboxDto,
  boundShellSnapshot,
  boundThread,
  boundThreadDto,
  fitsIpcPayload,
  MAX_IPC_JSON_BYTES,
  MAX_SHELL_THREADS,
  MAX_STORED_THREAD_MESSAGES,
  MAX_MESSAGE_TEXT_CHARS,
  selectNewestByUpdatedAt,
  truncateText,
} from "../bridge/src/t3/bounds.ts";
import {
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
  message,
  eventBase,
  itemBase,
} from "./fixtures/t3.ts";
test("selectNewestByUpdatedAt keeps the newest items without sorting the full input", () => {
  const threads = Array.from({ length: MAX_SHELL_THREADS + 25 }, (_, index) => ({
    id: `thread-${index}`,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
  }));
  const selected = selectNewestByUpdatedAt(threads, MAX_SHELL_THREADS);
  assert.equal(selected.length, MAX_SHELL_THREADS);
  assert.equal(selected[0]?.id, `thread-${MAX_SHELL_THREADS + 24}`);
  assert.equal(selected.at(-1)?.id, "thread-25");
});

test("shell snapshots retain the newest V2 threads and decoded timestamps", () => {
  const threads = Array.from({ length: MAX_SHELL_THREADS + 25 }, (_, index) => ({
    ...v2ThreadShell,
    id: ThreadId.make("thread-" + index),
    updatedAt: DateTime.makeUnsafe(index * 1000),
  }));
  const bounded = boundShellSnapshot({ ...v2ShellSnapshot, threads });
  assert.equal(bounded.threads.length, MAX_SHELL_THREADS);
  assert.equal(bounded.threads[0]?.id, "thread-" + (MAX_SHELL_THREADS + 24));
  assert(DateTime.isDateTime(bounded.threads[0]?.updatedAt));
});

test("V2 projection bounds messages and structured timeline rows", () => {
  const messages = Array.from({ length: MAX_STORED_THREAD_MESSAGES + 5 }, (_, index) =>
    message("x".repeat(MAX_MESSAGE_TEXT_CHARS + 100), false, "message-" + index),
  );
  const bounded = boundThread({ ...v2Projection, messages });
  assert.equal(bounded.messages.length, MAX_STORED_THREAD_MESSAGES);
  assert.equal(bounded.messages.at(-1)?.text.length, MAX_MESSAGE_TEXT_CHARS);
});

test("V2 projection drops nested raw tool payloads from retained state", () => {
  const tool = {
    ...itemBase("tool-1"),
    type: "dynamic_tool" as const,
    toolName: "test",
    input: { blob: "x".repeat(100000) },
    output: { blob: "y".repeat(100000) },
  };
  const bounded = boundThread({ ...v2Projection, turnItems: [tool] });
  const item = bounded.turnItems[0];
  assert.equal(item?.type, "dynamic_tool");
  if (item?.type === "dynamic_tool") {
    assert.equal(item.input, null);
    assert.equal(item.output, null);
  }
});

test("shell reducer output stays bounded across repeated V2 updates", () => {
  const projection = new T3Projection();
  projection.applyShell({ kind: "snapshot", snapshot: { ...v2ShellSnapshot, threads: [] } });
  for (let index = 0; index < MAX_SHELL_THREADS + 5; index++)
    projection.applyShell({
      kind: "thread.updated",
      sequence: index + 2,
      location: "active",
      thread: {
        ...v2ThreadShell,
        id: ThreadId.make("thread-" + index),
        updatedAt: DateTime.makeUnsafe(index * 1000),
      },
    });
  assert.equal(projection.shell?.threads.length, MAX_SHELL_THREADS);
});

test("thread reducer output stays bounded and ignores replayed V2 events", () => {
  const projection = new T3Projection();
  projection.applyThread({ kind: "snapshot", projection: v2Projection, snapshotSequence: 1 });
  for (let index = 0; index < MAX_STORED_THREAD_MESSAGES + 5; index++)
    projection.applyThread({
      kind: "event",
      sequence: index + 2,
      event: {
        ...eventBase(index),
        type: "message.updated",
        payload: message("x".repeat(MAX_MESSAGE_TEXT_CHARS + 100), false, "message-" + index),
      },
    });
  assert.equal(projection.thread?.messages.length, MAX_STORED_THREAD_MESSAGES);
  assert.equal(projection.thread?.messages.at(-1)?.text.length, MAX_MESSAGE_TEXT_CHARS);
  assert.equal(
    projection.applyThread({
      kind: "event",
      sequence: 2,
      event: { ...eventBase(1), type: "message.updated", payload: message("old") },
    }),
    false,
  );
});
test("bounded inbox and thread IPC payloads stay under the NDJSON cap", () => {
  const huge = "z".repeat(MAX_MESSAGE_TEXT_CHARS);
  const inbox: InboxDto = {
    updatedAt: "2026-08-31T00:00:00.000Z",
    capabilities: {
      settlement: true,
      snooze: true,
      pinning: true,
      pinReorder: true,
      titleRegeneration: true,
      threadPagination: true,
    },
    projects: [],
    models: [],
    pinned: [],
    active: Array.from({ length: 400 }, (_, index) => ({
      id: `thread-${index}`,
      environmentId: "env",
      environmentLabel: "env",
      projectId: "project-1",
      project: "Project",
      projectKey: "project-1",
      branch: null,
      title: truncateText(`title-${index}`, 256),
      provider: "codex",
      model: "gpt-5.6",
      phase: "idle",
      lifecycle: "active",
      updatedAt: "2026-08-31T00:00:00.000Z",
      latestActivityAt: "2026-08-31T00:00:00.000Z",
      attention: false,
      pinned: false,
      snoozedUntil: null,
      settled: false,
      canPin: true,
      canSettle: true,
      canSnooze: true,
    })),
    snoozed: [],
    settled: [],
  };
  const thread: ThreadDto = {
    environmentId: "env",
    environmentLabel: "env",
    id: "thread-1",
    projectId: "project-1",
    project: "Project",
    branch: null,
    title: "Thread",
    provider: "codex",
    model: "gpt-5.6",
    modelOptions: [],
    runtimeMode: "full-access",
    interactionMode: "default",
    titleRegenerating: false,
    phase: "idle",
    activeWorkStartedAt: null,
    lifecycle: "active",
    sessionError: null,
    capabilities: inbox.capabilities,
    queue: { held: true, canManage: true, total: 30, messages: Array.from({ length: 30 }, (_, index) => ({
      runId: `queued-${index}`, text: huge, editable: true, attachmentCount: 1,
    })) },
    history: { hasMore: false, browsing: false, loading: false, error: null },
    messages: Array.from({ length: MAX_STORED_THREAD_MESSAGES + 10 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant",
      text: huge,
      streaming: false,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      attachments: [],
    })),
    diffs: [],
    approvals: [],
    inputs: [],
    updatedAt: "2026-08-31T00:00:00.000Z",
  };

  assert.ok(fitsIpcPayload(event("inbox.changed", boundInboxDto(inbox))));
  const boundedQueue = boundThreadDto(thread).queue;
  assert.equal(boundedQueue.total, 30);
  assert.equal(boundedQueue.messages.length, 16);
  assert.equal(boundedQueue.messages[0]?.text.length, 4096);
  assert.equal(boundedQueue.messages[0]?.editable, false);
  assert.ok(fitsIpcPayload(event("thread.snapshot", boundThreadDto(thread))));
  assert.ok(
    ipcJsonByteLength(event("thread.snapshot", boundThreadDto(thread))) <= MAX_IPC_JSON_BYTES,
  );
});

function ipcJsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
