import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentWorkingCopyDto,
  WorkspaceChangeDto,
  WorkspaceFileReviewDto,
  WorkspaceStatusDto,
} from "@ponderosa/core";
import {
  listSecureDirectory,
  readSecureFileAsync,
  secureDirectoryIdentity,
} from "@ponderosa/native-host";
import {
  FILE_REFERENCE_IGNORED_SEGMENTS,
  MAX_FILE_BYTES,
  safeRelativePath,
} from "./project-files.js";

const WORKSPACE_REVIEW_MAX_BYTES = 2 * 1024 * 1024;
const GIT_CONTROL_FILE_MAX_BYTES = 4 * 1024;

function isWorkspaceReviewPathAllowed(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.every((segment) =>
    !FILE_REFERENCE_IGNORED_SEGMENTS.has(segment) &&
    !/^\.env(?:\.|$)/iu.test(segment) &&
    !/(?:^|[-_.])(secret|secrets|credential|credentials|token|tokens|password|passwd|oauth)(?:$|[-_.])/iu.test(segment),
  );
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface FileIdentity {
  path: string;
  identity: string;
}

interface DirectoryIdentity {
  path: string;
  identity: string;
}

export interface GitRepositoryIdentity {
  root: DirectoryIdentity;
  marker: {
    kind: "directory" | "file";
    identity: string;
    size?: number;
    modifiedMs: number;
  };
  gitDirectory: DirectoryIdentity;
  commonDirectory: DirectoryIdentity;
  controlFiles: FileIdentity[];
}

export type GitRunner = (
  identity: GitRepositoryIdentity,
  args: string[],
) => Promise<GitResult>;

function statIdentity(value: BigIntStats, includeContentState: boolean): string {
  const base = `${value.dev}:${value.ino}:${value.mode & 0o170000n}`;
  return includeContentState
    ? `${base}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`
    : base;
}

async function captureDirectory(input: string): Promise<DirectoryIdentity> {
  const before = await lstat(input, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Git metadata path is not a retained directory");
  }
  const canonical = await realpath(input);
  const after = await lstat(input, { bigint: true });
  const canonicalStats = await lstat(canonical, { bigint: true });
  const identity = statIdentity(before, false);
  if (
    identity !== statIdentity(after, false) ||
    identity !== statIdentity(canonicalStats, false)
  ) {
    throw new Error("Git metadata directory changed while resolving");
  }
  return { path: canonical, identity };
}

async function readControlFile(
  input: string,
  maxBytes = GIT_CONTROL_FILE_MAX_BYTES,
): Promise<{ body: Buffer; identity: FileIdentity }> {
  const before = await lstat(input, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1n ||
    before.size > BigInt(maxBytes)
  ) {
    throw new Error("Git control file is not a bounded regular file");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await open(input, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    const identity = statIdentity(before, true);
    if (!opened.isFile() || identity !== statIdentity(opened, true)) {
      throw new Error("Git control file changed while opening");
    }
    const body = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    const current = await lstat(input, { bigint: true });
    if (
      body.length < 1 ||
      body.length > maxBytes ||
      identity !== statIdentity(afterRead, true) ||
      identity !== statIdentity(current, true)
    ) {
      throw new Error("Git control file changed while reading");
    }
    return { body, identity: { path: input, identity } };
  } finally {
    await handle.close();
  }
}

function singleLine(value: Buffer | string, prefix = ""): string {
  if (Buffer.isBuffer(value) && !isUtf8(value)) {
    throw new Error("Git control file is not UTF-8");
  }
  let text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  if (
    !text ||
    text.includes("\n") ||
    text.includes("\r") ||
    text.includes("\0") ||
    !text.startsWith(prefix)
  ) {
    throw new Error("Git control value is not one canonical line");
  }
  const result = text.slice(prefix.length);
  if (!result) {
    throw new Error("Git control path is empty");
  }
  return result;
}

function resolvedControlPath(fromDirectory: string, value: string): string {
  return path.resolve(fromDirectory, value);
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

async function inspectGitRepository(root: string): Promise<GitRepositoryIdentity> {
  const rootDirectory = await captureDirectory(await realpath(root));
  const marker = listSecureDirectory({ root: rootDirectory.path })
    ?.find((entry) => entry.name === ".git");
  if (!marker || (marker.kind !== "directory" && marker.kind !== "file")) {
    throw new Error("Project root has no retained Git marker");
  }

  const markerPath = path.join(rootDirectory.path, ".git");
  if (marker.kind === "directory") {
    const gitDirectory = await captureDirectory(markerPath);
    return {
      root: rootDirectory,
      marker: {
        kind: marker.kind,
        identity: marker.identity,
        modifiedMs: marker.modifiedMs,
      },
      gitDirectory,
      commonDirectory: gitDirectory,
      controlFiles: [],
    };
  }

  if (
    marker.size === undefined ||
    marker.size < 1 ||
    marker.size > GIT_CONTROL_FILE_MAX_BYTES
  ) {
    throw new Error("Git marker file is oversized");
  }
  const markerBody = await readSecureFileAsync({
    root: rootDirectory.path,
    relativePath: ".git",
    maxBytes: GIT_CONTROL_FILE_MAX_BYTES,
    expectedSize: marker.size,
    requireNonEmpty: true,
  });
  if (!markerBody) throw new Error("Git marker changed during secure read");

  const gitDirectory = await captureDirectory(resolvedControlPath(
    rootDirectory.path,
    singleLine(markerBody, "gitdir: "),
  ));
  const commonFile = await readControlFile(path.join(gitDirectory.path, "commondir"));
  const commonDirectory = await captureDirectory(resolvedControlPath(
    gitDirectory.path,
    singleLine(commonFile.body),
  ));
  const backlinkFile = await readControlFile(path.join(gitDirectory.path, "gitdir"));
  const backlink = resolvedControlPath(
    gitDirectory.path,
    singleLine(backlinkFile.body),
  );
  if (!samePath(backlink, markerPath)) {
    throw new Error("Linked-worktree Git metadata does not point back to this Project root");
  }

  const worktreesDirectory = path.join(commonDirectory.path, "worktrees");
  const relativeAdminPath = path.relative(worktreesDirectory, gitDirectory.path);
  if (
    !relativeAdminPath ||
    path.isAbsolute(relativeAdminPath) ||
    relativeAdminPath.startsWith(`..${path.sep}`) ||
    relativeAdminPath === ".." ||
    relativeAdminPath.includes(path.sep)
  ) {
    throw new Error("Git directory is not owned by the linked-worktree common directory");
  }

  return {
    root: rootDirectory,
    marker: {
      kind: marker.kind,
      identity: marker.identity,
      size: marker.size,
      modifiedMs: marker.modifiedMs,
    },
    gitDirectory,
    commonDirectory,
    controlFiles: [commonFile.identity, backlinkFile.identity],
  };
}

async function repositoryIdentityStillCurrent(
  identity: GitRepositoryIdentity,
): Promise<boolean> {
  const marker = listSecureDirectory({ root: identity.root.path })
    ?.find((entry) => entry.name === ".git");
  if (
    !marker ||
    marker.kind !== identity.marker.kind ||
    marker.identity !== identity.marker.identity ||
    marker.modifiedMs !== identity.marker.modifiedMs ||
    marker.size !== identity.marker.size
  ) return false;
  try {
    const [root, gitDirectory, commonDirectory, ...controlFiles] = await Promise.all([
      lstat(identity.root.path, { bigint: true }),
      lstat(identity.gitDirectory.path, { bigint: true }),
      lstat(identity.commonDirectory.path, { bigint: true }),
      ...identity.controlFiles.map((file) => lstat(file.path, { bigint: true })),
    ]);
    if (
      identity.root.identity !== statIdentity(root, false) ||
      identity.gitDirectory.identity !== statIdentity(gitDirectory, false) ||
      identity.commonDirectory.identity !== statIdentity(commonDirectory, false)
    ) return false;
    return controlFiles.every((stats, index) =>
      identity.controlFiles[index]?.identity === statIdentity(stats, true));
  } catch {
    return false;
  }
}

function gitEnvironment(identity: GitRepositoryIdentity): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) delete environment[name];
  environment.GIT_DIR = identity.gitDirectory.path;
  environment.GIT_WORK_TREE = identity.root.path;
  environment.GIT_COMMON_DIR = identity.commonDirectory.path;
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

function runGit(identity: GitRepositoryIdentity, args: string[]): Promise<GitResult> {
  return runGitBytes(identity, args).then(result => ({ ...result, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") }));
}

function runGitBytes(identity: GitRepositoryIdentity, args: string[]): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "--no-optional-locks",
        "-c", "color.ui=false",
        "-c", "core.fsmonitor=false",
        "-c", "core.untrackedCache=false",
        "-c", "core.hooksPath=",
        ...args,
      ],
      {
        cwd: identity.root.path,
        encoding: "buffer",
        env: gitEnvironment(identity),
        timeout: 8_000,
        maxBuffer: WORKSPACE_REVIEW_MAX_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          if (typeof error.code !== "number") return reject(error);
          return resolve({ stdout, stderr, exitCode: error.code });
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
  });
}

export function parseGitStatus(output: string): WorkspaceChangeDto[] {
  const records = output.split("\0");
  const changes: WorkspaceChangeDto[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    const pathValue = record.slice(3);
    const renamed = x === "R" || y === "R" || x === "C" || y === "C";
    const previousPath = renamed ? records[index += 1] : undefined;
    if (!isWorkspaceReviewPathAllowed(pathValue)) continue;
    const combined = `${x}${y}`;
    changes.push({
      path: pathValue,
      ...(previousPath && isWorkspaceReviewPathAllowed(previousPath) ? { previousPath } : {}),
      kind: renamed ? "rename" : combined.includes("D") ? "delete" : combined === "??" || combined.includes("A") ? "create" : "edit",
      staged: x !== " " && x !== "?",
      unstaged: y !== " " && y !== "?",
      untracked: combined === "??",
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function workspaceStatus(
  projectId: string,
  agentId: string,
  workingCopy: AgentWorkingCopyDto,
  root: string,
  gitRunner: GitRunner = runGit,
): Promise<WorkspaceStatusDto> {
  const generatedAt = new Date().toISOString();
  try {
    const identity = await inspectGitRepository(root);
    const [topLevel, gitDirectory, commonDirectory] = await Promise.all([
      gitRunner(identity, ["rev-parse", "--show-toplevel"]),
      gitRunner(identity, ["rev-parse", "--absolute-git-dir"]),
      gitRunner(identity, ["rev-parse", "--git-common-dir"]),
    ]);
    if (
      topLevel.exitCode !== 0 ||
      gitDirectory.exitCode !== 0 ||
      commonDirectory.exitCode !== 0
    ) return { projectId, agentId, workingCopy, isGitRepository: false, generatedAt, changes: [] };
    const reportedRoot = await realpath(singleLine(topLevel.stdout));
    const reportedGitDirectory = await realpath(singleLine(gitDirectory.stdout));
    const reportedCommonDirectory = await realpath(singleLine(commonDirectory.stdout));
    if (
      !samePath(reportedRoot, identity.root.path) ||
      !samePath(reportedGitDirectory, identity.gitDirectory.path) ||
      !samePath(reportedCommonDirectory, identity.commonDirectory.path)
    ) return { projectId, agentId, workingCopy, isGitRepository: false, generatedAt, changes: [] };
    const [status, branch, head] = await Promise.all([
      gitRunner(identity, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      gitRunner(identity, ["rev-parse", "--abbrev-ref", "HEAD"]),
      gitRunner(identity, ["rev-parse", "--short", "HEAD"]),
    ]);
    if (
      status.exitCode !== 0 ||
      !await repositoryIdentityStillCurrent(identity)
    ) return { projectId, agentId, workingCopy, isGitRepository: false, generatedAt, changes: [] };
    return {
      projectId,
      agentId,
      workingCopy,
      isGitRepository: true,
      ...(branch.exitCode === 0 ? { branch: singleLine(branch.stdout) } : {}),
      ...(head.exitCode === 0 ? { head: singleLine(head.stdout) } : {}),
      generatedAt,
      changes: parseGitStatus(status.stdout),
    };
  } catch {
    return { projectId, agentId, workingCopy, isGitRepository: false, generatedAt, changes: [] };
  }
}

async function workspaceFile(
  projectId: string,
  agentId: string,
  workingCopyId: string,
  root: string,
  input: string | undefined,
): Promise<WorkspaceFileReviewDto> {
  const relativePath = safeRelativePath(input);
  if (!relativePath || !isWorkspaceReviewPathAllowed(relativePath)) throw new Error("path is excluded from workspace review");
  const rootIdentity = secureDirectoryIdentity({ root });
  if (!rootIdentity) throw new Error("workspace storage is unavailable");
  let repository: GitRepositoryIdentity | undefined;
  try { repository = await inspectGitRepository(root); }
  catch { /* non-Git folders can still show safely read current content */ }
  let exists = false;
  let content: string | undefined;
  let capturedBytes: Buffer | undefined;
  let truncated = false;
  const segments = relativePath.split("/");
  const leaf = segments.pop()!;
  const entry = listSecureDirectory({
    root,
    relativePath: segments.join("/"),
  })?.find((candidate) =>
    candidate.name === leaf && candidate.kind === "file");
  if (entry?.size !== undefined) {
    exists = true;
    if (entry.size <= MAX_FILE_BYTES) {
      const body = await readSecureFileAsync({
        root,
        relativePath,
        maxBytes: MAX_FILE_BYTES,
        expectedSize: entry.size,
      });
      if (!body) throw new Error("workspace file changed during secure read");
      capturedBytes = body;
      if (isUtf8(body) && !body.includes(0)) content = body.toString("utf8");
    } else {
      truncated = true;
    }
  }
  let stagedDiff = "";
  let unstagedDiff = "";
  if (repository) {
    const before = await runGit(repository, ["status", "--porcelain=v1", "-z"]);
    const indexBefore = await runGit(repository, ["ls-files", "--stage", "--", relativePath]);
    const headBefore = await runGit(repository, ["rev-parse", "--verify", "HEAD"]);
    try {
      const previousPath = parseGitStatus(before.stdout).find(change => change.path === relativePath)?.previousPath;
      const staged = await runGit(repository, ["diff", "--cached", "--find-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--", ...(previousPath ? [previousPath] : []), relativePath]);
      if (staged.exitCode !== 0) throw new Error("staged patch is unavailable");
      stagedDiff = staged.stdout;
      // Never let Git reopen an untrusted working-file pathname. Capture the
      // index through Git, then compare it with the verified secure-file read
      // in private temporary files. No external diff/text conversion runs.
      const indexed = await runGitBytes(repository, ["show", `:${relativePath}`]);
      if (capturedBytes !== undefined || (!exists && indexed.exitCode === 0)) {
        const temporary = await mkdtemp(path.join(tmpdir(), "ponderosa-review-"));
        try {
          const oldFile = indexed.exitCode === 0 ? path.join(temporary, "before") : process.platform === "win32" ? "NUL" : "/dev/null";
          const newFile = exists ? path.join(temporary, "after") : process.platform === "win32" ? "NUL" : "/dev/null";
          if (indexed.exitCode === 0) await writeFile(oldFile, indexed.stdout, { mode: 0o600, flag: "wx" });
          if (exists) await writeFile(newFile, capturedBytes!, { mode: 0o600, flag: "wx" });
          const patch = await new Promise<string>((resolve, reject) => execFile("git",
            ["-c", "color.ui=false", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", oldFile, newFile],
            { cwd: temporary, encoding: "utf8", timeout: 8_000, maxBuffer: WORKSPACE_REVIEW_MAX_BYTES },
            (error, stdout) => error && (typeof error.code !== "number" || error.code > 1) ? reject(error) : resolve(stdout)));
          unstagedDiff = patch.split("\n").map(line => {
            if (line.startsWith("diff --git ")) return `diff --git a/${relativePath} b/${relativePath}`;
            if (line.startsWith("--- ") && indexed.exitCode === 0) return `--- a/${relativePath}`;
            if (line.startsWith("+++ ") && exists) return `+++ b/${relativePath}`;
            if (line.startsWith("Binary files ")) return `Binary files ${indexed.exitCode === 0 ? `a/${relativePath}` : "/dev/null"} and ${exists ? `b/${relativePath}` : "/dev/null"} differ`;
            return line;
          }).join("\n");
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
      const after = await runGit(repository, ["status", "--porcelain=v1", "-z"]);
      const indexAfter = await runGit(repository, ["ls-files", "--stage", "--", relativePath]);
      const headAfter = await runGit(repository, ["rev-parse", "--verify", "HEAD"]);
      const currentBytes = capturedBytes ? await readSecureFileAsync({ root, relativePath, maxBytes: MAX_FILE_BYTES, expectedSize: capturedBytes.length }) : undefined;
      if (before.exitCode !== 0 || after.exitCode !== 0 || before.stdout !== after.stdout ||
          indexBefore.stdout !== indexAfter.stdout || headBefore.exitCode !== headAfter.exitCode || headBefore.stdout !== headAfter.stdout || (capturedBytes && !currentBytes?.equals(capturedBytes)) ||
          !await repositoryIdentityStillCurrent(repository) ||
          secureDirectoryIdentity({ root }) !== rootIdentity) throw new Error("workspace changed during review; refresh to capture current changes");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        truncated = true;
      } else throw error;
    }
  }
  const diff = [stagedDiff, unstagedDiff].filter(Boolean).join("\n");
  return { projectId, agentId, workingCopyId, path: relativePath, exists, ...(content !== undefined ? { content } : {}), diff, stagedDiff, unstagedDiff, truncated };
}

export {
  WORKSPACE_REVIEW_MAX_BYTES,
  isWorkspaceReviewPathAllowed,
  runGit,
  workspaceStatus,
  workspaceFile,
};
