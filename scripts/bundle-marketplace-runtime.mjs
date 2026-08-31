#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip, constants } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(root, "dist", "t3-mini-bridge");
const archive = join(root, "lib", "t3-mini-bridge-linux-x64.gz");
const checksumFile = join(root, "lib", "t3-mini-bridge-linux-x64.sha256");
const archiveStage = `${archive}.${process.pid}.tmp`;
const checksumStage = `${checksumFile}.${process.pid}.tmp`;

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The marketplace payload must be built on x86-64 Linux.");
}

const [metadata, lock] = await Promise.all([
  readFile(join(root, "package.json"), "utf8").then(JSON.parse),
  readFile(join(root, "t3-upstream.lock.json"), "utf8").then(JSON.parse),
]);
const expectedNodeVersion = (await readFile(join(root, ".node-version"), "utf8")).trim();
if (process.version !== `v${expectedNodeVersion}`) {
  throw new Error(`Marketplace payloads must be built with Node ${expectedNodeVersion}; received ${process.version}.`);
}
const selfTest = spawnSync(executable, ["--self-test"], {
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
});
if (selfTest.error || selfTest.status !== 0) {
  throw selfTest.error ?? new Error(`Standalone bridge self-test failed with status ${selfTest.status}.`);
}
const result = JSON.parse(selfTest.stdout.trim());
if (result.ok !== true || result.bridgeVersion !== metadata.version || result.upstreamCommit !== lock.commit) {
  throw new Error("The standalone bridge does not match project metadata and the pinned T3 revision.");
}

const hash = createHash("sha256");
await new Promise((resolveHash, rejectHash) => {
  const input = createReadStream(executable);
  input.on("data", (chunk) => hash.update(chunk));
  input.once("error", rejectHash);
  input.once("end", resolveHash);
});
const checksum = hash.digest("hex");

try {
  await pipeline(
    createReadStream(executable),
    createGzip({ level: constants.Z_BEST_COMPRESSION }),
    createWriteStream(archiveStage, { mode: 0o644 }),
  );
  await writeFile(checksumStage, `${checksum}  t3-mini-bridge\n`, { mode: 0o644 });
  await chmod(archiveStage, 0o644);
  await chmod(checksumStage, 0o644);
  await rename(archiveStage, archive);
  await rename(checksumStage, checksumFile);
} finally {
  await Promise.all([
    rm(archiveStage, { force: true }),
    rm(checksumStage, { force: true }),
  ]);
}

process.stdout.write(`Updated marketplace runtime: ${archive}\nSHA-256: ${checksum}\n`);
