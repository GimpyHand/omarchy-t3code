import assert from "node:assert/strict";
import test from "node:test";

import type { OrchestrationThread } from "../upstream/t3code/packages/contracts/src/index.ts";
import { deriveMessageStreamEvents } from "../bridge/src/t3/session.ts";

function snapshot(text: string, streaming: boolean): OrchestrationThread {
  return {
    messages: [{
      id: "message-1",
      role: "assistant",
      text,
      turnId: "turn-1",
      streaming,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:01.000Z",
    }],
  } as unknown as OrchestrationThread;
}

test("stream projection emits only incremental assistant text", () => {
  const changes = deriveMessageStreamEvents(snapshot("Hello", true), snapshot("Hello world", true), "thread-1");
  assert.deepEqual(changes.deltas, [{ threadId: "thread-1", messageId: "message-1", delta: " world" }]);
  assert.deepEqual(changes.completed, []);
});

test("stream projection reports initial chunks and completion transitions", () => {
  assert.deepEqual(
    deriveMessageStreamEvents(null, snapshot("First", true), "thread-1").deltas,
    [{ threadId: "thread-1", messageId: "message-1", delta: "First" }],
  );
  assert.deepEqual(
    deriveMessageStreamEvents(snapshot("Done", true), snapshot("Done", false), "thread-1").completed,
    [{ threadId: "thread-1", messageId: "message-1" }],
  );
});
