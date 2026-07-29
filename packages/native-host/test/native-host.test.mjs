import assert from "node:assert/strict";
import test from "node:test";
import {
  listSecureDirectory,
  readSecureFile,
  removeSecureFile,
  secureFileAuthoritySupported,
  writeSecureFileAtomic,
  windowsJobObjectsSupported,
} from "../dist/index.js";
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

test("Windows Job Object capability fails closed by platform", () => {
  assert.equal(windowsJobObjectsSupported("linux"), false);
  assert.equal(windowsJobObjectsSupported("darwin"), false);
  if (process.platform !== "win32") assert.equal(windowsJobObjectsSupported(), false);
});

test("secure file authority retains root-relative no-follow access", () => {
  assert.equal(secureFileAuthoritySupported(), true);
  const parent = mkdtempSync(path.join(os.tmpdir(), "ponderosa-secure-file-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  mkdirSync(path.join(root, "nested"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, "nested", "safe.txt"), "safe");
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leaf-link"));
  symlinkSync(
    outside,
    path.join(root, "directory-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const rootLink = path.join(parent, "root-link");
  symlinkSync(root, rootLink, process.platform === "win32" ? "junction" : "dir");
  if (process.platform !== "win32") {
    linkSync(
      path.join(root, "nested", "safe.txt"),
      path.join(root, "nested", "hard-link"),
    );
  }
  try {
    assert.equal(readSecureFile({
      root: rootLink,
      relativePath: "nested/safe.txt",
      maxBytes: 16,
    }), undefined);
    assert.equal(readSecureFile({
      root,
      relativePath: "nested/safe.txt",
      maxBytes: 16,
    })?.toString(), process.platform === "win32" ? "safe" : undefined);
    if (process.platform !== "win32") {
      rmSync(path.join(root, "nested", "hard-link"));
      assert.equal(readSecureFile({
        root,
        relativePath: "nested/safe.txt",
        maxBytes: 16,
      })?.toString(), "safe");
    }
    assert.equal(readSecureFile({ root, relativePath: "leaf-link", maxBytes: 16 }), undefined);
    assert.equal(readSecureFile({ root, relativePath: "directory-link/secret.txt", maxBytes: 16 }), undefined);
    assert.throws(() => readSecureFile({ root, relativePath: "../outside/secret.txt", maxBytes: 16 }));
    assert.throws(() => readSecureFile({ root, relativePath: path.join(root, "nested", "safe.txt"), maxBytes: 16 }));
    assert.equal(readSecureFile({ root, relativePath: "nested/safe.txt", maxBytes: 3 }), undefined);
    assert.deepEqual(
      listSecureDirectory({ root, relativePath: "nested" })
        ?.map(({ name, kind, size }) => ({ name, kind, size })),
      [{ name: "safe.txt", kind: "file", size: 4 }],
    );
    writeSecureFileAtomic({
      root,
      relativeDirectory: "managed/content",
      leaf: "artifact",
      temporaryLeaf: ".artifact.test.tmp",
      body: Buffer.from("managed"),
    });
    assert.equal(readSecureFile({
      root,
      relativePath: "managed/content/artifact",
      maxBytes: 16,
    })?.toString(), "managed");
    assert.throws(() => writeSecureFileAtomic({
      root,
      relativeDirectory: "managed/content",
      leaf: "artifact",
      temporaryLeaf: ".artifact.collision.tmp",
      body: Buffer.from("collision"),
    }));
    assert.equal(removeSecureFile({
      root,
      relativeDirectory: "managed/content",
      leaf: "artifact",
    }), true);
    assert.equal(removeSecureFile({
      root,
      relativeDirectory: "managed/content",
      leaf: "artifact",
    }), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
