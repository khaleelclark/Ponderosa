import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditPortableSymlinkTree,
  copyPortableTree,
} from "./symlink-portability.mjs";

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ponderosa-portable-links-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("preserves internal relative links without embedding the source path", (t) => {
  const directory = fixture(t);
  const source = path.join(directory, "checkout", "bundle");
  const destination = path.join(directory, "artifact", "bundle");
  mkdirSync(path.join(source, "lib"), { recursive: true });
  writeFileSync(path.join(source, "lib", "value.txt"), "portable");
  symlinkSync(path.join("lib", "value.txt"), path.join(source, "value-link"));

  const audit = copyPortableTree(source, destination, { label: "fixture artifact" });
  const copiedTarget = readlinkSync(path.join(destination, "value-link"));

  assert.equal(copiedTarget, path.join("lib", "value.txt"));
  assert.equal(path.isAbsolute(copiedTarget), false);
  assert.equal(copiedTarget.includes(source), false);
  assert.equal(audit.symlinkCount, 1);
  assert.equal(readFileSync(path.join(destination, "value-link"), "utf8"), "portable");
});

test("rejects absolute, escaping, and dangling links", async (t) => {
  const cases = [
    {
      name: "absolute",
      expected: /absolute symlink/u,
      target(root) {
        const outside = path.join(path.dirname(root), "outside.txt");
        writeFileSync(outside, "outside");
        return outside;
      },
    },
    {
      name: "windows-absolute",
      expected: /absolute symlink/u,
      target() {
        return "C:\\build-host\\checkout\\dependency";
      },
    },
    {
      name: "escaping",
      expected: /escaping symlink/u,
      target(root) {
        const outside = path.join(path.dirname(root), "outside.txt");
        writeFileSync(outside, "outside");
        return path.join("..", "outside.txt");
      },
    },
    {
      name: "dangling",
      expected: /dangling symlink/u,
      target() {
        return "missing.txt";
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const directory = fixture(t);
      const root = path.join(directory, scenario.name);
      mkdirSync(root);
      symlinkSync(scenario.target(root), path.join(root, "unsafe-link"));
      assert.throws(
        () => auditPortableSymlinkTree(root, { label: scenario.name }),
        scenario.expected,
      );
    });
  }
});

test("rejects an internal link chain that ultimately escapes", (t) => {
  const directory = fixture(t);
  const root = path.join(directory, "bundle");
  const outside = path.join(directory, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "value.txt"), "outside");
  symlinkSync(outside, path.join(root, "indirect"));
  symlinkSync(path.join("indirect", "value.txt"), path.join(root, "value-link"));

  assert.throws(
    () => auditPortableSymlinkTree(root, { label: "indirect fixture" }),
    /resolving outside its root|absolute symlink/u,
  );
});

test("Debian artifact preserves an internal relative link and omits the build-host path", {
  skip: process.platform !== "linux",
}, (t) => {
  const directory = fixture(t);
  const bundle = path.join(directory, "checkout-host-marker", "Ponderosa");
  const output = path.join(directory, "installers");
  const extracted = path.join(directory, "extracted");
  mkdirSync(path.join(bundle, "lib"), { recursive: true });
  writeFileSync(path.join(bundle, "lib", "value.txt"), "portable");
  symlinkSync(path.join("lib", "value.txt"), path.join(bundle, "value-link"));
  writeFileSync(path.join(bundle, "build-manifest.json"), `${JSON.stringify({
    version: "0.0.0-beta.portability",
    commit: "fixture",
    target: { platform: "linux", arch: "x64" },
  })}\n`);

  execFileSync(process.execPath, [
    path.resolve("packaging/package-beta.mjs"),
    "--bundle", bundle,
    "--output", output,
    "--format", "deb",
  ], { stdio: "pipe" });

  const artifact = path.join(output, "Ponderosa-0.0.0-beta.portability-linux-x64.deb");
  assert.equal(existsSync(artifact), true);
  execFileSync("dpkg-deb", ["--extract", artifact, extracted]);
  const installedRoot = path.join(extracted, "opt", "ponderosa-beta");
  const audit = auditPortableSymlinkTree(installedRoot, { label: "extracted fixture artifact" });
  const copiedTarget = readlinkSync(path.join(installedRoot, "value-link"));

  assert.equal(copiedTarget, path.join("lib", "value.txt"));
  assert.equal(path.isAbsolute(copiedTarget), false);
  assert.equal(copiedTarget.includes(bundle), false);
  assert.equal(audit.links.some((link) => link.target.includes("checkout-host-marker")), false);
});
