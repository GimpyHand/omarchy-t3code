import type { AuthStatusDto } from "../protocol/types.ts";

/**
 * Authentication provider boundary for the bridge.
 *
 * Production uses NativeClerkProvider only. The CLI loopback OAuth provider was
 * removed: the deployed Relay rejects that token type at DPoP exchange
 * (`UPSTREAM_OAUTH_DPOP_UNSUPPORTED`). `relayCredential` may still advertise
 * `oauth_token` so Relay error mapping can classify a non-default credential
 * kind if one ever appears.
 */
export interface AuthProvider {
  initialize(): Promise<AuthStatusDto>;
  status(): AuthStatusDto;
  login(): Promise<AuthStatusDto>;
  logout(): Promise<AuthStatusDto>;
  relayCredential(): Promise<{ token: string; kind: "oauth_token" | "clerk_session" }>;
}
