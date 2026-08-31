#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: "inherit",
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} ${args.join(" ")} failed with status ${result.status}.`);
  }
  return result;
}

if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, "package"]);
else run("pnpm", ["package"]);
run(join(root, "dist", "install"), [], { cwd: join(root, "dist") });
