import assert from "node:assert/strict";
import test from "node:test";

import { T3ImageAttachmentStore } from "../bridge/src/t3/attachments.ts";

test("clipboard screenshots are staged by opaque id and resolved to the pinned upload shape", async () => {
  const bytes = Buffer.from("fake-png-bytes");
  const store = new T3ImageAttachmentStore(async () => ({ mimeType: "image/png", bytes }));

  const draft = await store.pasteClipboard("thread-1");
  assert.match(draft.id, /^[0-9a-f-]{36}$/u);
  assert.equal(draft.name, "pasted-screenshot.png");
  assert.equal(draft.sizeBytes, bytes.byteLength);
  assert.equal(draft.previewUrl, `data:image/png;base64,${bytes.toString("base64")}`);
  assert.deepEqual(store.resolve("thread-1", [draft.id]), [{
    type: "image",
    name: "pasted-screenshot.png",
    mimeType: "image/png",
    sizeBytes: bytes.byteLength,
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
  }]);

  assert.throws(
    () => store.resolve("thread-2", [draft.id]),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_NOT_FOUND",
  );
  store.consume("thread-1", [draft.id]);
  assert.throws(
    () => store.resolve("thread-1", [draft.id]),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_NOT_FOUND",
  );
});

test("clipboard staging rejects unsupported and empty image payloads", async () => {
  const unsupported = new T3ImageAttachmentStore(async () => ({
    mimeType: "image/bmp",
    bytes: Buffer.from("bitmap"),
  }));
  await assert.rejects(
    unsupported.pasteClipboard("thread-1"),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_TYPE_UNSUPPORTED",
  );

  const empty = new T3ImageAttachmentStore(async () => ({ mimeType: "image/png", bytes: Buffer.alloc(0) }));
  await assert.rejects(
    empty.pasteClipboard("thread-1"),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_TOO_LARGE",
  );
});
