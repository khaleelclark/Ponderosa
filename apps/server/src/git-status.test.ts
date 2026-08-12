import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  runGit as runWorkspaceGit,
  workspaceStatus,
  type GitRunner,
} from "./git-status.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function temporaryDirectory(prefix: string): string {
  const fixture = mkdtempSync(join(tmpdir(), prefix));
  directories.push(fixture);
  return fixture;
}

function initializeRepository(repository: string): void {
  mkdirSync(repository);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Ponderosa Test");
  git(repository, "config", "user.email", "test@ponderosa.local");
  writeFileSync(join(repository, "sample.ts"), "export const value = 1;\n");
  git(repository, "add", "sample.ts");
  git(repository, "commit", "-m", "baseline");
}

function linkedWorktreeFixture(prefix = "ponderosa-git-worktree-"): {
  fixture: string;
  repository: string;
  worktree: string;
  gitDirectory: string;
} {
  const fixture = temporaryDirectory(prefix);
  const repository = join(fixture, "repository");
  const worktree = join(fixture, "linked");
  initializeRepository(repository);
  git(repository, "worktree", "add", "-b", "linked", worktree);
  const marker = readFileSync(join(worktree, ".git"), "utf8").trimEnd();
  return {
    fixture,
    repository,
    worktree,
    gitDirectory: resolve(worktree, marker.slice("gitdir: ".length)),
  };
}

async function expectNotRepository(
  projectId: string,
  root: string,
  runner?: GitRunner,
): Promise<void> {
  await expect(workspaceStatus(projectId, root, runner)).resolves.toMatchObject({
    projectId,
    isGitRepository: false,
    changes: [],
  });
}

describe("workspace Git detection", () => {
  test("accepts both a primary checkout and its linked worktree", async () => {
    const { repository, worktree } = linkedWorktreeFixture();
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
    const fixture = temporaryDirectory("ponderosa-fake-git-");
    writeFileSync(join(fixture, ".git"), "not a gitdir pointer\n");

    await expectNotRepository("fake", fixture);
  });

  test("accepts a genuine linked worktree with a relative gitdir marker", async () => {
    const { worktree, gitDirectory } = linkedWorktreeFixture("ponderosa-relative-worktree-");
    writeFileSync(
      join(worktree, ".git"),
      `gitdir: ${relative(worktree, gitDirectory)}\n`,
    );

    await expect(workspaceStatus("relative", worktree)).resolves.toMatchObject({
      projectId: "relative",
      isGitRepository: true,
      branch: "linked",
      changes: [],
    });
  });

  test.skipIf(process.platform === "win32")(
    "rejects a stable .git symlink without following it",
    async () => {
      const fixture = temporaryDirectory("ponderosa-git-symlink-");
      const repository = join(fixture, "repository");
      const project = join(fixture, "project");
      initializeRepository(repository);
      mkdirSync(project);
      symlinkSync(join(repository, ".git"), join(project, ".git"), "dir");

      await expectNotRepository("symlink", project);
    },
  );

  test.each([
    ["malformed", "not a gitdir pointer\n"],
    ["multiline", "gitdir: /tmp/first\ngitdir: /tmp/second\n"],
    ["empty path", "gitdir: \n"],
    ["padded path", "gitdir: /tmp/repository  \n"],
    ["oversized", `gitdir: ${"a".repeat(4_097)}\n`],
  ])("rejects a %s .git marker", async (label, body) => {
    const fixture = temporaryDirectory(`ponderosa-git-${label.replace(" ", "-")}-`);
    writeFileSync(join(fixture, ".git"), body);
    await expectNotRepository(label, fixture);
  });

  test.each(["absolute", "relative"])(
    "rejects a valid-looking %s pointer to an unrelated repository",
    async (kind) => {
      const fixture = temporaryDirectory(`ponderosa-unrelated-${kind}-`);
      const repository = join(fixture, "repository");
      const project = join(fixture, "project");
      initializeRepository(repository);
      mkdirSync(project);
      const target = kind === "absolute"
        ? join(repository, ".git")
        : relative(project, join(repository, ".git"));
      writeFileSync(join(project, ".git"), `gitdir: ${target}\n`);

      await expectNotRepository(kind, project);
    },
  );

  test("rejects a copied linked-worktree marker whose backlink names another root", async () => {
    const { fixture, worktree } = linkedWorktreeFixture("ponderosa-copied-worktree-");
    const copied = join(fixture, "copied");
    mkdirSync(copied);
    copyFileSync(join(worktree, ".git"), join(copied, ".git"));

    await expectNotRepository("copied", copied);
  });

  test("rejects a stale linked-worktree marker", async () => {
    const fixture = temporaryDirectory("ponderosa-stale-worktree-");
    writeFileSync(join(fixture, ".git"), `gitdir: ${join(fixture, "missing")}\n`);
    await expectNotRepository("stale", fixture);
  });

  test.each(["multiline", "oversized", "unrelated"])(
    "rejects %s linked-worktree commondir contents",
    async (kind) => {
      const { fixture, worktree, gitDirectory } = linkedWorktreeFixture(
        `ponderosa-commondir-${kind}-`,
      );
      const commondir = join(gitDirectory, "commondir");
      if (kind === "multiline") writeFileSync(commondir, "../..\n../other\n");
      else if (kind === "oversized") writeFileSync(commondir, "a".repeat(4_097));
      else {
        const unrelated = join(fixture, "unrelated");
        initializeRepository(unrelated);
        writeFileSync(commondir, `${join(unrelated, ".git")}\n`);
      }

      await expectNotRepository(kind, worktree);
    },
  );

  test("overrides an external core.worktree and reports only the Project root", async () => {
    const fixture = temporaryDirectory("ponderosa-core-worktree-");
    const repository = join(fixture, "repository");
    const external = join(fixture, "external");
    initializeRepository(repository);
    mkdirSync(external);
    writeFileSync(join(external, "sample.ts"), "export const value = 99;\n");
    git(repository, "config", "core.worktree", external);

    await expect(workspaceStatus("bounded", repository)).resolves.toMatchObject({
      projectId: "bounded",
      isGitRepository: true,
      branch: "main",
      changes: [],
    });
  });

  test("fails closed when Git reports a top level outside the registered Project root", async () => {
    const fixture = temporaryDirectory("ponderosa-top-level-");
    const repository = join(fixture, "repository");
    const external = join(fixture, "external");
    initializeRepository(repository);
    mkdirSync(external);
    const runner: GitRunner = async (identity, args) =>
      args.join(" ") === "rev-parse --show-toplevel"
        ? { stdout: `${external}\n`, stderr: "", exitCode: 0 }
        : runWorkspaceGit(identity, args);

    await expectNotRepository("boundary", repository, runner);
  });

  test("fails closed if the .git marker is swapped before child processes run", async () => {
    const { worktree } = linkedWorktreeFixture("ponderosa-marker-swap-");
    let swapped = false;
    const runner: GitRunner = async (identity, args) => {
      if (!swapped) {
        swapped = true;
        renameSync(join(worktree, ".git"), join(worktree, ".git.original"));
        writeFileSync(join(worktree, ".git"), "gitdir: /tmp/attacker-controlled\n");
      }
      return runWorkspaceGit(identity, args);
    };

    await expectNotRepository("swap", worktree, runner);
  });

  test.each([
    "rev-parse --show-toplevel",
    "rev-parse --absolute-git-dir",
    "rev-parse --git-common-dir",
    "status --porcelain=v1 -z --untracked-files=all",
    "rev-parse --abbrev-ref HEAD",
    "rev-parse --short HEAD",
  ])("fails closed when `%s` exits nonzero", async (failedCommand) => {
    const fixture = temporaryDirectory("ponderosa-git-nonzero-");
    const repository = join(fixture, "repository");
    initializeRepository(repository);
    const runner: GitRunner = async (identity, args) =>
      args.join(" ") === failedCommand
        ? { stdout: "", stderr: "forced failure", exitCode: 128 }
        : runWorkspaceGit(identity, args);

    await expectNotRepository("nonzero", repository, runner);
  });

  test.each([
    ["timeout", Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" })],
    ["max-buffer", Object.assign(new Error("stdout maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })],
    ["termination", Object.assign(new Error("terminated"), { signal: "SIGKILL" })],
  ])("fails closed on a Git %s error", async (label, error) => {
    const fixture = temporaryDirectory(`ponderosa-git-${label}-`);
    const repository = join(fixture, "repository");
    initializeRepository(repository);
    const runner: GitRunner = async (identity, args) => {
      if (args[0] === "status") throw error;
      return runWorkspaceGit(identity, args);
    };

    await expectNotRepository(label, repository, runner);
  });
});
