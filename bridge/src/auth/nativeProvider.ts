import type { AuthStatusDto } from "../protocol/types.ts";
import { BridgeError } from "../security/redact.ts";
import type { SecretStore } from "../security/secretStore.ts";
import { openSystemBrowser } from "./browser.ts";
import { startNativeCallbackServer } from "./nativeCallback.ts";
import { activateT3ProtocolHandler } from "./protocolHandler.ts";
import type { AuthProvider } from "./provider.ts";

const CLERK_CLIENT_SECRET_KEY = "t3-connect-clerk-client";
const LEGACY_CLI_OAUTH_SECRET_KEY = "t3-connect-oauth";
const RELAY_TOKEN_REFRESH_MARGIN_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface NativeClerkConfig {
  clerkUrl: string;
  jwtTemplate: string;
  desktopRedirectUrl: string;
  clerkApiVersion: string;
  clerkJsVersion: string;
  electronSdkVersion: string;
}

export const DEFAULT_NATIVE_CLERK_CONFIG: Readonly<NativeClerkConfig> = Object.freeze({
  clerkUrl: "https://clerk.t3.codes",
  jwtTemplate: "t3-relay",
  desktopRedirectUrl: "t3code://app/",
  // These match the Clerk versions pinned by T3 Nightly at the compatibility
  // revision. They are public request metadata, not credentials.
  clerkApiVersion: "2026-05-12",
  clerkJsVersion: "6.29.2",
  electronSdkVersion: "0.0.34",
});

interface NativeClerkProviderOptions {
  store: SecretStore;
  fetch?: typeof globalThis.fetch;
  openBrowser?: (url: string) => Promise<void>;
  activateProtocolHandler?: () => Promise<() => Promise<void>>;
  config?: Partial<NativeClerkConfig>;
  callbackTimeoutMs?: number;
  onStatus?: (status: AuthStatusDto) => void;
}

interface ClerkResult {
  data: Record<string, unknown>;
  client: Record<string, unknown> | null;
  clientToken: string;
}

interface ActiveSession {
  id: string;
  value: Record<string, unknown>;
}

class ClerkRequestError extends BridgeError {
  constructor(
    code: string,
    message: string,
    readonly status: number,
    retryable = false,
  ) {
    super(code, message, retryable);
  }
}

function validateOrigin(raw: string): string {
  const url = new URL(raw);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password) {
    throw new BridgeError("AUTH_CONFIG_INVALID", "The T3 Connect Clerk URL must be a secure origin.");
  }
  return url.origin;
}

function parseJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned an unreadable response.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned an unreadable response.");
  }
  return parsed as Record<string, unknown>;
}

function authorizationToken(response: Response, fallback: string): string {
  const header = response.headers.get("authorization") ?? "";
  if (header.length === 0) return fallback;
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

function activeSession(client: Record<string, unknown>): ActiveSession | null {
  const sessions = Array.isArray(client.sessions) ? client.sessions : [];
  const active = sessions.filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && entry.status === "active" && typeof entry.id === "string",
  );
  const preferredId = typeof client.last_active_session_id === "string" ? client.last_active_session_id : "";
  const selected = active.find((entry) => entry.id === preferredId) ?? active[0];
  return selected && typeof selected.id === "string" ? { id: selected.id, value: selected } : null;
}

function sessionIdentity(session: Record<string, unknown>): string | null {
  const user = session.user;
  if (user === null || typeof user !== "object" || Array.isArray(user)) return null;
  const value = user as Record<string, unknown>;
  const addresses = Array.isArray(value.email_addresses)
    ? value.email_addresses.filter(
      (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry),
    )
    : [];
  const primaryId = typeof value.primary_email_address_id === "string" ? value.primary_email_address_id : "";
  const primary = addresses.find((entry) => entry.id === primaryId) ?? addresses[0];
  if (primary && typeof primary.email_address === "string" && primary.email_address.trim().length > 0) {
    return primary.email_address.trim();
  }
  return typeof value.username === "string" && value.username.trim().length > 0 ? value.username.trim() : null;
}

function signInRecord(result: ClerkResult): Record<string, unknown> | null {
  if (result.data.object === "sign_in_attempt") return result.data;
  const client = resolveClientRecord(result);
  const signIn = client?.sign_in;
  if (signIn !== null && typeof signIn === "object" && !Array.isArray(signIn)) {
    return signIn as Record<string, unknown>;
  }
  return null;
}

function signInId(result: ClerkResult): string | null {
  const signIn = signInRecord(result);
  const id = signIn?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function signInStatus(result: ClerkResult): string | null {
  const signIn = signInRecord(result);
  const status = signIn?.status;
  return typeof status === "string" ? status : null;
}

type SecondFactorStrategy = "email_code" | "totp" | "phone_code";

interface PendingSecondFactor {
  signInId: string;
  strategy: SecondFactorStrategy;
  emailAddressId?: string;
  phoneNumberId?: string;
  message: string;
}

export type PasswordSignInResult =
  | { status: "complete" }
  | { status: "second_factor"; message: string };

function parseSignInFactor(entry: unknown): Record<string, unknown> | null {
  return entry !== null && typeof entry === "object" && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : null;
}

function pickSecondFactor(signIn: Record<string, unknown>): PendingSecondFactor | null {
  const id = signIn.id;
  if (typeof id !== "string" || id.length === 0) return null;
  const factors = Array.isArray(signIn.supported_second_factors) ? signIn.supported_second_factors : [];
  for (const strategy of ["email_code", "totp", "phone_code"] as const) {
    const match = factors.map(parseSignInFactor).find((entry) => entry?.strategy === strategy);
    if (match === null || match === undefined) continue;
    if (strategy === "email_code") {
      const emailAddressId = typeof match.email_address_id === "string" ? match.email_address_id : "";
      if (emailAddressId.length === 0) continue;
      return {
        signInId: id,
        strategy,
        emailAddressId,
        message: "Enter the verification code from the email T3 Connect just sent you.",
      };
    }
    if (strategy === "totp") {
      return {
        signInId: id,
        strategy,
        message: "Enter the code from your authenticator app.",
      };
    }
    const phoneNumberId = typeof match.phone_number_id === "string" ? match.phone_number_id : "";
    if (phoneNumberId.length === 0) continue;
    return {
      signInId: id,
      strategy,
      phoneNumberId,
      message: "Enter the verification code sent to your phone.",
    };
  }
  return null;
}

function resolveClientRecord(result: ClerkResult): Record<string, unknown> | null {
  if (result.client !== null) return result.client;
  if (result.data.object === "client") return result.data;
  return null;
}

function pendingSignInId(client: Record<string, unknown>): string | null {
  const signIn = client.sign_in;
  if (signIn === null || typeof signIn !== "object" || Array.isArray(signIn)) return null;
  const id = (signIn as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function jwtExpiryEpochMs(token: string): number {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return Date.now() + 30_000;
    const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof claims.exp === "number" && Number.isFinite(claims.exp)
      ? claims.exp * 1_000
      : Date.now() + 30_000;
  } catch {
    return Date.now() + 30_000;
  }
}

export class NativeClerkProvider implements AuthProvider {
  private currentStatus: AuthStatusDto = {
    phase: "signedOut",
    identity: null,
    remoteAccess: "unknown",
    detail: null,
  };
  private relayToken: { token: string; expiresAtEpochMs: number } | null = null;
  private readonly config: NativeClerkConfig;
  private readonly request: typeof globalThis.fetch;
  private readonly launch: (url: string) => Promise<void>;
  private readonly activateHandler: () => Promise<() => Promise<void>>;
  private pendingSecondFactor: PendingSecondFactor | null = null;

  constructor(private readonly options: NativeClerkProviderOptions) {
    this.config = { ...DEFAULT_NATIVE_CLERK_CONFIG, ...options.config };
    this.request = options.fetch ?? globalThis.fetch;
    this.launch = options.openBrowser ?? openSystemBrowser;
    this.activateHandler = options.activateProtocolHandler ?? (() => activateT3ProtocolHandler());
  }

  status(): AuthStatusDto {
    return this.currentStatus;
  }

  private publish(status: AuthStatusDto): AuthStatusDto {
    this.currentStatus = status;
    this.options.onStatus?.(status);
    return status;
  }

  private signedInStatus(session: ActiveSession): AuthStatusDto {
    return {
      phase: "signedIn",
      identity: sessionIdentity(session.value),
      remoteAccess: "unknown",
      detail: null,
    };
  }

  private async clerkRequest(
    resource: string,
    clientToken: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    action: string,
  ): Promise<ClerkResult> {
    const origin = validateOrigin(this.config.clerkUrl);
    const url = new URL(resource, `${origin}/`);
    url.searchParams.set("__clerk_api_version", this.config.clerkApiVersion);
    url.searchParams.set("_clerk_js_version", this.config.clerkJsVersion);
    url.searchParams.set("_is_native", "1");
    url.searchParams.set("_electron_sdk_version", this.config.electronSdkVersion);
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (clientToken.length > 0) headers.authorization = `Bearer ${clientToken}`;
    if (init.body !== undefined && headers["content-type"] === undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.request(url, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BridgeError("AUTH_UNAVAILABLE", `${action} could not reach T3 Connect.`, true);
    }
    const text = await response.text();
    if (!response.ok) {
      try {
        const body = parseJsonObject(text);
        const errors = Array.isArray(body.errors) ? body.errors : [];
        const first = errors.find(
          (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry),
        );
        if (first) {
          const code = typeof first.code === "string" ? first.code : "";
          const clerkMessage = typeof first.long_message === "string" && first.long_message.trim().length > 0
            ? first.long_message.trim()
            : typeof first.message === "string" && first.message.trim().length > 0
              ? first.message.trim()
              : null;
          if (code === "form_password_incorrect") {
            throw new BridgeError("AUTH_PASSWORD_INVALID", "That email and password combination is incorrect.", false);
          }
          if (code === "form_identifier_not_found") {
            throw new BridgeError("AUTH_IDENTIFIER_NOT_FOUND", "No T3 Connect account matches that email.", false);
          }
          if (code === "form_code_incorrect") {
            throw new BridgeError("AUTH_CODE_INVALID", "That verification code is incorrect.", false);
          }
          if (clerkMessage !== null) {
            throw new ClerkRequestError("AUTH_REQUEST_REJECTED", clerkMessage, response.status, response.status >= 500);
          }
        }
      } catch (error) {
        if (error instanceof BridgeError || error instanceof ClerkRequestError) throw error;
      }
      throw new ClerkRequestError(
        "AUTH_REQUEST_REJECTED",
        `${action} failed (${response.status}).`,
        response.status,
        response.status >= 500,
      );
    }
    const body = parseJsonObject(text);
    const responseValue = body.response;
    const data = responseValue !== null && typeof responseValue === "object" && !Array.isArray(responseValue)
      ? responseValue as Record<string, unknown>
      : body;
    const clientValue = body.client;
    const client = clientValue !== null && typeof clientValue === "object" && !Array.isArray(clientValue)
      ? clientValue as Record<string, unknown>
      : null;
    return { data, client, clientToken: authorizationToken(response, clientToken) };
  }

  private async rememberClientToken(token: string): Promise<string> {
    if (token.length === 0) {
      throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned no native session credential.");
    }
    await this.options.store.set(CLERK_CLIENT_SECRET_KEY, token);
    return token;
  }

  private async initializeClient(): Promise<ClerkResult> {
    const result = await this.clerkRequest("/v1/client", "", { method: "GET" }, "T3 Connect session setup");
    await this.rememberClientToken(result.clientToken);
    return result;
  }

  private async currentClient(createWhenMissing: boolean): Promise<ClerkResult | null> {
    const stored = await this.options.store.get(CLERK_CLIENT_SECRET_KEY);
    if (stored === null || stored.length === 0) return createWhenMissing ? this.initializeClient() : null;
    try {
      const result = await this.clerkRequest("/v1/client", stored, { method: "GET" }, "T3 Connect sign-in check");
      await this.rememberClientToken(result.clientToken);
      return result;
    } catch (error) {
      if (!(error instanceof ClerkRequestError) || (error.status !== 401 && error.status !== 403)) throw error;
      await this.options.store.remove(CLERK_CLIENT_SECRET_KEY).catch(() => undefined);
      return createWhenMissing ? this.initializeClient() : null;
    }
  }

  async initialize(): Promise<AuthStatusDto> {
    try {
      const client = await this.currentClient(false);
      if (client === null) {
        const legacy = await this.options.store.get(LEGACY_CLI_OAUTH_SECRET_KEY);
        return this.publish({
          phase: "signedOut",
          identity: null,
          remoteAccess: "unknown",
          detail: legacy === null ? null : "Sign in once more to upgrade this client to T3 Connect Relay authentication.",
        });
      }
      const session = activeSession(client.data);
      if (session === null) {
        return this.publish({ phase: "signedOut", identity: null, remoteAccess: "unknown", detail: null });
      }
      return this.publish(this.signedInStatus(session));
    } catch (error) {
      return this.publish({
        phase: "error",
        identity: null,
        remoteAccess: "unknown",
        detail: error instanceof Error ? error.message : "T3 Connect session validation failed.",
      });
    }
  }

  private async ensureSignedInClient(token: string): Promise<string> {
    let result = await this.clerkRequest("/v1/client", token, { method: "GET" }, "T3 Connect sign-in check");
    let nextToken = await this.rememberClientToken(result.clientToken);
    const client = resolveClientRecord(result);
    if (client === null || activeSession(client) === null) {
      throw new BridgeError("AUTH_INCOMPLETE", "T3 Connect did not create an active session.");
    }
    return nextToken;
  }

  private async prepareSecondFactor(token: string, pending: PendingSecondFactor): Promise<string> {
    const params = new URLSearchParams({ strategy: pending.strategy });
    if (pending.emailAddressId) params.set("email_address_id", pending.emailAddressId);
    if (pending.phoneNumberId) params.set("phone_number_id", pending.phoneNumberId);
    const result = await this.clerkRequest(
      `/v1/client/sign_ins/${encodeURIComponent(pending.signInId)}/prepare_second_factor`,
      token,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      },
      "T3 Connect verification",
    );
    return this.rememberClientToken(result.clientToken);
  }

  async submitPasswordSignIn(
    clientToken: string,
    identifier: string,
    password: string,
  ): Promise<{ token: string; result: PasswordSignInResult }> {
    this.pendingSecondFactor = null;
    let token = clientToken;
    let result = await this.clerkRequest(
      "/v1/client/sign_ins",
      token,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ identifier }).toString(),
      },
      "T3 Connect password sign-in",
    );
    token = await this.rememberClientToken(result.clientToken);

    const startedSignInId = signInId(result) ?? (() => {
      const client = resolveClientRecord(result);
      return client === null ? null : pendingSignInId(client);
    })();
    if (startedSignInId === null) {
      throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned no sign-in request.");
    }

    result = await this.clerkRequest(
      `/v1/client/sign_ins/${encodeURIComponent(startedSignInId)}/attempt_first_factor`,
      token,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          strategy: "password",
          password,
        }).toString(),
      },
      "T3 Connect password sign-in",
    );
    token = await this.rememberClientToken(result.clientToken);

    const status = signInStatus(result);
    if (status === "needs_second_factor" || status === "needs_client_trust") {
      const signIn = signInRecord(result);
      if (signIn === null) {
        throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned no verification step.");
      }
      const pending = pickSecondFactor(signIn);
      if (pending === null) {
        throw new BridgeError(
          "AUTH_SECOND_FACTOR_UNSUPPORTED",
          "This account needs a verification step the mini client does not support yet. Use Google or GitHub sign-in for now.",
          false,
        );
      }
      this.pendingSecondFactor = pending;
      token = await this.prepareSecondFactor(token, pending);
      return { token, result: { status: "second_factor", message: pending.message } };
    }

    token = await this.ensureSignedInClient(token);
    return { token, result: { status: "complete" } };
  }

  async submitSecondFactorSignIn(clientToken: string, code: string): Promise<string> {
    const pending = this.pendingSecondFactor;
    if (pending === null) {
      throw new BridgeError("AUTH_SECOND_FACTOR_PENDING", "No verification step is waiting. Start sign-in again from the Omarchy panel.");
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      throw new BridgeError("AUTH_CODE_INVALID", "Enter the verification code.", false);
    }

    let token = clientToken;
    const result = await this.clerkRequest(
      `/v1/client/sign_ins/${encodeURIComponent(pending.signInId)}/attempt_second_factor`,
      token,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          strategy: pending.strategy,
          code: trimmed,
        }).toString(),
      },
      "T3 Connect verification",
    );
    token = await this.rememberClientToken(result.clientToken);
    this.pendingSecondFactor = null;
    return this.ensureSignedInClient(token);
  }

  async login(): Promise<AuthStatusDto> {
    this.publish({ phase: "signingIn", identity: null, remoteAccess: "unknown", detail: null });
    let callback: Awaited<ReturnType<typeof startNativeCallbackServer>> | null = null;
    let restoreHandler: (() => Promise<void>) | null = null;
    try {
      const initial = await this.currentClient(true);
      if (initial === null) throw new BridgeError("AUTH_START_FAILED", "Could not initialize T3 Connect sign-in.");
      let clientToken = initial.clientToken;
      let oauthSignInId = "";
      callback = await startNativeCallbackServer({
        store: this.options.store,
        ...(this.options.callbackTimeoutMs !== undefined ? { timeoutMs: this.options.callbackTimeoutMs } : {}),
        signInWithPassword: async (identifier, password) => {
          const step = await this.submitPasswordSignIn(clientToken, identifier, password);
          clientToken = step.token;
          return step.result;
        },
        completeSecondFactor: async (code) => {
          clientToken = await this.submitSecondFactorSignIn(clientToken, code);
        },
        startOAuthSignIn: async (provider) => {
          const started = await this.clerkRequest(
            "/v1/client/sign_ins",
            clientToken,
            {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                strategy: `oauth_${provider}`,
                redirect_url: this.config.desktopRedirectUrl,
                action_complete_redirect_url: this.config.desktopRedirectUrl,
              }).toString(),
            },
            "T3 Connect browser sign-in",
          );
          clientToken = await this.rememberClientToken(started.clientToken);
          if (typeof started.data.id !== "string" || started.data.id.length === 0) {
            throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned no sign-in request.");
          }
          const verification = started.data.first_factor_verification;
          if (verification === null || typeof verification !== "object" || Array.isArray(verification)) {
            throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned no browser verification.");
          }
          const verificationUrl = (verification as Record<string, unknown>).external_verification_redirect_url;
          if (typeof verificationUrl !== "string" || verificationUrl.length === 0) {
            throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned no browser verification.");
          }
          oauthSignInId = started.data.id;
          return verificationUrl;
        },
      });
      restoreHandler = await this.activateHandler();
      await this.launch(`http://${callback.host}:${callback.port}/`);

      const completion = await Promise.race([
        callback.result.then((value) => ({ kind: "callback" as const, value })),
        callback.signInCompleted.then(() => ({ kind: "inline" as const })),
      ]);

      let client: Record<string, unknown> | null = null;
      if (completion.kind === "callback") {
        let signInId = oauthSignInId;
        if (signInId.length === 0) {
          const current = await this.clerkRequest("/v1/client", clientToken, { method: "GET" }, "T3 Connect sign-in check");
          clientToken = await this.rememberClientToken(current.clientToken);
          signInId = pendingSignInId(current.data) ?? "";
        }
        if (signInId.length === 0) {
          throw new BridgeError("AUTH_CALLBACK_INVALID", "T3 Connect returned before sign-in was initialized.");
        }
        const completed = await this.clerkRequest(
          `/v1/client/sign_ins/${encodeURIComponent(signInId)}?rotating_token_nonce=${encodeURIComponent(completion.value.rotatingTokenNonce)}`,
          clientToken,
          { method: "GET" },
          "T3 Connect browser callback",
        );
        clientToken = await this.rememberClientToken(completed.clientToken);
        client = completed.client ?? completed.data;
      } else {
        const refreshed = await this.currentClient(true);
        if (refreshed === null) throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned no completed session.");
        clientToken = refreshed.clientToken;
        client = refreshed.data;
      }

      if (client === null) {
        const refreshed = await this.currentClient(true);
        client = refreshed?.data ?? null;
      }
      if (client === null) throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned no completed session.");
      const session = activeSession(client);
      if (session === null) throw new BridgeError("AUTH_INCOMPLETE", "T3 Connect did not create an active session.");
      this.relayToken = null;
      await this.options.store.remove(LEGACY_CLI_OAUTH_SECRET_KEY).catch(() => undefined);
      return this.publish(this.signedInStatus(session));
    } catch (error) {
      this.publish({
        phase: "error",
        identity: null,
        remoteAccess: "unknown",
        detail: error instanceof Error ? error.message : "T3 Connect authentication failed.",
      });
      throw error;
    } finally {
      await callback?.close().catch(() => undefined);
      await restoreHandler?.().catch(() => undefined);
    }
  }

  async logout(): Promise<AuthStatusDto> {
    this.relayToken = null;
    await Promise.all([
      this.options.store.remove(CLERK_CLIENT_SECRET_KEY),
      this.options.store.remove(LEGACY_CLI_OAUTH_SECRET_KEY),
    ]);
    return this.publish({ phase: "signedOut", identity: null, remoteAccess: "unknown", detail: null });
  }

  async relayCredential(): Promise<{ token: string; kind: "clerk_session" }> {
    if (this.relayToken !== null && this.relayToken.expiresAtEpochMs > Date.now() + RELAY_TOKEN_REFRESH_MARGIN_MS) {
      return { token: this.relayToken.token, kind: "clerk_session" };
    }
    const client = await this.currentClient(false);
    const session = client === null ? null : activeSession(client.data);
    if (client === null || session === null) {
      this.relayToken = null;
      throw new BridgeError("AUTH_REQUIRED", "Sign in with T3 Connect first.");
    }
    try {
      const token = await this.clerkRequest(
        `/v1/client/sessions/${encodeURIComponent(session.id)}/tokens/${encodeURIComponent(this.config.jwtTemplate)}?debug=skip_cache`,
        client.clientToken,
        { method: "POST", body: "{}" },
        "T3 Connect Relay sign-in",
      );
      await this.rememberClientToken(token.clientToken);
      if (typeof token.data.jwt !== "string" || token.data.jwt.length === 0) {
        throw new BridgeError("AUTH_RESPONSE_INVALID", "T3 Connect returned no Relay credential.");
      }
      this.relayToken = { token: token.data.jwt, expiresAtEpochMs: jwtExpiryEpochMs(token.data.jwt) };
      return { token: this.relayToken.token, kind: "clerk_session" };
    } catch (error) {
      if (error instanceof ClerkRequestError && (error.status === 401 || error.status === 403)) {
        this.relayToken = null;
        await this.options.store.remove(CLERK_CLIENT_SECRET_KEY).catch(() => undefined);
        this.publish({
          phase: "signedOut",
          identity: null,
          remoteAccess: "unknown",
          detail: "The T3 Connect session expired; sign in again.",
        });
        throw new BridgeError("AUTH_EXPIRED", "The T3 Connect session expired; sign in again.");
      }
      throw error;
    }
  }
}
