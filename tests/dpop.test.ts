import assert from "node:assert/strict";
import test from "node:test";

import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Effect from "effect/Effect";

import { MemorySecretStore } from "../bridge/src/security/secretStore.ts";
import { DpopKeyManager } from "../bridge/src/t3/dpop.ts";

async function signerFor(manager: DpopKeyManager) {
  return Effect.runPromise(
    ManagedRelay.ManagedRelayDpopSigner.pipe(Effect.provide(manager.signerLayer())),
  );
}

test("Secret-Service-backed DPoP keys produce proofs accepted by pinned T3 verification", async () => {
  const store = new MemorySecretStore();
  const signer = await signerFor(new DpopKeyManager(store));
  const accessToken = "test-access-token";
  const url = "https://relay.example.test/v1/client/connect?ignored=yes#fragment";
  const thumbprint = await Effect.runPromise(signer.thumbprint);
  const proof = await Effect.runPromise(signer.createProof({ method: "POST", url, accessToken }));
  const verified = verifyDpopProof({
    proof,
    method: "POST",
    url,
    nowEpochSeconds: Math.floor(Date.now() / 1_000),
    expectedThumbprint: thumbprint,
    expectedAccessToken: accessToken,
  });
  assert.equal(verified.ok, true);

  const stored = JSON.parse((await store.get("relay-dpop-proof-key"))!);
  assert.equal(stored.privateJwk.kty, "EC");
  assert.equal(typeof stored.privateJwk.d, "string");
  const restored = await signerFor(new DpopKeyManager(store));
  assert.equal(await Effect.runPromise(restored.thumbprint), thumbprint);
});
