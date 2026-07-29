import { isUtf8 } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FilesResponse } from "@ponderosa/core";
import { listSecureDirectory, readSecureFile } from "@ponderosa/native-host";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function safeRelativePath(input: string | undefined): string {
  const value = input ?? "";
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized === "/") return "";
  if (normalized.startsWith("../") || normalized === ".." || path.isAbsolute(value)) {
    throw new Error("path escapes project");
  }
  return normalized;
}

const FILE_REFERENCE_IGNORED_SEGMENTS = new Set([
  "node_modules", "vendor", "dist", "build", "coverage", "__pycache__",
  ".git", ".hg", ".svn", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
]);

/** File mentions are model context, so credential-ish and generated paths fail closed. */
export function isProjectFileReferenceAllowed(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.every((segment) =>
    !FILE_REFERENCE_IGNORED_SEGMENTS.has(segment) &&
    !segment.startsWith(".") &&
    !/(?:^|[-_.])(secret|secrets|credential|credentials|token|tokens|password|passwd|oauth)(?:$|[-_.])/iu.test(segment),
  );
}

async function readScopedPath(root: string, relInput: string | undefined): Promise<FilesResponse> {
  const rel = safeRelativePath(relInput);
  if (rel && !isProjectFileReferenceAllowed(rel)) throw new Error("path is excluded from project references");
  if (process.platform !== "linux") {
    const entries = listSecureDirectory({ root, relativePath: rel });
    if (entries) {
      return {
        kind: "dir",
        path: rel,
        entries: entries
          .filter((entry) =>
            isProjectFileReferenceAllowed(path.posix.join(rel, entry.name)))
          .map((entry) => ({
            name: entry.name,
            path: path.posix.join(rel, entry.name),
            kind: entry.kind === "directory" ? ("dir" as const) : ("file" as const),
          }))
          .sort((a, b) =>
            Number(a.kind === "file") - Number(b.kind === "file") ||
            a.name.localeCompare(b.name)),
      };
    }
    const segments = rel.split("/");
    const leaf = segments.pop();
    if (!leaf) throw new Error("project file path is missing");
    const parent = segments.join("/");
    const entry = listSecureDirectory({ root, relativePath: parent })
      ?.find((candidate) =>
        candidate.name === leaf && candidate.kind === "file");
    if (!entry || entry.size === undefined) throw new Error("project file is unavailable");
    if (entry.size > MAX_FILE_BYTES) throw new Error("file exceeds 2 MiB browser limit");
    const buffer = readSecureFile({
      root,
      relativePath: rel,
      maxBytes: MAX_FILE_BYTES,
    });
    if (!buffer) throw new Error("project file changed during secure read");
    return isUtf8(buffer)
      ? { kind: "file", path: rel, content: buffer.toString("utf8"), encoding: "utf-8" }
      : { kind: "file", path: rel, content: buffer.toString("base64"), encoding: "base64" };
  }
  const rootReal = await fs.realpath(root);
  const target = path.resolve(rootReal, rel);
  const targetReal = await fs.realpath(target);
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new Error("path escapes project");
  }

  const stat = await fs.stat(targetReal);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(targetReal, { withFileTypes: true });
    return {
      kind: "dir",
      path: rel,
      entries: entries
        .filter((entry) => (entry.isDirectory() || entry.isFile()) && isProjectFileReferenceAllowed(path.posix.join(rel, entry.name)))
        .map((entry) => ({
          name: entry.name,
          path: path.posix.join(rel, entry.name),
          kind: entry.isDirectory() ? ("dir" as const) : ("file" as const),
        }))
        .sort((a, b) => Number(a.kind === "file") - Number(b.kind === "file") || a.name.localeCompare(b.name)),
    };
  }

  if (stat.size > MAX_FILE_BYTES) throw new Error("file exceeds 2 MiB browser limit");
  const buffer = await fs.readFile(targetReal);
  return isUtf8(buffer)
    ? { kind: "file", path: rel, content: buffer.toString("utf8"), encoding: "utf-8" }
    : { kind: "file", path: rel, content: buffer.toString("base64"), encoding: "base64" };
}

export {
  MAX_FILE_BYTES,
  FILE_REFERENCE_IGNORED_SEGMENTS,
  pathExists,
  safeRelativePath,
  readScopedPath,
};
