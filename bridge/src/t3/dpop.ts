import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { importJWK, type JWK } from "jose";

import {
  browserCryptoLayer,
  createBrowserDpopProof,
} from "../../../upstream/t3code/apps/web/src/cloud/dpop.ts";

import type { SecretStore } from "../security/secretStore.ts";

const DPOP_SECRET_KEY = "relay-dpop-proof-key";

interface StoredDpopKey {
  privateJwk: JWK;
  publicJwk: DpopPublicJwk;
  thumbprint: string;
}

interface LoadedDpopKey extends StoredDpopKey {
  privateKey: CryptoKey;
}

function isPublicJwk(value: unknown): value is DpopPublicJwk {
  if (value === null || typeof value !== "object") return false;
  const jwk = value as Record<string, unknown>;
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    jwk.x.length > 0 &&
    typeof jwk.y === "string" &&
    jwk.y.length > 0
  );
}

async function importStored(value: string): Promise<LoadedDpopKey> {
  const parsed = JSON.parse(value) as Partial<StoredDpopKey>;
  if (!parsed.privateJwk || !isPublicJwk(parsed.publicJwk)) throw new Error("Stored DPoP key is invalid.");
  const thumbprint = computeDpopJwkThumbprint(parsed.publicJwk);
  if (parsed.thumbprint !== thumbprint) throw new Error("Stored DPoP key thumbprint does not match.");
  const privateKey = (await importJWK(parsed.privateJwk, "ES256", { extractable: false })) as CryptoKey;
  return { privateJwk: parsed.privateJwk, publicJwk: parsed.publicJwk, thumbprint, privateKey };
}

async function generateKey(): Promise<LoadedDpopKey> {
  const generated = (await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateJwk = (await globalThis.crypto.subtle.exportKey("jwk", generated.privateKey)) as JWK;
  const exportedPublic = await globalThis.crypto.subtle.exportKey("jwk", generated.publicKey);
  if (!isPublicJwk(exportedPublic)) throw new Error("Generated DPoP public key is invalid.");
  const thumbprint = computeDpopJwkThumbprint(exportedPublic);
  const privateKey = (await importJWK(privateJwk, "ES256", { extractable: false })) as CryptoKey;
  return { privateJwk, publicJwk: exportedPublic, thumbprint, privateKey };
}

export class DpopKeyManager {
  private loaded: Promise<LoadedDpopKey> | null = null;

  constructor(private readonly store: SecretStore) {}

  private load(): Promise<LoadedDpopKey> {
    if (this.loaded !== null) return this.loaded;
    this.loaded = (async () => {
      const stored = await this.store.get(DPOP_SECRET_KEY);
      if (stored !== null) return importStored(stored);
      const generated = await generateKey();
      await this.store.set(
        DPOP_SECRET_KEY,
        JSON.stringify({
          privateJwk: generated.privateJwk,
          publicJwk: generated.publicJwk,
          thumbprint: generated.thumbprint,
        }),
      );
      return generated;
    })();
    return this.loaded;
  }

  signerLayer(): Layer.Layer<ManagedRelay.ManagedRelayDpopSigner> {
    const signer = ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.tryPromise({
        try: async () => (await this.load()).thumbprint,
        catch: (cause) =>
          new ManagedRelay.ManagedRelayDpopKeyLoadError({ keyStore: "indexed-db", cause }),
      }),
      createProof: (input) =>
        Effect.tryPromise({ try: () => this.load(), catch: (cause) => cause }).pipe(
          Effect.flatMap((proofKey) =>
            createBrowserDpopProof({ ...input, proofKey }).pipe(
              Effect.provide(browserCryptoLayer),
              Effect.map((result) => result.proof),
            ),
          ),
          Effect.mapError((cause) =>
            new ManagedRelay.ManagedRelayDpopProofCreationError({
              method: input.method,
              url: input.url,
              cause,
            }),
          ),
        ),
    });
    return Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer);
  }
}
