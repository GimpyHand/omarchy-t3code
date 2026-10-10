#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const freshExecutable = join(root, "dist", "t3-mini-bridge");
const trackedArchive = join(root, "lib", "t3-mini-bridge-linux-x64.gz");
const trackedChecksum = join(root, "lib", "t3-mini-bridge-linux-x64.sha256");
const decompressedStage = join(root, "dist", `.tracked-t3-mini-bridge.${process.pid}`);

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", rejectHash);
    input.once("end", resolveHash);
  });
  return hash.digest("hex");
}

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Marketplace runtime verification requires x86-64 Linux.");
}

if (Number(process.versions.node.split(".")[0]) < 26) throw new Error("Marketplace builds require Node 26 or newer.");

const buildRecord = JSON.parse(await readFile(join(root, "lib", "runtime-build.json"), "utf8"));
if (process.version !== buildRecord.nodeVersion) {
  throw new Error("Use the recorded Node builder to reproduce this payload, or rebuild and bundle with current Node.");
}

try {
  await stat(freshExecutable);
  const checkoutPath = spawnSync("grep", ["--fixed-strings", "--text", "--quiet", "--", root, freshExecutable], {
    cwd: root,
    encoding: "utf8",
  });
  if (checkoutPath.error) throw checkoutPath.error;
  if (checkoutPath.status === 0) {
    throw new Error("The fresh marketplace runtime embeds its checkout path and is not reproducible.");
  }
  if (checkoutPath.status !== 1) {
    throw new Error(`Could not inspect the fresh marketplace runtime for checkout paths (grep ${checkoutPath.status}).`);
  }

  await pipeline(
    createReadStream(trackedArchive),
    createGunzip(),
    createWriteStream(decompressedStage, { mode: 0o600 }),
  );

  const comparison = spawnSync("cmp", ["--silent", "--", freshExecutable, decompressedStage], {
    cwd: root,
    encoding: "utf8",
  });
  if (comparison.error) throw comparison.error;
  if (comparison.status !== 0) {
    throw new Error(
      "The tracked marketplace payload does not byte-match the fresh source build. "
      + "Run pnpm package and pnpm bundle:marketplace with the current builder, then review the payload change.",
    );
  }

  const [freshDigest, decompressedDigest, checksumContents] = await Promise.all([
    sha256(freshExecutable),
    sha256(decompressedStage),
    readFile(trackedChecksum, "utf8"),
  ]);
  const checksumMatch = checksumContents.match(/^([0-9a-f]{64})  t3-mini-bridge\n$/u);
  if (!checksumMatch || checksumMatch[1] !== freshDigest || decompressedDigest !== freshDigest) {
    throw new Error("The tracked marketplace checksum does not match the byte-identical source build.");
  }

  const freshRecord = JSON.parse(await readFile(join(root, "dist", "plugin", "lib", "runtime-build.json"), "utf8"));
  for (const key of ["commit", "nodeVersion", "clerkJsVersion", "electronSdkVersion"]) {
    if (buildRecord[key] !== freshRecord[key]) throw new Error("The runtime build record does not match the reproduced payload.");
  }
  const inventoryText = await readFile(join(root, "dist", "plugin", "licenses", "BUNDLED-LICENSES.json"), "utf8");
  if (inventoryText !== await readFile(join(root, "licenses", "BUNDLED-LICENSES.json"), "utf8")) {
    throw new Error("The tracked license inventory does not match the reproduced payload.");
  }
  const inventory = JSON.parse(inventoryText);
  const licenseFiles = ["NODEJS-LICENSE", "T3-CODE-LICENSE", "OMARCHY-T3CODE-LICENSE", "BUNDLED-LEGAL-COMMENTS.txt", ...inventory.packages.map((entry) => entry.file)];
  for (const file of licenseFiles) {
    if (typeof file !== "string" || !/^[0-9A-Za-z@._-]+$/u.test(file)) throw new Error("Unsafe runtime license filename.");
    const [fresh, tracked] = await Promise.all([
      readFile(join(root, "dist", "plugin", "licenses", file)),
      readFile(join(root, "licenses", file)),
    ]);
    if (!fresh.equals(tracked)) throw new Error("The tracked license does not match the reproduced payload: " + file);
  }

  process.stdout.write(
    `Tracked marketplace runtime byte-matches the fresh Node ${process.version} source build (${freshDigest}).\n`,
  );
} finally {
  await rm(decompressedStage, { force: true });
}
