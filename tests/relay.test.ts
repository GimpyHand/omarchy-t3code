import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { NativeClerkProvider } from "../bridge/src/auth/nativeProvider.ts";
import { MemorySecretStore } from "../bridge/src/security/secretStore.ts";
import { DpopKeyManager } from "../bridge/src/t3/dpop.ts";
import { T3RelayClient } from "../bridge/src/t3/relay.ts";

test("prepared Relay sockets negotiate the upstream protocol and preserve the issued ticket", async () => {
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) !== String(ORCHESTRATION_PROTOCOL_VERSION)) {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
      return;
    }
    assert.equal(url.searchParams.get("wsTicket"), "ticket+with/special=characters");
    assert.equal(url.searchParams.get("clientSurface"), "desktop");
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const socketUrl = new URL(`ws://127.0.0.1:${address.port}/ws`);
  socketUrl.searchParams.set("wsTicket", "ticket+with/special=characters");
  socketUrl.searchParams.set("clientSurface", "desktop");
  const environmentId = EnvironmentId.make("environment-test");
  const store = new MemorySecretStore();
  const relay = new T3RelayClient(new NativeClerkProvider({ store }), new DpopKeyManager(store));
  // Authorization is isolated here; exercise the production connection adapter.
  Object.defineProperty(relay, "environments", { value: new Map([[environmentId, { environmentId, label: "Desktop" }]]) });
  Object.defineProperty(relay, "remoteAuthorization", {
    value: async () => ({
      authorizeDpop: () => Effect.succeed({
        environmentId,
        label: "Desktop",
        httpBaseUrl: `http://127.0.0.1:${address.port}`,
        socketUrl: socketUrl.toString(),
        httpAuthorization: null,
      }),
    }),
  });
  let socket: WebSocket | undefined;
  try {
    const prepared = await relay.prepareConnection(environmentId);
    socket = new WebSocket(prepared.socketUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("Prepared socket was rejected by protocol negotiation")), { once: true });
    });
  } finally {
    socket?.close();
    await relay.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
