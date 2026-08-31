import { spawn } from "node:child_process";

import { BridgeError, redactText } from "../security/redact.ts";

export async function openSystemBrowser(url: string): Promise<void> {
  const command = process.env.T3_MINI_BROWSER_COMMAND?.trim() || "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore", detached: false, env: process.env });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new BridgeError("BROWSER_OPEN_TIMEOUT", "Opening the system browser timed out.", true));
    }, 10_000);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        new BridgeError(
          "BROWSER_OPEN_FAILED",
          `Could not open the system browser: ${redactText(error)}`,
          true,
        ),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new BridgeError("BROWSER_OPEN_FAILED", "Could not open the system browser.", true));
    });
  });
}
