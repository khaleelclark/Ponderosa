import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNoBuildMachinePaths, pruneNativeBuildFiles, prunePackageManagerMetadata, pruneOnnxLinuxX64Payloads } from "../../packaging/bundle-privacy.mjs";

test("pnpm wrapper cleanup removes only build metadata and retains arguments, line endings and executable mode", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-shim-privacy-"));
  try {
    const bins = path.join(root, "node_modules", ".bin");
    mkdirSync(bins, { recursive: true });
    writeFileSync(path.join(root, "node_modules", ".modules.yaml"), "storeDir: /home/build-user/store");
    for (const [name, newline] of [["shim", "\n"], ["shim-crlf", "\r\n"]]) {
      const body = ['#!/bin/sh', '# runtime comment', 'printf "%s\\n" "$@"', ''].join(newline);
      writeFileSync(path.join(bins, name), body + '# cmd-shim-target=C:/Users/build-user/staging/script.js' + newline, { mode: 0o755 });
      if (process.platform !== "win32") chmodSync(path.join(bins, name), 0o755);
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

function onnxPayloadFixture(root) {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "1.27.0" }));
  const header = Buffer.alloc(64); header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); header.writeUInt16LE(62, 18);
  const target = path.join(root, "bin", "napi-v6", "linux", "x64"); mkdirSync(target, { recursive: true });
  for (const name of ["onnxruntime_binding.node", "libonnxruntime.so.1"]) writeFileSync(path.join(target, name), Buffer.concat([header, Buffer.from(name)]));
  for (const relative of ["darwin/arm64", "win32/x64", "linux/arm64"]) {
    const directory = path.join(root, "bin", "napi-v6", relative); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "non-target-binary"), "preserve unless this platform is excluded");
  }
  writeFileSync(path.join(root, "README.md"), "package documentation");
  return target;
}

test("Linux x64 ONNX staging removes only non-target platform payloads and preserves exact target bytes", { skip: process.platform !== "linux" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-onnx-target-"));
  try {
    const target = onnxPayloadFixture(root);
    const before = Object.fromEntries(readdirSync(target).map(name => [name, readFileSync(path.join(target, name))]));
    assert.deepEqual(pruneOnnxLinuxX64Payloads(root).sort(), ["bin/napi-v6/darwin", "bin/napi-v6/linux/arm64", "bin/napi-v6/win32"]);
    assert.deepEqual(readdirSync(path.join(root, "bin", "napi-v6")), ["linux"]);
    assert.deepEqual(readdirSync(path.join(root, "bin", "napi-v6", "linux")), ["x64"]);
    for (const [name, bytes] of Object.entries(before)) assert.deepEqual(readFileSync(path.join(target, name)), bytes);
    assert.equal(readFileSync(path.join(root, "README.md"), "utf8"), "package documentation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ONNX target validation refuses missing/wrong-architecture target, versions and links before pruning", { skip: process.platform !== "linux" }, () => {
  for (const mutation of ["missing", "wrong-architecture", "version", "symlink"]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-onnx-refusal-"));
    try {
      const target = onnxPayloadFixture(root); const library = path.join(target, "libonnxruntime.so.1");
      if (mutation === "missing") rmSync(library);
      if (mutation === "wrong-architecture") { const bytes = readFileSync(library); bytes.writeUInt16LE(183, 18); writeFileSync(library, bytes); }
      if (mutation === "version") writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "9.0.0" }));
      if (mutation === "symlink") { const directory = path.join(root, "bin", "napi-v6", "darwin"); rmSync(directory, { recursive: true }); symlinkSync(target, directory); }
      assert.throws(() => pruneOnnxLinuxX64Payloads(root));
      assert.equal(existsSync(path.join(root, "bin", "napi-v6", "linux", "arm64", "non-target-binary")), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
