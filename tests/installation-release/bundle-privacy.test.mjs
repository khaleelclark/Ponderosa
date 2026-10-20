import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNoBuildMachinePaths, pruneNativeBuildFiles, prunePackageManagerMetadata } from "../../packaging/bundle-privacy.mjs";

test("pnpm wrapper cleanup removes only build metadata and retains arguments, line endings and executable mode", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-shim-privacy-"));
  try {
    const bins = path.join(root, "node_modules", ".bin");
    mkdirSync(bins, { recursive: true });
    writeFileSync(path.join(root, "node_modules", ".modules.yaml"), "storeDir: /home/build-user/store");
    for (const [name, newline] of [["shim", "\n"], ["shim-crlf", "\r\n"]]) {
      const body = ['#!/bin/sh', '# runtime comment', 'printf "%s\\n" "$@"', ''].join(newline);
      writeFileSync(path.join(bins, name), body + '# cmd-shim-target=C:/Users/build-user/staging/script.js' + newline, { mode: 0o755 });
      writeFileSync(path.join(bins, name + ".cmd"), "@echo untouched\r\n");
      prunePackageManagerMetadata(root);
      assert.equal(readFileSync(path.join(bins, name), "utf8"), body);
      assert.equal(readFileSync(path.join(bins, name + ".cmd"), "utf8"), "@echo untouched\r\n");
      if (process.platform !== "win32") assert.equal(statSync(path.join(bins, name)).mode & 0o777, 0o755);
    }
    const nested = path.join(root, "node_modules", "dependency", "node_modules", ".bin");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "nested-shim"), "#!/bin/sh\nexec node relative.js \"$@\"\n# cmd-shim-target=C:/Users/build-user/stage/script.js\n");
    prunePackageManagerMetadata(root);
    assert.equal(readFileSync(path.join(nested, "nested-shim"), "utf8"), "#!/bin/sh\nexec node relative.js \"$@\"\n");
    assert.doesNotThrow(() => assertNoBuildMachinePaths(root, ["C:/Users/build-user"]));
    assert.equal(existsSync(path.join(root, "node_modules", ".modules.yaml")), false);
    if (process.platform !== "win32") {
      const executed = spawnSync(path.join(bins, "shim"), ["one two", "three"], { encoding: "utf8" });
      assert.equal(executed.status, 0);
      assert.equal(executed.stdout, "one two\nthree\n");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native packaging retains runtime addon bytes and removes private build intermediates", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-package-privacy-"));
  try {
    const release = path.join(root, "build", "Release");
    mkdirSync(path.join(release, "obj.target"), { recursive: true });
    const bytes = Buffer.from("retained runtime addon");
    writeFileSync(path.join(release, "runtime.node"), bytes);
    writeFileSync(path.join(release, "runtime.pdb"), "private source paths");
    writeFileSync(path.join(release, "obj.target", "native.obj"), "private source paths");
    writeFileSync(path.join(root, "build", "Makefile"), "private source paths");
    writeFileSync(path.join(root, "package.json"), "{}");
    // Windows does not use strip; its linker writes a filename-only PDB record.
    pruneNativeBuildFiles(root, "win32");
    assert.deepEqual(readdirSync(path.join(root, "build")), ["Release"]);
    assert.deepEqual(readdirSync(release), ["runtime.node"]);
    assert.deepEqual(readFileSync(path.join(release, "runtime.node")), bytes);
    assert.equal(readFileSync(path.join(root, "package.json"), "utf8"), "{}");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bundle path checks reject source paths across chunks, encoded URLs and UTF-16 records", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-package-privacy-"));
  try {
    const filename = path.join(root, "payload.bin");
    const prefix = "/home/build-user/Private Build";
    for (const bytes of [
      Buffer.concat([Buffer.alloc(64 * 1024 - 4), Buffer.from(prefix)]),
      Buffer.from(encodeURI(prefix)),
      Buffer.from(prefix, "utf16le"),
    ]) {
      writeFileSync(filename, bytes);
      assert.throws(() => assertNoBuildMachinePaths(root, [prefix]), /Build-machine path remains/);
    }
    writeFileSync(filename, "runtime data without build paths");
    assert.doesNotThrow(() => assertNoBuildMachinePaths(root, [prefix]));
    writeFileSync(filename, "C:/Users/build-user/source");
    assert.throws(() => assertNoBuildMachinePaths(root, ["C:\\Users\\build-user"]), /Build-machine path remains/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native pruning rejects a symlink in place of the runtime addon", { skip: process.platform === "win32" && "Windows symlink creation requires a separate privilege" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-package-privacy-"));
  try {
    const release = path.join(root, "build", "Release");
    mkdirSync(release, { recursive: true });
    writeFileSync(path.join(root, "outside.node"), "preserve");
    symlinkSync(path.join(root, "outside.node"), path.join(release, "runtime.node"));
    assert.throws(() => pruneNativeBuildFiles(root, "win32"), /ordinary file/);
    assert.equal(readFileSync(path.join(root, "outside.node"), "utf8"), "preserve");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only the pinned upstream libvips image may retain its public build paths", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-upstream-privacy-"));
  try {
    const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
    const sharpRequire = createRequire(serverRequire.resolve("sharp"));
    const upstream = readFileSync(sharpRequire.resolve("@img/sharp-libvips-darwin-arm64/binary"));
    assert.ok(upstream.includes(Buffer.from("/Users/runner")));
    const filename = path.join(root, "app/server/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib");
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, upstream);
    assert.doesNotThrow(() => assertNoBuildMachinePaths(root, ["/Users/runner"]));
    writeFileSync(filename, Buffer.concat([upstream, Buffer.from("modified")]));
    assert.throws(() => assertNoBuildMachinePaths(root, ["/Users/runner"]), /Build-machine path remains/);
    rmSync(filename);
    writeFileSync(path.join(root, "other.dylib"), upstream);
    assert.throws(() => assertNoBuildMachinePaths(root, ["/Users/runner"]), /Build-machine path remains/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
