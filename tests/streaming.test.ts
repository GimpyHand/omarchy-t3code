import assert from "node:assert/strict";
import test from "node:test";

import { v2Projection, message } from "./fixtures/t3.ts";
import { deriveMessageStreamEvents } from "../bridge/src/t3/session.ts";
function snapshot(text: string, streaming: boolean) {
  return { ...v2Projection, messages: [message(text, streaming)] };
}

test("stream projection emits only incremental assistant text", () => {
  const changes = deriveMessageStreamEvents(
    snapshot("Hello", true),
    snapshot("Hello world", true),
    "thread-1",
  );
  assert.deepEqual(changes.deltas, [
    { threadId: "thread-1", messageId: "message-1", delta: " world" },
  ]);
  assert.deepEqual(changes.completed, []);
});

test("stream projection reports initial chunks and completion transitions", () => {
  assert.deepEqual(deriveMessageStreamEvents(null, snapshot("First", true), "thread-1").deltas, [
    { threadId: "thread-1", messageId: "message-1", delta: "First" },
  ]);
  assert.deepEqual(
    deriveMessageStreamEvents(snapshot("Done", true), snapshot("Done", false), "thread-1")
      .completed,
    [{ threadId: "thread-1", messageId: "message-1" }],
  );
});
