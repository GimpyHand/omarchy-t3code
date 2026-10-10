import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const syncScript = new URL("../scripts/sync-t3.mjs", import.meta.url);

test("source sync preserves dirty checkouts and refuses an unexpected origin before fetching", async () => {
  const root = await mkdtemp(join(tmpdir(), "t3-source-sync-"));
  try {
    const scripts = join(root, "scripts");
    const source = join(root, "upstream", "t3code");
    await mkdir(scripts);
    await mkdir(source, { recursive: true });
    await copyFile(syncScript, join(scripts, "sync-t3.mjs"));
    execFileSync("git", ["init", "--quiet", source]);
    execFileSync("git", [
      "-C",
      source,
      "remote",
      "add",
      "origin",
      "https://github.com/pingdotgg/t3code.git",
    ]);
    const localWork = join(source, "local-work.txt");
    await writeFile(localWork, "preserve this work\n");
    const dirty = spawnSync(process.execPath, [join(scripts, "sync-t3.mjs")], { encoding: "utf8" });
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /T3 source has local changes/u);
    assert.equal(await readFile(localWork, "utf8"), "preserve this work\n");
    await rm(localWork);
    execFileSync("git", [
      "-C",
      source,
      "remote",
      "set-url",
      "origin",
      "https://example.invalid/t3code.git",
    ]);
    const untrusted = spawnSync(process.execPath, [join(scripts, "sync-t3.mjs")], {
      encoding: "utf8",
    });
    assert.notEqual(untrusted.status, 0);
    assert.match(untrusted.stderr, /T3 source origin is not the official repository/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
