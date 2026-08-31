import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { buildClerkLoginPage, buildSecondFactorPage } from "./clerkLoginPage.ts";
import type { PasswordSignInResult } from "./nativeProvider.ts";
import { BridgeError } from "../security/redact.ts";
import type { SecretStore } from "../security/secretStore.ts";

export const NATIVE_CALLBACK_SECRET_KEY = "t3-connect-native-callback";

const CALLBACK_TIMEOUT_MS = 10 * 60_000;
const CALLBACK_BODY_LIMIT = 4_096;

interface PendingCallback {
  version: 1;
  port: number;
  secret: string;
  expiresAtEpochMs: number;
}

export interface NativeCallbackResult {
  rotatingTokenNonce: string;
}

export interface NativeCallbackServer {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly result: Promise<NativeCallbackResult>;
  readonly signInCompleted: Promise<void>;
  close(): Promise<void>;
}

export interface NativeCallbackServerOptions {
  store: SecretStore;
  signInWithPassword: (identifier: string, password: string) => Promise<PasswordSignInResult>;
  completeSecondFactor: (code: string) => Promise<void>;
  startOAuthSignIn: (provider: "google" | "github") => Promise<string>;
  timeoutMs?: number;
}

function safeEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parsePendingCallback(value: string): PendingCallback {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object") {
    throw new BridgeError("AUTH_CALLBACK_INVALID", "The T3 Connect callback state is invalid.");
  }
  const pending = parsed as Record<string, unknown>;
  if (
    pending.version !== 1 ||
    !Number.isInteger(pending.port) ||
    Number(pending.port) < 1 ||
    Number(pending.port) > 65_535 ||
    typeof pending.secret !== "string" ||
    Buffer.from(pending.secret, "base64url").length !== 32 ||
    typeof pending.expiresAtEpochMs !== "number"
  ) {
    throw new BridgeError("AUTH_CALLBACK_INVALID", "The T3 Connect callback state is invalid.");
  }
  return pending as unknown as PendingCallback;
}

function parseNativeCallback(rawUrl: string): NativeCallbackResult {
  let callback: URL;
  try {
    callback = new URL(rawUrl);
  } catch {
    throw new BridgeError("AUTH_CALLBACK_INVALID", "T3 Connect returned an invalid browser callback.");
  }
  if (callback.protocol !== "t3code:" || callback.hostname !== "app") {
    throw new BridgeError("AUTH_CALLBACK_INVALID", "This is not a T3 Connect desktop callback.");
  }
  if (callback.searchParams.get("__clerk_status") === "failed") {
    throw new BridgeError("AUTH_CANCELLED", "T3 Connect browser sign-in was cancelled.");
  }
  const rotatingTokenNonce = callback.searchParams.get("rotating_token_nonce") ?? "";
  if (rotatingTokenNonce.length === 0 || rotatingTokenNonce.length > 4_096) {
    throw new BridgeError("AUTH_CALLBACK_INVALID", "T3 Connect returned an incomplete browser callback.");
  }
  return { rotatingTokenNonce };
}

function readSmallBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > CALLBACK_BODY_LIMIT) {
        reject(new BridgeError("AUTH_CALLBACK_INVALID", "The T3 Connect callback was too large."));
        request.destroy();
      }
    });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });
}

function parseFormBody(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  onFinished?: () => void,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value), onFinished);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function userFacingSignInError(error: unknown): string {
  if (!(error instanceof BridgeError)) {
    return "T3 Connect sign-in failed. Check your email and password, then try again.";
  }
  if (error.code === "AUTH_CANCELLED") return "T3 Connect sign-in was cancelled.";
  if (error.code === "AUTH_PASSWORD_INVALID" || error.code === "AUTH_IDENTIFIER_NOT_FOUND") return error.message;
  if (error.code === "AUTH_CODE_INVALID") return error.message;
  if (error.code === "AUTH_SECOND_FACTOR_PENDING") return error.message;
  if (error.code === "AUTH_SECOND_FACTOR_UNSUPPORTED" || error.code === "AUTH_CLIENT_TRUST_REQUIRED") return error.message;
  if (error.code === "AUTH_REQUIRED" || error.code === "AUTH_INCOMPLETE") {
    return "T3 Connect did not finish sign-in. Check your email and password, then try again.";
  }
  return error.message;
}

export async function startNativeCallbackServer(
  options: NativeCallbackServerOptions,
): Promise<NativeCallbackServer> {
  const secret = randomBytes(32).toString("base64url");
  let settled = false;
  let inlineCompleted = false;
  let signInStarted = false;
  let secondFactorMessage = "";
  let resolveResult!: (value: NativeCallbackResult) => void;
  let rejectResult!: (error: Error) => void;
  let resolveInline!: () => void;
  let rejectInline!: (error: Error) => void;
  const result = new Promise<NativeCallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const signInCompleted = new Promise<void>((resolve, reject) => {
    resolveInline = resolve;
    rejectInline = reject;
  });
  const settle = (value: NativeCallbackResult | Error): void => {
    if (settled) return;
    settled = true;
    if (value instanceof Error) rejectResult(value);
    else resolveResult(value);
  };
  const settleInline = (error?: Error): void => {
    if (inlineCompleted) return;
    inlineCompleted = true;
    if (error) rejectInline(error);
    else resolveInline();
  };

  const server = createServer((request, response) => {
    void (async () => {
      const localUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && localUrl.pathname === "/") {
        sendHtml(response, 200, buildClerkLoginPage());
        return;
      }
      if (request.method === "POST" && localUrl.pathname === "/sign-in/password") {
        const form = parseFormBody(await readSmallBody(request));
        const identifier = form.get("identifier")?.trim() ?? "";
        const password = form.get("password") ?? "";
        if (identifier.length === 0 || password.length === 0) {
          sendHtml(response, 400, buildClerkLoginPage({ errorMessage: "Enter both email and password." }));
          return;
        }
        try {
          const step = await options.signInWithPassword(identifier, password);
          if (step.status === "second_factor") {
            secondFactorMessage = step.message;
            sendHtml(response, 200, buildSecondFactorPage({ message: step.message }));
            return;
          }
          settleInline();
          sendHtml(response, 200, buildClerkLoginPage({ errorMessage: "Signed in. You can close this tab; Omarchy will reopen T3 Command Center." }));
        } catch (error) {
          sendHtml(response, 401, buildClerkLoginPage({ errorMessage: userFacingSignInError(error) }));
        }
        return;
      }
      if (request.method === "POST" && localUrl.pathname === "/sign-in/second-factor") {
        const form = parseFormBody(await readSmallBody(request));
        const code = form.get("code")?.trim() ?? "";
        if (code.length === 0) {
          sendHtml(response, 400, buildSecondFactorPage({
            message: secondFactorMessage || "Enter the verification code from T3 Connect.",
            errorMessage: "Enter the verification code.",
          }));
          return;
        }
        try {
          await options.completeSecondFactor(code);
          settleInline();
          sendHtml(response, 200, buildSecondFactorPage({
            message: "Verified. You can close this tab; Omarchy will reopen T3 Command Center.",
          }));
        } catch (error) {
          sendHtml(response, 401, buildSecondFactorPage({
            message: secondFactorMessage || "Enter the verification code from T3 Connect.",
            errorMessage: userFacingSignInError(error),
          }));
        }
        return;
      }
      if (request.method === "GET" && localUrl.pathname === "/start") {
        const provider = localUrl.searchParams.get("provider");
        if (provider !== "google" && provider !== "github") {
          response.writeHead(400).end();
          return;
        }
        if (signInStarted) {
          response.writeHead(409).end();
          return;
        }
        signInStarted = true;
        try {
          const verificationUrl = new URL(await options.startOAuthSignIn(provider));
          if (verificationUrl.protocol !== "https:" || verificationUrl.username || verificationUrl.password) {
            throw new BridgeError("AUTH_START_FAILED", "T3 Connect returned an unsafe browser destination.");
          }
          response.writeHead(302, { location: verificationUrl.toString(), "cache-control": "no-store" });
          response.end();
        } catch {
          signInStarted = false;
          sendHtml(
            response,
            502,
            buildClerkLoginPage({ errorMessage: "Authorization could not begin. Close this page and retry from the Omarchy panel." }),
          );
        }
        return;
      }
      if (request.method === "POST" && localUrl.pathname === "/oauth-callback") {
        const provided = String(request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
        if (!safeEqual(provided, secret)) {
          response.writeHead(403).end();
          return;
        }
        try {
          const callback = parseNativeCallback(await readSmallBody(request));
          sendJson(response, 200, { handled: true, completed: true }, () => settle(callback));
        } catch (error) {
          const callbackError = error instanceof Error
            ? error
            : new BridgeError("AUTH_CALLBACK_INVALID", "T3 Connect browser sign-in failed.");
          sendJson(response, 200, { handled: true, completed: false }, () => settle(callbackError));
        }
        return;
      }
      response.writeHead(404).end();
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
      settle(error instanceof Error ? error : new BridgeError("AUTH_CALLBACK_FAILED", "T3 Connect callback handling failed."));
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new BridgeError("CALLBACK_BIND_FAILED", "Could not start the T3 Connect loopback callback.");
  }
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    settle(new BridgeError("AUTH_TIMEOUT", "T3 Connect sign-in timed out. Try again from the panel."));
    settleInline(new BridgeError("AUTH_TIMEOUT", "T3 Connect sign-in timed out. Try again from the panel."));
  }, timeoutMs);
  timeout.unref();

  try {
    await options.store.set(NATIVE_CALLBACK_SECRET_KEY, JSON.stringify({
      version: 1,
      port: address.port,
      secret,
      expiresAtEpochMs: Date.now() + timeoutMs,
    } satisfies PendingCallback));
  } catch (error) {
    clearTimeout(timeout);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  let closed = false;
  return {
    host: "127.0.0.1",
    port: address.port,
    result,
    signInCompleted,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      await options.store.remove(NATIVE_CALLBACK_SECRET_KEY).catch(() => undefined);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

export async function forwardNativeCallback(
  rawUrl: string,
  store: SecretStore,
  request: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  parseNativeCallback(rawUrl);
  const stored = await store.get(NATIVE_CALLBACK_SECRET_KEY);
  if (stored === null) {
    throw new BridgeError("AUTH_CALLBACK_NOT_PENDING", "No Omarchy T3 Connect sign-in is waiting.");
  }
  const pending = parsePendingCallback(stored);
  if (pending.expiresAtEpochMs < Date.now()) {
    await store.remove(NATIVE_CALLBACK_SECRET_KEY).catch(() => undefined);
    throw new BridgeError("AUTH_CALLBACK_EXPIRED", "The Omarchy T3 Connect sign-in has expired.");
  }
  let response: Response;
  try {
    response = await request(`http://127.0.0.1:${pending.port}/oauth-callback`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pending.secret}`,
        "content-type": "text/plain; charset=utf-8",
      },
      body: rawUrl,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new BridgeError("AUTH_CALLBACK_UNREACHABLE", "The Omarchy T3 Connect callback listener could not be reached.");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || body === null || typeof body !== "object" || (body as { handled?: unknown }).handled !== true) {
    throw new BridgeError("AUTH_CALLBACK_REJECTED", "The Omarchy T3 Connect callback was not accepted.");
  }
}
