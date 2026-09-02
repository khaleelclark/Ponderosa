#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { auditPortableSymlinkTree } from "./qualification/symlink-portability.mjs";

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
  path.join(bundle, "schema", "0000_current_schema.sql"),
  path.join(bundle, "qualification", "verify-installed-bundle.mjs"),
];
for (const pathname of required) {
  if (!existsSync(pathname)) throw new Error(`Bundle is incomplete: ${pathname}`);
}
auditPortableSymlinkTree(bundle, { label: "verified native beta bundle" });

if (manifest.target.platform !== process.platform || manifest.target.arch !== process.arch) {
  throw new Error(
    `Native verification requires ${manifest.target.platform}/${manifest.target.arch}; ` +
    `this host is ${process.platform}/${process.arch}. Static cross-verification is not release evidence.`,
  );
}
if (!/^v24\.\d+\.\d+(?:[-+].*)?$/u.test(manifest.nodeVersion)) {
  throw new Error(`Manifest does not declare a supported Node 24 runtime: ${manifest.nodeVersion ?? "missing"}`);
}
if (manifest.databaseSchemaVersion !== "0000_current_schema.sql") {
  throw new Error(`Unexpected launch-baseline schema: ${manifest.databaseSchemaVersion ?? "missing"}`);
}
const schemaHash = createHash("sha256")
  .update(readFileSync(path.join(bundle, "schema", manifest.databaseSchemaVersion)))
  .digest("hex");
if (schemaHash !== manifest.databaseSchemaSha256) {
  throw new Error("Bundled launch-baseline schema does not match its manifest identity.");
}

const reportPath = path.resolve(option(
  "report",
  path.join(path.dirname(bundle), "qualification-report.json"),
));
const result = spawnSync(
  path.join(bundle, "runtime", nodeName),
  [
    path.join(bundle, "qualification", "verify-installed-bundle.mjs"),
    "--install-root", bundle,
    "--report", reportPath,
  ],
  { encoding: "utf8", timeout: 60_000, windowsHide: true },
);
if (result.status !== 0) {
  throw new Error(`Installed-bundle qualification failed:\n${result.stderr || result.stdout}`);
}
process.stdout.write(result.stdout);
process.stdout.write(`Natively verified Ponderosa ${manifest.version} (${manifest.commit}) at ${bundle}\n`);
