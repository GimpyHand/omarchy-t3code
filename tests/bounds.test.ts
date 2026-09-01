import assert from "node:assert/strict";
import test from "node:test";

import type { OrchestrationShellSnapshot, OrchestrationThread } from "../upstream/t3code/packages/contracts/src/index.ts";

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
  truncateText,
} from "../bridge/src/t3/bounds.ts";
import { event } from "../bridge/src/protocol/output.ts";

function shellThread(id: string, updatedAt: string) {
  return {
    id,
    projectId: "project-1",
    title: id,
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
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
  };
}

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
  assert.equal(bounded.threads.at(0)?.id, `thread-${MAX_SHELL_THREADS + 24}`);
  assert.equal(bounded.threads.at(-1)?.id, `thread-25`);
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
  const thread = {
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as unknown as OrchestrationThread;

  const bounded = boundThread(thread);
  assert.equal(bounded.messages.length, MAX_STORED_THREAD_MESSAGES);
  assert.equal(bounded.messages.at(-1)?.id, `message-${MAX_STORED_THREAD_MESSAGES + 4}`);
  assert.equal(bounded.messages.at(-1)?.text.length, MAX_MESSAGE_TEXT_CHARS);
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
      title: truncateText(`title-${index}-${huge}`, 4096),
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
