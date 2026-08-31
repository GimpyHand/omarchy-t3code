import assert from "node:assert/strict";
import test from "node:test";

import type { OrchestrationThreadActivity } from "../upstream/t3code/packages/contracts/src/index.ts";
import { derivePendingApprovals, derivePendingInputs } from "../bridge/src/t3/pending.ts";

function activity(id: string, sequence: number, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id,
    sequence,
    tone: "approval",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: `2026-08-22T00:00:0${sequence}.000Z`,
  } as OrchestrationThreadActivity;
}

test("pending approval projection follows request/resolution events", () => {
  const requested = activity("a", 1, "approval.requested", { requestId: "request-1", requestKind: "command", detail: "npm test" });
  assert.deepEqual(derivePendingApprovals([requested]), [{ requestId: "request-1", requestKind: "command", detail: "npm test", createdAt: requested.createdAt }]);
  assert.deepEqual(derivePendingApprovals([requested, activity("b", 2, "approval.resolved", { requestId: "request-1" })]), []);
  const applyPatch = activity("c", 3, "approval.requested", { requestId: "request-2", requestType: "apply_patch_approval" });
  assert.equal(derivePendingApprovals([applyPatch])[0]?.requestKind, "file-change");
  const unknown = activity("d", 4, "approval.requested", { requestId: "request-3", requestType: "commandish" });
  assert.deepEqual(derivePendingApprovals([unknown]), []);
});

test("pending user input keeps exact Nightly question/option semantics", () => {
  const request = activity("q", 1, "user-input.requested", {
    requestId: "input-1",
    questions: [{ id: "framework", header: "Framework", question: "Choose one", multiSelect: false, options: [{ label: "QML", description: "Native shell UI" }] }],
  });
  const projected = derivePendingInputs([request]);
  assert.equal(projected[0]?.questions[0]?.id, "framework");
  assert.equal(projected[0]?.questions[0]?.options[0]?.label, "QML");
  assert.equal(projected[0]?.questions[0]?.options[0]?.description, "Native shell UI");
  assert.deepEqual(derivePendingInputs([request, activity("r", 2, "user-input.resolved", { requestId: "input-1" })]), []);
});
