import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isWorkspaceReviewPathAllowed,
  workspaceFile,
} from "../src/git-status.js";

describe("workspace review file authority", () => {
  const disposable: string[] = [];

  afterEach(() => {
    for (const directory of disposable.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes secret-name rejection from retained-root containment", () => {
    expect(isWorkspaceReviewPathAllowed("directory-link/secret.txt")).toBe(false);
    expect(isWorkspaceReviewPathAllowed("directory-link/public.txt")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("rejects an allowed file name through a symlink directory", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ponderosa-workspace-review-"));
    disposable.push(directory);
    const root = path.join(directory, "root");
    const outside = path.join(directory, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "public.txt"), "outside");
    symlinkSync(outside, path.join(root, "directory-link"), "dir");

    await expect(workspaceFile(
      "qualification",
      root,
      "directory-link/public.txt",
    )).resolves.toMatchObject({
      projectId: "qualification",
      path: "directory-link/public.txt",
      exists: false,
      diff: "",
      stagedDiff: "",
      unstagedDiff: "",
      truncated: false,
    });
  });
});
