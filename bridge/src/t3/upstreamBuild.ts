import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

export interface UpstreamBuild {
  commit: string;
  clerkJsVersion: string;
  electronSdkVersion: string;
}

export function readUpstreamBuild(source: string): UpstreamBuild {
  if (!existsSync(join(source, ".git"))) {
    throw new Error("T3 source is missing. Run pnpm sync:t3, then pnpm install.");
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("T3 source has no valid commit.");
  if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source, encoding: "utf8" }).trim()) {
    throw new Error("T3 source has tracked edits; commit or preserve them before packaging a reproducible payload.");
  }
  const catalog = parseDocument(readFileSync(join(source, "pnpm-workspace.yaml"), "utf8"));
  if (catalog.errors.length) throw new Error("T3 source catalog is invalid YAML.");
  const version = (name: string): string => {
    const value = catalog.getIn(["catalog", name]);
    if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
      throw new Error("T3 catalog has no exact SDK version for " + name);
    }
    return value;
  };
  return {
    commit,
    clerkJsVersion: version("@clerk/clerk-js"),
    electronSdkVersion: version("@clerk/electron"),
  };
}

// The bundler replaces this source reader with its build-time result.
export const upstreamBuild = readUpstreamBuild(
  fileURLToPath(new URL("../../../upstream/t3code/", import.meta.url)),
);
