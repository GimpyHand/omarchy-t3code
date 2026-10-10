#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryUrl = "https://github.com/GimpyHand/omarchy-t3code";

function fail(message) {
  throw new Error(`Repository validation failed: ${message}`);
}

async function json(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function uncompressedSha256(path) {
  const hash = createHash("sha256");
  const decompressed = createReadStream(path).pipe(createGunzip());
  for await (const chunk of decompressed) hash.update(chunk);
  return hash.digest("hex");
}

const [metadata, bridgeMetadata, manifest] = await Promise.all([
  json("package.json"),
  json("bridge/package.json"),
  json("manifest.json"),
]);

if (metadata.version !== bridgeMetadata.version || metadata.version !== manifest.version) {
  fail("package.json, bridge/package.json, and manifest.json versions must match.");
}
if (manifest.id !== metadata.omarchy?.pluginId) {
  fail("the manifest ID must match package.json omarchy.pluginId.");
}
if (metadata.repository?.url !== `git+${repositoryUrl}.git`) {
  fail("package.json repository metadata is not the publication repository.");
}

const manifestPaths = execFileSync("git", ["ls-files", "--", "*manifest.json"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);
if (manifestPaths.length !== 1 || manifestPaths[0] !== "manifest.json") {
  fail("marketplace publication requires exactly one manifest.json at the repository root.");
}
const symlinks = execFileSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((line) => line.startsWith("120000 "));
if (symlinks.length > 0) fail("tracked symlinks are not allowed in an Omarchy plugin repository.");
try {
  await access(join(root, "upstream", "t3code", ".git"));
} catch {
  fail("Run pnpm sync:t3 to initialize T3 source.");
}
const sourceCommit = execFileSync(
  "git",
  ["-C", join(root, "upstream", "t3code"), "rev-parse", "HEAD"],
  { encoding: "utf8" },
).trim();
if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) fail("Run pnpm sync:t3 to initialize T3 source.");
const readme = await readFile(join(root, "README.md"), "utf8");
if (!readme.includes(repositoryUrl)) fail("README.md does not link to the publication repository.");
if (!readme.includes(`omarchy plugin add ${repositoryUrl}.git --enable`)) {
  fail("README.md does not document the marketplace installation command.");
}
if (!readme.includes("./uninstall")) fail("README.md does not document safe removal.");

await access(join(root, "preview.png"));
await access(join(root, "LICENSE"));
await access(join(root, "THIRD_PARTY_NOTICES.md"));
await access(join(root, "licenses", "NODEJS-LICENSE"));
await access(join(root, "licenses", "T3-CODE-LICENSE"));
await access(join(root, "licenses", "BUNDLED-LICENSES.json"));
await access(join(root, "scripts", "deploy-package"));
await access(join(root, "scripts", "remove-package"));
await access(join(root, "scripts", "verify-marketplace-runtime.mjs"));
await access(join(root, "lib", "t3-mini-bridge-linux-x64.gz"));
await access(join(root, "lib", "t3-mini-bridge-linux-x64.sha256"));

const preview = await readFile(join(root, "preview.png"));
if (
  preview.byteLength < 24 ||
  preview.byteLength > 50 * 1024 * 1024 ||
  preview.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
) {
  fail("preview.png must be a valid PNG no larger than 50 MB.");
}
const previewWidth = preview.readUInt32BE(16);
const previewHeight = preview.readUInt32BE(20);
if (previewWidth < 1 || previewHeight < 1 || previewWidth > 40_000_000 / previewHeight) {
  fail("preview.png exceeds the marketplace 40-megapixel limit.");
}
const archive = await stat(join(root, "lib", "t3-mini-bridge-linux-x64.gz"));
if (archive.size < 1 || archive.size >= 100 * 1024 * 1024) {
  fail("the bundled marketplace runtime must fit GitHub's per-file limit.");
}
const checksumContents = await readFile(
  join(root, "lib", "t3-mini-bridge-linux-x64.sha256"),
  "utf8",
);
const checksumMatch = checksumContents.match(/^([0-9a-f]{64})  t3-mini-bridge\n$/u);
if (
  !checksumMatch ||
  checksumMatch[1] !== (await uncompressedSha256(join(root, "lib", "t3-mini-bridge-linux-x64.gz")))
) {
  fail("the marketplace runtime archive does not match its uncompressed checksum.");
}
const bundledLicenses = await json("licenses/BUNDLED-LICENSES.json");
const buildRecord = await json("lib/runtime-build.json");
const bundledNodeVersion = String(bundledLicenses.node?.version ?? "")
  .match(/^v(\d+)\.(\d+)\.(\d+)$/u)
  ?.slice(1)
  .map(Number);
if (
  !bundledNodeVersion ||
  bundledNodeVersion[0] < 26 ||
  !Array.isArray(bundledLicenses.packages) ||
  bundledLicenses.packages.length === 0
) {
  fail("the marketplace runtime license inventory is incomplete.");
}
if (
  !/^[0-9a-f]{40}$/u.test(buildRecord.commit) ||
  buildRecord.nodeVersion !== bundledLicenses.node.version ||
  typeof buildRecord.clerkJsVersion !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(buildRecord.clerkJsVersion) ||
  typeof buildRecord.electronSdkVersion !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(buildRecord.electronSdkVersion)
) {
  fail(
    "the marketplace build record must identify its T3 source, SDKs, and licensed Node builder.",
  );
}
if (
  metadata.scripts?.["verify:marketplace-runtime"] !== "node scripts/verify-marketplace-runtime.mjs"
) {
  fail("package.json must expose the marketplace payload provenance verifier.");
}
if (
  (await readFile(join(root, "LICENSE"), "utf8")) !==
  (await readFile(join(root, "licenses", "OMARCHY-T3CODE-LICENSE"), "utf8"))
) {
  fail("the marketplace runtime does not contain the current project license.");
}
for (const executable of [
  join(root, "bin", "t3-mini-bridge"),
  join(root, "scripts", "deploy-package"),
  join(root, "scripts", "remove-package"),
]) {
  if (((await stat(executable)).mode & 0o111) === 0) fail(`${executable} must be executable.`);
}

process.stdout.write(
  `Validated ${manifest.id} ${metadata.version} at T3 main (${sourceCommit}).\n`,
);
