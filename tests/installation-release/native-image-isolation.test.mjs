import assert from "node:assert/strict";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertIndependentNativeImages, isolateNativeImages } from "../../packaging/qualification/native-image-isolation.mjs";

test("packaged native formats retain bytes and mode without sharing cache inodes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-native-isolation-"));
  try {
    const bundle = path.join(root, "bundle", "nested");
    mkdirSync(bundle, { recursive: true });
    const names = ["addon.node", "upper.NODE", "native.dll", "native.dylib", "native.so", "native.so.42.1"];
    const cache = path.join(root, "build-cache");
    writeFileSync(cache, "owned native fixture", { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(cache, 0o755);
    for (const name of names) linkSync(cache, path.join(bundle, name));
    writeFileSync(path.join(bundle, "ordinary.js"), "untouched");
    assert.throws(() => assertIndependentNativeImages(bundle), /shares a writable inode/);
    assert.equal(isolateNativeImages(bundle), names.length);
    const identities = names.map(name => statSync(path.join(bundle, name)).ino);
    assert.equal(isolateNativeImages(bundle), names.length); // Already independent: no second copy.
    assert.deepEqual(names.map(name => statSync(path.join(bundle, name)).ino), identities);
    truncateSync(cache, 0);
    writeFileSync(cache, "replacement cache bytes");
    for (const name of names) {
      const filename = path.join(bundle, name);
      assert.equal(readFileSync(filename, "utf8"), "owned native fixture");
      assert.equal(statSync(filename).nlink, 1);
      if (process.platform !== "win32") assert.equal(statSync(filename).mode & 0o777, 0o755);
    }
    assert.deepEqual(readdirSync(bundle).sort(), [...names, "ordinary.js"].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const independent of [false, true]) {
  test(`loaded SQLite survives cache truncation: independent=${independent}`, {
    skip: !independent && process.platform !== "linux" && "SIGBUS control requires Linux",
  }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-native-mapping-"));
    try {
      const require = createRequire(new URL("../../packages/agents/package.json", import.meta.url));
      const sqlite = require.resolve("better-sqlite3");
      const cache = path.join(root, "owned-cache.node");
      const bundle = path.join(root, "bundle");
      mkdirSync(bundle);
      const installed = path.join(bundle, "installed.node");
      // Copy first: this test never links to or mutates the actual package cache.
      copyFileSync(path.resolve(path.dirname(sqlite), "../build/Release/better_sqlite3.node"), cache);
      linkSync(cache, installed);
      const bytes = readFileSync(installed);
      assert.throws(() => assertIndependentNativeImages(bundle), /shares a writable inode/);
      if (independent) assert.equal(isolateNativeImages(bundle), 1);
      const script = `
        import { createRequire } from 'node:module';
        import { truncateSync } from 'node:fs';
        const Database = createRequire(import.meta.url)(process.argv[2]);
        const db = new Database(':memory:', { nativeBinding: process.argv[1] });
        db.exec('CREATE TABLE retained(value); INSERT INTO retained VALUES(42)');
        console.log('loaded');
        truncateSync(process.argv[3], 0);
        if (db.prepare('SELECT value FROM retained').get().value !== 42) throw Error('SQLite readback failed');
        db.close();
      `;
      const args = ["--input-type=module", "-e", script, installed, sqlite, cache];
      // Disable core files for the deliberately corrupted, disposable Linux child.
      const child = process.platform === "linux"
        ? spawnSync("/bin/sh", ["-c", 'ulimit -c 0; exec "$@"', "native-image-fixture", process.execPath, ...args], { encoding: "utf8", timeout: 10_000 })
        : spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10_000 });
      assert.ifError(child.error);
      assert.equal(child.stdout, "loaded\n", child.stderr);
      if (independent) {
        assert.equal(child.signal, null, child.stderr);
        assert.equal(child.status, 0, child.stderr);
        assert.equal(assertIndependentNativeImages(bundle), 1);
        assert.deepEqual(readFileSync(installed), bytes);
      } else {
        assert.equal(child.signal, "SIGBUS", child.stderr);
        assert.equal(statSync(installed).size, 0);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
