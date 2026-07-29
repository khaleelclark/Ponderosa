import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readScopedPath } from "../src/project-files.js";
import { ProjectFileAuthority } from "../src/routes/project-files.js";

function authority(): ProjectFileAuthority {
  return new ProjectFileAuthority({
    getProject: () => undefined,
  });
}

describe("ProjectFileAuthority", () => {
  it("accounts transfer capacity by weight and releases idempotently", () => {
    const files = authority();
    const first = files.acquire("project", 2);
    const second = files.acquire("project", 2);
    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");
    expect(files.acquire("project", 1)).toBeUndefined();

    first!();
    first!();
    expect(files.acquire("project", 1)).toBeTypeOf("function");
  });

  it("only advertises the bounded inline-preview media types", () => {
    const files = authority();
    expect(files.mediaType("result.pdf")).toBe("application/pdf");
    expect(files.supportsPreview("application/pdf")).toBe(true);
    expect(files.supportsPreview("text/html")).toBe(false);
    expect(files.mediaType(undefined)).toBeUndefined();
  });

  it("rejects leaf swaps at the legacy and browser production boundaries", async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "project-authority-"));
    const root = path.join(parent, "root");
    const outside = path.join(parent, "outside.txt");
    mkdirSync(root);
    writeFileSync(path.join(root, "safe.txt"), "safe");
    writeFileSync(outside, "secret");
    try {
      await expect(readScopedPath(root, "safe.txt", {
        afterResolve: () => {
          renameSync(path.join(root, "safe.txt"), path.join(root, "retained.txt"));
          symlinkSync(outside, path.join(root, "safe.txt"));
        },
      })).rejects.toThrow(/changed/);

      rmSync(path.join(root, "safe.txt"));
      renameSync(path.join(root, "retained.txt"), path.join(root, "safe.txt"));
      const browser = new ProjectFileAuthority(
        {
          getProject: () => ({ hostPath: root }) as never,
        },
        {
          afterResolve: () => {
            renameSync(path.join(root, "safe.txt"), path.join(root, "retained.txt"));
            symlinkSync(outside, path.join(root, "safe.txt"));
          },
        },
      );
      await expect(browser.fileForBrowser(
        "project",
        "safe.txt",
        { maxBytes: 16 },
      )).resolves.toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
