import assert from "node:assert/strict";
import test from "node:test";
import * as Schema from "effect/Schema";

import { ClientOrchestrationCommand, type OrchestrationShellSnapshot, type ServerConfig } from "../upstream/t3code/packages/contracts/src/index.ts";
import { T3Commands } from "../bridge/src/t3/commands.ts";
import { T3ImageAttachmentStore } from "../bridge/src/t3/attachments.ts";
import type { T3EnvironmentSession } from "../bridge/src/t3/session.ts";

function harness(
  capabilities = { threadSettlement: true, threadSnooze: true, threadPinning: true, threadTitleRegeneration: true },
  attachments?: T3ImageAttachmentStore,
) {
  const dispatched: Array<Record<string, unknown>> = [];
  const shell = {
    snapshotSequence: 1,
    projects: [{
      id: "project-1",
      title: "Project",
      workspaceRoot: "/workspace",
      repositoryIdentity: null,
      defaultModelSelection: { instanceId: "codex", model: "gpt-5.6" },
      scripts: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }],
    threads: [{
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "default" },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: { turnId: "turn-1", state: "running", requestedAt: "2026-08-22T00:00:00.000Z", startedAt: "2026-08-22T00:00:01.000Z", completedAt: null, assistantMessageId: null },
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    }],
    updatedAt: "2026-08-22T00:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;
  const config = {
    environment: { capabilities },
    providers: [{
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      availability: "available",
      models: [{
        slug: "gpt-5.6",
        capabilities: {
          optionDescriptors: [{
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
            ],
            currentValue: "high",
          }, {
            id: "serviceTier",
            label: "Service Tier",
            type: "select",
            options: [
              { id: "default", label: "Standard", isDefault: true },
              { id: "fast", label: "Fast", description: "1.5x speed, increased usage" },
            ],
            currentValue: "default",
          }],
        },
      }],
    }],
  } as unknown as ServerConfig;
  const session = {
    projection: {
      shell,
      config,
      models: () => [],
    },
    dispatch: async (command: unknown) => {
      const decoded = Schema.decodeUnknownSync(ClientOrchestrationCommand)(command);
      dispatched.push(decoded as unknown as Record<string, unknown>);
      return { sequence: dispatched.length };
    },
  } as unknown as T3EnvironmentSession;
  return { commands: new T3Commands(() => session, attachments), dispatched };
}

test("thread creation uses Nightly atomic bootstrap + a supervised access fallback", async () => {
  const { commands, dispatched } = harness();
  const result = await commands.create({
    environmentId: "environment-1", projectId: "project-1", prompt: "Investigate the failure" });
  assert.equal(result.sequence, 1);
  const command = dispatched[0];
  assert.equal(command?.type, "thread.turn.start");
  assert.equal((command?.bootstrap as { createThread: { projectId: string } }).createThread.projectId, "project-1");
  assert.equal((command?.message as { text: string }).text, "Investigate the failure");
  assert.equal(command?.runtimeMode, "approval-required");
  assert.equal(
    (command?.bootstrap as { createThread: { runtimeMode: string } }).createThread.runtimeMode,
    "approval-required",
  );
});

test("thread creation applies advertised model options and access level", async () => {
  const { commands, dispatched } = harness();
  await commands.create({
    environmentId: "environment-1",
    projectId: "project-1",
    prompt: "Investigate the failure",
    providerInstanceId: "codex",
    model: "gpt-5.6",
    modelOptions: [
      { id: "reasoningEffort", value: "xhigh" },
      { id: "serviceTier", value: "fast" },
    ],
    runtimeMode: "approval-required",
  });
  assert.deepEqual(dispatched[0]?.modelSelection, {
    instanceId: "codex",
    model: "gpt-5.6",
    options: [
      { id: "reasoningEffort", value: "xhigh" },
      { id: "serviceTier", value: "fast" },
    ],
  });
  assert.equal(dispatched[0]?.runtimeMode, "approval-required");
  assert.equal(
    (dispatched[0]?.bootstrap as { createThread: { runtimeMode: string } }).createThread.runtimeMode,
    "approval-required",
  );
});

test("thread creation rejects unadvertised model option values", async () => {
  const { commands, dispatched } = harness();
  await assert.rejects(
    commands.create({
    environmentId: "environment-1",
      projectId: "project-1",
      prompt: "Investigate the failure",
      providerInstanceId: "codex",
      model: "gpt-5.6",
      modelOptions: [{ id: "reasoningEffort", value: "unsupported" }],
    }),
    (error: unknown) => (error as { code?: string }).code === "MODEL_OPTION_INVALID",
  );
  assert.equal(dispatched.length, 0);
});

test("lifecycle, turns, approvals, and input map to real orchestration commands", async () => {
  const { commands, dispatched } = harness();
  await commands.send({
    environmentId: "environment-1", threadId: "thread-1", text: "Continue" });
  await commands.interrupt({
    environmentId: "environment-1", threadId: "thread-1" });
  await commands.settle({
    environmentId: "environment-1", threadId: "thread-1" });
  await commands.unsettle({ threadId: "thread-1" });
  await commands.snooze({
    environmentId: "environment-1", threadId: "thread-1", until: "2026-08-23T00:00:00.000Z" });
  await commands.unsnooze({ threadId: "thread-1" });
  await commands.pin({
    environmentId: "environment-1", threadId: "thread-1" });
  await commands.unpin({ threadId: "thread-1" });
  await commands.rename({
    environmentId: "environment-1", threadId: "thread-1", title: "Renamed" });
  await commands.regenerateTitle({
    environmentId: "environment-1", threadId: "thread-1" });
  await commands.respondApproval({
    environmentId: "environment-1", threadId: "thread-1", requestId: "approval-1", decision: "acceptForSession" });
  await commands.respondInput({
    environmentId: "environment-1", threadId: "thread-1", requestId: "input-1", answers: { choice: "Yes" } });
  assert.deepEqual(dispatched.map((command) => command.type), [
    "thread.turn.start",
    "thread.turn.interrupt",
    "thread.settle",
    "thread.unsettle",
    "thread.snooze",
    "thread.unsnooze",
    "thread.pin",
    "thread.unpin",
    "thread.meta.update",
    "thread.meta.update",
    "thread.approval.respond",
    "thread.user-input.respond",
  ]);
  assert.equal(dispatched[3]?.reason, "user");
  assert.equal(dispatched[5]?.reason, "user");
  assert.equal(dispatched[8]?.title, "Renamed");
  assert.equal(dispatched[9]?.regenerateTitle, true);
});

test("unsupported server capabilities reject lifecycle mutation locally", async () => {
  const { commands } = harness({ threadSettlement: false, threadSnooze: false, threadPinning: false, threadTitleRegeneration: false });
  await assert.rejects(commands.settle({
    environmentId: "environment-1", threadId: "thread-1" }), (error: unknown) => (error as { code?: string }).code === "CAPABILITY_UNSUPPORTED");
  await assert.rejects(commands.snooze({
    environmentId: "environment-1", threadId: "thread-1", until: "2026-08-23T00:00:00.000Z" }), (error: unknown) => (error as { code?: string }).code === "CAPABILITY_UNSUPPORTED");
  await assert.rejects(commands.pin({
    environmentId: "environment-1", threadId: "thread-1" }), (error: unknown) => (error as { code?: string }).code === "CAPABILITY_UNSUPPORTED");
  await assert.rejects(commands.regenerateTitle({
    environmentId: "environment-1", threadId: "thread-1" }), (error: unknown) => (error as { code?: string }).code === "CAPABILITY_UNSUPPORTED");
});

test("model option changes are capability-validated and persisted with the full selection", async () => {
  const { commands, dispatched } = harness();
  await commands.setModelOption({
    environmentId: "environment-1", threadId: "thread-1", optionId: "reasoningEffort", value: "xhigh" });
  assert.deepEqual(dispatched[0]?.modelSelection, {
    instanceId: "codex",
    model: "gpt-5.6",
    options: [
      { id: "reasoningEffort", value: "xhigh" },
      { id: "serviceTier", value: "default" },
    ],
  });
  await assert.rejects(
    commands.setModelOption({
    environmentId: "environment-1", threadId: "thread-1", optionId: "reasoningEffort", value: "unsupported" }),
    (error: unknown) => (error as { code?: string }).code === "MODEL_OPTION_INVALID",
  );
});

test("turn dispatch preserves options for the selected model", async () => {
  const { commands, dispatched } = harness();
  await commands.send({
    environmentId: "environment-1",
    threadId: "thread-1",
    text: "Continue",
    providerInstanceId: "codex",
    model: "gpt-5.6",
  });
  assert.deepEqual(dispatched[0]?.modelSelection, {
    instanceId: "codex",
    model: "gpt-5.6",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "default" },
    ],
  });
});

test("screenshot-only turns dispatch actual pinned upload attachments and consume their staging ids", async () => {
  const bytes = Buffer.from("screenshot");
  const attachments = new T3ImageAttachmentStore(async () => ({ mimeType: "image/png", bytes }));
  const { commands, dispatched } = harness(undefined, attachments);
  const draft = await commands.pasteClipboardImage({
    environmentId: "environment-1", threadId: "thread-1" });

  await commands.send({
    environmentId: "environment-1", threadId: "thread-1", text: "", attachmentIds: [draft.id] });

  assert.deepEqual((dispatched[0]?.message as { text: string; attachments: unknown[] }).attachments, [{
    type: "image",
    name: "pasted-screenshot.png",
    mimeType: "image/png",
    sizeBytes: bytes.byteLength,
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
  }]);
  assert.equal((dispatched[0]?.message as { text: string }).text, "");
  assert.throws(
    () => attachments.resolve("thread-1", [draft.id]),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_NOT_FOUND",
  );
});
