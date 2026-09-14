#!/usr/bin/env node
// Explicit release preparation only. Never invoked by Play, server startup, or the base build.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, stat, lstat, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [sourceArg, destinationArg, platform, version] = process.argv.slice(2);
if (!sourceArg || !destinationArg || !["linux-x64", "darwin-arm64", "win32-x64"].includes(platform) || !/^[a-zA-Z0-9._-]{1,80}$/.test(version ?? "")) {
  throw new Error("Usage: node package-runtime.mjs VERIFIED-STAGING NEW-OUTPUT PLATFORM VERSION");
}
const source = await realpath(sourceArg);
const destination = path.resolve(destinationArg);
if (destination === source || destination.startsWith(source + path.sep)) throw new Error("Output must be outside staging.");
await mkdir(destination, { mode: 0o700 }); // Refuse to overwrite an existing release candidate.
const files = [];
async function visit(directory, prefix = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[a-zA-Z0-9_! .-]+$/.test(entry.name) || entry.name.trim() !== entry.name) throw new Error("Unsafe package name");
    const relative = prefix + entry.name;
    const filename = path.join(directory, entry.name);
    const resolved = await realpath(filename);
    if (!resolved.startsWith(source + path.sep)) throw new Error("Package link escapes verified staging");
    const metadata = await lstat(filename);
    if (metadata.isDirectory()) { await visit(filename, relative + "/"); continue; }
    const target = await stat(filename);
    if (!target.isFile() || target.size === 0) throw new Error("Unexpected package file");
    const hash = createHash("sha256"); for await (const chunk of createReadStream(filename)) hash.update(chunk);
    const sha256 = hash.digest("hex");
    const asset = `${sha256}-${entry.name}`;
    await copyFile(filename, path.join(destination, asset));
    files.push({ path: relative, bytes: target.size, sha256, ...(relative === "ponderosa-speech" || relative === "ponderosa-speech.exe" ? { executable: true } : {}) });
  }
}
await visit(source);
const manifest = { version, platform, qualified: false, packageUrl: `https://github.com/khaleelclark/Ponderosa/releases/download/${version}/linux-x64-package.tar.gz`, executable: platform === "win32-x64" ? "ponderosa-speech.exe" : "ponderosa-speech", modelRoot: "model", files };
await writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ files: files.length, downloadBytes: files.reduce((sum, file) => sum + file.bytes, 0), qualified: false }));
