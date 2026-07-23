#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const bundle = path.resolve(option(
  "bundle",
  path.join("dist", "beta", `${process.platform}-${process.arch}`, "Ponderosa"),
));
const manifestPath = path.join(bundle, "build-manifest.json");
if (!existsSync(manifestPath)) throw new Error(`Bundle manifest is missing: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const nodeName = manifest.target.platform === "win32" ? "node.exe" : "node";
const required = [
  path.join(bundle, "runtime", nodeName),
  path.join(bundle, "app", "launcher", "dist", "cli.js"),
  path.join(bundle, "app", "server", "dist", "main.js"),
  path.join(bundle, "app", "web", "dist", "index.html"),
  path.join(bundle, "migrations"),
  path.join(bundle, "starter-pack", "expected-results.json"),
  path.join(bundle, "docs", "wiki", "getting-started.md"),
];
if (manifest.target.platform === "win32") required.push(path.join(bundle, "ponderosa.vbs"));
for (const pathname of required) {
  if (!existsSync(pathname)) throw new Error(`Bundle is incomplete: ${pathname}`);
}

if (manifest.target.platform === process.platform && manifest.target.arch === process.arch) {
  const result = spawnSync(
    path.join(bundle, "runtime", nodeName),
    [
      path.join(bundle, "app", "launcher", "dist", "cli.js"),
      "version",
      "--install-root", bundle,
      "--json",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Bundled launcher failed:\n${result.stderr || result.stdout}`);
  }
  const reported = JSON.parse(result.stdout);
  if (reported.commit !== manifest.commit || reported.version !== manifest.version) {
    throw new Error("Bundled launcher identity does not match its manifest.");
  }
} else {
  process.stdout.write(
    `Static verification only: bundle targets ${manifest.target.platform}/${manifest.target.arch}; host is ${process.platform}/${process.arch}.\n`,
  );
}
process.stdout.write(`Verified Ponderosa ${manifest.version} (${manifest.commit}) at ${bundle}\n`);
