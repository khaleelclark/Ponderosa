import type { EngineId } from "../adapter.js";
import type { AgentDto, AgentHealthDto } from "./agents.js";
import type { BrowserControlOwner, BrowserSessionStatus } from "../events.js";
import type { ConversationDto } from "./conversations.js";
import type { HistoryWindowDto } from "./common.js";
import type { ProjectDto, ProjectSort } from "./projects.js";
import type { TriggerDefinitionDto } from "./triggers.js";

export type NotificationPreference = "direct_responses" | "project_responses" | "mentions" | "all_messages" | "everyone" | "broadcasts" | "none";

/** Durable independent notification switches. `allMessages` implies the
 * narrower categories in the UI without changing their saved values. */
export interface NotificationPreferencesDto {
  mentions: boolean;
  directReplies: boolean;
  projectChatMessages: boolean;
  broadcasts: boolean;
  allMessages: boolean;
}

export interface WorkspacePreferencesDto {
  projectSort: ProjectSort;
  /** Stable project IDs in the operator's chosen order. Unknown/deleted IDs are ignored. */
  projectOrder: string[];
  /** Stable resource keys arranged by the operator on Home. */
  homeOrder?: string[];
  /** Sort mode for the mixed Home resource list. */
  homeSort?: ProjectSort;
  /** Stable conversation IDs in the operator's chosen order. */
  chatOrder?: string[];
  /** Sort mode shared by Chat navigation and the All Chats workspace. */
  chatSort?: ProjectSort;
  /** Stable Agent IDs in the operator's chosen order. */
  agentOrder?: string[];
  /** Sort mode shared by Agent navigation and the All Agents workspace. */
  agentSort?: ProjectSort;
  /** Stable Trigger IDs in the operator's chosen order. */
  triggerOrder?: string[];
  /** Sort mode shared by Trigger navigation and the All Triggers workspace. */
  triggerSort?: ProjectSort;
  /** Stable namespaced resource keys pinned across Home and noun views. */
  starredResourceIds?: string[];
  /** Stable project IDs pinned to the Starred section. Unknown/deleted IDs are ignored. */
  starredProjectIds: string[];
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  notifications: NotificationPreferencesDto;
  fontFamily: "inter" | "system" | "sans";
  /** Operator-controlled global runtime switches. Missing engines default to enabled. */
  providerAvailability: Record<string, boolean>;
  /** Provider whose subscription quota is shown by default when several are authenticated. */
  defaultUsageProvider?: EngineId;
  /** Concrete model/effort defaults chosen independently for each engine. */
  engineDefaults?: Record<string, { model: string; effort?: string }>;
  /** Operator-managed versioned Claude model choices. Environment pins take precedence. */
  claudeModelOptions: Array<{
    id: string;
    label?: string;
    resolvedModel?: string;
    validatedAt?: string;
    availability?: "available" | "unavailable";
    unavailableReason?: string;
  }>;
  /** Ponderosa-managed rules supplied to every Agent. */
  globalInstructions: string;
  /** Workspace-wide admission limit for concurrently active Agent Runs. */
  maxConcurrentAgentRuns: number;
  /** Proactively roll a provider session over once its context grows past these limits. */
  contextRolloverEnabled: boolean;
  /** Absolute context-token ceiling, counting cached tokens. */
  contextRolloverTokens: number;
  /** Also roll over at this fraction of the window, for providers that report one. */
  contextRolloverWindowFraction: number;
  /** Durable, cross-device completion marker for the operator's welcome flow. */
  onboardingCompletedAt: string | null;
  profile: OperatorProfileDto;
  updatedAt: string;
}

export type WorkspaceDirectoryKind = "project" | "conversation" | "agent" | "trigger";

export interface WorkspaceProjectDirectoryItemDto {
  kind: "project";
  project: ProjectDto;
  recentConversation?: Pick<ConversationDto, "id" | "title" | "updatedAt">;
  conversationCount: number;
  runningAgentCount: number;
}

export interface WorkspaceConversationDirectoryItemDto {
  kind: "conversation";
  project: Pick<ProjectDto, "id" | "label" | "hostPath">;
  conversation: ConversationDto;
}

export interface WorkspaceAgentDirectoryItemDto {
  kind: "agent";
  project: Pick<ProjectDto, "id" | "label" | "hostPath">;
  agent: AgentDto;
  health: AgentHealthDto;
}

export interface WorkspaceTriggerDirectoryItemDto {
  kind: "trigger";
  project: Pick<ProjectDto, "id" | "label" | "hostPath">;
  agent: Pick<AgentDto, "id" | "title">;
  trigger: TriggerDefinitionDto;
}

export type WorkspaceDirectoryItemDto =
  | WorkspaceProjectDirectoryItemDto
  | WorkspaceConversationDirectoryItemDto
  | WorkspaceAgentDirectoryItemDto
  | WorkspaceTriggerDirectoryItemDto;

export interface WorkspaceDirectoryPageDto<
  T extends WorkspaceDirectoryItemDto = WorkspaceDirectoryItemDto,
> {
  kind: T["kind"];
  /** Starred matches are returned independently and never consume the page limit. */
  starredItems: T[];
  items: T[];
  /** Total matching resources, including starred resources. */
  total: number;
  /** Workspace-wide active count, present for the Agent directory. */
  activeCount?: number;
  history: HistoryWindowDto;
}

export type WorkspaceResourceKind =
  | "project"
  | "conversation"
  | "agent"
  | "trigger";

export interface WorkspaceResourceRecencyDto {
  resourceKey: `${WorkspaceResourceKind}:${string}`;
  kind: WorkspaceResourceKind;
  resourceId: string;
  lastUsedAt: string;
}

export interface WorkspaceResourceRecencyListDto {
  resources: WorkspaceResourceRecencyDto[];
}

export interface MarkWorkspaceResourceUsedRequest {
  kind: WorkspaceResourceKind;
  resourceId: string;
}

export interface OperatorProfileDto {
  displayName: string;
  handle: string;
  avatarId: string;
}

export interface UploadedOperatorAvatarDto {
  /** Content-addressed managed avatar identity persisted in OperatorProfileDto. */
  avatarId: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  url: string;
}

export type UpdateWorkspacePreferencesRequest = Partial<Omit<WorkspacePreferencesDto, "updatedAt">>;

export interface DraftAttachmentDto {
  id: string;
  conversationId: string;
  ownerId?: string;
  name: string;
  mediaType: string;
  size: number;
  createdAt: string;
  downloadUrl: string;
}

export interface ConversationDraftDto {
  conversationId: string;
  /** Durable browser-profile owner. Drafts never roam to another browser profile. */
  ownerId: string;
  text: string;
  /** Stable staged asset IDs; a draft is never represented as a chat event. */
  attachmentIds: string[];
  /** Metadata for staged files still referenced by this draft. */
  attachments?: DraftAttachmentDto[];
  revision: number;
  updatedAt: string;
  clientId: string;
}

/** A rejected stale write includes the displaced text as a recoverable copy. */
export interface ConversationDraftConflictDto {
  current: ConversationDraftDto;
  displaced: Pick<ConversationDraftDto, "conversationId" | "text" | "attachmentIds" | "clientId"> & { capturedAt: string };
}

export interface ConversationDraftConflictListDto {
  conversationId: string;
  conflicts: ConversationDraftConflictDto[];
}

export interface PutConversationDraftRequest {
  text: string;
  attachmentIds: string[];
  expectedRevision: number;
  clientId: string;
  ownerId?: string;
}

export interface GenerateConversationTitleResponse {
  title: string;
  generated: boolean;
}

export interface WorkspaceNotificationDto {
  id: string;
  projectId?: string;
  conversationId?: string;
  /** Every Project chat where the affected Agent currently participates. */
  conversationIds?: string[];
  agentId?: string;
  /** All Agents directly affected by this current issue. */
  agentIds?: string[];
  communicationEventId?: string;
  kind: Exclude<NotificationPreference, "none"> | "collaboration" | "operational" | "decision";
  category?: "communication" | "provider" | "trigger" | "budget" | "coordination" | "decision" | "system";
  severity?: "info" | "attention" | "urgent";
  status?: "open" | "resolved" | "dismissed";
  /** Stable key used to converge repeated reports of the same operational problem. */
  dedupeKey?: string;
  action?: { kind: "open_settings" | "open_project" | "open_conversation" | "open_agent" | "open_decision"; targetId?: string };
  title: string;
  body: string;
  createdAt: string;
  readAt?: string;
  resolvedAt?: string;
  decision?: Pick<DecisionDto, "id" | "mode" | "options" | "allowOther" | "status" | "runtimeAction">;
  /** Human-facing recovery context for one current coordination problem. */
  resolution?: {
    kind: "coordination_request";
    traceId: string;
    requestId: string;
    recipientAgentId: string;
    recipientTitle: string;
    assignment: string;
    outcome: string;
    retryAvailable: boolean;
  };
}

export interface RetryCoordinationRequestResponse {
  requestIds: string[];
  joinId?: string;
  replayed: boolean;
  retryOfRequestId: string;
}

export type DecisionMode = "approval" | "choice" | "text";
export interface DecisionOptionDto { id: string; label: string; description?: string }
export interface DecisionDto {
  id: string;
  projectId: string;
  conversationId?: string;
  agentId: string;
  runId: string;
  /** Authoritative V3 scheduler Run that created the Decision. */
  coordinationRunId?: string;
  mode: DecisionMode;
  question: string;
  context?: string;
  options: DecisionOptionDto[];
  allowOther: boolean;
  /** Correlated questions intentionally suspended while this blocking Decision
   * is pending. Server-owned; provider input cannot supply this lineage. */
  continuationRequestIds?: string[];
  blocking: boolean;
  /** A live provider request that must be answered through the server-owned
   * runtime bridge. Sensitive URLs and submitted fields are never persisted. */
  runtimeAction?: {
    kind: "mcp_elicitation";
    mode: "url" | "form" | "openai/form";
    serverName: string;
  };
  /** Server-owned destructive authorization scope. Provider-authored Decisions
   * never populate this field. */
  approvalScope?: {
    kind: "agent_management";
    planId: string;
    operationKinds: Array<"delete_agent" | "set_manager">;
    targetAgentIds: string[];
    previewHash?: string;
    scopeHash: string;
  };
  status: "pending" | "resolved" | "cancelled";
  response?: { optionId?: string; text?: string; respondedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface ResolveDecisionRequest {
  optionId?: string;
  text?: string;
  /** Ephemeral provider form content. The server forwards this to the waiting
   * runtime request and deliberately excludes it from the Decision record. */
  content?: unknown;
}

export type RuntimeElicitationActionDto =
  | {
      decisionId: string;
      mode: "url";
      serverName: string;
      message: string;
      url: string;
    }
  | {
      decisionId: string;
      mode: "form" | "openai/form";
      serverName: string;
      message: string;
      requestedSchema: Record<string, unknown>;
    };

export interface WebPushSubscriptionDto {
  deviceId: string;
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  updatedAt: string;
}

export interface WebPushStatusDto {
  configured: boolean;
  configuration: "active" | "missing" | "invalid";
  publicKey?: string;
  /** Safe operator-facing diagnostic; never contains key material. */
  detail?: string;
  setupCommand?: string;
  /** Present when a device ID was supplied to the status request. */
  deviceRegistered?: boolean;
}

/** Current Git-backed workspace state. Execution events remain the provenance trail. */
export interface WorkspaceChangeDto {
  path: string;
  previousPath?: string;
  kind: "create" | "edit" | "delete" | "rename";
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

/** GET /api/projects/:id/workspace response. */
export interface WorkspaceStatusDto {
  projectId: string;
  isGitRepository: boolean;
  branch?: string;
  head?: string;
  generatedAt: string;
  changes: WorkspaceChangeDto[];
}

/** GET /api/projects/:id/workspace/file response. */
export interface WorkspaceFileReviewDto {
  projectId: string;
  path: string;
  exists: boolean;
  /** Current UTF-8 file body when it is small enough and safe to display. */
  content?: string;
  diff: string;
  stagedDiff: string;
  unstagedDiff: string;
  truncated: boolean;
}

/** Safe, user-facing resolution of a file inside one Project workspace. */
export interface WorkspaceFileViewDto {
  projectId: string;
  path: string;
  name: string;
  mediaType: string;
  size: number;
  previewable: boolean;
  text?: string;
  truncated: boolean;
  previewUrl?: string;
  downloadUrl?: string;
}

/** One ephemeral host browser bound to an exact active Run. */
export interface BrowserSessionDto {
  id: string;
  projectId: string;
  agentId: string;
  runId: string;
  conversationId?: string;
  status: BrowserSessionStatus;
  controlOwner: BrowserControlOwner;
  /** Monotonic fence for operator input. Stale tabs cannot keep typing. */
  controlEpoch: number;
  url?: string;
  title?: string;
  frameRevision: number;
  openedAt: string;
  updatedAt: string;
  failure?: string;
}

/** One operator-owned browser that persists for the lifetime of a Project. */
export interface ProjectBrowserSessionDto {
  id: string;
  projectId: string;
  status: BrowserSessionStatus;
  controlOwner: BrowserControlOwner;
  /** Present only while an exact active Run has borrowed control. */
  controllerAgentId?: string;
  controllerRunId?: string;
  controlEpoch: number;
  url?: string;
  title?: string;
  frameRevision: number;
  openedAt: string;
  updatedAt: string;
  failure?: string;
}

export interface ProjectBrowserControlRequest extends BrowserControlRequest {
  /** Required when handing control to an agent; ignored when reclaiming it. */
  agentId?: string;
}

export interface ProjectBrowserNavigateRequest {
  url: string;
}

export interface BrowserControlRequest {
  owner: BrowserControlOwner;
  expectedControlEpoch: number;
}

export type BrowserOperatorInputRequest =
  | { kind: "click"; x: number; y: number; expectedControlEpoch: number }
  | { kind: "type"; text: string; expectedControlEpoch: number }
  | { kind: "key"; key: string; expectedControlEpoch: number }
  | { kind: "scroll"; deltaX: number; deltaY: number; expectedControlEpoch: number };

// ─── Files (scoped file browser, SPEC §8/§11) ────────────────────────────────

/** One entry in a directory listing. */
export interface FileEntryDto {
  name: string;
  /** Path relative to the project's host path root. */
  path: string;
  kind: "file" | "dir";
  size?: number;
}

/**
 * GET /api/files response. Either a directory listing or a single file's content.
 * The endpoint is scoped strictly to registered project paths (AGENTS.md inv. 6).
 */
export type FilesResponse =
  | { kind: "dir"; path: string; entries: FileEntryDto[] }
  | { kind: "file"; path: string; content: string; encoding: "utf-8" | "base64" };

// ─── Health ──────────────────────────────────────────────────────────────────

/** GET /api/health response. */
export interface HealthDto {
  status: "ok";
  service: "ponderosa";
  version: string;
  /** Exact deployed source revision captured when this daemon started. */
  revision: string;
}

/** Bounded tail of one installed-engine log. */
export interface EngineLogDto {
  stream: "server" | "error";
  text: string;
  totalBytes: number;
  returnedBytes: number;
  truncated: boolean;
  updatedAt?: string;
}

export interface ReadinessCheckDto {
  ok: boolean;
  detail: string;
}

export interface NetworkSecurityPostureDto {
  mode: "loopback" | "authenticated" | "trusted_tailnet";
  /** Exact configured listener host. Never contains credentials. */
  bindHost: string;
  authenticationRequired: boolean;
  detail: string;
  warning?: string;
}

/** GET /api/ready response. Readiness is allowed to be unavailable (HTTP 503). */
export interface ReadinessDto {
  status: "ready" | "not_ready";
  service: "ponderosa";
  version: string;
  canAcceptWork: boolean;
  networkSecurity: NetworkSecurityPostureDto;
  /** Durable API intake remains available while deployment draining pauses
   * provider leasing. */
  acceptingDurableIntake: boolean;
  leasingRuns: boolean;
  deploymentDrain: {
    state: "accepting" | "draining";
    /** True only when every durable and local execution/cleanup authority has
     * reached zero; this is the deployment replacement gate. */
    readyForRestart: boolean;
    activeRuns: number;
    schedulerRuns: number;
    localRuns: number;
    providerAuthorities: number;
    browserAuthorities: number;
    pendingCleanupOperations: number;
    retainedTeardownFailures: number;
  };
  checks: {
    daemon: ReadinessCheckDto;
    dataDirectory: ReadinessCheckDto;
    projections: ReadinessCheckDto;
    /** Native descriptor/handle authority required for race-safe artifact reads. */
    artifactFilesystem: ReadinessCheckDto;
    /** Native authority that contains complete provider process trees. */
    processContainment: ReadinessCheckDto;
    runtimes: ReadinessCheckDto;
    communicationMigration: ReadinessCheckDto;
  };
  runtimes: Array<{
    id: string;
    configured: true;
    authenticated: boolean;
    available: boolean;
    detail?: string;
  }>;
}
