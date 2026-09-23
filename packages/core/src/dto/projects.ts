import type { EngineId } from "../adapter.js";

// ─── Projects ────────────────────────────────────────────────────────────────

/** A codebase/repo on the host; a UI tab (SPEC §2). Mirrors the `projects` table. */
export interface ProjectDto {
  id: string;
  label: string;
  /** Absolute host path for the Project's explicit Shared folder. */
  hostPath: string;
  createdAt: string;
  lastUsedAt?: string;
  /** Server-authoritative default for every newly created Project chat. */
  defaultEngine: EngineId;
  /** Optional Project override. Missing values inherit the workspace engine default. */
  defaultModel?: string;
  defaultEffort?: string;
  /** Most recently opened non-deleted Project chat. */
  lastConversationId?: string;
  /** Project-wide operator rules injected after global rules and before Agent instructions. */
  instructions?: string;
}

export interface AgentPresetDto {
  id: string;
  projectId: string;
  name: string;
  description: string;
  guidance: string;
  engine: EngineId;
  model?: string;
  effort?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CreateAgentPresetRequest = Pick<AgentPresetDto, "name" | "description" | "guidance" | "engine"> &
  Partial<Pick<AgentPresetDto, "model" | "effort" | "enabled">>;
export type UpdateAgentPresetRequest = Partial<Omit<CreateAgentPresetRequest, "engine">> & { engine?: EngineId };

/** POST /api/projects body. */
export interface CreateProjectRequest {
  label: string;
  defaultEngine: EngineId;
  defaultModel?: string;
  defaultEffort?: string;
  /** Initial Chat processing tier; Projects themselves do not own this setting. */
  defaultSpeed?: string;
  /** Existing absolute host folder. Omit to use a new managed empty workspace. */
  hostPath?: string;
  /** Create a named empty folder below Ponderosa's managed workspace root. */
  createFolderName?: string;
}

export type ProjectSort = "last_used" | "alphabetical" | "custom";

/** PATCH /api/projects/:id body. Project working folders are immutable after creation. */
export interface UpdateProjectRequest {
  label?: string;
  instructions?: string;
  defaultEngine?: EngineId;
  /** Null clears the Project override and resumes inheriting the workspace default. */
  defaultModel?: string | null;
  defaultEffort?: string | null;
}

export interface ProjectFolderOptionDto {
  hostPath: string;
  name: string;
  source: "registered" | "managed";
}

/** GET /api/project-folders response. Never exposes arbitrary host directories. */
export interface ProjectFolderOptionsDto {
  managedRoot: string;
  folders: ProjectFolderOptionDto[];
}

export interface ProjectDeletionPreviewDto {
  projectId: string;
  chats: number;
  agents: number;
  automations: number;
  managedFiles: number;
  activeAgents: Array<{ id: string; title: string }>;
  projectBrowserActive: boolean;
  nonempty: boolean;
}

export interface ProjectDeletionResponseDto {
  deleted: true;
  deletionReceiptId: string;
  cleanupPending: boolean;
  replayed?: boolean;
}

export interface HostFolderBrowseDto {
  path: string;
  root: string;
  parentPath?: string;
  folders: Array<{ name: string; hostPath: string }>;
}

export interface CreateHostFolderRequest {
  parentPath: string;
  name: string;
}

export interface HostFolderCreateDto {
  name: string;
  hostPath: string;
}
