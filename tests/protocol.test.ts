import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decodeRequestLine, ProtocolDecodeError } from "../bridge/src/protocol/decode.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("protocol decoder validates envelopes and operation payloads", () => {
  const decoded = decodeRequestLine(JSON.stringify({
    protocolVersion: 1,
    requestId: "request-1",
    type: "thread.snooze",
    payload: { environmentId: "environment-1", threadId: "thread-1", until: "2026-08-23T00:00:00.000Z" },
  }));
  assert.equal(decoded.requestId, "request-1");
  const option = decodeRequestLine(JSON.stringify({
    protocolVersion: 1,
    requestId: "option-1",
    type: "thread.model.option.set",
    payload: { environmentId: "environment-1", threadId: "thread-1", optionId: "reasoningEffort", value: "xhigh" },
  }));
  assert.equal(option.type, "thread.model.option.set");
  const create = decodeRequestLine(JSON.stringify({
    protocolVersion: 1,
    requestId: "create-1",
    type: "thread.create",
    payload: {
      environmentId: "environment-1",
      projectId: "project-1",
      prompt: "Investigate",
      providerInstanceId: "codex",
      model: "gpt-5.6",
      modelOptions: [
        { id: "reasoningEffort", value: "xhigh" },
        { id: "serviceTier", value: "fast" },
      ],
      runtimeMode: "approval-required",
    },
  }));
  assert.equal(create.type, "thread.create");
  const clipboard = decodeRequestLine(JSON.stringify({
    protocolVersion: 1,
    requestId: "paste-1",
    type: "attachment.clipboard.read",
    payload: { environmentId: "environment-1", threadId: "thread-1" },
  }));
  assert.equal(clipboard.type, "attachment.clipboard.read");
  const imageOnly = decodeRequestLine(JSON.stringify({
    protocolVersion: 1,
    requestId: "send-image-1",
    type: "thread.send",
    payload: { environmentId: "environment-1", threadId: "thread-1", text: "", attachmentIds: ["attachment-1"] },
  }));
  assert.equal(imageOnly.type, "thread.send");
  assert.throws(() => decodeRequestLine("not json"), ProtocolDecodeError);
  assert.throws(() => decodeRequestLine(JSON.stringify({ protocolVersion: 2, requestId: "x", type: "bridge.ping" })), /protocolVersion/u);
  assert.throws(() => decodeRequestLine(JSON.stringify({ protocolVersion: 1, requestId: "x", type: "thread.open", payload: {} })), /environmentId/u);
  assert.throws(() => decodeRequestLine(JSON.stringify({ protocolVersion: 1, requestId: "x", type: "approval.respond", payload: { environmentId: "e", threadId: "t", requestId: "a", decision: "yes" } })), /decision/u);
  assert.throws(() => decodeRequestLine(JSON.stringify({ protocolVersion: 1, requestId: "x", type: "thread.model.option.set", payload: { environmentId: "e", threadId: "t", optionId: "reasoningEffort", value: "" } })), /value/u);
  assert.throws(() => decodeRequestLine(JSON.stringify({ protocolVersion: 1, requestId: "x", type: "thread.create", payload: { environmentId: "e", projectId: "p", prompt: "go", modelOptions: [{ id: "reasoningEffort", value: "high" }, { id: "reasoningEffort", value: "low" }] } })), /duplicate/u);
  assert.throws(() => decodeRequestLine(JSON.stringify({ protocolVersion: 1, requestId: "x", type: "thread.create", payload: { environmentId: "e", projectId: "p", prompt: "go", runtimeMode: "unsafe" } })), /runtimeMode/u);
  assert.throws(() => decodeRequestLine(JSON.stringify({ protocolVersion: 1, requestId: "x", type: "thread.send", payload: { environmentId: "e", threadId: "t", text: "", attachmentIds: [] } })), /message content/u);
  assert.throws(() => decodeRequestLine(JSON.stringify({ protocolVersion: 1, requestId: "x", type: "thread.send", payload: { environmentId: "e", threadId: "t", text: "go", attachmentIds: ["same", "same"] } })), /duplicates/u);
  assert.throws(() => decodeRequestLine(JSON.stringify({ protocolVersion: 1, requestId: "x", type: "attachment.discard", payload: { environmentId: "e", threadId: "t" } })), /attachmentId/u);
  assert.throws(() => decodeRequestLine(" ".repeat(1_000_001)), /1 MB/u);
});

test("NDJSON bridge correlates concurrent responses and survives malformed input", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "bridge/src/main.ts"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", T3_MINI_TEST_MEMORY_SECRETS: "1" },
  });
  const lines: unknown[] = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(JSON.parse(line));
    for (const wake of waiters.splice(0)) wake();
  });

  async function waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const found = lines.find((line) => predicate(line as Record<string, unknown>));
      if (found) return found as Record<string, unknown>;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    throw new Error("Timed out waiting for bridge output.");
  }

  await waitFor((message) => message.event === "bridge.ready");
  child.stdin.write("{bad json\n");
  child.stdin.write(`${JSON.stringify({ protocolVersion: 1, requestId: "one", type: "bridge.ping", payload: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ protocolVersion: 1, requestId: "two", type: "auth.status", payload: {} })}\n`);
  const malformed = await waitFor((message) => message.requestId === "invalid");
  assert.equal((malformed.error as { code: string }).code, "INVALID_REQUEST");
  const one = await waitFor((message) => message.requestId === "one");
  const two = await waitFor((message) => message.requestId === "two");
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  child.stdin.write(`${JSON.stringify({ protocolVersion: 1, requestId: "stop", type: "bridge.shutdown", payload: {} })}\n`);
  await waitFor((message) => message.requestId === "stop");
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
});

test("NDJSON requests are dispatched sequentially", async () => {
  const channel = await readFile(join(root, "bridge", "src", "ipc", "ndjson.ts"), "utf8");
  assert.match(channel, /private handling = Promise\.resolve\(\)/u);
  assert.match(channel, /this\.handling = this\.handling\s*\.then\(\(\) => this\.handler\.handle\(request\)\)/u);
});
