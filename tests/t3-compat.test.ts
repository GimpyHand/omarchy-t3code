import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as Schema from "effect/Schema";

import {
  ClientOrchestrationCommand,
  ExecutionEnvironmentCapabilities,
  ORCHESTRATION_WS_METHODS,
} from "../upstream/t3code/packages/contracts/src/index.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("machine-readable Nightly pin matches the exact submodule revision", async () => {
  const lock = JSON.parse(await readFile(join(root, "t3-upstream.lock.json"), "utf8"));
  assert.equal(lock.channel, "nightly");
  assert.match(lock.tag, /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/u);
  assert.match(lock.commit, /^[0-9a-f]{40}$/u);
  const actual = execFileSync("git", ["-C", join(root, "upstream", "t3code"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(actual, lock.commit);
});

test("required lifecycle capabilities decode from pinned contracts", () => {
  const decoded = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities)({
    threadSettlement: true,
    threadSnooze: true,
    threadPinning: true,
    threadPinReorder: true,
    threadTitleRegeneration: true,
  });
  assert.equal(decoded.threadSettlement, true);
  assert.equal(decoded.threadSnooze, true);
  assert.equal(decoded.threadPinning, true);
  assert.equal(decoded.threadPinReorder, true);
});

test("required Effect RPC methods and orchestration commands exist", () => {
  assert.equal(ORCHESTRATION_WS_METHODS.subscribeShell, "orchestration.subscribeShell");
  assert.equal(ORCHESTRATION_WS_METHODS.subscribeThread, "orchestration.subscribeThread");
  assert.equal(ORCHESTRATION_WS_METHODS.dispatchCommand, "orchestration.dispatchCommand");
  const decode = Schema.decodeUnknownSync(ClientOrchestrationCommand);
  const commands = [
    { type: "thread.settle", commandId: "c1", threadId: "t1" },
    { type: "thread.unsettle", commandId: "c2", threadId: "t1", reason: "user" },
    { type: "thread.snooze", commandId: "c3", threadId: "t1", snoozedUntil: "2026-08-23T00:00:00.000Z" },
    { type: "thread.unsnooze", commandId: "c4", threadId: "t1", reason: "user" },
    { type: "thread.pin", commandId: "c5", threadId: "t1" },
    { type: "thread.unpin", commandId: "c6", threadId: "t1" },
    { type: "thread.turn.interrupt", commandId: "c7", threadId: "t1", createdAt: "2026-08-22T00:00:00.000Z" },
    { type: "thread.approval.respond", commandId: "c8", threadId: "t1", requestId: "r1", decision: "accept", createdAt: "2026-08-22T00:00:00.000Z" },
    { type: "thread.user-input.respond", commandId: "c9", threadId: "t1", requestId: "r2", answers: { q: "yes" }, createdAt: "2026-08-22T00:00:00.000Z" },
    { type: "thread.meta.update", commandId: "c10", threadId: "t1", modelSelection: { instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "xhigh" }, { id: "serviceTier", value: "default" }] } },
    { type: "thread.turn.start", commandId: "c11", threadId: "t1", message: { messageId: "m1", role: "user", text: "", attachments: [{ type: "image", name: "screenshot.png", mimeType: "image/png", sizeBytes: 1, dataUrl: "data:image/png;base64,AA==" }] }, runtimeMode: "full-access", interactionMode: "default", createdAt: "2026-08-22T00:00:00.000Z" },
  ];
  for (const command of commands) assert.equal(decode(command).type, command.type);
});

test("native Clerk session path matches the pinned Relay acceptance boundary", async () => {
  const source = await readFile(join(root, "upstream", "t3code", "infra", "relay", "src", "http", "Api.ts"), "utf8");
  const exchange = source.slice(source.indexOf('"exchangeDpopAccessToken"'), source.indexOf("export const dpopClientApi"));
  assert.match(exchange, /verifyClerkBearerToken\(config, args\.payload\.subject_token\)/u);
  assert.doesNotMatch(exchange, /verifyRelayClientBearerToken/u);
  const general = source.slice(source.indexOf("export function verifyRelayClientBearerToken"));
  const oauthFallback = source.slice(source.indexOf("function verifyClerkOAuthBearerToken"), source.indexOf("export function verifyRelayClientBearerToken"));
  assert.match(oauthFallback, /acceptsToken: "oauth_token"/u);
  assert.match(general, /verifyClerkOAuthBearerToken\(config, token\)/u);
  const provider = await readFile(join(root, "bridge", "src", "auth", "nativeProvider.ts"), "utf8");
  assert.match(provider, /sessions\/\$\{encodeURIComponent\(session\.id\)\}\/tokens\/\$\{encodeURIComponent\(this\.config\.jwtTemplate\)\}/u);
  assert.match(provider, /kind: "clerk_session"/u);
});

test("native Clerk request metadata matches versions pinned by T3", async () => {
  const lockfile = await readFile(join(root, "upstream", "t3code", "pnpm-lock.yaml"), "utf8");
  const provider = await readFile(join(root, "bridge", "src", "auth", "nativeProvider.ts"), "utf8");
  const clerkJs = lockfile.match(/^  '@clerk\/clerk-js': (\S+)$/mu)?.[1];
  const electron = lockfile.match(/^  '@clerk\/electron': (\S+)$/mu)?.[1];
  assert(clerkJs);
  assert(electron);
  assert.match(provider, new RegExp(`clerkJsVersion: "${clerkJs.replaceAll(".", "\\.")}"`, "u"));
  assert.match(provider, new RegExp(`electronSdkVersion: "${electron.replaceAll(".", "\\.")}"`, "u"));
});

test("bridge imports upstream reducers instead of implementing wire projection in QML", async () => {
  const projection = await readFile(join(root, "bridge", "src", "t3", "projection.ts"), "utf8");
  const session = await readFile(join(root, "bridge", "src", "t3", "session.ts"), "utf8");
  const dpop = await readFile(join(root, "bridge", "src", "t3", "dpop.ts"), "utf8");
  const qmlRoot = join(root, "qml");
  const qmlFiles = (await Promise.all(
    (await readdir(qmlRoot))
      .filter((name) => name.endsWith(".qml"))
      .map((name) => readFile(join(qmlRoot, name), "utf8")),
  )).join("\n");
  assert.match(projection, /applyShellStreamEvent/u);
  assert.match(projection, /applyThreadDetailEvent/u);
  assert.match(session, /RpcSessionFactory/u);
  assert.match(dpop, /createBrowserDpopProof/u);
  assert.doesNotMatch(qmlFiles, /DPoP|Effect RPC|clerkToken|accessToken/u);
});

test("newly created threads can subscribe before the shell projection catches up", async () => {
  const session = await readFile(join(root, "bridge", "src", "t3", "session.ts"), "utf8");
  const openThread = session.slice(session.indexOf("async openThread"), session.indexOf("private async subscribeThread"));
  assert.match(openThread, /requestedThreadId = threadId/u);
  assert.match(openThread, /subscribeThread\(threadId\)/u);
  assert.doesNotMatch(openThread, /currentShell/u);
});

test("stream completion markers and pagination are capability-gated like the official runtime", async () => {
  const session = await readFile(join(root, "bridge", "src", "t3", "session.ts"), "utf8");
  assert.match(session, /threadResumeCompletionMarker === true/u);
  assert.match(session, /threadSnapshotPagination === true/u);
  assert.match(session, /INITIAL_THREAD_USER_TURN_LIMIT/u);
});

test("unexpected shell or thread stream termination enters reconnect handling", async () => {
  const session = await readFile(join(root, "bridge", "src", "t3", "session.ts"), "utf8");
  assert.match(session, /observeStreamFiber/u);
  assert.match(session, /reportUnexpectedClose/u);
  assert.match(session, /callbacks\.onClosed\(new BridgeError/u);
  assert.match(session, /"SHELL_STREAM_FAILED"/u);
  assert.match(session, /"THREAD_STREAM_FAILED"/u);
  assert.doesNotMatch(session, /Effect\.catch\([\s\S]{0,200}SHELL_STREAM_FAILED/u);
});
