import assert from "node:assert/strict";
import test from "node:test";

import type {
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "../upstream/t3code/packages/contracts/src/index.ts";
import { T3Projection } from "../bridge/src/t3/projection.ts";
import type { InboxDto, ThreadDto } from "../bridge/src/protocol/types.ts";
import {
  boundInboxDto,
  boundShellSnapshot,
  boundThread,
  boundThreadDto,
  fitsIpcPayload,
  MAX_IPC_JSON_BYTES,
  MAX_MESSAGE_TEXT_CHARS,
  MAX_SHELL_THREADS,
  MAX_STORED_THREAD_MESSAGES,
  MAX_THREAD_ACTIVITIES,
  selectNewestByUpdatedAt,
  truncateText,
} from "../bridge/src/t3/bounds.ts";
import { event } from "../bridge/src/protocol/output.ts";

function shellThread(id: string, updatedAt: string): OrchestrationThreadShell {
  return {
    id,
    projectId: "project-1",
    title: id,
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  } as unknown as OrchestrationThreadShell;
}

function baseThread(): OrchestrationThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as unknown as OrchestrationThread;
}

function threadStreamEvent(
  type: string,
  payload: Record<string, unknown>,
  index: number,
): Parameters<T3Projection["applyThread"]>[0] {
  return {
    kind: "event",
    event: {
      sequence: index + 1,
      eventId: `event-${index}`,
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-08-31T00:00:00.000Z",
      commandId: `cmd-${index}`,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload,
    },
  } as unknown as Parameters<T3Projection["applyThread"]>[0];
}

test("selectNewestByUpdatedAt keeps the newest items without sorting the full input", () => {
  const threads = Array.from({ length: MAX_SHELL_THREADS + 25 }, (_, index) =>
    shellThread(`thread-${index}`, new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString()),
  );
  const selected = selectNewestByUpdatedAt(threads, MAX_SHELL_THREADS);
  assert.equal(selected.length, MAX_SHELL_THREADS);
  assert.equal(selected[0]?.id, `thread-${MAX_SHELL_THREADS + 24}`);
  assert.equal(selected.at(-1)?.id, "thread-25");
});

test("boundShellSnapshot keeps the newest threads and projects", () => {
  const threads = Array.from({ length: MAX_SHELL_THREADS + 25 }, (_, index) =>
    shellThread(`thread-${index}`, new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString()),
  );
  const snapshot = {
    snapshotSequence: 1,
    updatedAt: "2026-08-31T00:00:00.000Z",
    projects: [{
      id: "project-1",
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    }],
    threads,
  } as unknown as OrchestrationShellSnapshot;

  const bounded = boundShellSnapshot(snapshot);
  assert.equal(bounded.threads.length, MAX_SHELL_THREADS);
  assert.equal(bounded.threads[0]?.id, `thread-${MAX_SHELL_THREADS + 24}`);
});

test("boundThread truncates message text and keeps the newest messages", () => {
  const messages = Array.from({ length: MAX_STORED_THREAD_MESSAGES + 5 }, (_, index) => ({
    id: `message-${index}`,
    role: "assistant" as const,
    text: "x".repeat(MAX_MESSAGE_TEXT_CHARS + 100),
    attachments: [],
    turnId: null,
    streaming: false,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  }));
  const bounded = boundThread({ ...baseThread(), messages } as unknown as OrchestrationThread);
  assert.equal(bounded.messages.length, MAX_STORED_THREAD_MESSAGES);
  assert.equal(bounded.messages.at(-1)?.id, `message-${MAX_STORED_THREAD_MESSAGES + 4}`);
  assert.equal(bounded.messages.at(-1)?.text.length, MAX_MESSAGE_TEXT_CHARS);
});

test("boundActivity strips oversized nested payload fields", () => {
  const activity: OrchestrationThreadActivity = {
    id: "activity-1",
    tone: "neutral",
    kind: "approval.requested",
    summary: "Approve",
    payload: {
      requestId: "req-1",
      requestKind: "command",
      detail: "ok",
      nested: { blob: "z".repeat(100_000) },
    },
    turnId: null,
    createdAt: "2026-08-31T00:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
  const bounded = boundThread({
    ...baseThread(),
    activities: [activity],
  } as unknown as OrchestrationThread);
  const payload = bounded.activities[0]?.payload as Record<string, unknown> | null;
  assert.deepEqual(payload, {
    requestId: "req-1",
    requestKind: "command",
    detail: "ok",
  });
});

test("applyShell re-bounds reducer output after repeated thread upserts", () => {
  const projection = new T3Projection();
  projection.applyShell({
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 1,
      updatedAt: "2026-08-31T00:00:00.000Z",
      projects: [],
      threads: [shellThread("thread-0", "2026-08-31T00:00:00.000Z")],
    },
  } as unknown as Parameters<T3Projection["applyShell"]>[0]);

  for (let index = 1; index <= MAX_SHELL_THREADS + 10; index++) {
    projection.applyShell({
      kind: "thread-upserted",
      sequence: index,
      thread: shellThread(
        `thread-${index}`,
        new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      ),
    } as unknown as Parameters<T3Projection["applyShell"]>[0]);
  }

  assert.equal(projection.shell?.threads.length, MAX_SHELL_THREADS);
});

test("applyThread re-bounds reducer output after repeated message events", () => {
  const projection = new T3Projection();
  projection.applyThread({
    kind: "snapshot",
    snapshot: {
      thread: baseThread(),
      sequence: 1,
    },
  } as unknown as Parameters<T3Projection["applyThread"]>[0]);

  for (let index = 0; index < MAX_STORED_THREAD_MESSAGES + 5; index++) {
    projection.applyThread(
      threadStreamEvent("thread.message-sent", {
        threadId: "thread-1",
        messageId: `message-${index}`,
        role: "assistant",
        text: "hello",
        turnId: null,
        streaming: false,
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z",
      }, index),
    );
  }

  assert.equal(projection.thread?.messages.length, MAX_STORED_THREAD_MESSAGES);
});

test("applyThread re-bounds reducer output after repeated activity appends", () => {
  const projection = new T3Projection();
  projection.applyThread({
    kind: "snapshot",
    snapshot: { thread: baseThread(), sequence: 1 },
  } as unknown as Parameters<T3Projection["applyThread"]>[0]);

  for (let index = 0; index < MAX_THREAD_ACTIVITIES + 5; index++) {
    projection.applyThread(
      threadStreamEvent("thread.activity-appended", {
        threadId: "thread-1",
        activity: {
          id: `activity-${index}`,
          tone: "neutral",
          kind: "tool.started",
          summary: "Working",
          payload: { blob: "x".repeat(50_000) },
          turnId: null,
          createdAt: "2026-08-31T00:00:00.000Z",
        },
      }, index),
    );
  }

  assert.equal(projection.thread?.activities.length, MAX_THREAD_ACTIVITIES);
  const payload = projection.thread?.activities.at(-1)?.payload as Record<string, unknown> | null;
  assert.equal(payload, null);
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
  assert.ok(fitsIpcPayload(event("thread.snapshot", boundThreadDto(thread))));
  assert.ok(ipcJsonByteLength(event("thread.snapshot", boundThreadDto(thread))) <= MAX_IPC_JSON_BYTES);
});

function ipcJsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
