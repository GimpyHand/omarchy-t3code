import assert from "node:assert/strict";
import test from "node:test";
import { derivePendingApprovals, derivePendingInputs } from "../bridge/src/t3/pending.ts";
import { v2Projection, itemBase, request } from "./fixtures/t3.ts";

test("pending approval projection follows V2 request state and response capability", () => {
  const pending = request("command");
  const item = {
    ...itemBase("approval"),
    type: "approval_request" as const,
    requestId: pending.id,
    requestKind: "command" as const,
    prompt: "Run the command?",
  };
  const projection = { ...v2Projection, runtimeRequests: [pending], turnItems: [item] };
  assert.deepEqual(
    derivePendingApprovals(projection).map((entry) => entry.detail),
    ["Run the command?"],
  );
  assert.deepEqual(
    derivePendingApprovals({
      ...projection,
      runtimeRequests: [{ ...pending, status: "resolved" }],
    }),
    [],
  );
  assert.deepEqual(
    derivePendingApprovals({
      ...projection,
      runtimeRequests: [
        { ...pending, responseCapability: { type: "not_resumable", reason: "Ended" } },
      ],
    }),
    [],
  );
});

test("pending V2 questions preserve explanations and multiple selection", () => {
  const pending = request("user_input");
  const questions = [
    {
      id: "q1",
      header: "Choice",
      question: "Which option?",
      multiSelect: true,
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
    },
  ];
  const item = {
    ...itemBase("question"),
    type: "user_input_request" as const,
    requestId: pending.id,
    questions,
  };
  const projection = { ...v2Projection, runtimeRequests: [pending], turnItems: [item] };
  assert.deepEqual(derivePendingInputs(projection)[0]?.questions, questions);
  assert.deepEqual(
    derivePendingInputs({ ...projection, runtimeRequests: [{ ...pending, status: "cancelled" }] }),
    [],
  );
});
