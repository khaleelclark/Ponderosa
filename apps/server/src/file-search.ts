import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { listSecureDirectory } from "@ponderosa/native-host";
import type { GlobalFileSearchResponseDto, ProjectDto } from "@ponderosa/core";
import { isProjectFileReferenceAllowed } from "./project-files.js";

/** Bounded metadata-only discovery through the existing no-follow file authority. */
export async function searchWorkspaceFiles(projects: ProjectDto[], query: string, limit = 25): Promise<GlobalFileSearchResponseDto> {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const results: GlobalFileSearchResponseDto["results"] = [];
  const recentFiles: Array<{ file: GlobalFileSearchResponseDto["results"][number]; modifiedMs: number }> = [];
  let moreRecentFiles = false;
  const output = () => terms.length ? results : recentFiles.map(entry => entry.file);
  const queue = projects.map(project => ({ project, relativePath: "" }));
  const failed = new Set<string>();
  let cursor = 0, inspected = 0;
  const deadline = performance.now() + 750;
  while (cursor < queue.length && cursor < 500 && inspected < 50_000 && performance.now() < deadline) {
    const { project, relativePath } = queue[cursor++]!;
    try {
      const entries = listSecureDirectory({ root: project.hostPath, relativePath });
      if (!entries) { failed.add(project.id); continue; }
      for (const entry of entries) {
        if (++inspected > 50_000) break;
        const filePath = path.posix.join(relativePath, entry.name);
        if (!isProjectFileReferenceAllowed(filePath)) continue;
        if (entry.kind === "directory") { if (queue.length < 5000) queue.push({ project, relativePath: filePath }); else return { results: output(), truncated: true, unavailableRoots: failed.size }; }
        else if (entry.kind === "file" && terms.every(term => filePath.toLocaleLowerCase().includes(term))) {
          if (!terms.length) {
            recentFiles.push({ file: { project: { id: project.id, label: project.label }, path: filePath, name: entry.name }, modifiedMs: entry.modifiedMs });
            recentFiles.sort((a, b) => b.modifiedMs - a.modifiedMs || a.file.path.localeCompare(b.file.path) || a.file.project.id.localeCompare(b.file.project.id));
            if (recentFiles.length > limit) { recentFiles.pop(); moreRecentFiles = true; }
            continue;
          }
          if (results.length === limit) return { results, truncated: true, unavailableRoots: failed.size };
          results.push({ project: { id: project.id, label: project.label }, path: filePath, name: entry.name });
        }
      }
    } catch { failed.add(project.id); }
    await setImmediate();
  }
  return { results: output(), truncated: moreRecentFiles || cursor < queue.length || inspected > 50_000, unavailableRoots: failed.size };
}
