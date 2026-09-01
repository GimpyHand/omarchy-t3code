#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(root, "dist");
const packagedPlugin = join(outputRoot, "plugin");
const bridgeDist = join(root, "bridge", "dist");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout,
    env: options.env ?? process.env,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : "."}`);
  }
  return result;
}

function runPnpm(args) {
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args]);
  return run("pnpm", args);
}

async function buildStandalone() {
  const configPath = join(outputRoot, "sea-config.json");
  const executablePath = join(outputRoot, "t3-mini-bridge");
  const reproducibleMainPath = "bridge/dist/t3-mini-bridge.cjs";
  const [major, minor] = process.versions.node.split(".").map(Number);

  if (major > 25 || (major === 25 && minor >= 5)) {
    await writeFile(configPath, `${JSON.stringify({
      main: reproducibleMainPath,
      mainFormat: "commonjs",
      output: "dist/t3-mini-bridge",
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "none",
    }, null, 2)}\n`);
    run(process.execPath, ["--build-sea", configPath]);
  } else {
    const blobPath = join(outputRoot, "t3-mini-bridge.blob");
    await writeFile(configPath, `${JSON.stringify({
      main: reproducibleMainPath,
      output: "dist/t3-mini-bridge.blob",
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }, null, 2)}\n`);
    run(process.execPath, ["--experimental-sea-config", configPath]);
    await copyFile(process.execPath, executablePath);
    const postjectPackage = fileURLToPath(import.meta.resolve("postject/package.json"));
    const postject = join(dirname(postjectPackage), "dist", "cli.js");
    run(process.execPath, [
      postject,
      executablePath,
      "NODE_SEA_BLOB",
      blobPath,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ]);
  }

  await chmod(executablePath, 0o755);
  const selfTest = run(executablePath, ["--self-test"], { capture: true, timeout: 30_000 });
  const result = JSON.parse(selfTest.stdout.trim());
  const lock = JSON.parse(await readFile(join(root, "t3-upstream.lock.json"), "utf8"));
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (result.ok !== true || result.bridgeVersion !== metadata.version || result.upstreamCommit !== lock.commit) {
    throw new Error("The standalone bridge self-test did not match project metadata and the pinned T3 revision.");
  }
  return executablePath;
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  return null;
}

async function copyRuntimeLicenses(licensesRoot) {
  const mapPath = join(bridgeDist, "t3-mini-bridge.mjs.map");
  const sourceMap = JSON.parse(await readFile(mapPath, "utf8"));
  const packageRoots = new Set();
  for (const source of sourceMap.sources || []) {
    const absolute = resolve(dirname(mapPath), source);
    const match = absolute.match(/^(.*\/node_modules\/\.pnpm\/[^/]+\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+))/u);
    if (match?.[1]) packageRoots.add(match[1]);
  }

  const bundled = [];
  const seen = new Set();
  for (const packageRoot of [...packageRoots].sort()) {
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const identity = `${metadata.name}@${metadata.version}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const licenseFile = (await readdir(packageRoot)).find((name) => /^licen[cs]e(?:\.|$)/iu.test(name));
    if (!licenseFile) throw new Error(`Bundled dependency ${identity} has no distributable license file.`);
    const safeName = String(metadata.name).replace(/^@/u, "").replace(/[^0-9A-Za-z.-]+/gu, "-");
    const outputName = `${safeName}-${metadata.version}-LICENSE`;
    await copyFile(join(packageRoot, licenseFile), join(licensesRoot, outputName));
    bundled.push({ name: metadata.name, version: metadata.version, license: metadata.license, file: outputName });
  }

  const nodeExecutable = await realpath(process.execPath);
  const nodeRoot = dirname(dirname(nodeExecutable));
  const nodePrefix = String(process.config.variables.node_prefix || "");
  const nodeLicenseCandidates = [
    join(nodeRoot, "LICENSE"),
    join(nodeRoot, "node_modules", `node-${process.platform}-${process.arch}`, "LICENSE"),
    "/usr/share/licenses/nodejs/LICENSE",
  ];
  if (nodePrefix) {
    nodeLicenseCandidates.splice(2, 0,
      join(nodePrefix, "LICENSE"),
      join(nodePrefix, "share", "licenses", "nodejs", "LICENSE"),
    );
  }
  const nodeLicense = await firstExisting(nodeLicenseCandidates);
  if (nodeLicense === null) throw new Error(`Could not locate the Node.js ${process.version} runtime license.`);
  await copyFile(nodeLicense, join(licensesRoot, "NODEJS-LICENSE"));
  await copyFile(join(bridgeDist, "t3-mini-bridge.mjs.LEGAL.txt"), join(licensesRoot, "BUNDLED-LEGAL-COMMENTS.txt"));
  await writeFile(join(licensesRoot, "BUNDLED-LICENSES.json"), `${JSON.stringify({
    node: { version: process.version, license: "MIT", file: "NODEJS-LICENSE" },
    packages: bundled,
  }, null, 2)}\n`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectStream);
    stream.once("end", resolveStream);
  });
  return hash.digest("hex");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
run(process.execPath, [join(root, "scripts", "validate-repository.mjs")]);
runPnpm(["build"]);
run(process.execPath, [join(root, "scripts", "validate-plugin.mjs"), root]);
const executablePath = await buildStandalone();

await mkdir(packagedPlugin, { recursive: true });
await copyFile(join(root, "manifest.json"), join(packagedPlugin, "manifest.json"));
await cp(join(root, "qml"), join(packagedPlugin, "qml"), { recursive: true });
await cp(join(root, "bin"), join(packagedPlugin, "bin"), { recursive: true });
await mkdir(join(packagedPlugin, "lib"), { recursive: true });
await mkdir(join(packagedPlugin, "licenses"), { recursive: true });
await mkdir(join(packagedPlugin, "docs"), { recursive: true });
await copyFile(executablePath, join(packagedPlugin, "lib", "t3-mini-bridge"));
await copyFile(join(bridgeDist, "t3-mini-bridge.mjs"), join(packagedPlugin, "lib", "t3-mini-bridge.mjs"));
await copyFile(join(root, "LICENSE"), join(packagedPlugin, "LICENSE"));
await copyFile(join(root, "LICENSE"), join(packagedPlugin, "licenses", "OMARCHY-T3CODE-LICENSE"));
await copyFile(join(root, "upstream", "t3code", "LICENSE"), join(packagedPlugin, "licenses", "T3-CODE-LICENSE"));
await copyRuntimeLicenses(join(packagedPlugin, "licenses"));
await copyFile(join(root, "THIRD_PARTY_NOTICES.md"), join(packagedPlugin, "THIRD_PARTY_NOTICES.md"));
for (const name of ["README.md", "ARCHITECTURE.md", "SECURITY.md", "UPSTREAM.md", "CHANGELOG.md", "CONTRIBUTING.md"]) {
  if (existsSync(join(root, name))) await copyFile(join(root, name), join(packagedPlugin, name));
}
await copyFile(join(root, "docs", "ACCEPTANCE.md"), join(packagedPlugin, "docs", "ACCEPTANCE.md"));
await copyFile(join(root, "preview.png"), join(packagedPlugin, "preview.png"));
await chmod(join(packagedPlugin, "bin", "t3-mini-bridge"), 0o755);
await chmod(join(packagedPlugin, "lib", "t3-mini-bridge"), 0o755);
await copyFile(join(root, "scripts", "deploy-package"), join(outputRoot, "install"));
await chmod(join(outputRoot, "install"), 0o755);
await copyFile(join(root, "scripts", "remove-package"), join(outputRoot, "uninstall"));
await chmod(join(outputRoot, "uninstall"), 0o755);
// Also ship uninstall inside the plugin tree so README's installed path
// (~/.config/omarchy/plugins/<id>/uninstall) works after archive install.
await copyFile(join(root, "scripts", "remove-package"), join(packagedPlugin, "uninstall"));
await chmod(join(packagedPlugin, "uninstall"), 0o755);

const omarchy = spawnSync("omarchy", ["plugin", "validate", packagedPlugin], { cwd: root, encoding: "utf8", stdio: "inherit" });
if (omarchy.error && omarchy.error.code !== "ENOENT") throw omarchy.error;
if (!omarchy.error && omarchy.status !== 0) throw new Error("Omarchy rejected the packaged plugin manifest.");
const archivePath = join(outputRoot, "omarchy-t3code-plugin.tar.gz");
const tarPath = join(outputRoot, "omarchy-t3code-plugin.tar");
run("tar", [
  "--sort=name",
  "--mtime=@0",
  "--owner=0",
  "--group=0",
  "--numeric-owner",
  "--format=gnu",
  "-C",
  outputRoot,
  "-cf",
  tarPath,
  "install",
  "uninstall",
  "plugin",
]);
run("gzip", ["-n", "-f", tarPath]);
await rename(`${tarPath}.gz`, archivePath);
await writeFile(`${archivePath}.sha256`, `${await sha256(archivePath)}  ${basename(archivePath)}\n`);

process.stdout.write(`Packaged plugin: ${packagedPlugin}\nArchive: ${archivePath}\nChecksum: ${archivePath}.sha256\n`);
