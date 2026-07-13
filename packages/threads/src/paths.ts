// On-disk layout (SPEC §7). Folders are the source of truth; SQLite is a
// rebuildable projection over them.
//
//   $PONDEROSA_DATA_DIR/
//     ponderosa.db                     ← SQLite projections (rebuildable)
//     projects/
//       <project-id>/
//         project.json                 ← label, host path, createdAt
//         communication-events.jsonl   ← canonical cross-surface communication
//         communication-context.jsonl  ← explicit context eligibility
//         communication-projections.jsonl ← rebuildable cross-surface placements
//         run-triggers.jsonl              ← accepted communication-to-agent dispatches
//         agent-organization.jsonl    ← canonical mutable reporting relationships
//         conversations/
//           <conversation-id>/
//             conversation.json         ← title, defaults, timestamps
//             messages.jsonl           ← model-agnostic control chat
//             collaboration.jsonl      ← opt-in agent team chat
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

export function managedWorkspacesDir(dataDir: string): string {
  return path.join(dataDir, "workspaces");
}

export function projectDir(dataDir: string, projectId: string): string {
  return path.join(projectsDir(dataDir), projectId);
}

export function projectJsonPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "project.json");
}

/** Canonical project-level communication log; chat surfaces are projections. */
export function communicationEventsPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "communication-events.jsonl");
}

export function communicationContextPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "communication-context.jsonl");
}

export function communicationProjectionsPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "communication-projections.jsonl");
}

export function runTriggersPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "run-triggers.jsonl");
}

export function agentPresetsPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "agent-presets.jsonl");
}

export function agentOrganizationEventsPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "agent-organization.jsonl");
}

export function conversationsDir(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "conversations");
}

export function conversationDir(dataDir: string, projectId: string, conversationId: string): string {
  return path.join(conversationsDir(dataDir, projectId), conversationId);
}

export function conversationJsonPath(
  dataDir: string,
  projectId: string,
  conversationId: string,
): string {
  return path.join(conversationDir(dataDir, projectId, conversationId), "conversation.json");
}

export function conversationMessagesPath(
  dataDir: string,
  projectId: string,
  conversationId: string,
): string {
  return path.join(conversationDir(dataDir, projectId, conversationId), "messages.jsonl");
}

export function collaborationMessagesPath(
  dataDir: string,
  projectId: string,
  conversationId: string,
): string {
  return path.join(conversationDir(dataDir, projectId, conversationId), "collaboration.jsonl");
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

export function attachmentPath(dataDir: string, projectId: string, threadId: string, filename: string): string {
  if (!/^[a-f0-9-]+\.(png|jpg|gif|webp)$/.test(filename)) throw new Error("invalid attachment filename");
  return path.join(attachmentsDir(dataDir, projectId, threadId), filename);
}
