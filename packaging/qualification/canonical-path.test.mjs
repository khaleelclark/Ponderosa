import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalPath } from "./canonical-path.mjs";

test("canonicalizes a symlink alias for existing and future descendants", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ponderosa-canonical-path-"));
  try {
    const canonicalTemporaryRoot = path.join(root, "private", "var");
    const aliasTemporaryRoot = path.join(root, "var");
    const canonicalApplication = path.join(
      canonicalTemporaryRoot,
      "Applications",
      "Ponderosa Beta.app",
    );
    mkdirSync(canonicalApplication, { recursive: true });
    symlinkSync(canonicalTemporaryRoot, aliasTemporaryRoot, "dir");

    assert.equal(
      canonicalPath(path.join(aliasTemporaryRoot, "Applications", "Ponderosa Beta.app")),
      canonicalPath(canonicalApplication),
    );
    assert.equal(
      canonicalPath(path.join(aliasTemporaryRoot, "Ponderosa GUI Data", "launcher-state")),
      canonicalPath(path.join(
        canonicalTemporaryRoot,
        "Ponderosa GUI Data",
        "launcher-state",
      )),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
