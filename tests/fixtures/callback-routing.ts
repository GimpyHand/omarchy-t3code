import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activateT3ProtocolHandler } from "../../bridge/src/auth/protocolHandler.ts";

const config = process.env.XDG_CONFIG_HOME!;
const applications = join(process.env.XDG_DATA_HOME!, "applications");
await mkdir(config, { recursive: true });
await mkdir(applications, { recursive: true });
await writeFile(join(applications, "original-t3.desktop"), [
  "[Desktop Entry]", "Type=Application", "Name=Original T3",
  'Exec="/bin/true" %u', "MimeType=x-scheme-handler/t3code;", "",
].join("\n"));
await writeFile(join(config, "mimeapps.list"), "[Default Applications]\nx-scheme-handler/t3code=original-t3.desktop;\n");

function currentOwner(): string {
  return execFileSync("gio", ["mime", "x-scheme-handler/t3code"], { encoding: "utf8" }).split("\n")[0] ?? "";
}
assert.match(currentOwner(), /original-t3.desktop$/u);
const restore = await activateT3ProtocolHandler();
try {
  assert.match(currentOwner(), /bralyx.t3code-callback.desktop$/u);
} finally {
  await restore();
}
assert.match(currentOwner(), /original-t3.desktop$/u);
await assert.rejects(access(join(applications, "bralyx.t3code-callback.desktop")), { code: "ENOENT" });
console.log("T3_CALLBACK_ROUTING_OK");
