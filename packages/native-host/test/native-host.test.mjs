import assert from "node:assert/strict";
import test from "node:test";
import {
  readSecureFile,
  secureFileAuthoritySupported,
  windowsJobObjectsSupported,
} from "../dist/index.js";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("Windows Job Object capability fails closed by platform", () => {
  assert.equal(windowsJobObjectsSupported("linux"), false);
  assert.equal(windowsJobObjectsSupported("darwin"), false);
  if (process.platform !== "win32") assert.equal(windowsJobObjectsSupported(), false);
});

test("secure file authority retains root-relative no-follow access", () => {
  if (process.platform === "win32") {
    assert.equal(secureFileAuthoritySupported(), false);
    return;
  }
  assert.equal(secureFileAuthoritySupported(), true);
  const parent = mkdtempSync(path.join(os.tmpdir(), "ponderosa-secure-file-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  mkdirSync(path.join(root, "nested"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, "nested", "safe.txt"), "safe");
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leaf-link"));
  symlinkSync(outside, path.join(root, "directory-link"));
  try {
    assert.equal(readSecureFile({
      root,
      relativePath: "nested/safe.txt",
      maxBytes: 16,
    })?.toString(), "safe");
    assert.equal(readSecureFile({ root, relativePath: "leaf-link", maxBytes: 16 }), undefined);
    assert.equal(readSecureFile({ root, relativePath: "directory-link/secret.txt", maxBytes: 16 }), undefined);
    assert.throws(() => readSecureFile({ root, relativePath: "../outside/secret.txt", maxBytes: 16 }));
    assert.throws(() => readSecureFile({ root, relativePath: path.join(root, "nested", "safe.txt"), maxBytes: 16 }));
    assert.equal(readSecureFile({ root, relativePath: "nested/safe.txt", maxBytes: 3 }), undefined);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
