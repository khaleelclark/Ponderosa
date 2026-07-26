import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  WorkspaceChangeDto,
  WorkspaceFileReviewDto,
  WorkspaceStatusDto,
} from "@ponderosa/core";
import {
  FILE_REFERENCE_IGNORED_SEGMENTS,
  MAX_FILE_BYTES,
  safeRelativePath,
} from "./project-files.js";

const WORKSPACE_REVIEW_MAX_BYTES = 2 * 1024 * 1024;

function isWorkspaceReviewPathAllowed(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.every((segment) =>
    !FILE_REFERENCE_IGNORED_SEGMENTS.has(segment) &&
    !/^\.env(?:\.|$)/iu.test(segment) &&
    !/(?:^|[-_.])(secret|secrets|credential|credentials|token|tokens|password|passwd|oauth)(?:$|[-_.])/iu.test(segment),
  );
}

interface GitResult { stdout: string; stderr: string; exitCode: number }

function runGit(root: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "color.ui=false", ...args],
      { cwd: root, encoding: "utf8", timeout: 8_000, maxBuffer: WORKSPACE_REVIEW_MAX_BYTES },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "string") return reject(error);
        resolve({ stdout, stderr, exitCode: typeof error?.code === "number" ? error.code : 0 });
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

async function workspaceStatus(projectId: string, root: string): Promise<WorkspaceStatusDto> {
  const generatedAt = new Date().toISOString();
  try {
    const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return { projectId, isGitRepository: false, generatedAt, changes: [] };
    const [status, branch, head] = await Promise.all([
      runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(root, ["rev-parse", "--short", "HEAD"]),
    ]);
    return {
      projectId,
      isGitRepository: true,
      branch: branch.stdout.trim() || undefined,
      head: head.stdout.trim() || undefined,
      generatedAt,
      changes: parseGitStatus(status.stdout),
    };
  } catch {
    return { projectId, isGitRepository: false, generatedAt, changes: [] };
  }
}

async function workspaceFile(projectId: string, root: string, input: string | undefined): Promise<WorkspaceFileReviewDto> {
  const relativePath = safeRelativePath(input);
  if (!relativePath || !isWorkspaceReviewPathAllowed(relativePath)) throw new Error("path is excluded from workspace review");
  const rootReal = await fs.realpath(root);
  const candidate = path.resolve(rootReal, relativePath);
  if (!candidate.startsWith(`${rootReal}${path.sep}`)) throw new Error("path escapes project");

  const [staged, unstaged] = await Promise.all([
    runGit(rootReal, ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", relativePath]),
    runGit(rootReal, ["diff", "--no-ext-diff", "--unified=3", "--", relativePath]),
  ]);
  let exists = false;
  let content: string | undefined;
  let truncated = staged.stdout.length + unstaged.stdout.length >= WORKSPACE_REVIEW_MAX_BYTES;
  try {
    const resolved = await fs.realpath(candidate);
    if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) throw new Error("path escapes project");
    const stat = await fs.stat(resolved);
    exists = stat.isFile();
    if (exists && stat.size <= MAX_FILE_BYTES) {
      const body = await fs.readFile(resolved);
      if (isUtf8(body)) content = body.toString("utf8");
    } else if (exists) {
      truncated = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stagedDiff = staged.stdout;
  const unstagedDiff = unstaged.stdout;
  let diff = [stagedDiff, unstagedDiff].filter(Boolean).join("\n");
  if (!diff && exists && content !== undefined) {
    const lines = content.split("\n");
    diff = [`--- /dev/null`, `+++ b/${relativePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
    if (diff.length > WORKSPACE_REVIEW_MAX_BYTES) {
      diff = diff.slice(0, WORKSPACE_REVIEW_MAX_BYTES);
      truncated = true;
    }
  }
  return { projectId, path: relativePath, exists, ...(content !== undefined ? { content } : {}), diff, stagedDiff, unstagedDiff, truncated };
}

export {
  WORKSPACE_REVIEW_MAX_BYTES,
  isWorkspaceReviewPathAllowed,
  runGit,
  workspaceStatus,
  workspaceFile,
};
