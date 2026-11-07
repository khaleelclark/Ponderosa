import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// sharp-libvips 1.3.4 embeds its public upstream /Users/runner build paths.
// Accept only these exact upstream bytes; edits and dependency upgrades fail closed.
const upstreamBinaryHashes = new Map([
  ["app/server/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib", "c1a5b5633b21aeb8a229abf7d062e07e4d778c0b44ed43cd1f93362bda58c322"],
]);

export function prunePackageManagerMetadata(packageRoot) {
  function visit(directory) {
    if (path.basename(directory) === "node_modules") {
      rmSync(path.join(directory, ".modules.yaml"), { force: true });
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(filename); continue; }
      if (path.basename(directory) !== ".bin" || !entry.isFile()) continue;
      const original = readFileSync(filename, "utf8");
      if (!/^#!\/bin\/sh\r?\n/u.test(original)) continue;
      // pnpm also emits shims in nested production dependencies. Only its
      // build-only target comment is removed; runtime commands/mode are intact.
      const portable = original.replace(/^# cmd-shim-target=[^\r\n]*(?:\r?\n|$)/gmu, "");
      if (portable !== original) writeFileSync(filename, portable);
    }
  }
  const modules = path.join(packageRoot, "node_modules");
  if (existsSync(modules)) visit(modules);
}

export function pruneNativeBuildFiles(packageRoot, platform = process.platform) {
  const build = path.join(packageRoot, "build");
  const release = path.join(build, "Release");
  if (!lstatSync(build).isDirectory() || !lstatSync(release).isDirectory()) {
    throw new Error("Native build and Release paths must be ordinary directories.");
  }
  const retained = readdirSync(release).filter(name => name.endsWith(".node"));
  if (!retained.length) throw new Error("Native build has no runtime addon to retain.");
  for (const name of retained) {
    const addon = path.join(release, name);
    if (!lstatSync(addon).isFile()) throw new Error("Native runtime addon must be an ordinary file.");
    // Remove debug source paths, retaining the symbols needed to load the addon.
    if (platform !== "win32") execFileSync("/usr/bin/strip", ["-S", addon]);
  }
  for (const name of readdirSync(release)) {
    if (!retained.includes(name)) rmSync(path.join(release, name), { recursive: true, force: true });
  }
  for (const name of readdirSync(build)) {
    if (name !== "Release") rmSync(path.join(build, name), { recursive: true, force: true });
  }
}

// The pinned ONNX package ships several OS/architecture payloads. A Linux x64
// DEB must not ask native dpkg-shlibdeps to resolve its ARM64 libraries.
export function pruneOnnxLinuxX64Payloads(packageRoot) {
  const metadata = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.name !== "onnxruntime-node" || metadata.version !== "1.27.0") {
    throw new Error("Review native payload layout before packaging this ONNX Runtime version.");
  }
  const native = path.join(packageRoot, "bin", "napi-v6");
  for (const directory of [packageRoot, path.join(packageRoot, "bin"), native,
    path.join(native, "linux"), path.join(native, "linux", "x64")]) {
    if (!lstatSync(directory).isDirectory()) throw new Error("ONNX runtime paths must be ordinary directories.");
  }
  for (const name of ["onnxruntime_binding.node", "libonnxruntime.so.1"]) {
    const filename = path.join(native, "linux", "x64", name);
    if (!lstatSync(filename).isFile()) throw new Error("ONNX x64 runtime must be an ordinary file.");
    const header = Buffer.alloc(20);
    const descriptor = openSync(filename, "r");
    try {
      if (readSync(descriptor, header, 0, 20, 0) !== 20 ||
          !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
          header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) {
        throw new Error("ONNX retained runtime must be ELF64 little-endian x86-64.");
      }
    } finally { closeSync(descriptor); }
  }
  const removed = [path.join(native, "darwin"), path.join(native, "win32"),
    path.join(native, "linux", "arm64")].filter(filename => existsSync(filename));
  // Validate every removal before changing this disposable dependency copy.
  for (const directory of removed) {
    if (!lstatSync(directory).isDirectory()) throw new Error("ONNX non-target runtime must be an ordinary directory.");
  }
  for (const directory of removed) rmSync(directory, { recursive: true });
  return removed.map(directory => path.relative(packageRoot, directory));
}

export function assertNoBuildMachinePaths(root, prefixes) {
  const patterns = [...new Set(prefixes.filter(Boolean).flatMap(prefix => [
    prefix, prefix.replaceAll("\\", "/"), encodeURI(prefix.replaceAll("\\", "/")),
  ]))].flatMap(prefix => [Buffer.from(prefix), Buffer.from(prefix, "utf16le")]);
  if (!patterns.length) return;
  const overlap = Math.max(...patterns.map(pattern => pattern.length)) - 1;
  const buffer = Buffer.alloc(64 * 1024);
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { inspect(filename); continue; }
      if (!entry.isFile()) continue;
      const fd = openSync(filename, "r");
      try {
        let tail = Buffer.alloc(0), bytes;
        while ((bytes = readSync(fd, buffer)) > 0) {
          const content = Buffer.concat([tail, buffer.subarray(0, bytes)]);
          if (patterns.some(pattern => content.includes(pattern))) {
            const upstreamHash = upstreamBinaryHashes.get(path.relative(root, filename).split(path.sep).join("/"));
            if (upstreamHash && createHash("sha256").update(readFileSync(filename)).digest("hex") === upstreamHash) break;
            throw new Error(`Build-machine path remains in bundle file: ${path.relative(root, filename)}`);
          }
          tail = content.subarray(Math.max(0, content.length - overlap));
        }
      } finally { closeSync(fd); }
    }
  }
  inspect(root);
}
