import assert from "node:assert/strict";
import test from "node:test";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import { ORCHESTRATION_V2_WS_METHODS, OrchestrationV2Run, OrchestrationV2Command, MessageId } from "@t3tools/contracts";
import { T3Commands } from "../bridge/src/t3/commands.ts";
import { T3EnvironmentSession } from "../bridge/src/t3/session.ts";
import { T3Projection } from "../bridge/src/t3/projection.ts";
import type { ThreadDto } from "../bridge/src/protocol/types.ts";
import { decodeRequestLine } from "../bridge/src/protocol/decode.ts";
import { config, v2Now, v2ThreadShell, v2Projection, v2ShellSnapshot, message, itemBase, projectedItem } from "./fixtures/t3.ts";

function queuedProjection() {
  const queuedMessage = { ...message("Keep the screenshots", false, "queued-message"), role: "user" as const };
  const run = Schema.decodeUnknownSync(OrchestrationV2Run)({
    id: "queued-run", threadId: v2ThreadShell.id, ordinal: 1,
    providerInstanceId: v2ThreadShell.providerInstanceId,
    modelSelection: v2ThreadShell.modelSelection,
    providerThreadId: null, userMessageId: queuedMessage.id, rootNodeId: null,
    activeAttemptId: null, status: "queued", queueHeld: true,
    requestedAt: v2Now, startedAt: null, completedAt: null, checkpointId: null, contextHandoffId: null,
  });
  const item = { ...itemBase("queued-item"), type: "user_message" as const,
    createdBy: "user" as const, creationSource: "web" as const,
    messageId: queuedMessage.id, inputIntent: "queued_turn" as const, text: queuedMessage.text, attachments: [] };
  return { ...v2Projection, runs: [run], messages: [queuedMessage],
    turnItems: [item], visibleTurnItems: [projectedItem(item)] };
}

test("queue DTO reflects held server state and distinguishes steering", () => {
  const projection = new T3Projection();
  projection.config = config;
  projection.shell = v2ShellSnapshot;
  const queued = queuedProjection();
  const steer = { ...queued.turnItems[0]!, id: queued.turnItems[0]!.id,
    messageId: MessageId.make("steer-message"), inputIntent: "steer" as const };
  projection.applyThread({ kind: "snapshot", snapshotSequence: 1,
    projection: { ...queued, visibleTurnItems: [...queued.visibleTurnItems, projectedItem(steer, 1)] } });
  const dto = projection.threadDto("environment-1");
  assert.equal(dto.queue.held, true);
  assert.equal(dto.queue.canManage, true);
  assert.deepEqual(dto.queue.messages, [{ runId: "queued-run", text: "Keep the screenshots", editable: true, attachmentCount: 0 }]);
  assert.deepEqual(dto.messages.map((entry) => entry.delivery), ["queued", "steer"]);
  projection.thread = { ...queued, runs: [{ ...queued.runs[0]!, status: "starting" }] };
  assert.equal(projection.threadDto("environment-1").queue.held, false);
  assert.equal(projection.threadDto("environment-1").queue.total, 0);
});

test("queue operations decode against upstream contracts and reject stale or unsupported actions", async () => {
  const session = new T3EnvironmentSession({ onInbox() {}, onThread() {}, onMessageDelta() {},
    onMessageCompleted() {}, onApproval() {}, onInput() {}, onClosed() {}, onError() {} });
  session.projection.config = config;
  session.projection.thread = queuedProjection();
  const dispatched: OrchestrationV2Command[] = [];
  session.dispatch = async (value) => {
    dispatched.push(Schema.decodeUnknownSync(OrchestrationV2Command)(value));
    return { sequence: dispatched.length };
  };
  const commands = new T3Commands(() => session);
  const payload = { environmentId: "environment-1", threadId: v2ThreadShell.id, runId: "queued-run", text: "Updated" };
  await commands.manageQueue(payload, "resume");
  await commands.manageQueue(payload, "edit");
  await commands.manageQueue(payload, "cancel");
  assert.deepEqual(dispatched.map((entry) => entry.type), ["queue.resume", "queued-run.edit", "queued-run.cancel"]);
  assert(!("attachments" in dispatched[1]!));
  assert(!("context" in dispatched[1]!));
  await assert.rejects(commands.manageQueue({ ...payload, runId: "gone" }, "cancel"), /no longer queued/);
  await assert.rejects(commands.manageQueue({ ...payload, text: " " }, "edit"), /Enter message text/);
  session.projection.thread = { ...queuedProjection(), runs: [] };
  await assert.rejects(commands.manageQueue(payload, "resume"), /no longer paused/);
  session.projection.config = { ...config, environment: { ...config.environment, orchestrationProtocolVersion: 1 } };
  await assert.rejects(commands.manageQueue(payload, "cancel"), /does not support queue/);
  assert.equal(dispatched.length, 3);
});

test("queue requests require scope, run identity, and nonempty edit text", () => {
  const decode = (type: string, payload: Record<string, unknown>) => decodeRequestLine(JSON.stringify({
    protocolVersion: 1, requestId: "queue-request", type, payload,
  }));
  const scope = { environmentId: "environment-1", threadId: v2ThreadShell.id };
  assert.equal(decode("thread.queue.resume", scope).type, "thread.queue.resume");
  assert.throws(() => decode("thread.queue.cancel", scope), /runId/);
  assert.throws(() => decode("thread.queue.edit", { ...scope, runId: "run", text: " " }), /text/);
  assert.equal(decode("thread.queue.edit", { ...scope, runId: "run", text: "Changed" }).type, "thread.queue.edit");
});

test("jump to latest keeps queue controls usable until the replacement snapshot arrives", async () => {
  const snapshot = Promise.withResolvers<void>();
  const received = Promise.withResolvers<ThreadDto>();
  let subscriptions = 0;
  const session = new T3EnvironmentSession({ onInbox() {}, onThread(dto) {
    if (dto.queue.total === 0) received.resolve(dto);
  }, onMessageDelta() {}, onMessageCompleted() {}, onApproval() {}, onInput() {}, onClosed() {}, onError() {} });
  Object.assign(session, { environmentId: "environment-1", session: { client: {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]() {
      if (++subscriptions === 1) return Stream.never;
      return Stream.concat(Stream.fromEffect(Effect.promise(async () => {
        await snapshot.promise;
        return { kind: "snapshot" as const, snapshotSequence: 2, projection: v2Projection,
          historyCursor: "replacement-cursor", hasMoreHistory: true };
      })), Stream.never);
    },
  } } });
  session.projection.config = config;
  session.projection.shell = v2ShellSnapshot;
  const dispatched: OrchestrationV2Command[] = [];
  session.dispatch = async (value) => {
    dispatched.push(Schema.decodeUnknownSync(OrchestrationV2Command)(value));
    return { sequence: dispatched.length };
  };
  const commands = new T3Commands(() => session);
  const payload = { environmentId: "environment-1", threadId: v2ThreadShell.id, runId: "queued-run", text: "Updated" };
  try {
    await session.openThread(v2ThreadShell.id);
    session.projection.applyThread({ kind: "snapshot", snapshotSequence: 1, projection: queuedProjection(),
      historyCursor: "original-cursor", hasMoreHistory: true });
    const historyRequest = session.projection.history.begin(session.projection.thread!)!;
    await session.showLatest(v2ThreadShell.id);
    assert.equal(session.projection.history.fail(historyRequest, "Stale failure"), false);
    await commands.manageQueue(payload, "resume");
    await commands.manageQueue(payload, "edit");
    await commands.manageQueue(payload, "cancel");
    assert.deepEqual(dispatched.map((entry) => entry.type), ["queue.resume", "queued-run.edit", "queued-run.cancel"]);
    snapshot.resolve();
    assert.equal((await received.promise).queue.total, 0);
    assert.equal(session.projection.history.begin(session.projection.thread!)?.cursor, "replacement-cursor");
    await assert.rejects(commands.manageQueue(payload, "cancel"), /no longer queued/);
  } finally {
    snapshot.resolve();
    await session.close();
  }
});
