import path from "node:path";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { listSecureDirectory } from "@ponderosa/native-host";
import type { GlobalFileSearchResponseDto, ProjectDto } from "@ponderosa/core";
import { isProjectFileReferenceAllowed } from "./project-files.js";

type Match = { file: GlobalFileSearchResponseDto["results"][number]; modifiedMs: number };
type SearchCursor = { v: 2; scope: string; projectId: string; conversationId: string; path: string; modifiedMs: number };

/** Bounded metadata-only discovery through the existing no-follow file authority.
 * Pages re-scan live metadata, so changed files may move between recent pages.
 * Traversal ceilings remain disclosed even when no further page is available. */
export async function searchWorkspaceFiles(projects: Array<ProjectDto & { conversationId: string }>, query: string, limit = 25, cursor?: string): Promise<GlobalFileSearchResponseDto> {
  const normalized = query.trim().toLocaleLowerCase();
  const terms = normalized.split(/\s+/u).filter(Boolean);
  const scope = createHash("sha256").update(JSON.stringify([normalized,
    projects.map(project => [project.id, project.conversationId, project.hostPath]).sort((a, b) =>
      a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!))])).digest("hex");
  let boundary: SearchCursor | undefined;
  if (cursor !== undefined) {
    try {
      if (!cursor || cursor.length > 4096) throw new Error();
      boundary = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as SearchCursor;
      if (boundary.v !== 2 || boundary.scope !== scope || typeof boundary.projectId !== "string" || typeof boundary.conversationId !== "string" ||
          typeof boundary.path !== "string" || !Number.isFinite(boundary.modifiedMs) ||
          !projects.some(project => project.id === boundary!.projectId && project.conversationId === boundary!.conversationId) ||
          !isProjectFileReferenceAllowed(boundary.path)) throw new Error();
    } catch { throw new Error("Invalid file search cursor or changed search scope"); }
  }
  const compare = (a: Match, b: Match) => (terms.length ? 0 : b.modifiedMs - a.modifiedMs) ||
    a.file.project.id.localeCompare(b.file.project.id) || a.file.conversationId.localeCompare(b.file.conversationId) || a.file.path.localeCompare(b.file.path);
  const boundaryMatch = boundary && { file: { project: { id: boundary.projectId, label: "" }, conversationId: boundary.conversationId, path: boundary.path, name: "" }, modifiedMs: boundary.modifiedMs };
  const matches: Match[] = [];
  const queue = projects.map(project => ({ project, relativePath: "" }));
  const failed = new Set<string>();
  let index = 0, inspected = 0, queueFull = false;
  const deadline = performance.now() + 750;
  while (index < queue.length && index < 500 && inspected < 50_000 && performance.now() < deadline) {
    const { project, relativePath } = queue[index++]!;
    try {
      const entries = listSecureDirectory({ root: project.hostPath, relativePath });
      if (!entries) { failed.add(project.conversationId); continue; }
      for (const entry of entries) {
        if (++inspected > 50_000) break;
        const filePath = path.posix.join(relativePath, entry.name);
        if (!isProjectFileReferenceAllowed(filePath)) continue;
        if (entry.kind === "directory") {
          if (queue.length < 5000) queue.push({ project, relativePath: filePath });
          else queueFull = true;
        } else if (entry.kind === "file" && terms.every(term => filePath.toLocaleLowerCase().includes(term))) {
          const match = { file: { project: { id: project.id, label: project.label }, conversationId: project.conversationId, path: filePath, name: entry.name }, modifiedMs: entry.modifiedMs };
          if (boundaryMatch && compare(match, boundaryMatch) <= 0) continue;
          matches.push(match);
          matches.sort(compare);
          if (matches.length > limit + 1) matches.pop();
        }
      }
    } catch { failed.add(project.conversationId); }
    await setImmediate();
  }
  const hasMore = matches.length > limit;
  const selected = matches.slice(0, limit);
  const last = selected.at(-1);
  return {
    results: selected.map(match => match.file),
    truncated: hasMore || queueFull || index < queue.length || inspected > 50_000,
    unavailableRoots: failed.size,
    ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 2, scope, projectId: last.file.project.id, conversationId: last.file.conversationId, path: last.file.path, modifiedMs: last.modifiedMs } satisfies SearchCursor)).toString("base64url") } : {}),
  };
}
