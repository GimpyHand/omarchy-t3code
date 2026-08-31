import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { BridgeError, redactText } from "../security/redact.ts";

export const CALLBACK_DESKTOP_ID = "io.github.gimpyhand.omarchy-t3code-callback.desktop";
export const LEGACY_CALLBACK_DESKTOP_IDS = [
  "io.github.digitalpals.omarchy-t3code-callback.desktop",
  "io.github.omarchy-t3code-callback.desktop",
] as const;
/** @deprecated Prefer LEGACY_CALLBACK_DESKTOP_IDS */
export const LEGACY_CALLBACK_DESKTOP_ID = LEGACY_CALLBACK_DESKTOP_IDS[1];
const T3_SCHEME_MIME = "x-scheme-handler/t3code";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type MimeCommand = (args: string[]) => Promise<CommandResult>;

export interface ProtocolHandlerOptions {
  command?: MimeCommand;
  desktopId?: string;
  registerDesktop?: () => Promise<() => Promise<void>>;
  clearDefault?: () => Promise<void>;
}

function runXdgMime(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("xdg-mime", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new BridgeError("AUTH_CALLBACK_REGISTRATION_FAILED", "Desktop callback registration timed out."));
    }, 8_000);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 8_192) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 8_192) stderr += chunk;
    });
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new BridgeError(
        "AUTH_CALLBACK_REGISTRATION_FAILED",
        "xdg-mime is required for the T3 Connect browser callback.",
      ));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function queryDefault(command: MimeCommand): Promise<string> {
  const result = await command(["query", "default", T3_SCHEME_MIME]);
  if (result.code !== 0) {
    throw new BridgeError(
      "AUTH_CALLBACK_REGISTRATION_FAILED",
      `Could not inspect the desktop callback handler: ${redactText(result.stderr)}`,
    );
  }
  return result.stdout.trim();
}

async function setDefault(command: MimeCommand, desktopId: string): Promise<void> {
  const result = await command(["default", desktopId, T3_SCHEME_MIME]);
  if (result.code !== 0) {
    throw new BridgeError(
      "AUTH_CALLBACK_REGISTRATION_FAILED",
      `Could not register the T3 Connect desktop callback: ${redactText(result.stderr)}`,
    );
  }
}

function xdgRoots(environment: NodeJS.ProcessEnv = process.env): {
  applications: string;
  mimeapps: string[];
} {
  const home = environment.HOME || homedir();
  const config = environment.XDG_CONFIG_HOME || join(home, ".config");
  const data = environment.XDG_DATA_HOME || join(home, ".local", "share");
  for (const path of [config, data]) {
    if (!isAbsolute(path)) {
      throw new BridgeError("AUTH_CALLBACK_REGISTRATION_FAILED", "Desktop callback paths must be absolute.");
    }
  }
  return {
    applications: join(data, "applications"),
    mimeapps: [...new Set([
      join(config, "mimeapps.list"),
      join(config, "applications", "mimeapps.list"),
      join(data, "applications", "mimeapps.list"),
    ])],
  };
}

function desktopArgument(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BridgeError("AUTH_CALLBACK_REGISTRATION_FAILED", "The callback executable path is invalid.");
  }
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("$", "\\$").replaceAll('"', '\\"')}"`;
}

function callbackCommand(): string[] {
  const executable = resolve(process.execPath);
  const script = process.argv[1];
  return typeof script === "string" && /\.mjs$/u.test(script) && resolve(script) !== executable
    ? [executable, resolve(script)]
    : [executable];
}

function desktopEntry(command: string[]): string {
  const executable = command.map(desktopArgument).join(" ");
  return `[Desktop Entry]
Type=Application
Name=T3 Command Center OAuth Callback
Comment=Return T3 Connect browser authentication to the Omarchy mini client
NoDisplay=true
Terminal=false
MimeType=${T3_SCHEME_MIME};
Exec=${executable} --oauth-callback %u
`;
}

async function refreshDesktopDatabase(applications: string): Promise<void> {
  await new Promise<void>((resolveRefresh) => {
    const child = spawn("update-desktop-database", [applications], { stdio: "ignore" });
    child.once("error", () => resolveRefresh());
    child.once("close", () => resolveRefresh());
  });
}

async function atomicWrite(path: string, contents: string | Buffer, mode: number): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function installT3CallbackDesktop(
  environment: NodeJS.ProcessEnv = process.env,
  command: string[] = callbackCommand(),
): Promise<() => Promise<void>> {
  const { applications } = xdgRoots(environment);
  const desktopPath = join(applications, CALLBACK_DESKTOP_ID);
  await mkdir(applications, { recursive: true, mode: 0o700 });
  let previous: Buffer | null = null;
  let previousMode = 0o644;
  try {
    [previous, previousMode] = await Promise.all([
      readFile(desktopPath),
      stat(desktopPath).then((value) => value.mode & 0o777),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(desktopPath, desktopEntry(command), 0o644);
  await refreshDesktopDatabase(applications);

  let removed = false;
  return async (): Promise<void> => {
    if (removed) return;
    removed = true;
    if (previous === null) await rm(desktopPath, { force: true });
    else await atomicWrite(desktopPath, previous, previousMode);
    await refreshDesktopDatabase(applications);
  };
}

function withoutDesktopAssociation(contents: string, desktopId: string): string {
  const hadFinalNewline = contents.endsWith("\n");
  const lines = contents.split(/\r?\n/u);
  if (hadFinalNewline) lines.pop();
  const filtered = lines.flatMap((line) => {
    const match = line.match(/^(\s*x-scheme-handler\/t3code\s*=\s*)(.*)$/u);
    if (!match) return [line];
    const owners = (match[2] ?? "").split(";").map((value) => value.trim()).filter(Boolean);
    const remaining = owners.filter((owner) => owner !== desktopId);
    return remaining.length === 0 ? [] : [`${match[1]}${remaining.join(";")};`];
  });
  return `${filtered.join("\n")}${hadFinalNewline ? "\n" : ""}`;
}

export async function clearT3ProtocolDefault(
  desktopId = CALLBACK_DESKTOP_ID,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { applications, mimeapps } = xdgRoots(environment);
  for (const path of mimeapps) {
    let contents: string;
    let mode: number;
    try {
      [contents, mode] = await Promise.all([
        readFile(path, "utf8"),
        stat(path).then((value) => value.mode & 0o777),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const updated = withoutDesktopAssociation(contents, desktopId);
    if (updated !== contents) await atomicWrite(path, updated, mode);
  }
  await refreshDesktopDatabase(applications);
}

export async function activateT3ProtocolHandler(
  options: ProtocolHandlerOptions = {},
): Promise<() => Promise<void>> {
  const command = options.command ?? runXdgMime;
  const desktopId = options.desktopId ?? CALLBACK_DESKTOP_ID;
  const removeDesktop = await (options.registerDesktop ?? installT3CallbackDesktop)();
  const clearDefault = options.clearDefault ?? (() => clearT3ProtocolDefault(desktopId));
  let previous = "";
  const restoreOwner = async (): Promise<void> => {
    if (await queryDefault(command) !== desktopId) return;
    if (previous.length > 0 && previous !== desktopId) await setDefault(command, previous);
    else await clearDefault();
  };

  try {
    previous = await queryDefault(command);
    if (previous !== desktopId) await setDefault(command, desktopId);
    const active = await queryDefault(command);
    if (active !== desktopId) {
      throw new BridgeError(
        "AUTH_CALLBACK_REGISTRATION_FAILED",
        "The desktop did not activate the Omarchy T3 Connect callback handler.",
      );
    }
  } catch (error) {
    await restoreOwner().catch(() => undefined);
    await removeDesktop().catch(() => undefined);
    throw error;
  }

  let restored = false;
  return async (): Promise<void> => {
    if (restored) return;
    restored = true;
    try {
      await restoreOwner();
      await removeDesktop();
    } catch {
      // Keep the hidden desktop entry installed if owner restoration fails so
      // the current association never points at a missing handler. The
      // uninstaller removes this exact fallback entry.
    }
  };
}
