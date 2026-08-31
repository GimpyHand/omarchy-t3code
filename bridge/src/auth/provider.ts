import { buildConnectAuthorizeRequestUrl, connectLoopbackRedirectUri } from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";

import type { AuthStatusDto } from "../protocol/types.ts";
import { BridgeError } from "../security/redact.ts";
import type { SecretStore } from "../security/secretStore.ts";
import { openSystemBrowser } from "./browser.ts";
import { startCallbackServer } from "./callbackServer.ts";
import { makePkceRequest } from "./pkce.ts";

const OAUTH_SECRET_KEY = "t3-connect-oauth";
const REFRESH_EARLY_MS = 5 * 60_000;

export interface AuthConfig {
  hostedAppUrl: string;
  relayUrl: string;
  clerkPublishableKey: string;
  clientId: string;
  loopbackPort: number;
}

export const DEFAULT_AUTH_CONFIG: Readonly<AuthConfig> = Object.freeze({
  // The stable hosted deployment can lag the pinned Nightly's loopback OAuth
  // fixes. A Nightly client must enter through the Nightly web channel so the
  // fragment's loopback port survives sign-in and Clerk redirects back here.
  hostedAppUrl: "https://nightly.app.t3.codes",
  relayUrl: "https://relay.t3.codes",
  clerkPublishableKey: "pk_live_Y2xlcmsudDMuY29kZXMk",
  clientId: "hzxSgY2cH10sDU2r",
  loopbackPort: 34338,
});

export interface OAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtEpochMs: number;
  identity?: string;
}

export interface AuthProvider {
  initialize(): Promise<AuthStatusDto>;
  status(): AuthStatusDto;
  login(): Promise<AuthStatusDto>;
  logout(): Promise<AuthStatusDto>;
  relayCredential(): Promise<{ token: string; kind: "oauth_token" | "clerk_session" }>;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
}

export interface OAuthProviderOptions {
  store: SecretStore;
  fetch?: typeof globalThis.fetch;
  openBrowser?: (url: string) => Promise<void>;
  config?: Partial<AuthConfig>;
  onStatus?: (status: AuthStatusDto) => void;
}

function parseStored(value: string): OAuthCredential {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object") throw new Error("Invalid stored credential.");
  const token = parsed as Record<string, unknown>;
  if (
    typeof token.accessToken !== "string" ||
    typeof token.refreshToken !== "string" ||
    typeof token.expiresAtEpochMs !== "number"
  ) {
    throw new Error("Invalid stored credential.");
  }
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAtEpochMs: token.expiresAtEpochMs,
    ...(typeof token.identity === "string" ? { identity: token.identity } : {}),
  };
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (value === null || typeof value !== "object") throw new Error("OAuth response is not an object.");
  const result = value as Record<string, unknown>;
  if (
    typeof result.access_token !== "string" ||
    typeof result.expires_in !== "number" ||
    typeof result.token_type !== "string"
  ) {
    throw new Error("OAuth response is incomplete.");
  }
  return {
    access_token: result.access_token,
    expires_in: result.expires_in,
    token_type: result.token_type,
    ...(typeof result.refresh_token === "string" ? { refresh_token: result.refresh_token } : {}),
    ...(typeof result.id_token === "string" ? { id_token: result.id_token } : {}),
  };
}

function identityFromIdToken(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const key of ["email", "preferred_username", "sub"] as const) {
      if (typeof claims[key] === "string" && claims[key].length > 0) return claims[key];
    }
  } catch {
    return null;
  }
  return null;
}

export class LoopbackOAuthProvider implements AuthProvider {
  private credential: OAuthCredential | null = null;
  private currentStatus: AuthStatusDto = {
    phase: "signedOut",
    identity: null,
    remoteAccess: "unknown",
    detail: null,
  };
  private readonly config: AuthConfig;
  private readonly request: typeof globalThis.fetch;
  private readonly launch: (url: string) => Promise<void>;

  constructor(private readonly options: OAuthProviderOptions) {
    this.config = { ...DEFAULT_AUTH_CONFIG, ...options.config };
    this.request = options.fetch ?? globalThis.fetch;
    this.launch = options.openBrowser ?? openSystemBrowser;
  }

  status(): AuthStatusDto {
    return this.currentStatus;
  }

  private publish(status: AuthStatusDto): AuthStatusDto {
    this.currentStatus = status;
    this.options.onStatus?.(status);
    return status;
  }

  private signedInStatus(credential: OAuthCredential): AuthStatusDto {
    return {
      phase: "signedIn",
      identity: credential.identity ?? null,
      // Relay compatibility is learned from the real DPoP exchange. Keeping
      // this unknown allows a server-side rollout to unblock existing clients.
      remoteAccess: "unknown",
      detail: null,
    };
  }

  async initialize(): Promise<AuthStatusDto> {
    try {
      const stored = await this.options.store.get(OAUTH_SECRET_KEY);
      if (stored === null) return this.publish({ phase: "signedOut", identity: null, remoteAccess: "unknown", detail: null });
      this.credential = parseStored(stored);
      await this.refreshIfNeeded();
      return this.publish(this.signedInStatus(this.credential));
    } catch {
      this.credential = null;
      await this.options.store.remove(OAUTH_SECRET_KEY).catch(() => undefined);
      return this.publish({
        phase: "signedOut",
        identity: null,
        remoteAccess: "unknown",
        detail: "The saved T3 Connect session expired; sign in again.",
      });
    }
  }

  private async exchange(params: URLSearchParams): Promise<TokenResponse> {
    const frontend = clerkFrontendApiUrlFromPublishableKey(this.config.clerkPublishableKey);
    const response = await this.request(`${frontend}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: params,
      redirect: "error",
    });
    if (!response.ok) {
      throw new BridgeError("AUTH_EXCHANGE_FAILED", `T3 Connect token exchange failed (${response.status}).`, response.status >= 500);
    }
    return parseTokenResponse(await response.json());
  }

  private async persist(response: TokenResponse, prior?: OAuthCredential): Promise<OAuthCredential> {
    const identity = identityFromIdToken(response.id_token) ?? prior?.identity;
    const credential: OAuthCredential = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? prior?.refreshToken ?? "",
      expiresAtEpochMs: Date.now() + response.expires_in * 1_000,
      ...(identity ? { identity } : {}),
    };
    await this.options.store.set(OAUTH_SECRET_KEY, JSON.stringify(credential));
    this.credential = credential;
    return credential;
  }

  private async refreshIfNeeded(): Promise<void> {
    const credential = this.credential;
    if (credential === null || credential.expiresAtEpochMs > Date.now() + REFRESH_EARLY_MS) return;
    if (!credential.refreshToken) throw new BridgeError("AUTH_EXPIRED", "The T3 Connect session expired.");
    const response = await this.exchange(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: this.config.clientId,
      }),
    );
    await this.persist(response, credential);
  }

  async login(): Promise<AuthStatusDto> {
    this.publish({ phase: "signingIn", identity: null, remoteAccess: "unknown", detail: null });
    const pkce = makePkceRequest();
    const callback = await startCallbackServer({
      port: this.config.loopbackPort,
      expectedState: pkce.state,
    });
    try {
      const authorizationUrl = buildConnectAuthorizeRequestUrl({
        hostedAppUrl: this.config.hostedAppUrl,
        state: pkce.state,
        challenge: pkce.challenge,
        loopbackPort: this.config.loopbackPort,
      });
      await this.launch(authorizationUrl);
      const code = await callback.code;
      const response = await this.exchange(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: connectLoopbackRedirectUri(this.config.loopbackPort),
          client_id: this.config.clientId,
          code_verifier: pkce.verifier,
        }),
      );
      const credential = await this.persist(response);
      return this.publish(this.signedInStatus(credential));
    } catch (error) {
      this.publish({
        phase: "error",
        identity: null,
        remoteAccess: "unknown",
        detail: error instanceof Error ? error.message : "T3 Connect authentication failed.",
      });
      throw error;
    } finally {
      await callback.close();
    }
  }

  async logout(): Promise<AuthStatusDto> {
    this.credential = null;
    await this.options.store.remove(OAUTH_SECRET_KEY);
    return this.publish({ phase: "signedOut", identity: null, remoteAccess: "unknown", detail: null });
  }

  async relayCredential(): Promise<{ token: string; kind: "oauth_token" }> {
    if (this.credential === null) throw new BridgeError("AUTH_REQUIRED", "Sign in with T3 Connect first.");
    await this.refreshIfNeeded();
    if (this.credential === null) throw new BridgeError("AUTH_REQUIRED", "Sign in with T3 Connect first.");
    return { token: this.credential.accessToken, kind: "oauth_token" };
  }
}
