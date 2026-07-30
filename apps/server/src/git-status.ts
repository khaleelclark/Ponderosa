import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import type {
  WorkspaceChangeDto,
  WorkspaceFileReviewDto,
  WorkspaceStatusDto,
} from "@ponderosa/core";
import {
  listSecureDirectory,
  readSecureFileAsync,
} from "@ponderosa/native-host";
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
      [
        "--no-optional-locks",
        "-c", "color.ui=false",
        "-c", "core.fsmonitor=false",
        "-c", "core.untrackedCache=false",
        ...args,
      ],
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
    const retainedGitDirectory = listSecureDirectory({ root })
      ?.some((entry) => entry.name === ".git" && entry.kind === "directory");
    if (!retainedGitDirectory) {
      return { projectId, isGitRepository: false, generatedAt, changes: [] };
    }
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
  let exists = false;
  let content: string | undefined;
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
      if (isUtf8(body)) content = body.toString("utf8");
    } else {
      truncated = true;
    }
  }
  const stagedDiff = "";
  const unstagedDiff = "";
  let diff = "";
  if (exists && content !== undefined) {
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
