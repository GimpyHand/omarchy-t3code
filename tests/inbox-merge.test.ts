import assert from "node:assert/strict";
import test from "node:test";

import { emptyInbox, mergeInboxes } from "../bridge/src/t3/inboxMerge.ts";
import type { InboxDto } from "../bridge/src/protocol/types.ts";

function sample(environmentId: string, label: string, threadId: string, activityAt: string): InboxDto {
  return {
    updatedAt: activityAt,
    capabilities: {
      settlement: true,
      snooze: false,
      pinning: true,
      pinReorder: false,
      titleRegeneration: false,
      threadPagination: false,
    },
    projects: [{ id: "project-1", title: "Project", projectKey: "title:project", environmentId, environmentLabel: label }],
    models: [{
      environmentId,
      instanceId: "codex",
      provider: "codex",
      providerLabel: "Codex",
      model: "gpt",
      label: "GPT",
      isDefault: true,
      available: true,
      modelOptions: [],
    }],
    pinned: [],
    active: [{
      id: threadId,
      environmentId,
      environmentLabel: label,
      projectId: "project-1",
      project: "Project",
      projectKey: "title:project",
      branch: null,
      title: threadId,
      provider: "codex",
      model: "gpt",
      phase: "ready",
      lifecycle: "active",
      updatedAt: activityAt,
      latestActivityAt: activityAt,
      attention: false,
      pinned: false,
      snoozedUntil: null,
      settled: false,
      canPin: true,
      canSettle: true,
      canSnooze: false,
    }],
    snoozed: [],
    settled: [],
  };
}

test("mergeInboxes combines systems and unions capabilities", () => {
  assert.equal(emptyInbox().active.length, 0);
  const merged = mergeInboxes([
    sample("env-a", "Alpha", "thread-old", "2026-08-20T00:00:00.000Z"),
    sample("env-b", "Beta", "thread-new", "2026-08-22T00:00:00.000Z"),
  ]);
  assert.deepEqual(merged.active.map((entry) => entry.id), ["thread-new", "thread-old"]);
  assert.equal(merged.active[0]?.environmentLabel, "Beta");
  assert.equal(merged.projects.length, 2);
  assert.equal(merged.models.length, 2);
  assert.equal(merged.capabilities.settlement, true);
  assert.equal(merged.capabilities.pinning, true);
  assert.equal(merged.capabilities.snooze, false);
  assert.equal(merged.updatedAt, "2026-08-22T00:00:00.000Z");
});
