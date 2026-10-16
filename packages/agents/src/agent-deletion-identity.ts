import { validateDeletionTombstone } from "./deletion-tombstone-ownership.js";

export const AGENT_DELETION_IDENTITY_FILE = ".ponderosa-agent-deletion.json";

export interface AgentDeletionIdentity {
  version: 1;
  kind: "agent-deletion";
  projectId: string;
  conversationId: string | null;
  agentId: string;
  tombstoneName: string;
  ownershipToken: string;
}

export interface AgentDeletionDirectoryIdentity {
  agentId: string;
  projectId: string;
  conversationId: string | null;
  tombstoneName: string;
  ownershipToken: string;
  createdAt: string;
}

export function validateAgentDeletionName(row: AgentDeletionDirectoryIdentity): void {
  if (row.tombstoneName.includes("/") || row.tombstoneName.includes("\\") ||
      !row.tombstoneName.startsWith(`.${row.agentId}.deleting-`) || !row.ownershipToken) {
    throw new Error("invalid Agent deletion recovery journal");
  }
}

export function agentDeletionIdentity(
  row: AgentDeletionDirectoryIdentity,
): AgentDeletionIdentity {
  return {
    version: 1,
    kind: "agent-deletion",
    projectId: row.projectId,
    conversationId: row.conversationId,
    agentId: row.agentId,
    tombstoneName: row.tombstoneName,
    ownershipToken: row.ownershipToken,
  };
}

export function validateAgentDeletionDirectory(
  path: string,
  row: AgentDeletionDirectoryIdentity,
): void {
  validateAgentDeletionName(row);
  validateDeletionTombstone(
    path,
    AGENT_DELETION_IDENTITY_FILE,
    agentDeletionIdentity(row),
    "Agent deletion audit directory",
  );
}
