import { ThreadId } from "@t3tools/contracts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatAttachmentId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  RunId,
  type OrchestrationV2ShellSnapshot,
  type ServerConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { lifecycleOf, T3Projection } from "../bridge/src/t3/projection.ts";
import {
  config,
  v2Now,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
  assistantItem,
  itemBase,
  projectedItem,
  request,
} from "./fixtures/t3.ts";
const configWithModelOptions = {
  ...config,
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
                  { id: "low", label: "Low", isDefault: true },
                  { id: "xhigh", label: "Extra High" },
                ],
                currentValue: "low",
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

test("V2 inbox preserves pins, snoozes and server-owned settlement", () => {
  const pinnedAt = v2Now;
  const threads = [
    { ...v2ThreadShell, id: ThreadId.make("b"), pinnedAt, pinOrderKey: "b" },
    { ...v2ThreadShell, id: ThreadId.make("a"), pinnedAt, pinOrderKey: "a" },
    {
      ...v2ThreadShell,
      id: ThreadId.make("snoozed"),
      pinnedAt,
      snoozedAt: v2Now,
      snoozedUntil: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
    },
    {
      ...v2ThreadShell,
      id: ThreadId.make("settled"),
      settledOverride: "settled" as const,
      settledAt: v2Now,
    },
    {
      ...v2ThreadShell,
      id: ThreadId.make("old-active"),
      updatedAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z"),
    },
  ];
  const projection = new T3Projection();
  projection.config = config;
  projection.applyShell({ kind: "snapshot", snapshot: { ...v2ShellSnapshot, threads } });
  const inbox = projection.inbox("environment-1");
  assert.deepEqual(
    inbox.pinned.map((thread) => thread.id),
    ["a", "b"],
  );
  assert.deepEqual(
    inbox.snoozed.map((thread) => thread.id),
    ["snoozed"],
  );
  assert.deepEqual(
    inbox.settled.map((thread) => thread.id),
    ["settled"],
  );
  assert.deepEqual(
    inbox.active.map((thread) => thread.id),
    ["old-active"],
  );
});

test("pending V2 input raises a snoozed thread's hand", () => {
  const pending = request("user_input");
  const thread = {
    ...v2ThreadShell,
    snoozedUntil: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
    pendingRuntimeRequest: { id: pending.id, kind: pending.kind, createdAt: pending.createdAt },
  };
  assert.equal(lifecycleOf(thread, config), "active");
});

test("project identity is shared across systems without exposing workspace paths", () => {
  const projection = new T3Projection();
  projection.config = config;
  projection.shell = {
    ...v2ShellSnapshot,
    projects: [{ ...v2ShellSnapshot.projects[0]!, title: " Shared " }],
  };
  assert.equal(
    projection.inbox("a").projects[0]?.projectKey,
    projection.inbox("b").projects[0]?.projectKey,
  );
  assert.equal(projection.inbox("a").projects[0]?.projectKey, "title:shared");
});

test("unsupported lifecycle capabilities gate V2 controls", () => {
  const projection = new T3Projection();
  projection.shell = v2ShellSnapshot;
  projection.config = {
    ...config,
    environment: {
      ...config.environment,
      capabilities: {
        ...config.environment.capabilities,
        threadSettlement: false,
        threadSnooze: false,
        threadPinning: false,
      },
    },
  };
  const row = projection.inbox("environment-1").active[0];
  assert.equal(row?.canSettle, false);
  assert.equal(row?.canPin, false);
  assert.equal(row?.canSnooze, false);
});

test("model catalog exposes advertised defaults and option choices", () => {
  const projection = new T3Projection();
  projection.config = configWithModelOptions;
  const models = projection.models();
  assert(models.length > 0);
  assert(models[0]?.modelOptions.some((option) => option.id === "reasoningEffort"));
});

test("V2 thread shows conversation, persisted attachments and checkpoint files without raw tools", () => {
  const projection = new T3Projection();
  projection.config = config;
  projection.shell = v2ShellSnapshot;
  const reply = {
    ...assistantItem("Done"),
    attachments: [
      {
        type: "image" as const,
        id: ChatAttachmentId.make("image-1"),
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 42,
      },
    ],
  };
  const tool = {
    ...itemBase("command"),
    type: "command_execution" as const,
    input: "secret tool command",
    output: "raw output",
  };
  projection.applyThread({
    kind: "snapshot",
    snapshotSequence: 1,
    projection: {
      ...v2Projection,
      turnItems: [reply, tool],
      visibleTurnItems: [projectedItem(reply), projectedItem(tool, 1)],
      checkpoints: [
        {
          id: CheckpointId.make("checkpoint"),
          threadId: v2ThreadShell.id,
          scopeId: CheckpointScopeId.make("scope"),
          runId: RunId.make("run"),
          nodeId: NodeId.make("node"),
          parentCheckpointId: null,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/checkpoint"),
          status: "ready",
          files: [{ path: "file.ts", kind: "modified", additions: 3, deletions: 1 }],
          capturedAt: v2Now,
        },
      ],
    },
  });
  const dto = projection.threadDto("environment-1");
  assert.deepEqual(
    dto.messages.map((message) => message.text),
    ["Done"],
  );
  assert.deepEqual(dto.messages[0]?.attachments, [
    { id: "image-1", name: "image.png", mimeType: "image/png", sizeBytes: 42 },
  ]);
  assert.deepEqual(dto.diffs[0]?.files, [
    { path: "file.ts", kind: "modified", additions: 3, deletions: 1 },
  ]);
  assert(!JSON.stringify(dto).includes("raw output"));
});
