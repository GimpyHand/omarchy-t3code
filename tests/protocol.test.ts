import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decodeRequestLine, ProtocolDecodeError } from "../bridge/src/protocol/decode.ts";
import type { BridgeOutput } from "../bridge/src/protocol/types.ts";
import { v2Projection } from "./fixtures/t3.ts";

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

for (const historyType of ["thread.history.load", "thread.history.latest"]) {
  test(`NDJSON ${historyType} preserves ordering without blocking live controls or close`, { timeout: 10_000 }, async (t) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/history-ipc.ts"], {
      cwd: root, stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => { child.kill(); });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const scope = { environmentId: "environment-1", threadId: v2Projection.thread.id };
    const requests = [
      { requestId: "open", type: "thread.open", payload: scope },
      { requestId: "history", type: historyType, payload: scope },
      ...(historyType === "thread.history.load" ? [{ requestId: "duplicate", type: historyType, payload: scope }] : []),
      { requestId: "interrupt", type: "thread.interrupt", payload: scope },
      { requestId: "approval", type: "approval.respond", payload: { ...scope, requestId: "approval", decision: "decline" } },
      { requestId: "input", type: "input.respond", payload: { ...scope, requestId: "input", answers: { question: "answer" } } },
      { requestId: "send", type: "thread.send", payload: { ...scope, text: "Follow up" } },
      { requestId: "close", type: "thread.close", payload: {} },
    ];
    const output = createInterface({ input: child.stdout });
    child.stdin.write(requests.map((request) => JSON.stringify({ protocolVersion: 1, ...request })).join("\n") + "\n");
    const messages: BridgeOutput[] = [];
    for await (const line of output) {
      messages.push(JSON.parse(line) as BridgeOutput);
      if (messages.filter((message) => message.type === "response").length === requests.length) break;
    }
    const responses = messages.filter((message) => message.type === "response");
    assert.equal(responses.length, requests.length, stderr);
    assert(responses.every((message) => message.ok), JSON.stringify(responses));
    assert.deepEqual(responses.map((message) => message.requestId), [
      "open", ...(historyType === "thread.history.load" ? ["duplicate"] : ["history"]),
      "interrupt", "approval", "input", "send", "close", ...(historyType === "thread.history.load" ? ["history"] : []),
    ]);
    assert.deepEqual(responses.filter((message) => message.ok && ["interrupt", "approval", "input", "send"].includes(message.requestId)).map((message) => message.ok && message.payload), [
      { sequence: 1 }, { sequence: 2 }, { sequence: 3 }, { sequence: 4 },
    ]);
    const historyResponse = responses.find((message) => message.requestId === "history");
    assert.deepEqual(historyResponse?.ok && historyResponse.payload, historyType === "thread.history.load" ? { loaded: false } : {});
    assert.equal(messages.filter((message) => message.type === "event" && message.event === "thread.snapshot").length, historyType === "thread.history.load" ? 2 : 1);
    const exit = once(child, "exit");
    child.stdin.end();
    const [exitCode] = await exit;
    assert.equal(exitCode, 0, stderr);
  });
}
