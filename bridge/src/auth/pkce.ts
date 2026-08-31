import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const base64url = (value: Uint8Array): string => Buffer.from(value).toString("base64url");

export interface PkceRequest {
  verifier: string;
  challenge: string;
  state: string;
}

/** Mirrors T3 Nightly's CliTokenManager: 32 verifier bytes and 16 state bytes. */
export function makePkceRequest(): PkceRequest {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: base64url(randomBytes(16)),
  };
}

export function stateMatches(expected: string, received: string | null): boolean {
  if (received === null) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
}
