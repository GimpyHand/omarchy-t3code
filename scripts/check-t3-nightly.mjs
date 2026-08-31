#!/usr/bin/env node
import { changedCompatibilityFiles, latestNightly, readPin } from "./t3-nightly-lib.mjs";

const pinned = await readPin();
const newest = await latestNightly();
const different = pinned.commit !== newest.commit;
const changedFiles = different ? await changedCompatibilityFiles(pinned.commit, newest.commit) : [];
const report = { pinned, newest, different, changedFiles };

if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(`Pinned Nightly: ${pinned.tag} (${pinned.commit})\n`);
  process.stdout.write(`Newest Nightly: ${newest.tag} (${newest.commit})\n`);
  process.stdout.write(different ? "Update available.\n" : "Pinned revision is current.\n");
  if (changedFiles.length > 0) process.stdout.write(`Compatibility-sensitive changes:\n${changedFiles.map((file) => `  ${file}`).join("\n")}\n`);
}

if (different && process.argv.includes("--fail-on-update")) process.exitCode = 2;
