import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Preferences {
  selectedEnvironmentId?: string;
}

function statePath(): string {
  const root = process.env.XDG_STATE_HOME?.trim() || join(process.env.HOME || "/tmp", ".local", "state");
  return join(root, "omarchy-t3code", "preferences.json");
}

export async function readSelectedEnvironment(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as Preferences;
    return typeof parsed.selectedEnvironmentId === "string" ? parsed.selectedEnvironmentId : null;
  } catch {
    return null;
  }
}

export async function writeSelectedEnvironment(environmentId: string): Promise<void> {
  const target = statePath();
  const directory = dirname(target);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify({ selectedEnvironmentId: environmentId }, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, target);
}
