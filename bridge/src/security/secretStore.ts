import { spawn } from "node:child_process";

import { BridgeError, redactText } from "./redact.ts";

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const SECRET_SERVICE_APPLICATION = "bralyx.t3code";
export const LEGACY_SECRET_SERVICE_APPLICATIONS = [
  "io.github.gimpyhand.omarchy-t3code",
  "io.github.digitalpals.omarchy-t3code",
  "io.github.omarchy-t3code",
] as const;

export interface SecretToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type SecretToolRunner = (args: string[], input?: string) => Promise<SecretToolResult>;

function runSecretTool(args: string[], input?: string): Promise<SecretToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new BridgeError("SECRET_STORE_TIMEOUT", "The desktop secret store timed out.", true));
    }, 8_000);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new BridgeError(
          "SECRET_STORE_UNAVAILABLE",
          `The Secret Service client is unavailable: ${redactText(error)}`,
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

export class SecretServiceStore implements SecretStore {
  private readonly legacyApplications: readonly string[];
  private readonly tool: SecretToolRunner;

  constructor(
    private readonly application = SECRET_SERVICE_APPLICATION,
    legacyApplications?: readonly string[],
    tool: SecretToolRunner = runSecretTool,
  ) {
    this.legacyApplications = legacyApplications
      ?? (application === SECRET_SERVICE_APPLICATION ? [...LEGACY_SECRET_SERVICE_APPLICATIONS] : []);
    this.tool = tool;
  }

  private async lookup(application: string, key: string): Promise<string | null> {
    const result = await this.tool([
      "lookup",
      "application",
      application,
      "item",
      key,
    ]);
    if (result.code === 1) return null;
    if (result.code !== 0) {
      throw new BridgeError(
        "SECRET_STORE_READ_FAILED",
        `Could not read the desktop secret store: ${redactText(result.stderr)}`,
        true,
      );
    }
    return result.stdout.replace(/\r?\n$/u, "");
  }

  private async removeFrom(application: string, key: string): Promise<void> {
    const result = await this.tool([
      "clear",
      "application",
      application,
      "item",
      key,
    ]);
    if (result.code !== 0 && result.code !== 1) {
      throw new BridgeError(
        "SECRET_STORE_REMOVE_FAILED",
        `Could not clear the desktop secret store: ${redactText(result.stderr)}`,
        true,
      );
    }
  }

  async get(key: string): Promise<string | null> {
    const current = await this.lookup(this.application, key);
    if (current !== null) return current;
    for (const legacyApplication of this.legacyApplications) {
      const legacy = await this.lookup(legacyApplication, key);
      if (legacy !== null) {
        await this.set(key, legacy);
        await this.removeFrom(legacyApplication, key).catch(() => undefined);
        return legacy;
      }
    }
    return null;
  }

  async set(key: string, value: string): Promise<void> {
    const result = await this.tool(
      [
        "store",
        `--label=Omarchy T3 Command Center (${key})`,
        "application",
        this.application,
        "item",
        key,
      ],
      value,
    );
    if (result.code !== 0) {
      throw new BridgeError(
        "SECRET_STORE_WRITE_FAILED",
        `Could not write the desktop secret store: ${redactText(result.stderr)}`,
        true,
      );
    }
  }

  async remove(key: string): Promise<void> {
    await this.removeFrom(this.application, key);
    for (const legacyApplication of this.legacyApplications) {
      await this.removeFrom(legacyApplication, key);
    }
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}
