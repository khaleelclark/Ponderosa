// On-disk layout (SPEC §7). Folders are the source of truth; SQLite is a
// rebuildable projection over them.
//
//   $PONDEROSA_DATA_DIR/
//     ponderosa.db                     ← SQLite projections (rebuildable)
//     projects/
//       <project-id>/
//         project.json                 ← label, host path, createdAt
//         threads/
//           <thread-id>/
//             thread.json              ← title, active engine, sessionIds, state, ts
//             events.jsonl             ← ⭐ append-only canonical log
//             artifacts/               ← diffs, reports, logs
//             attachments/             ← optional uploads

import path from "node:path";

export function dbPath(dataDir: string): string {
  return path.join(dataDir, "ponderosa.db");
}

export function projectsDir(dataDir: string): string {
  return path.join(dataDir, "projects");
}

export function projectDir(dataDir: string, projectId: string): string {
  return path.join(projectsDir(dataDir), projectId);
}

export function projectJsonPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "project.json");
}

export function threadsDir(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "threads");
}

export function threadDir(dataDir: string, projectId: string, threadId: string): string {
  return path.join(threadsDir(dataDir, projectId), threadId);
}

export function threadJsonPath(
  dataDir: string,
  projectId: string,
  threadId: string,
): string {
  return path.join(threadDir(dataDir, projectId, threadId), "thread.json");
}

export function eventsPath(
  dataDir: string,
  projectId: string,
  threadId: string,
): string {
  return path.join(threadDir(dataDir, projectId, threadId), "events.jsonl");
}

export function artifactsDir(
  dataDir: string,
  projectId: string,
  threadId: string,
): string {
  return path.join(threadDir(dataDir, projectId, threadId), "artifacts");
}

export function attachmentsDir(
  dataDir: string,
  projectId: string,
  threadId: string,
): string {
  return path.join(threadDir(dataDir, projectId, threadId), "attachments");
}
