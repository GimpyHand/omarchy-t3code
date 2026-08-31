#!/usr/bin/env node
import { redactText } from "./security/redact.ts";
import { forwardNativeCallback } from "./auth/nativeCallback.ts";
import { SecretServiceStore } from "./security/secretStore.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import upstreamLock from "../../t3-upstream.lock.json" with { type: "json" };

async function run(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      protocolVersion: 1,
      bridgeVersion: packageMetadata.version,
      upstreamCommit: upstreamLock.commit,
    })}\n`);
    return;
  }

  const callbackIndex = process.argv.indexOf("--oauth-callback");
  if (callbackIndex !== -1) {
    const callbackUrl = process.argv[callbackIndex + 1];
    if (!callbackUrl) throw new Error("A T3 Connect callback URL is required.");
    await forwardNativeCallback(callbackUrl, new SecretServiceStore());
    return;
  }

  const { BridgeApp } = await import("./app.ts");
  const app = new BridgeApp();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.shutdown().finally(() => process.exit(0));
    });
  }

  process.once("uncaughtException", (error) => {
    process.stderr.write(`t3-mini-bridge fatal: ${redactText(error)}\n`);
    void app.shutdown().finally(() => process.exit(1));
  });

  process.once("unhandledRejection", (error) => {
    process.stderr.write(`t3-mini-bridge rejected: ${redactText(error)}\n`);
  });

  await app.start();
}

void run().catch((error) => {
  process.stderr.write(`t3-mini-bridge startup failed: ${redactText(error)}\n`);
  process.exitCode = 1;
});
