import { setImmediate } from "node:timers/promises";
import { ORCHESTRATION_V2_WS_METHODS, OrchestrationV2ThreadHistoryPage, RunId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { NdjsonChannel } from "../../bridge/src/ipc/ndjson.ts";
import { event, failure, success } from "../../bridge/src/protocol/output.ts";
import { asBridgeError } from "../../bridge/src/security/redact.ts";
import { T3Commands } from "../../bridge/src/t3/commands.ts";
import { T3EnvironmentSession } from "../../bridge/src/t3/session.ts";
import { assistantItem, config, projectedItem, v2Projection, v2ShellSnapshot } from "./t3.ts";

let finishPage!: (page: OrchestrationV2ThreadHistoryPage) => void;
let sequence = 0;
const session = new T3EnvironmentSession({
  onInbox() {}, onThread(dto) { channel.write(event("thread.snapshot", dto)); },
  onMessageDelta() {}, onMessageCompleted() {}, onApproval() {}, onInput() {}, onClosed() {}, onError() {},
}, async () => new Promise((resolve) => { finishPage = resolve; }));
session.dispatch = async () => ({ sequence: ++sequence });
const commands = new T3Commands(() => session);

const channel = new NdjsonChannel({
  async handle(request) {
    try {
      let payload: unknown;
      if (request.type === "thread.open") {
        // Opening must finish before a queued history request can start.
        await setImmediate();
        Object.assign(session, { environmentId: "environment-1", prepared: {}, session: { client: {
          [ORCHESTRATION_V2_WS_METHODS.subscribeThread]() { return Stream.never; },
        } } });
        session.projection.config = config;
        session.projection.shell = { ...v2ShellSnapshot, threads: v2ShellSnapshot.threads.map((thread) => ({
          ...thread, activeRunId: RunId.make("active-run"),
        })) };
        await session.openThread(v2Projection.thread.id);
        session.projection.applyThread({ kind: "snapshot", snapshotSequence: 1,
          projection: v2Projection, historyCursor: "cursor", hasMoreHistory: true });
        payload = {};
      } else if (request.type === "thread.close") {
        await session.closeThread();
        channel.write(success(request.requestId, {}));
        // Finish only after close: a blocking fetch would prevent reaching this point.
        finishPage?.(Schema.decodeUnknownSync(OrchestrationV2ThreadHistoryPage)({
          snapshotSequence: 1, items: [projectedItem(assistantItem("Stale page", "older"))],
          nextCursor: null, hasMoreHistory: false,
        }));
        return;
      } else {
        payload = await commands.handle(request);
      }
      channel.write(success(request.requestId, payload));
    } catch (error) {
      const bridgeError = asBridgeError(error);
      channel.write(failure(request.requestId, bridgeError.code, bridgeError.message, bridgeError.retryable));
    }
  },
  async shutdown() { await session.close(); channel.stop(); },
});
channel.start();
