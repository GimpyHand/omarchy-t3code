import { ThreadId } from "@t3tools/contracts";
import assert from "node:assert/strict";
import test from "node:test";
import * as Schema from "effect/Schema";

import {
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
  ChatAttachment,
  RunId,
  type OrchestrationV2ShellSnapshot,
  type ServerConfig,
} from "../upstream/t3code/packages/contracts/src/index.ts";
import { T3Commands } from "../bridge/src/t3/commands.ts";
import { T3ImageAttachmentStore } from "../bridge/src/t3/attachments.ts";
import { T3EnvironmentSession } from "../bridge/src/t3/session.ts";

import { v2ShellSnapshot, v2ThreadShell, v2Projection, v2Project } from "./fixtures/t3.ts";

function harness(
  capabilities = {
    threadSettlement: true,
    threadSnooze: true,
    threadPinning: true,
    threadTitleRegeneration: true,
  },
  attachments?: T3ImageAttachmentStore,
) {
  const dispatched: Array<Record<string, unknown>> = [];
  const selection = {
    instanceId: v2ThreadShell.modelSelection.instanceId,
    model: "gpt-5.6",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "default" },
    ],
  };
  const shell: OrchestrationV2ShellSnapshot = {
    ...v2ShellSnapshot,
    projects: [{ ...v2Project, id: v2Project.id, defaultModelSelection: selection }],
    threads: [
      {
        ...v2ThreadShell,
        id: ThreadId.make("thread-1"),
        projectId: v2Project.id,
        modelSelection: selection,
        latestRunId: RunId.make("run-1"),
      },
    ],
  };
  const config = {
    environment: { capabilities },
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        availability: "available",
        models: [
          {
            slug: "gpt-5.6",
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High", isDefault: true },
                    { id: "xhigh", label: "Extra High" },
                  ],
                  currentValue: "high",
                },
                {
                  id: "serviceTier",
                  label: "Service Tier",
                  type: "select",
                  options: [
                    { id: "default", label: "Standard", isDefault: true },
                    { id: "fast", label: "Fast", description: "1.5x speed, increased usage" },
                  ],
                  currentValue: "default",
                },
              ],
            },
          },
        ],
      },
    ],
  } as unknown as ServerConfig;
  const session = new T3EnvironmentSession({
    onInbox: () => {},
    onThread: () => {},
    onMessageDelta: () => {},
    onMessageCompleted: () => {},
    onApproval: () => {},
    onInput: () => {},
    onClosed: () => {},
    onError: () => {},
  });
  session.projection.shell = shell;
  session.projection.config = config;
  session.dispatch = async (command) => {
    const decoded = Schema.decodeUnknownSync(OrchestrationV2Command)(command);
    dispatched.push(decoded);
    return { sequence: dispatched.length };
  };
  session.launch = async (command) => {
    const decoded = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput)(command);
    dispatched.push({ type: "thread.launch", ...decoded });
    return {
      threadId: decoded.threadId ?? v2ThreadShell.id,
      projection: v2Projection,
      resumed: false,
    };
  };
  session.persistAttachments = async (_threadId, _messageId, uploads) =>
    uploads.map((upload, index) =>
      Schema.decodeUnknownSync(ChatAttachment)({
        type: upload.type,
        id: "stored-" + index,
        name: upload.name,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
      }),
    );
  return { commands: new T3Commands(() => session, attachments), dispatched, session };
}

test("thread creation uses the atomic V2 launch API with supervised access", async () => {
  const { commands, dispatched } = harness();
  const result = await commands.create({
    environmentId: "environment-1",
    projectId: "project-v2",
    prompt: "Investigate the failure",
  });
  assert(result.threadId);
  assert.equal(dispatched[0]?.type, "thread.launch");
  assert.equal(dispatched[0]?.projectId, "project-v2");
  assert.deepEqual(dispatched[0]?.workspaceStrategy, { type: "root" });
  assert.equal((dispatched[0]?.initialMessage as { text: string }).text, "Investigate the failure");
  assert.equal(dispatched[0]?.runtimeMode, "approval-required");
});

test("thread creation applies advertised model options and access level", async () => {
  const { commands, dispatched } = harness();
  await commands.create({
    environmentId: "environment-1",
    projectId: "project-v2",
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
});

test("thread creation rejects unadvertised model option values", async () => {
  const { commands, dispatched } = harness();
  await assert.rejects(
    commands.create({
      environmentId: "environment-1",
      projectId: "project-v2",
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
    environmentId: "environment-1",
    threadId: "thread-1",
    text: "Continue",
  });
  await commands.interrupt({
    environmentId: "environment-1",
    threadId: "thread-1",
  });
  await commands.settle({
    environmentId: "environment-1",
    threadId: "thread-1",
  });
  await commands.unsettle({ threadId: "thread-1" });
  await commands.snooze({
    environmentId: "environment-1",
    threadId: "thread-1",
    until: "2026-08-23T00:00:00.000Z",
  });
  await commands.unsnooze({ threadId: "thread-1" });
  await commands.pin({
    environmentId: "environment-1",
    threadId: "thread-1",
  });
  await commands.unpin({ threadId: "thread-1" });
  await commands.rename({
    environmentId: "environment-1",
    threadId: "thread-1",
    title: "Renamed",
  });
  await commands.regenerateTitle({
    environmentId: "environment-1",
    threadId: "thread-1",
  });
  await commands.respondApproval({
    environmentId: "environment-1",
    threadId: "thread-1",
    requestId: "approval-1",
    decision: "acceptForSession",
  });
  await commands.respondInput({
    environmentId: "environment-1",
    threadId: "thread-1",
    requestId: "input-1",
    answers: { choice: "Yes" },
  });
  assert.deepEqual(
    dispatched.map((command) => command.type),
    [
      "message.dispatch",
      "run.interrupt",
      "thread.settle",
      "thread.unsettle",
      "thread.snooze",
      "thread.unsnooze",
      "thread.pin",
      "thread.unpin",
      "thread.metadata.update",
      "thread.metadata.update",
      "runtime-request.respond",
      "runtime-request.respond",
    ],
  );
  assert.equal(dispatched[3]?.reason, "user");
  assert.equal(dispatched[5]?.reason, "user");
  assert.equal(dispatched[8]?.title, "Renamed");
  assert.equal(dispatched[9]?.regenerateTitle, true);
});

test("unsupported server capabilities reject lifecycle mutation locally", async () => {
  const { commands } = harness({
    threadSettlement: false,
    threadSnooze: false,
    threadPinning: false,
    threadTitleRegeneration: false,
  });
  await assert.rejects(
    commands.settle({
      environmentId: "environment-1",
      threadId: "thread-1",
    }),
    (error: unknown) => (error as { code?: string }).code === "CAPABILITY_UNSUPPORTED",
  );
  await assert.rejects(
    commands.snooze({
      environmentId: "environment-1",
      threadId: "thread-1",
      until: "2026-08-23T00:00:00.000Z",
    }),
    (error: unknown) => (error as { code?: string }).code === "CAPABILITY_UNSUPPORTED",
  );
  await assert.rejects(
    commands.pin({
      environmentId: "environment-1",
      threadId: "thread-1",
    }),
    (error: unknown) => (error as { code?: string }).code === "CAPABILITY_UNSUPPORTED",
  );
  await assert.rejects(
    commands.regenerateTitle({
      environmentId: "environment-1",
      threadId: "thread-1",
    }),
    (error: unknown) => (error as { code?: string }).code === "CAPABILITY_UNSUPPORTED",
  );
});

test("model option changes are capability-validated and persisted with the full selection", async () => {
  const { commands, dispatched } = harness();
  await commands.setModelOption({
    environmentId: "environment-1",
    threadId: "thread-1",
    optionId: "reasoningEffort",
    value: "xhigh",
  });
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
      environmentId: "environment-1",
      threadId: "thread-1",
      optionId: "reasoningEffort",
      value: "unsupported",
    }),
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

test("screenshot-only turns dispatch persisted V2 attachments and consume their staging ids", async () => {
  const bytes = Buffer.from("screenshot");
  const attachments = new T3ImageAttachmentStore(async () => ({ mimeType: "image/png", bytes }));
  const { commands, dispatched } = harness(undefined, attachments);
  const draft = await commands.pasteClipboardImage({
    environmentId: "environment-1",
    threadId: "thread-1",
  });

  await commands.send({
    environmentId: "environment-1",
    threadId: "thread-1",
    text: "",
    attachmentIds: [draft.id],
  });

  assert.deepEqual(dispatched[0]?.attachments, [
    {
      type: "image",
      name: "pasted-screenshot.png",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      id: "stored-0",
    },
  ]);
  assert.equal(dispatched[0]?.text, "");
  assert.throws(
    () => attachments.resolve("thread-1", [draft.id]),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_NOT_FOUND",
  );
});

test("Stop rejects a thread without any run before dispatch", async () => {
  const { commands, dispatched, session } = harness();
  session.projection.shell = {
    ...v2ShellSnapshot,
    threads: [{ ...v2ThreadShell, id: ThreadId.make("thread-1") }],
  };
  await assert.rejects(
    commands.interrupt({ environmentId: "environment-1", threadId: "thread-1" }),
    { code: "NO_ACTIVE_RUN" },
  );
  assert.equal(dispatched.length, 0);
});
