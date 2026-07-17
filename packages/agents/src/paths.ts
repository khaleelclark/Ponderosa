// On-disk layout (SPEC §7). Folders own authored state and telemetry; SQLite
// owns Communication V3 scheduler state and rebuildable views of authored data.
//
//   $PONDEROSA_DATA_DIR/
//     ponderosa.db                     ← projections + authoritative V3 runtime state
//     projects/
//       <project-id>/
//         project.json                 ← label, host path, createdAt
//         communication-events.jsonl   ← canonical cross-surface communication
//         communication-revisions.jsonl ← append-only edits of communication text
//         communication-context.jsonl  ← explicit context eligibility
//         communication-projections.jsonl ← rebuildable cross-surface placements
//         agent-organization.jsonl    ← canonical mutable reporting relationships
//         conversations/
//           <conversation-id>/
//             conversation.json         ← title, defaults, timestamps
//             messages.jsonl           ← model-agnostic control chat
//             collaboration.jsonl      ← opt-in agent team chat
//         agents/
//           <agent-id>/
//             agent.json              ← title, active engine, sessionIds, state, ts
//             events.jsonl             ← ⭐ append-only canonical log
//             artifacts/               ← diffs, reports, logs
//             attachments/             ← optional uploads

import path from "node:path";

export function dbPath(dataDir: string): string {
  return path.join(dataDir, "ponderosa.db");
}

export function workspaceEventsPath(dataDir: string): string {
  return path.join(dataDir, "workspace-events.jsonl");
}

export function workspaceInstancePath(dataDir: string): string {
  return path.join(dataDir, "workspace-instance-id");
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

export function communicationRevisionsPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "communication-revisions.jsonl");
}

export function communicationContextPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "communication-context.jsonl");
}

export function communicationProjectionsPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "communication-projections.jsonl");
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

export function messageDispatchesPath(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "message-dispatches.jsonl");
}

export function agentsDir(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "agents");
}

export function agentDir(dataDir: string, projectId: string, agentId: string): string {
  return path.join(agentsDir(dataDir, projectId), agentId);
}

export function agentJsonPath(
  dataDir: string,
  projectId: string,
  agentId: string,
): string {
  return path.join(agentDir(dataDir, projectId, agentId), "agent.json");
}

export function importedAgentHistoryPath(dataDir: string, projectId: string, agentId: string): string {
  return path.join(agentDir(dataDir, projectId, agentId), "imported-history.json");
}

export function eventsPath(
  dataDir: string,
  projectId: string,
  agentId: string,
): string {
  return path.join(agentDir(dataDir, projectId, agentId), "events.jsonl");
}

export function artifactsDir(
  dataDir: string,
  projectId: string,
  agentId: string,
): string {
  return path.join(agentDir(dataDir, projectId, agentId), "artifacts");
}

export function artifactContentPath(
  dataDir: string,
  projectId: string,
  agentId: string,
  artifactPath: string,
): string {
  const base = artifactsDir(dataDir, projectId, agentId);
  const target = path.resolve(base, artifactPath);
  if (target !== base && target.startsWith(base + path.sep)) {
    return target;
  }
  throw new Error("artifact path escapes artifacts directory");
}

/** Project-owned generated artifacts survive origin-Agent deletion and rebuild. */
export function managedArtifactsDir(dataDir: string, projectId: string): string {
  return path.join(projectDir(dataDir, projectId), "artifacts");
}

export function managedArtifactsLogPath(dataDir: string, projectId: string): string {
  return path.join(managedArtifactsDir(dataDir, projectId), "artifacts.jsonl");
}

export function managedArtifactContentPath(dataDir: string, projectId: string, artifactId: string): string {
  const base = path.join(managedArtifactsDir(dataDir, projectId), "content");
  const target = path.resolve(base, artifactId);
  if (target !== base && target.startsWith(base + path.sep)) return target;
  throw new Error("artifact id escapes managed artifact storage");
}

export function attachmentsDir(
  dataDir: string,
  projectId: string,
  agentId: string,
): string {
  return path.join(agentDir(dataDir, projectId, agentId), "attachments");
}

export function attachmentPath(dataDir: string, projectId: string, agentId: string, filename: string): string {
  if (!/^[a-f0-9-]+\.(png|jpg|gif|webp)$/.test(filename)) throw new Error("invalid attachment filename");
  return path.join(attachmentsDir(dataDir, projectId, agentId), filename);
}
