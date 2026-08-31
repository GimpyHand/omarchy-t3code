import { createServer, type Server } from "node:http";

import { BridgeError } from "../security/redact.ts";
import { stateMatches } from "./pkce.ts";

const COMPLETE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>T3 Connect complete</title><style>body{font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:34rem;padding:2rem;text-align:center}h1{font-size:1.4rem}</style></head>
<body><main><h1>Connected to T3</h1><p>Authentication is complete. Omarchy T3 Command Center is opening; this tab can be closed.</p></main></body></html>`;

export interface CallbackHandle {
  host: "127.0.0.1";
  port: number;
  code: Promise<string>;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startCallbackServer(input: {
  port: number;
  expectedState: string;
  timeoutMs?: number;
}): Promise<CallbackHandle> {
  let boundPort = input.port;
  let resolveCode!: (value: string) => void;
  let rejectCode!: (reason: unknown) => void;
  let settled = false;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${boundPort}`);
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }
    const returnedCode = url.searchParams.get("code");
    if (!stateMatches(input.expectedState, url.searchParams.get("state")) || !returnedCode) {
      response.writeHead(400, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("Invalid T3 Connect authorization callback.");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(COMPLETE_HTML);
    if (!settled) {
      settled = true;
      resolveCode(returnedCode);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        new BridgeError(
          error.code === "EADDRINUSE" ? "CALLBACK_PORT_OCCUPIED" : "CALLBACK_LISTEN_FAILED",
          error.code === "EADDRINUSE"
            ? `T3's OAuth callback port ${input.port} is already in use.`
            : "Could not start the loopback OAuth listener.",
          error.code === "EADDRINUSE",
        ),
      );
    };
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: input.port, exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (address !== null && typeof address === "object") boundPort = address.port;
      resolve();
    });
  });

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCode(new BridgeError("AUTH_TIMEOUT", "T3 Connect authentication timed out.", true));
    void closeServer(server);
  }, input.timeoutMs ?? 10 * 60_000);
  timeout.unref();

  return {
    host: "127.0.0.1",
    port: boundPort,
    code,
    async close() {
      clearTimeout(timeout);
      if (server.listening) await closeServer(server);
    },
  };
}
