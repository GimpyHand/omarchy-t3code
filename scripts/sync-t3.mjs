#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "upstream", "t3code");
const repository = "https://github.com/pingdotgg/t3code.git";
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--build-record")) {
  throw new Error("Usage: sync-t3.mjs [--build-record]");
}
// Reproduction only: normal development always fetches main.
const target = args.length
  ? JSON.parse(await readFile(join(root, "lib", "runtime-build.json"), "utf8")).commit
  : "main";
if (target !== "main" && (typeof target !== "string" || !/^[0-9a-f]{40}$/u.test(target))) {
  throw new Error("The runtime build record has no valid source commit.");
}

function git(args, cwd = root) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr.trim());
  return result.stdout.trim();
}

if (!existsSync(join(source, ".git"))) {
  if (existsSync(source))
    throw new Error(`Refusing to replace an existing non-Git directory: ${source}`);
  await mkdir(dirname(source), { recursive: true });
  git(["clone", "--depth=1", "--branch=main", "--single-branch", repository, source]);
} else {
  if (git(["status", "--porcelain"], source))
    throw new Error("T3 source has local changes; preserve them before syncing.");
  if (git(["remote", "get-url", "origin"], source) !== repository)
    throw new Error("T3 source origin is not the official repository.");
}
git(["fetch", "--depth=1", "origin", target], source);
git(["checkout", "--detach", "FETCH_HEAD"], source);

// Effect packages share types and upstream patches, so follow T3's catalog together.
const catalog = await readFile(join(source, "pnpm-workspace.yaml"), "utf8");
let workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
for (const name of ["effect", "@effect/platform-node", "@effect/vitest"]) {
  const line = catalog
    .split("\n")
    .find((line) => line.startsWith(`  ${name}: `) || line.startsWith(`  "${name}": `));
  const version = line?.split(": ")[1]?.trim();
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`T3 catalog has no exact version for ${name}.`);
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  workspace = workspace.replace(
    new RegExp(`^  "?${escaped}"?: .+$`, "mu"),
    `  "${name}": ${version}`,
  );
  if (name === "@effect/platform-node") continue;
  const file = `${name.replaceAll("/", "__")}@${version}.patch`;
  workspace = workspace.replace(new RegExp(`^  "?${escaped}@[^\\n]+$`, "mu"), "");
  if (existsSync(join(source, "patches", file)))
    workspace += `\n  "${name}@${version}": upstream/t3code/patches/${file}\n`;
}
await writeFile(join(root, "pnpm-workspace.yaml"), workspace.replace(/\n{3,}/gu, "\n\n"));
process.stdout.write(
  `T3 ${target === "main" ? "main" : "build source"}: ${git(["rev-parse", "HEAD"], source)}\nRun pnpm install after syncing.\n`,
);
