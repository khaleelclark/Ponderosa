import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hostPlatformAdapter } from "../../apps/launcher/dist/platform.js";
import { writeJsonAtomic } from "../../apps/launcher/dist/paths.js";
import { writeJsonAtomic as writeDurableJson } from "../../packages/native-host/dist/fs.js";

test("Windows discovers native providers outside PATH and preserves explicit executable precedence", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-native-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nativeBin = path.join(root, ".local", "bin");
  mkdirSync(nativeBin, { recursive: true });
  const platform = hostPlatformAdapter("win32");
  const env = { PATH: "", APPDATA: path.join(root, "Roaming"), LOCALAPPDATA: path.join(root, "Local") };
  for (const provider of ["claude", "codex"]) {
    const filename = path.join(nativeBin, `${provider}.exe`);
    writeFileSync(filename, "owned executable fixture", { mode: 0o755 });
    assert.deepEqual(platform.executableCandidates(provider, env, root), [filename]);
    const explicit = path.join(root, `${provider}-explicit.exe`);
    writeFileSync(explicit, "owned explicit fixture", { mode: 0o755 });
    const key = `PONDEROSA_${provider.toUpperCase()}_BIN`;
    assert.deepEqual(platform.executableCandidates(provider, { ...env, [key]: explicit }, root), [explicit, filename]);
  }
});


test("launcher state uses the shared durable writer and replaces private JSON without remnants", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-atomic-json-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(writeJsonAtomic, writeDurableJson);
  const file = path.join(root, "state.json");
  writeFileSync(file, "old state", { mode: 0o666 });
  const value = { generation: "next", nested: [1, "new state"] };
  writeJsonAtomic(file, value);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(value, null, 2) + "\n");
  assert.deepEqual(readdirSync(root), ["state.json"]);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  writeJsonAtomic(file, { generation: "later" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { generation: "later" });
  assert.deepEqual(readdirSync(root), ["state.json"]);
});

test("durable JSON failure preserves the destination and existing temporary-file evidence", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-atomic-json-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "destination");
  mkdirSync(file);
  writeFileSync(path.join(file, "keep.txt"), "keep existing destination");
  assert.throws(() => writeDurableJson(file, { generation: "unpublished" }));
  assert.equal(readFileSync(path.join(file, "keep.txt"), "utf8"), "keep existing destination");
  const temporary = readdirSync(root).filter(name => name.startsWith("destination.") && name.endsWith(".tmp"));
  assert.equal(temporary.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, temporary[0]), "utf8")), { generation: "unpublished" });
  if (process.platform !== "win32") assert.equal(statSync(path.join(root, temporary[0])).mode & 0o777, 0o600);
  const missing = path.join(root, "missing-parent", "state.json");
  assert.throws(() => writeDurableJson(missing, {}));
  assert.deepEqual(readdirSync(root).sort(), ["destination", temporary[0]].sort());
});
