import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { workspaceStatus } from "./git-status.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function runGit(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("workspace Git detection", () => {
  test("accepts both a primary checkout and its linked worktree", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "ponderosa-git-worktree-"));
    directories.push(fixture);
    const repository = join(fixture, "repository");
    const worktree = join(fixture, "linked");
    mkdirSync(repository);
    runGit(repository, "init", "--initial-branch=main");
    runGit(repository, "config", "user.name", "Ponderosa Test");
    runGit(repository, "config", "user.email", "test@ponderosa.local");
    writeFileSync(join(repository, "sample.ts"), "export const value = 1;\n");
    runGit(repository, "add", "sample.ts");
    runGit(repository, "commit", "-m", "baseline");
    runGit(repository, "worktree", "add", "-b", "linked", worktree);
    writeFileSync(join(worktree, "sample.ts"), "export const value = 2;\n");

    expect(statSync(join(repository, ".git")).isDirectory()).toBe(true);
    expect(statSync(join(worktree, ".git")).isFile()).toBe(true);

    const primary = await workspaceStatus("primary", repository);
    expect(primary).toMatchObject({
      projectId: "primary",
      isGitRepository: true,
      branch: "main",
      changes: [],
    });

    const linked = await workspaceStatus("linked", worktree);
    expect(linked).toMatchObject({
      projectId: "linked",
      isGitRepository: true,
      branch: "linked",
      changes: [{
        path: "sample.ts",
        kind: "edit",
        staged: false,
        unstaged: true,
        untracked: false,
      }],
    });
  });

  test("does not trust an arbitrary retained .git file", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "ponderosa-fake-git-"));
    directories.push(fixture);
    writeFileSync(join(fixture, ".git"), "not a gitdir pointer\n");

    await expect(workspaceStatus("fake", fixture)).resolves.toMatchObject({
      projectId: "fake",
      isGitRepository: false,
      changes: [],
    });
  });
});
