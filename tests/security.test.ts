import assert from "node:assert/strict";
import test from "node:test";

import { redactText, redactValue } from "../bridge/src/security/redact.ts";

test("logs redact JWTs, authorization headers, and sensitive object fields", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwZXJzb24ifQ.signaturevalue";
  assert.equal(redactText(`Bearer ${jwt}`), "[REDACTED]");
  assert.equal(redactText(`DPoP ${jwt}`), "[REDACTED]");
  assert.equal(redactText("Bearer opaque-access-token-value"), "[REDACTED]");
  assert.equal(redactText("DPoP token exchange"), "DPoP token exchange");
  assert.equal(
    redactText("CLI OAuth at its DPoP access-credential exchange."),
    "CLI OAuth at its DPoP access-credential exchange.",
  );
  const redacted = redactValue({ accessToken: "opaque", nested: { privateKey: "secret", safe: "visible" } });
  assert.deepEqual(redacted, { accessToken: "[REDACTED]", nested: { privateKey: "[REDACTED]", safe: "visible" } });
});
