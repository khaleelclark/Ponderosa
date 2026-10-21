import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hostPlatformAdapter } from "../../apps/launcher/dist/platform.js";

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
