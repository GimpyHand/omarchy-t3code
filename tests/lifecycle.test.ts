import assert from "node:assert/strict";
import test from "node:test";

import type {
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  ServerConfig,
} from "../upstream/t3code/packages/contracts/src/index.ts";
import { lifecycleOf, T3Projection } from "../bridge/src/t3/projection.ts";

const config = {
  environment: {
    serverVersion: "0.0.34",
    capabilities: {
      threadSettlement: true,
      threadSnooze: true,
      threadPinning: true,
      threadPinReorder: true,
      threadTitleRegeneration: true,
    },
  },
  threadSnapshotPagination: true,
  providers: [],
} as unknown as ServerConfig;

const configWithModelOptions = {
  ...config,
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
            { id: "low", label: "Low", isDefault: true },
            { id: "xhigh", label: "Extra High" },
          ],
          currentValue: "low",
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

function thread(id: string, overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
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
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
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
    backgroundLiveness: null,
    planProgress: null,
    ...overrides,
  } as OrchestrationThreadShell;
}

test("Inbox projection follows Nightly lifecycle precedence and ordering", () => {
  const projection = new T3Projection();
  projection.config = config;
  projection.shell = {
    snapshotSequence: 10,
    projects: [{
      id: "project-1",
      title: "Omarchy",
      workspaceRoot: "/workspace",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }],
    threads: [
      thread("pinned-b", { pinnedAt: "2026-08-20T00:00:00.000Z", pinOrderKey: "b" }),
      thread("pinned-a", { pinnedAt: "2026-08-20T00:00:00.000Z", pinOrderKey: "a" }),
      thread("snooze-over-pin", {
        pinnedAt: "2026-08-20T00:00:00.000Z",
        pinOrderKey: "c",
        snoozedAt: "2026-08-21T00:00:00.000Z",
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      }),
      thread("settled", { settledOverride: "settled", settledAt: "2026-08-21T00:00:00.000Z" }),
      thread("older-active", { createdAt: "2026-08-18T00:00:00.000Z" }),
      thread("newer-active", { createdAt: "2026-08-19T00:00:00.000Z", hasPendingUserInput: true }),
      thread("archived", { archivedAt: "2026-08-21T00:00:00.000Z" }),
    ],
    updatedAt: "2026-08-22T00:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;

  const inbox = projection.inbox("environment-1", "Desktop");
  assert.deepEqual(inbox.pinned.map((entry) => entry.id), ["pinned-a", "pinned-b"]);
  assert.deepEqual(inbox.active.map((entry) => entry.id), ["newer-active", "older-active"]);
  assert.deepEqual(inbox.snoozed.map((entry) => entry.id), ["snooze-over-pin"]);
  assert.deepEqual(inbox.settled.map((entry) => entry.id), ["settled"]);
  assert.equal(inbox.active[0]?.phase, "inputNeeded");
  assert.equal(inbox.active[0]?.attention, true);
  assert.equal(inbox.active[0]?.environmentId, "environment-1");
  assert.equal(inbox.active[0]?.environmentLabel, "Desktop");
  assert.equal(inbox.active[0]?.branch, null);
  assert.equal(inbox.capabilities.settlement, true);
  assert.equal(inbox.capabilities.snooze, true);
  assert.equal(inbox.capabilities.pinReorder, true);
  assert.equal(inbox.active[0]?.canPin, true);
  assert.equal(inbox.projects[0]?.title, "Omarchy");
  assert.equal(inbox.projects[0]?.projectKey, "title:omarchy");
  assert.equal(inbox.active[0]?.projectKey, "title:omarchy");
  assert.equal(inbox.projects[0]?.environmentId, "environment-1");
});

test("Inbox projects share a repo projectKey across systems", () => {
  const projection = new T3Projection();
  projection.config = config;
  projection.shell = {
    snapshotSequence: 1,
    projects: [{
      id: "local-a",
      title: "JessupsJerky",
      workspaceRoot: "/a",
      repositoryIdentity: {
        canonicalKey: "github.com/owner/example-repo",
        locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:owner/example-repo.git" },
      },
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }],
    threads: [thread("thread-a", { projectId: "local-a" as OrchestrationThreadShell["projectId"] })],
    updatedAt: "2026-08-22T00:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;

  const inbox = projection.inbox("gimpybook", "gimpybook");
  assert.equal(inbox.projects[0]?.projectKey, "repo:github.com/owner/example-repo");
  assert.equal(inbox.active[0]?.projectKey, "repo:github.com/owner/example-repo");
});

test("unsupported lifecycle capabilities keep server fields capability-gated", () => {
  const unsupported = {
    ...config,
    environment: { ...config.environment, capabilities: {} },
  } as unknown as ServerConfig;
  const settled = thread("legacy", { settledOverride: "settled" });
  assert.equal(lifecycleOf(settled, unsupported, "2026-08-22T00:00:00.000Z"), "active");
});

test("model catalog exposes advertised defaults for new-thread selection", () => {
  const projection = new T3Projection();
  projection.config = configWithModelOptions;
  assert.deepEqual(projection.models()[0]?.modelOptions, [{
    id: "reasoningEffort",
    label: "Reasoning",
    description: null,
    currentValue: "low",
    choices: [
      { id: "low", label: "Low", description: null, isDefault: true },
      { id: "xhigh", label: "Extra High", description: null, isDefault: false },
    ],
  }, {
    id: "serviceTier",
    label: "Service Tier",
    description: null,
    currentValue: "default",
    choices: [
      { id: "default", label: "Standard", description: null, isDefault: true },
      { id: "fast", label: "Fast", description: "1.5x speed, increased usage", isDefault: false },
    ],
  }]);
});

test("thread projection exposes checkpoint diffs without raw tool activity", () => {
  const projection = new T3Projection();
  const shellThread = thread("thread-diff", {
    modelSelection: {
      instanceId: "codex",
      model: "gpt-5.6",
      options: [
        { id: "reasoningEffort", value: "xhigh" },
        { id: "serviceTier", value: "default" },
      ],
    } as unknown as OrchestrationThreadShell["modelSelection"],
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: "2026-08-22T00:00:00.000Z",
      startedAt: "2026-08-22T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    } as unknown as OrchestrationThreadShell["latestTurn"],
    session: {
      threadId: "thread-diff",
      status: "running",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: "turn-1",
      lastError: null,
      updatedAt: "2026-08-22T00:00:01.000Z",
    } as unknown as OrchestrationThreadShell["session"],
  });
  projection.config = configWithModelOptions;
  projection.shell = {
    snapshotSequence: 1,
    projects: [{
      id: "project-1",
      title: "Omarchy",
      workspaceRoot: "/workspace",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }],
    threads: [shellThread],
    updatedAt: "2026-08-22T00:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;
  projection.thread = {
    ...shellThread,
    deletedAt: null,
    messages: [{
      id: "message-1",
      role: "assistant",
      text: "Implemented.",
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }],
    proposedPlans: [],
    activities: [{
      id: "activity-1",
      tone: "tool",
      kind: "tool.started",
      summary: "Run command started",
      payload: { command: "pnpm check" },
      turnId: "turn-1",
      createdAt: "2026-08-22T00:00:00.000Z",
    }],
    checkpoints: [{
      turnId: "turn-1",
      checkpointTurnCount: 1,
      checkpointRef: "checkpoint-1",
      status: "ready",
      files: [{ path: "src/main.ts", kind: "modified", additions: 8, deletions: 3 }],
      assistantMessageId: "message-1",
      completedAt: "2026-08-22T00:00:01.000Z",
    }],
  } as unknown as OrchestrationThread;

  const dto = projection.threadDto("environment-1");
  assert.deepEqual(dto.diffs, [{
    turnId: "turn-1",
    checkpointTurnCount: 1,
    status: "ready",
    files: [{ path: "src/main.ts", kind: "modified", additions: 8, deletions: 3 }],
    assistantMessageId: "message-1",
    completedAt: "2026-08-22T00:00:01.000Z",
  }]);
  assert.equal("activities" in dto, false);
  assert.equal(dto.phase, "working");
  assert.equal(dto.activeWorkStartedAt, "2026-08-22T00:00:01.000Z");
  assert.equal(dto.branch, null);
  assert.equal(dto.environmentLabel, "environment-1");
  assert.deepEqual(dto.modelOptions, [{
    id: "reasoningEffort",
    label: "Reasoning",
    description: null,
    currentValue: "xhigh",
    choices: [
      { id: "low", label: "Low", description: null, isDefault: true },
      { id: "xhigh", label: "Extra High", description: null, isDefault: false },
    ],
  }, {
    id: "serviceTier",
    label: "Service Tier",
    description: null,
    currentValue: "default",
    choices: [
      { id: "default", label: "Standard", description: null, isDefault: true },
      { id: "fast", label: "Fast", description: "1.5x speed, increased usage", isDefault: false },
    ],
  }]);
});

test("thread projection preserves server attachment metadata without exposing upload data", () => {
  const projection = new T3Projection();
  const shellThread = thread("thread-image");
  projection.config = config;
  projection.shell = {
    snapshotSequence: 1,
    projects: [{
      id: "project-1",
      title: "Omarchy",
      workspaceRoot: "/workspace",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }],
    threads: [shellThread],
    updatedAt: "2026-08-22T00:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;
  projection.thread = {
    ...shellThread,
    deletedAt: null,
    messages: [{
      id: "message-image",
      role: "user",
      text: "",
      attachments: [{
        type: "image",
        id: "server-attachment-1",
        name: "pasted-screenshot.png",
        mimeType: "image/png",
        sizeBytes: 42,
      }],
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  } as unknown as OrchestrationThread;

  assert.deepEqual(projection.threadDto("environment-1").messages[0]?.attachments, [{
    id: "server-attachment-1",
    name: "pasted-screenshot.png",
    mimeType: "image/png",
    sizeBytes: 42,
  }]);
});

export { config as lifecycleTestConfig, thread as lifecycleTestThread };
