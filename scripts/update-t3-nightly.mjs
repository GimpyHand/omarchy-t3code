#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { changedCompatibilityFiles, latestNightly, readPin, repositoryRoot, lockPath } from "./t3-nightly-lib.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`);
  }
  return result;
}

function pnpm(args) {
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args]);
  return run("pnpm", args);
}

const pinned = await readPin();
const newest = await latestNightly();
const changedFiles = await changedCompatibilityFiles(pinned.commit, newest.commit);

process.stdout.write(`Pinned: ${pinned.tag} (${pinned.commit})\nCandidate: ${newest.tag} (${newest.commit})\n`);
if (changedFiles.length > 0) process.stdout.write(`Compatibility-sensitive changes:\n${changedFiles.map((file) => `  ${file}`).join("\n")}\n`);
if (pinned.commit === newest.commit) {
  process.stdout.write("Already on the newest published Nightly.\n");
  process.exit(0);
}
if (process.argv.includes("--dry-run")) process.exit(0);

const status = run("git", ["status", "--porcelain", "--untracked-files=no"], { capture: true }).stdout.trim();
if (status) throw new Error("Refusing to update a tracked dirty worktree. Commit or stash changes first.");

const upstream = join(repositoryRoot, "upstream", "t3code");
run("git", ["fetch", "--force", "origin", `refs/tags/${newest.tag}:refs/tags/${newest.tag}`], { cwd: upstream });
run("git", ["checkout", "--detach", newest.commit], { cwd: upstream });
await writeFile(lockPath, `${JSON.stringify(newest, null, 2)}\n`);
for (const relativePath of ["README.md", "UPSTREAM.md", "docs/ACCEPTANCE.md"]) {
  const path = join(repositoryRoot, relativePath);
  const current = await readFile(path, "utf8");
  const updated = current
    .replaceAll(pinned.tag, newest.tag)
    .replaceAll(pinned.commit, newest.commit);
  if (updated === current) {
    throw new Error(`Could not update the supported T3 revision in ${relativePath}.`);
  }
  await writeFile(path, updated);
}

try {
  pnpm(["install"]);
  pnpm(["check"]);
} catch (error) {
  process.stderr.write(`\nNightly compatibility failed at ${newest.tag}. The candidate pin remains in the worktree for diagnosis; nothing was published.\n`);
  throw error;
}

process.stdout.write(`\nCompatibility passed. ${newest.tag} is ready for review as the new supported pin; publishing remains manual.\n`);
