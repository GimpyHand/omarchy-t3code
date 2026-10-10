import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ORCHESTRATION_V2_WS_METHODS, OrchestrationV2ThreadBoundedSnapshot, OrchestrationV2ThreadHistoryPage, ThreadId } from "@t3tools/contracts";
import { T3EnvironmentSession } from "../bridge/src/t3/session.ts";
import type { ThreadDto } from "../bridge/src/protocol/types.ts";
import { T3Projection } from "../bridge/src/t3/projection.ts";
import { T3ThreadHistory } from "../bridge/src/t3/history.ts";
import { decodeRequestLine } from "../bridge/src/protocol/decode.ts";
import { config, v2Projection, v2ShellSnapshot, assistantItem, projectedItem } from "./fixtures/t3.ts";

function projection(count = 2, prefix = "recent") {
  const items = Array.from({ length: count }, (_, index) => assistantItem(`${prefix} ${index}`, `${prefix}-${index}`));
  return { ...v2Projection, turnItems: items, visibleTurnItems: items.map((item, index) => projectedItem(item, index)) };
}
function page(prefix: string, count = 16, nextCursor: string | null = null) {
  return Schema.decodeUnknownSync(OrchestrationV2ThreadHistoryPage)({
    snapshotSequence: 1, items: projection(count, prefix).visibleTurnItems,
    nextCursor, hasMoreHistory: nextCursor !== null,
  });
}

test("history prepends upstream-decoded pages, deduplicates overlap, and keeps live text", () => {
  const history = new T3ThreadHistory();
  const initial = projection();
  history.reset("opaque-cursor", true);
  const request = history.begin(initial)!;
  assert.equal(history.begin(initial), null);
  const updated = { ...initial, turnItems: initial.turnItems.map((item) => ({ ...item, text: "Live update" })),
    visibleTurnItems: initial.visibleTurnItems.map((row) => ({ ...row, item: { ...row.item, text: "Live update" } })) };
  const older = page("older", 2);
  assert(history.complete(request, { ...older, items: [...older.items, initial.visibleTurnItems[0]!] }, updated, 1));
  assert.deepEqual(history.rows(updated).map((row) => row.item.id), ["older-0", "older-1", "recent-0", "recent-1"]);
  assert.equal(history.rows(updated).at(-1)?.item.type, "assistant_message");
  assert.equal((history.rows(updated).at(-1)!.item as { text: string }).text, "Live update");
  assert.equal(history.state(updated).hasMore, false);
});

test("history cursor survives live events but stale completions and failures cannot replace a new snapshot", () => {
  const adapter = new T3Projection();
  adapter.config = config;
  adapter.shell = v2ShellSnapshot;
  adapter.applyThread({ kind: "snapshot", snapshotSequence: 1, projection: projection(), historyCursor: "first", hasMoreHistory: true });
  const request = adapter.history.begin(adapter.thread!)!;
  adapter.applyThread({ kind: "snapshot", snapshotSequence: 5, projection: projection(1, "replacement"), historyCursor: "second", hasMoreHistory: true });
  assert.equal(adapter.history.complete(request, page("stale"), adapter.thread!, adapter.currentThreadSequence), false);
  assert.equal(adapter.history.fail(request, "Stale failure"), false);
  assert.equal(adapter.threadDto("environment-1").history.error, null);
  assert.equal(adapter.history.begin(adapter.thread!)?.cursor, "second");
  adapter.clearThread();
  assert.equal(adapter.history.complete(request, page("stale"), projection(), -1), false);
});

test("history errors retain the cursor for retry, and jump to latest discards in-flight pages", () => {
  const history = new T3ThreadHistory();
  const initial = projection();
  history.reset("retry-cursor", true);
  const request = history.begin(initial)!;
  assert(history.fail(request, "Try again"));
  assert.equal(history.state(initial).loading, false);
  assert.equal(history.state(initial).error, "Try again");
  const retry = history.begin(initial)!;
  assert.equal(retry.cursor, "retry-cursor");
  history.latest();
  assert.equal(history.complete(retry, page("stale"), initial, 1), false);
  assert.equal(history.state(initial).browsing, false);
  assert.deepEqual(history.rows(initial), initial.visibleTurnItems);
});

test("retained history pages locally and remote paging continues within memory and IPC limits", () => {
  const initial = projection(100);
  const history = new T3ThreadHistory();
  history.reset("remote-cursor", true);
  assert.equal(history.rows(initial).length, 64);
  assert.equal(history.begin(initial)?.cursor, null);
  assert.equal(history.rows(initial)[0]?.item.id, "recent-20");
  history.begin(initial);
  history.begin(initial);
  assert.equal(history.rows(initial)[0]?.item.id, "recent-0");
  for (let index = 0; index < 40; index++) {
    const request = history.begin(initial)!;
    assert.notEqual(request.cursor, null);
    assert(history.complete(request, page(`page-${index}`, 16, `cursor-${index}`), initial, 1));
    assert(history.rows(initial).length <= 64);
  }
  assert.equal(history.rows(initial)[0]?.item.id, "page-39-0");
  history.latest();
  assert.equal(history.rows(initial).at(-1)?.item.id, "recent-99");
});

test("history does not resurrect a row hidden by a live update while its page was in flight", () => {
  const initial = projection();
  const history = new T3ThreadHistory();
  history.reset("cursor", true);
  const request = history.begin(initial)!;
  const hidden = assistantItem("Hidden", "hidden");
  const current = { ...initial, turnItems: [...initial.turnItems, hidden] };
  const older = page("older", 1);
  history.complete(request, { ...older, items: [projectedItem(hidden), ...older.items] }, current, 1);
  assert(!history.rows(current).some((row) => row.item.id === hidden.id));
});

test("history operation validation requires environment and thread identity", () => {
  for (const type of ["thread.history.load", "thread.history.latest"]) {
    const decode = (payload: Record<string, unknown>) => decodeRequestLine(JSON.stringify({ protocolVersion: 1, requestId: "history", type, payload }));
    assert.throws(() => decode({ threadId: "thread" }), /environmentId/);
    assert.throws(() => decode({ environmentId: "environment" }), /threadId/);
    assert.equal(decode({ environmentId: "environment", threadId: "thread" }).type, type);
  }
});

test("session history loads publish loading state and ignore pages after close or reconnect", async () => {
  const snapshots: ThreadDto[] = [];
  let finishPage!: (value: OrchestrationV2ThreadHistoryPage) => void;
  const session = new T3EnvironmentSession({ onInbox() {}, onThread(dto) { snapshots.push(dto); },
    onMessageDelta() {}, onMessageCompleted() {}, onApproval() {}, onInput() {}, onClosed() {}, onError() {} },
    async () => new Promise((resolve) => { finishPage = resolve; }));
  Object.assign(session, { environmentId: "environment-1", prepared: {} });
  session.projection.config = config;
  session.projection.shell = v2ShellSnapshot;
  session.projection.applyThread({ kind: "snapshot", snapshotSequence: 1, projection: projection(), historyCursor: "cursor", hasMoreHistory: true });
  const loading = session.loadEarlier(v2Projection.thread.id);
  assert.equal(snapshots.at(-1)?.history.loading, true);
  assert.deepEqual(await session.loadEarlier(v2Projection.thread.id), { loaded: false });
  finishPage(page("older"));
  assert.deepEqual(await loading, { loaded: true });
  assert.equal(snapshots.at(-1)?.history.loading, false);
  session.projection.applyThread({ kind: "snapshot", snapshotSequence: 2, projection: projection(), historyCursor: "new", hasMoreHistory: true });
  const stale = session.loadEarlier(v2Projection.thread.id);
  await session.closeThread();
  const count = snapshots.length;
  finishPage(page("stale"));
  assert.deepEqual(await stale, { loaded: false });
  assert.equal(snapshots.length, count);
  assert.equal(session.projection.thread, null);
});

test("unsupported history loading returns a retryable UI state without querying the server", async () => {
  const session = new T3EnvironmentSession({ onInbox() {}, onThread() {}, onMessageDelta() {},
    onMessageCompleted() {}, onApproval() {}, onInput() {}, onClosed() {}, onError() {} });
  Object.assign(session, { environmentId: "environment-1", prepared: {} });
  session.projection.config = { ...config, threadSnapshotPagination: false };
  session.projection.shell = v2ShellSnapshot;
  session.projection.applyThread({ kind: "snapshot", snapshotSequence: 1, projection: projection(), historyCursor: "cursor", hasMoreHistory: true });
  await assert.rejects(session.loadEarlier(v2Projection.thread.id), /does not support/);
  assert.equal(session.projection.history.loading, false);
  assert.equal(session.projection.history.state(session.projection.thread!).hasMore, true);
});

test("history pages ahead of the live sequence retain their cursor for retry after catch-up", async () => {
  const snapshots: ThreadDto[] = [];
  const cursors: string[] = [];
  const ahead = { ...page("older", 1, "next-cursor"), snapshotSequence: 3 };
  const session = new T3EnvironmentSession({ onInbox() {}, onThread(dto) { snapshots.push(dto); },
    onMessageDelta() {}, onMessageCompleted() {}, onApproval() {}, onInput() {}, onClosed() {}, onError() {} },
    async (_prepared, _threadId, cursor) => { cursors.push(cursor); return ahead; });
  Object.assign(session, { environmentId: "environment-1", prepared: {} });
  session.projection.config = config;
  session.projection.shell = v2ShellSnapshot;
  session.projection.applyThread({ kind: "snapshot", snapshotSequence: 1, projection: projection(), historyCursor: "cursor", hasMoreHistory: true });

  await assert.rejects(session.loadEarlier(v2Projection.thread.id), { code: "HISTORY_NOT_SYNCHRONIZED", retryable: true });
  assert.equal(snapshots.at(-1)?.history.loading, false);
  assert.match(snapshots.at(-1)?.history.error ?? "", /still synchronizing/);
  assert(!session.projection.history.rows(session.projection.thread!).some((row) => row.item.id === "older-0"));

  // Unknown events still advance the stream watermark without resetting history.
  session.projection.applyThread({ kind: "unknown-event", sequence: 3, eventType: "future.event" });
  assert.deepEqual(await session.loadEarlier(v2Projection.thread.id), { loaded: true });
  assert.deepEqual(cursors, ["cursor", "cursor"]);
  assert.equal(snapshots.at(-1)?.history.error, null);
  assert.equal(session.projection.history.rows(session.projection.thread!)[0]?.item.id, "older-0");

  // Pages behind the stream remain compatible and use the upstream live-row merge.
  session.projection.applyThread({ kind: "unknown-event", sequence: 4, eventType: "future.event" });
  assert.deepEqual(await session.loadEarlier(v2Projection.thread.id), { loaded: true });
  assert.equal(cursors.at(-1), "next-cursor");
});

test("thread opening gets the bounded window and history cursor directly from the socket", async () => {
  const received = Promise.withResolvers<ThreadDto>();
  const requests: Array<{ threadId: string; acceptBoundedSnapshot?: boolean; afterSequence?: number }> = [];
  const bounded = Schema.decodeUnknownSync(OrchestrationV2ThreadBoundedSnapshot)({
    snapshotSequence: 1, projection: projection(), historyCursor: "socket-cursor",
    hasMoreHistory: true, latestLocalTurnOrdinal: null,
  });
  const cursors: string[] = [];
  const session = new T3EnvironmentSession({ onInbox() {}, onThread(dto) { received.resolve(dto); },
    onMessageDelta() {}, onMessageCompleted() {}, onApproval() {}, onInput() {}, onClosed() {}, onError() {} },
    async (_prepared, _threadId, cursor) => { cursors.push(cursor); return page("older"); });
  Object.assign(session, { environmentId: "environment-1", prepared: {}, session: { client: {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread](input: (typeof requests)[number]) {
      requests.push(input);
      return Stream.concat(Stream.make({ kind: "snapshot" as const, ...bounded }), Stream.never);
    },
  } } });
  session.projection.config = config;
  session.projection.shell = v2ShellSnapshot;
  try {
    await session.openThread(v2Projection.thread.id);
    const dto = await received.promise;
    assert.equal(dto.history.hasMore, true);
    assert.deepEqual(requests, [{ threadId: v2Projection.thread.id, acceptBoundedSnapshot: true }]);
    assert.deepEqual(await session.loadEarlier(v2Projection.thread.id), { loaded: true });
    assert.deepEqual(cursors, ["socket-cursor"]);
  } finally {
    await session.close();
  }
});

test("a stale jump-to-latest refresh cannot let shell updates duplicate a newer thread subscription", async () => {
  const interrupting = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<void>();
  const inbox = Promise.withResolvers<void>();
  const streamRequests: string[] = [];
  const nextId = ThreadId.make("next-thread");
  const session = new T3EnvironmentSession({ onInbox() { inbox.resolve(); }, onThread() {},
    onMessageDelta() {}, onMessageCompleted() {}, onApproval() {}, onInput() {}, onClosed() {}, onError() {} });
  Object.assign(session, { environmentId: "environment-1", prepared: {}, session: { client: {
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]() {
      return Stream.concat(Stream.make({ kind: "snapshot" as const, snapshot: v2ShellSnapshot }), Stream.never);
    },
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }: { threadId: string }) {
      streamRequests.push(threadId);
      return threadId === nextId ? Stream.never : Stream.never.pipe(Stream.ensuring(Effect.promise(() => {
        interrupting.resolve();
        return interrupted.promise;
      })));
    },
  } } });
  session.projection.config = config;
  session.projection.shell = v2ShellSnapshot;

  try {
    // A socket without an initial item must not keep openThread pending.
    await session.openThread(v2Projection.thread.id);
    await setImmediate();
    session.projection.applyThread({ kind: "snapshot", snapshotSequence: 1, projection: projection(), historyCursor: "cursor", hasMoreHistory: true });
    const refresh = session.showLatest(v2Projection.thread.id);
    await interrupting.promise;
    await session.openThread(nextId);
    interrupted.resolve();
    await refresh;
    // Deliver a shell update while the newer socket snapshot is still pending.
    (session as unknown as { startShellStream(): void }).startShellStream();
    await inbox.promise;
    await setImmediate();
    assert.deepEqual(streamRequests, [v2Projection.thread.id, nextId]);
    assert.equal(session.projection.thread, null);
  } finally {
    interrupted.resolve();
    await session.close();
  }
});
