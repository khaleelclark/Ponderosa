import type { EngineId } from "../adapter.js";
import type { ArtifactKind } from "./artifacts.js";
import type {
  AgentOperationalReason,
  AgentOperationalStatus,
} from "./common.js";
import type { AgentPresetDto } from "./projects.js";
import type { CreateTriggerRequest } from "./triggers.js";

// ─── Agents ─────────────────────────────────────────────────────────────────

/** Derived agent state (current branch/commit), from `state` events (SPEC §2). */
export interface AgentState {
  branch?: string;
  commit?: string;
}

export interface AgentManagementPermissionsDto {
  /** May cancel and atomically delete roots inside this Agent's descendant subtree. */
  allowAutomaticDescendantDeletion: boolean;
  /** May rearrange reporting lines inside this Agent's subtree, but never detach from it. */
  allowAutomaticDescendantReorganization: boolean;
}

/** A stable, addressable agent identity. Mirrors the `agents` projection. */
export interface AgentDto {
  id: string;
  projectId: string;
  /** Optional primary Project conversation that groups this agent. */
  conversationId?: string;
  /** All Project conversations this agent belongs to. `conversationId` is primary. */
  conversationIds: string[];
  title: string;
  /** The engine currently bound to this agent. */
  activeEngine: EngineId;
  /** Durable provider selection used when a turn does not override it. */
  model?: string;
  /** Durable reasoning-effort selection used when a turn does not override it. */
  effort?: string;
  state: AgentState;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Direct manager in the mutable agent organization. Undefined means the agent reports to the user. */
  managerAgentId?: string;
  /** Explicit operator-granted authority over this Agent's descendants. */
  managementPermissions: AgentManagementPermissionsDto;
  /** Stable creation provenance for an agent spawned by another agent. */
  spawnedByAgentId?: string;
  spawnedByExecutionId?: string;
  /** Exact optional message supplied by the spawning agent. */
  spawnPrompt?: string;
  /** Immutable-at-spawn preset provenance and guidance snapshot. */
  presetSnapshot?: Pick<AgentPresetDto, "id" | "name" | "description" | "guidance" | "engine" | "model" | "effort">;
  importedHistoryCount?: number;
  importedFrom?: string;
}

export type AgentExportMode = "template" | "context" | "full";
export interface PortableAgentHistoryMessageDto { role: "user" | "assistant" | "system"; text: string; createdAt?: string }
export interface PortableArtifactDto {
  ref: string;
  kind: ArtifactKind;
  path: string;
  summary?: string;
  createdAt: string;
  mediaType?: string;
  visibility?: "project" | "published";
  pinned?: boolean;
  sourcePath?: string;
  dataBase64: string;
}
export interface PortableAgentNodeDto {
  ref: string;
  title: string;
  engine: string;
  model?: string;
  effort?: string;
  initialInstructions?: string;
  managerRef?: string;
  managementPermissions: AgentManagementPermissionsDto;
  history?: PortableAgentHistoryMessageDto[];
  artifacts?: PortableArtifactDto[];
  triggers?: Array<Omit<CreateTriggerRequest, "conversationId"> & { enabled: false }>;
}
export interface AgentPortablePackageDto {
  schema: "ponderosa.agent-package.v1";
  mode: AgentExportMode;
  kind: "agent" | "organization";
  exportedAt: string;
  sourceLabel: string;
  /** Historical provenance only. Destination Project rules remain authoritative. */
  sourceProjectInstructions?: string;
  rootRef: string;
  agents: PortableAgentNodeDto[];
}
export interface ImportAgentPackageRequest {
  package: AgentPortablePackageDto;
  conversationId: string;
  engineMapping: Record<string, string>;
  /** Required when any imported Agent receives autonomous destructive authority. */
  acknowledgeElevatedManagementPermissions?: boolean;
}
export interface CopyAgentPackageRequest {
  sourceAgentId: string;
  conversationId: string;
  /** Template copies omit history, files, and Triggers. Defaults to full. */
  mode?: "template" | "full";
  /** Copy the source Agent's complete managed descendant organization. */
  organization?: boolean;
  /** Required when any copied Agent receives autonomous destructive authority. */
  acknowledgeElevatedManagementPermissions?: boolean;
}
export interface ImportAgentPackageResponse { rootAgentId: string; agentIds: string[] }

export interface AgentRoleProfile {
  role: string;
  description: string;
}

/**
 * Present a spawned agent's durable identity as its role instead of silently
 * calling every agent without a preset a Generalist. Keep the prompt-derived
 * description compact because this profile is also injected into team discovery.
 */
export function agentRoleProfile(
  agent: Pick<AgentDto, "title" | "spawnPrompt" | "presetSnapshot">,
): AgentRoleProfile {
  const prompt = agent.spawnPrompt?.replace(/\s+/g, " ").trim();
  const compactPrompt = prompt && prompt.length > 160
    ? `${prompt.slice(0, 160).replace(/\s+\S*$/, "").trimEnd()}…`
    : prompt;
  if (agent.presetSnapshot) {
    return { role: agent.presetSnapshot.name, description: agent.presetSnapshot.description };
  }
  if (compactPrompt) {
    return { role: agent.title, description: compactPrompt };
  }
  return { role: "Generalist", description: `General-purpose agent ${agent.title}` };
}

export interface TeamDirectoryAgentDto {
  agentId: string;
  displayName: string;
  role: string;
  description: string;
  status: AgentOperationalStatus;
  currentActivity?: string;
  managerAgentId?: string;
  childAgentIds: string[];
  engine: EngineId;
  preset?: { id: string; name: string };
}

export interface TeamDirectoryDto {
  projectId: string;
  generatedAt: string;
  agents: TeamDirectoryAgentDto[];
}

/** POST /api/projects/:id/agents body. */
export interface CreateAgentRequest {
  title: string;
  engine: EngineId;
  conversationId?: string;
  model?: string;
  effort?: string;
  /** Per-opening-turn processing tier. "standard" clears provider acceleration. */
  speed?: string;
  /** Optional first turn, dispatched atomically with agent creation. */
  initialMessage?: string;
  /** Conversation-scoped staged assets committed with the optional first turn. */
  draftAttachmentIds?: string[];
  /** Browser-private draft owner used to resolve staged first-turn attachments. */
  draftOwnerId?: string;
  presetId?: string;
  /** Optional existing agent this new agent reports to. User-authorized creation only. */
  managerAgentId?: string;
  /** Persisted Agent settings. Omitted creation defaults both permissions off. */
  managementPermissions?: AgentManagementPermissionsDto;
}

/** PATCH /api/agents/:id body (persistent Agent settings). */
export interface UpdateAgentRequest {
  title?: string;
  archived?: boolean;
  /** Provider used when the next Run starts. Does not reconfigure an active Run. */
  activeEngine?: EngineId;
  /** Durable next-Run model. Null clears the Agent override. */
  model?: string | null;
  /** Durable next-Run reasoning effort. Null clears the Agent override. */
  effort?: string | null;
  managementPermissions?: AgentManagementPermissionsDto;
}

export interface AgentDeletionPreviewRequest {
  rootAgentIds: string[];
}

export interface AgentDeletionAffectedAgentDto {
  id: string;
  title: string;
  managerAgentId?: string;
}

export interface AgentDeletionPreviewDto {
  projectId: string;
  /** Server-normalized roots; descendants of another selected root are omitted. */
  rootAgentIds: string[];
  affectedAgents: AgentDeletionAffectedAgentDto[];
  /** Hash of the exact confirmed roots, affected IDs, names, and reporting edges. */
  previewHash: string;
}

export interface CommitAgentDeletionRequest {
  rootAgentIds: string[];
  previewHash: string;
}

export interface CommitAgentDeletionResponse {
  deleted: true;
  deletedAgentIds: string[];
  deletionReceiptId: string;
  cleanupPending: boolean;
  replayed?: boolean;
}

/** PUT /api/agents/:id/manager body. Null promotes to top level. */
export interface UpdateAgentOrganizationRequest {
  managerAgentId: string | null;
}

/** Canonical append-only record for mutable agent organization. */
export interface AgentOrganizationEvent {
  eventId: string;
  type: "manager_changed";
  projectId: string;
  agentId: string;
  managerAgentId: string | null;
  createdAt: string;
}

/** PUT /api/agents/:id/conversation-memberships body. Replaces membership atomically. */
export interface UpdateAgentConversationMembershipsRequest {
  conversationIds: string[];
  /** Must be one of `conversationIds`; omit only when the resulting set is empty. */
  primaryConversationId?: string;
}

export interface AgentHealthDto {
  /** Stable agent identity; titles and mention handles are presentation only. */
  agentId: string;
  managerAgentId?: string;
  childAgentIds: string[];
  status: AgentOperationalStatus;
  /** Timestamp of the authoritative observation that selected `status`. */
  statusTimestamp: string;
  reason: AgentOperationalReason;
  /** Runtime generation and bounded liveness window, when work is active. */
  executionId?: string;
  leaseExpiresAt?: string;
  runtimeOwnership?: "running" | "stalled" | "cancelling" | "interrupted";
  /** Present only while the server canonically owns an active execution. */
  runtimeActivity?: {
    state: "responding";
    executionId: string;
    startedAt: string;
  };
  /** A provider process currently owns this Agent's resumable session. */
  providerSessionLive?: boolean;
}

export interface AgentHealthProjectionDto {
  scope: { type: "project" | "conversation"; id: string };
  generatedAt: string;
  agents: AgentHealthDto[];
}
