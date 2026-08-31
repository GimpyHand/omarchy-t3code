#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginRoot = resolve(process.argv[2] || repositoryRoot);
const manifest = JSON.parse(await readFile(join(pluginRoot, "manifest.json"), "utf8"));

function fail(message) {
  throw new Error(`Invalid Omarchy plugin: ${message}`);
}

if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1.");
if (typeof manifest.id !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u.test(manifest.id)) fail("id must be a reverse-DNS-style identifier.");
if (typeof manifest.name !== "string" || !manifest.name.trim()) fail("name is required.");
if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version)) fail("version must be semantic.");
if (typeof manifest.author !== "string" || !manifest.author.trim()) fail("author is required.");
if (typeof manifest.description !== "string" || !manifest.description.trim()) fail("description is required.");
if (typeof manifest.license !== "string" || !manifest.license.trim()) fail("license is required.");
for (const [field, limit] of Object.entries({ id: 128, name: 120, version: 64, author: 120, description: 500, license: 120 })) {
  const value = manifest[field];
  if (typeof value !== "string" || value !== value.trim() || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    fail(`${field} must be trimmed, printable, and no longer than ${limit} characters.`);
  }
}
if (!Array.isArray(manifest.kinds) || manifest.kinds.length === 0) fail("kinds must be non-empty.");
if (new Set(manifest.kinds).size !== manifest.kinds.length) fail("kinds must not contain duplicates.");
if (manifest.entryPoints === null || typeof manifest.entryPoints !== "object") fail("entryPoints are required.");
if (manifest.omarchy?.clonedFrom !== undefined) fail("published plugins must not declare omarchy.clonedFrom.");
if (manifest.barWidget?.defaultSection !== undefined && !["left", "center", "right"].includes(manifest.barWidget.defaultSection)) {
  fail("barWidget.defaultSection must be left, center, or right.");
}

const entryForKind = { bar: "bar", "bar-widget": "barWidget", menu: "menu", overlay: "overlay", panel: "panel", service: "service" };
for (const kind of manifest.kinds) {
  const key = entryForKind[kind];
  if (!key) fail(`unsupported kind ${kind}.`);
  const entry = manifest.entryPoints[key];
  if (typeof entry !== "string" || !entry || entry !== entry.trim() || entry.startsWith("/") || entry.includes("..") || /[\\:\r\n\0]/u.test(entry)) {
    fail(`entryPoints.${key} must be a safe relative path.`);
  }
  const target = normalize(resolve(pluginRoot, entry));
  if (relative(pluginRoot, target).startsWith("..")) fail(`entryPoints.${key} escapes the plugin root.`);
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`entryPoints.${key} must be a regular file.`);
}

process.stdout.write(`Validated ${manifest.id} ${manifest.version}.\n`);
