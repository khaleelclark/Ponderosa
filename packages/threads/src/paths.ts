// On-disk layout (SPEC §7). Folders are the source of truth; SQLite is a
// rebuildable projection over them.
//
//   $PONDEROSA_DATA_DIR/
//     ponderosa.db                     ← SQLite projections (rebuildable)
//     projects/
//       <project-id>/
//         project.json                 ← label, host path, createdAt
//         master-chats/
//           <master-chat-id>/
//             master-chat.json         ← title, defaults, timestamps
//             messages.jsonl           ← model-agnostic control chat
//             collaboration.jsonl      ← opt-in agent collaboration chat
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

export function masterChatsDir(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "master-chats");
}

export function masterChatDir(dataDir: string, projectId: string, masterChatId: string): string {
  return path.join(masterChatsDir(dataDir, projectId), masterChatId);
}

export function masterChatJsonPath(
  dataDir: string,
  projectId: string,
  masterChatId: string,
): string {
  return path.join(masterChatDir(dataDir, projectId, masterChatId), "master-chat.json");
}

export function masterChatMessagesPath(
  dataDir: string,
  projectId: string,
  masterChatId: string,
): string {
  return path.join(masterChatDir(dataDir, projectId, masterChatId), "messages.jsonl");
}

export function collaborationChatMessagesPath(
  dataDir: string,
  projectId: string,
  masterChatId: string,
): string {
  return path.join(masterChatDir(dataDir, projectId, masterChatId), "collaboration.jsonl");
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

export function artifactContentPath(
  dataDir: string,
  projectId: string,
  threadId: string,
  artifactPath: string,
): string {
  const base = artifactsDir(dataDir, projectId, threadId);
  const target = path.resolve(base, artifactPath);
  if (target !== base && target.startsWith(base + path.sep)) {
    return target;
  }
  throw new Error("artifact path escapes artifacts directory");
}

export function attachmentsDir(
  dataDir: string,
  projectId: string,
  threadId: string,
): string {
  return path.join(threadDir(dataDir, projectId, threadId), "attachments");
}
