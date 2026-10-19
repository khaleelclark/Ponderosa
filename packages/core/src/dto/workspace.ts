import { LONG_TEXT_MAX_UTF8_BYTES, unicodeCodePointLength, utf8ByteLength } from "../text-policy.js";
import type { EngineId } from "../adapter.js";
import type { SpeechPreferencesDto } from "./speech.js";
import type { AgentDto, AgentHealthDto, AgentWorkingCopyDto } from "./agents.js";
import type { BrowserControlOwner, BrowserSessionStatus } from "../events.js";
import type { AgentMentionBindingDto, ConversationDto } from "./conversations.js";
import type { HistoryWindowDto } from "./common.js";
import type { ProjectDto, ProjectSort } from "./projects.js";

/** Durable switches for the two operator-visible communication scopes. */
export interface NotificationPreferencesDto {
  directResponses: boolean;
  broadcasts: boolean;
}

export interface ChatFolderDto {
  id: string;
  name: string;
  conversationIds: string[];
  expanded: boolean;
  /** A starred folder is also shown in the Chats sidebar's Starred section. */
  starred?: boolean;
}

export interface ProjectFolderDto {
  id: string;
  name: string;
  projectIds: string[];
  expanded: boolean;
}

export interface WorkspacePreferencesDto {
  /** Absent Agent entries inherit their Chat's notification mode. */
  notificationScopes?: Record<string, "all" | "attention" | "muted">;
  /** Presentation-only, single-level Project groups in the navigation rail. */
  projectFolders?: ProjectFolderDto[];
  /** Presentation only; membership never changes a conversation's Project. */
  chatFolders?: ChatFolderDto[];
  /** Absent on pre-local-voice workspaces; resolves to browser speech. */
  speech?: SpeechPreferencesDto;
  /** Canonical monotonic preference mutation sequence. */
  revision: number;
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

export type WorkspaceDirectoryKind = "project" | "conversation" | "agent";

export interface WorkspaceProjectDirectoryItemDto {
  kind: "project";
  project: ProjectDto;
  /** Presentation-only host path. The exact authoritative path remains on `project.hostPath`. */
  displayPath: string;
  recentConversation?: Pick<ConversationDto, "id" | "title" | "updatedAt">;
  conversationCount: number;
  runningAgentCount: number;
}

/** A scalar presentation of canonical Agent health, never a second status authority.
 * Active includes working, waiting, recovery and attention states. */
export interface WorkspaceActivityCountDto {
  status: import("../workspace-activity.js").AgentDisplayStatus | "unknown";
  decisionCount: number;
  errorCount: number;
  idleCount: number;
  activeCount: number;
  runningCount: number;
  refreshingCount: number;
  waitingCount: number;
  recoveryCount: number;
  attentionCount: number;
  unknownCount: number;
  /** Oldest confirmation in the aggregate; absent if any evidence is unavailable. */
  lastConfirmedAt?: string;
}

export interface WorkspaceActivityProjectionRequestDto {
  /** At most 200 Chat IDs and 200 groups, with 10,000 group member IDs total. */
  conversationIds: string[];
  chatFolders: Array<Pick<ChatFolderDto, "id" | "conversationIds">>;
}

export interface WorkspaceActivityProjectionDto {
  conversations: Record<string, WorkspaceActivityCountDto>;
  chatFolders: Record<string, WorkspaceActivityCountDto>;
}

export interface WorkspaceConversationDirectoryItemDto {
  kind: "conversation";
  project: Pick<ProjectDto, "id" | "label" | "hostPath">;
  conversation: ConversationDto;
  /** Canonical active-work count; omitted by older servers. */
  runningAgentCount?: number;
}

export interface WorkspaceAgentDirectoryItemDto {
  kind: "agent";
  project: Pick<ProjectDto, "id" | "label" | "hostPath">;
  agent: AgentDto;
  ownerConversation?: Pick<ConversationDto, "id" | "title">;
  health: AgentHealthDto;
  /** Confirmation from the canonical health read, independent of status changes. */
  healthConfirmedAt?: string;
}

export type WorkspaceDirectoryItemDto =
  | WorkspaceProjectDirectoryItemDto
  | WorkspaceConversationDirectoryItemDto
  | WorkspaceAgentDirectoryItemDto;

export interface WorkspaceDirectoryPageDto<
  T extends WorkspaceDirectoryItemDto = WorkspaceDirectoryItemDto,
> {
  kind: T["kind"];
  /** Client-only marker: a stale continuation was transparently restarted. */
  reset?: boolean;
  /** Starred matches are returned independently and never consume the page limit. */
  starredItems: T[];
  /** Initial Chat page supplement: matching saved folder members, independent of pagination. */
  folderItems?: T[];
  items: T[];
  /** Total matching resources, including starred resources. */
  total: number;
  /** Workspace-wide active count, present for health-filtered Agent views. */
  activeCount?: number;
  /** Current health aggregate from the same summary observation as its counts. */
  activity?: WorkspaceActivityCountDto;
  /** Distinct current Agents with a leased or running scheduler Run. */
  runningCount?: number;
  history: HistoryWindowDto;
}

export type WorkspaceResourceKind =
  | "project"
  | "conversation"
  | "agent"
 ;

export interface WorkspaceResourceRecencyDto {
  resourceKey: `${WorkspaceResourceKind}:${string}`;
  kind: WorkspaceResourceKind;
  resourceId: string;
  lastUsedAt: string;
}

export interface WorkspaceResourceRecencyListDto {
  resources: WorkspaceResourceRecencyDto[];
  /** Older unstarred entries were omitted from this bounded projection. */
  truncated?: boolean;
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

export type UpdateWorkspacePreferencesRequest = Partial<Omit<WorkspacePreferencesDto, "revision" | "updatedAt">> & {
  /** Required compare-and-swap revision when replacing folder preferences. */
  projectFoldersRevision?: number;
  chatFoldersRevision?: number;
};

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
  /** Staged UTF-8 payload for extracted long paste, submitted as message text. */
  pastedTextAttachmentId?: string;
  pastedTextAttachment?: DraftAttachmentDto;
  /** Stable structural recipients captured before display handles can change. */
  mentionBindings?: AgentMentionBindingDto[];
  /** Captured intents are recovery metadata, never delivery or queue authority. */
  pendingSubmissions?: DraftPendingSubmissionDto[];
  /** Staged metadata for captured attempts, separate from editable attachments. */
  pendingSubmissionAttachments?: DraftAttachmentDto[];
  /** Server-owned retirement state. Old captures must never be restamped. */
  retiredPendingSubmissionIds?: Array<{ idempotencyKey: string; captureRevision: number }>;
  pendingSubmissionRevisionFloor?: number;
  /** Live older conflict identities exempt from bounded tombstone compaction. */
  pendingSubmissionOlderActiveIds?: string[];
  /** Exact ambiguous send authority retained until the server settles it. */
  pendingSubmission?: DraftPendingSubmissionDto;
  revision: number;
  updatedAt: string;
  clientId: string;
}

/** A rejected stale write includes the displaced text as a recoverable copy. */
export interface ConversationDraftConflictDto {
  /** Stable identity used to restore or discard exactly this displaced write. */
  id: string;
  current: ConversationDraftDto;
  displaced: Pick<ConversationDraftDto, "conversationId" | "text" | "attachmentIds" | "pastedTextAttachmentId" | "mentionBindings" | "pendingSubmission" | "pendingSubmissions" | "clientId"> & { capturedAt: string };
}

export interface DraftPendingSubmissionDto {
  /** Required for multi-capture entries: exact submitted text and original observed revision. */
  text?: string;
  editorText?: string;
  pastedText?: string;
  captureRevision?: number;
  /** SHA-256 of the exact durable content, routing, runtime, and action. */
  fingerprint: string;
  /** Pre-preparation fingerprint used to recognize the same intent on reload. */
  intentFingerprint?: string;
  idempotencyKey: string;
  /** Immutable server-bound routing selected before dispatch. */
  request?: {
    conversationId?: string;
    recipientAgentIds: string[];
    mentionBindings?: AgentMentionBindingDto[];
    broadcastAttachmentOwnerAgentId?: string;
    runtime: {
      activeRunDelivery: "steer" | "queue";
      engine?: string;
      model?: string;
      effort?: string;
      speed?: string;
    };
  };
  /** Original request assets stay immutable while conflict recovery may replace
   * the editable draft copies. */
  draftAttachmentIds?: string[];
  editableDraftAttachmentIds?: string[];
  pastedTextAttachmentId?: string;
  editablePastedTextAttachmentId?: string;
  /** Generated title bound to an Agent-creation submission before dispatch. */
  agentTitle?: string;
  /** The compound Agent-creation step committed; later work must retain this identity. */
  agentCreationCommitted?: boolean;
  /** Server asset IDs prepared before dispatch, grouped by request scope. */
  uploads?: Array<{
    scope: string;
    recipients: Array<{ agentId: string; attachmentIds: string[] }>;
  }>;
}

/** Server retirement projection shared by persistence and retained-byte readers. */
export function draftPendingSubmissionRetired(current: Pick<ConversationDraftDto,
  "retiredPendingSubmissionIds" | "pendingSubmissionRevisionFloor" | "pendingSubmissions" | "pendingSubmissionOlderActiveIds">,
  pending: Pick<DraftPendingSubmissionDto, "idempotencyKey" | "captureRevision">): boolean {
  return Boolean(current.retiredPendingSubmissionIds?.some(item => item.idempotencyKey === pending.idempotencyKey)) ||
    ((pending.captureRevision ?? 0) < (current.pendingSubmissionRevisionFloor ?? 0) &&
      !current.pendingSubmissions?.some(item => item.idempotencyKey === pending.idempotencyKey) &&
      !current.pendingSubmissionOlderActiveIds?.includes(pending.idempotencyKey));
}

/** Shared bounded draft recovery validation, also used by direct store callers. */
export function draftPendingSubmissionError(value: unknown, maxAttachmentsPerMessage: number, expectedRevision: number, captured = false): string | undefined {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const validPendingMentionBinding = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const binding = value as Record<string, unknown>;
    return !Object.keys(binding).some(key => ![
      "agentId", "handle", "projectId", "currentHandle", "currentTitle",
    ].includes(key)) && [
      binding.agentId, binding.handle, binding.projectId, binding.currentHandle, binding.currentTitle,
    ].every(field => typeof field === "string" && field.trim() && field.length <= 300);
  };

  if (!value || typeof value !== "object" ||
      Array.isArray(value)) return "invalid pending draft submission";
  const pending = value as Record<string, unknown>;
  if (Object.keys(pending).some(key => ![
    "fingerprint", "intentFingerprint", "idempotencyKey", "request", "draftAttachmentIds",
    "editableDraftAttachmentIds", "pastedTextAttachmentId", "editablePastedTextAttachmentId",
    "agentTitle", "agentCreationCommitted", "uploads", "text", "editorText", "pastedText", "captureRevision",
  ].includes(key)) ||
      [pending.text, pending.editorText, pending.pastedText].some(text => text !== undefined &&
        (typeof text !== "string" || utf8ByteLength(text) > LONG_TEXT_MAX_UTF8_BYTES)) ||
      (pending.captureRevision !== undefined && (!Number.isSafeInteger(pending.captureRevision) || Number(pending.captureRevision) < 0 || Number(pending.captureRevision) > expectedRevision)) ||
      typeof pending.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(pending.fingerprint) ||
      (pending.intentFingerprint !== undefined &&
        (typeof pending.intentFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(pending.intentFingerprint))) ||
      typeof pending.idempotencyKey !== "string" || !pending.idempotencyKey.trim() ||
      pending.idempotencyKey.length > 200 ||
      [pending.draftAttachmentIds, pending.editableDraftAttachmentIds].some(ids =>
        ids !== undefined && (!Array.isArray(ids) || ids.length > maxAttachmentsPerMessage ||
          ids.some(id => typeof id !== "string" || !uuid.test(id)) ||
          new Set(ids).size !== ids.length)) ||
      [pending.pastedTextAttachmentId, pending.editablePastedTextAttachmentId].some(id =>
        id !== undefined && (typeof id !== "string" || !uuid.test(id))) ||
      (pending.request !== undefined && (() => {
        if (!pending.request || typeof pending.request !== "object" || Array.isArray(pending.request)) return true;
        const route = pending.request as Record<string, unknown>;
        if (Object.keys(route).some(key => ![
          "conversationId", "recipientAgentIds", "mentionBindings", "broadcastAttachmentOwnerAgentId", "runtime",
        ].includes(key)) ||
            (route.conversationId !== undefined &&
              (typeof route.conversationId !== "string" || !route.conversationId || route.conversationId.length > 200)) ||
            (route.broadcastAttachmentOwnerAgentId !== undefined &&
              (typeof route.broadcastAttachmentOwnerAgentId !== "string" || !route.broadcastAttachmentOwnerAgentId ||
                route.broadcastAttachmentOwnerAgentId.length > 200)) ||
            !Array.isArray(route.recipientAgentIds) || route.recipientAgentIds.length > 100 ||
            route.recipientAgentIds.some(id => typeof id !== "string" || !id || id.length > 200) ||
            new Set(route.recipientAgentIds).size !== route.recipientAgentIds.length ||
            !route.runtime || typeof route.runtime !== "object" || Array.isArray(route.runtime)) return true;
        const runtime = route.runtime as Record<string, unknown>;
        if (Object.keys(runtime).some(key => ![
          "activeRunDelivery", "engine", "model", "effort", "speed",
        ].includes(key)) ||
            (runtime.activeRunDelivery !== "steer" && runtime.activeRunDelivery !== "queue") ||
            [runtime.engine, runtime.model, runtime.effort, runtime.speed].some(value =>
              value !== undefined && (typeof value !== "string" || value.length > 200))) return true;
        if (route.mentionBindings === undefined) return false;
        if (!Array.isArray(route.mentionBindings) || route.mentionBindings.length > 100) return true;
        return route.mentionBindings.some(binding => !validPendingMentionBinding(binding));
      })()) ||
      (pending.agentTitle !== undefined &&
        (pending.intentFingerprint === undefined ||
          typeof pending.agentTitle !== "string" || !pending.agentTitle.trim() ||
          unicodeCodePointLength(pending.agentTitle) > 200)) ||
      (pending.agentCreationCommitted !== undefined &&
        pending.agentCreationCommitted !== true)) return "invalid pending draft submission";
  if (pending.uploads !== undefined &&
      (!Array.isArray(pending.uploads) || pending.uploads.length > 4 ||
        pending.uploads.some(value => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return true;
          const upload = value as Record<string, unknown>;
          if (Object.keys(upload).some(key => !["scope", "recipients"].includes(key)) ||
              typeof upload.scope !== "string" || !upload.scope || upload.scope.length > 100 ||
              !Array.isArray(upload.recipients) || upload.recipients.length > 100) return true;
          return upload.recipients.some(value => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return true;
            const recipient = value as Record<string, unknown>;
            return Object.keys(recipient).some(key => !["agentId", "attachmentIds"].includes(key)) ||
              typeof recipient.agentId !== "string" || !recipient.agentId || recipient.agentId.length > 200 ||
              !Array.isArray(recipient.attachmentIds) ||
              recipient.attachmentIds.length > maxAttachmentsPerMessage ||
              recipient.attachmentIds.some(id => typeof id !== "string" || !uuid.test(id)) ||
              new Set(recipient.attachmentIds).size !== recipient.attachmentIds.length;
          });
        }) ||
        new Set(pending.uploads.map(value => (value as { scope: string }).scope)).size !==
          pending.uploads.length ||
        pending.uploads.some(value => {
          const recipients = (value as { recipients: Array<{ agentId: string }> }).recipients;
          return new Set(recipients.map(recipient => recipient.agentId)).size !== recipients.length;
        }))) return "invalid pending draft submission uploads";
  if (captured && (typeof pending.text !== "string" || pending.captureRevision === undefined || pending.request === undefined)) return "captured text, original revision and request are required";
  return undefined;
}

export interface RestoreConversationDraftConflictRequest {
  ownerId: string;
  expectedRevision: number;
  clientId: string;
  /** Fresh same-surface assets replacing unavailable displaced assets. */
  attachmentReplacements?: Array<{ fromId: string; toId: string }>;
  /** Displaced assets whose bytes are no longer available in this browser. */
  unavailableAttachmentIds?: string[];
}

export interface ResolveConversationDraftConflictResponse {
  conflictId: string;
  action: "restored" | "discarded";
  replayed: boolean;
  draft?: ConversationDraftDto;
  /** Latest canonical state when an idempotent replay's original result is no longer current. */
  currentDraft?: ConversationDraftDto;
  /** Durable historical-to-canonical asset mapping, stable across restore replay. */
  attachmentReplacements?: Array<{ fromId: string; toId: string }>;
  unavailableAttachmentIds?: string[];
}

export interface RestoreConversationDraftConflictUnavailableResponse {
  error: "draft conflict attachment is unavailable";
  /** Historical displaced IDs requiring replacement or explicit removal. */
  unavailableAttachmentIds: string[];
}

export interface ConversationDraftConflictListDto {
  conversationId: string;
  conflicts: ConversationDraftConflictDto[];
}

export interface PutConversationDraftRequest {
  /** Append/merge only. Omitting identities never retires them. Maximum 32 live IDs. */
  pendingSubmissions?: DraftPendingSubmissionDto[];
  /** Explicitly retire only these known identities after acceptance or deliberate discard. */
  retirePendingSubmissionIds?: string[];
  text: string;
  attachmentIds: string[];
  pastedTextAttachmentId?: string;
  mentionBindings?: AgentMentionBindingDto[];
  pendingSubmission?: DraftPendingSubmissionDto;
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
  /** Authored source for notification policy, independent of navigation target. */
  sourceAgentId?: string;
  projectId?: string;
  conversationId?: string;
  /** Current names projected on bounded notification reads, not identity. */
  projectLabel?: string;
  conversationTitle?: string;
  /** Every Project chat where the affected Agent currently participates. */
  conversationIds?: string[];
  agentId?: string;
  /** Current display title projected by notification reads; not notification identity. */
  agentTitle?: string;
  /** All Agents directly affected by this current issue. */
  agentIds?: string[];
  communicationEventId?: string;
  kind: "direct_responses" | "everyone" | "broadcasts" | "collaboration" | "operational" | "decision" | "information";
  category?: "communication" | "provider" | "coordination" | "decision" | "system";
  severity?: "info" | "attention" | "urgent";
  status?: "open" | "resolved" | "dismissed";
  /** Stable key used to converge repeated reports of the same operational problem. */
  dedupeKey?: string;
  action?: { kind: "open_settings" | "open_project" | "open_conversation" | "open_agent" | "open_decision"; targetId?: string };
  title: string;
  body: string;
  /** Bounded in-app context; never included in lock-screen push copy. */
  contextPreview?: string;
  /** Bounded evidence from the exact canonical work record, when retained. */
  workContext?: {
    kind: "request" | "join" | "activation";
    recordId: string;
    traceId?: string;
    state: string;
    occurredAt: string;
    assignment?: string;
    /** Bounded canonical work detail for in-app review, not push copy. */
    detail?: string;
  };
  createdAt: string;
  /** Durable receipt that the operator reviewed this still-open action. */
  acknowledgedAt?: string;
  /** Durable receipt that an informational authored update was seen. */
  readAt?: string;
  /** Canonical closure/dismissal time for an action that is no longer open. */
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

/** One bounded page of current operator-facing notifications. Historical
 * resolved/read rows stay durable in the workspace log but are not part of
 * this live feed. */
export interface WorkspaceNotificationPageDto {
  items: WorkspaceNotificationDto[];
  /** All unresolved actions, including actions the operator already reviewed. */
  openActionCount: number;
  /** Unresolved actions that have not yet been reviewed. */
  unacknowledgedActionCount: number;
  unreadUpdateCount: number;
  nextCursor?: string;
}

/** Exact unread counts for one canonical notification scope. */
export interface WorkspaceNotificationCountProjectionDto {
  importantCount: number;
  ordinaryCount: number;
  totalCount: number;
}

/** Exact Project counts split so Project-level attention is never described
 * as Chat activity. Chat counts dedupe notification IDs even when one
 * notification projects into several Chats. */
export interface WorkspaceProjectNotificationProjectionDto
  extends WorkspaceNotificationCountProjectionDto {
  chat: WorkspaceNotificationCountProjectionDto & { affectedConversationCount: number };
  projectLevel: WorkspaceNotificationCountProjectionDto;
}

/** A bounded request for exact server-side notification projections. Clients
 * may batch large resource catalogs; notification records never cross this
 * boundary. */
export interface WorkspaceNotificationProjectionRequestDto {
  projectIds: string[];
  conversationIds: string[];
  /** Presentation groups only; counts dedupe canonical notification identities.
   * At most 200 groups and 10,000 total member IDs per request. */
  chatFolders?: Array<Pick<ChatFolderDto, "id" | "conversationIds">>;
}

export interface WorkspaceNotificationProjectionDto {
  workspace: WorkspaceNotificationCountProjectionDto;
  allMessages: WorkspaceNotificationCountProjectionDto;
  projects: Record<string, WorkspaceProjectNotificationProjectionDto>;
  conversations: Record<string, WorkspaceNotificationCountProjectionDto>;
  chatFolders?: Record<string, WorkspaceNotificationCountProjectionDto>;
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
  /** Server-owned authorization scope. Provider-authored Decisions
   * never populate this field. */
  approvalScope?: {
    kind: "agent_management";
    planId: string;
    operationKinds: Array<"delete_agent" | "set_manager">;
    targetAgentIds: string[];
    previewHash?: string;
    scopeHash: string;
  } | {
    kind: "saved_browser";
    profileId: string;
    projectId: string;
    agentId: string;
  } | {
    kind: "artifact_publication";
    operationId: string;
    projectId: string;
    conversationId: string;
    agentId: string;
    sourcePath: string;
    filename: string;
    sha256: string;
    size: number;
    expiresAt: string;
  };
  status: "pending" | "resolved" | "cancelled";
  response?: { optionId?: string; text?: string; skipped?: true; respondedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface ResolveDecisionRequest {
  /** Explicit operator cancellation; never an answer or approval. */
  skip?: true;
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

/** GET /api/agents/:id/workspace response. */
export interface WorkspaceStatusDto {
  projectId: string;
  agentId: string;
  workingCopy: AgentWorkingCopyDto;
  isGitRepository: boolean;
  branch?: string;
  head?: string;
  generatedAt: string;
  changes: WorkspaceChangeDto[];
}

/** GET /api/agents/:id/workspace/file response. */
export interface WorkspaceFileReviewDto {
  projectId: string;
  agentId: string;
  workingCopyId: string;
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

export interface BrowserPageDto {
  id: string;
  loading?: boolean;
  title?: string;
  url?: string;
  openerPageId?: string;
  active: boolean;
  isNew: boolean;
  closable: boolean;
}

export interface BrowserPendingFileChooserDto {
  pageId: string;
  mode: "selectSingle" | "selectMultiple";
  requestedAt: string;
  expiresAt: string;
  controlOwner: BrowserControlOwner;
  controlEpoch: number;
}

export interface BrowserUploadRequest {
  artifactId: string;
  selector?: string;
  expectedControlEpoch: number;
}

export interface BrowserUploadReceiptDto {
  artifactId: string;
  displayName: string;
  mediaType: string;
  size: number;
  sha256: string;
  attachedAt: string;
}

export interface BrowserUploadResponseDto {
  session: BrowserSessionDto;
  upload: BrowserUploadReceiptDto;
}

export interface BrowserCapabilitiesDto {
  multiPage: boolean;
  fileUpload: boolean;
  /** Chrome is running in the host display service rather than headless mode. */
  hostedHeaded: boolean;
  /** The server can retain explicitly configured browser profiles. */
  persistentProfiles: boolean;
  /** Live process belongs to the independent browser service. */
  retainedAcrossAppRestart?: boolean;
  /** Responsive native window display, independent of the agent connection. */
  nativeDisplay?: boolean;
}

export type BrowserProfileMode = "disposable" | "trusted";

/** Versioned custody. Legacy namespaces locate storage; they never confer browser access. */
export type BrowserOwner = { version: 1; kind: "chat"; conversationId: string } | { version: 1; kind: "saved" };
export const CHAT_BROWSER_OWNER_PREFIX = "chat-browser:v1:";
export function chatBrowserOwnerId(conversationId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(conversationId)) throw new Error("Invalid browser Chat identity.");
  return `${CHAT_BROWSER_OWNER_PREFIX}${conversationId}`;
}
export function browserOwnerFromId(id: string): BrowserOwner | undefined {
  if (id === "saved-browser") return { version: 1, kind: "saved" };
  if (!id.startsWith(CHAT_BROWSER_OWNER_PREFIX)) return undefined;
  const conversationId = id.slice(CHAT_BROWSER_OWNER_PREFIX.length);
  return /^[a-zA-Z0-9_-]{1,160}$/u.test(conversationId) ? { version: 1, kind: "chat", conversationId } : undefined;
}
export function browserOwnerId(owner: BrowserOwner): string {
  if (owner.version !== 1) throw new Error("Unsupported browser ownership version.");
  if (owner.kind === "saved") return "saved-browser";
  if (owner.kind === "chat") return chatBrowserOwnerId(owner.conversationId);
  throw new Error("Unknown browser owner.");
}

export interface BrowserProfileDto {
  owner?: BrowserOwner;
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserAgentPreferenceDto {
  owner?: BrowserOwner;
  agentId: string;
  projectId: string;
  mode: BrowserProfileMode;
  profileId?: string;
  profileName?: string;
  updatedAt: string;
}

export interface CreateBrowserProfileRequest {
  name: string;
}

export interface UpdateBrowserProfileRequest {
  name: string;
}

export interface UpdateBrowserAgentPreferenceRequest {
  mode: BrowserProfileMode;
  profileId?: string;
}

/** One host browser bound to an exact active Run. Browser process ownership is
 * always ephemeral; only an explicitly selected trusted profile is retained. */
export interface BrowserSessionDto {
  owner?: BrowserOwner;
  nextRunAgentId?: string;
  location?: "hosted" | "local";
  localPaused?: boolean;
  manualControl?: "manual" | "connecting" | "automation";
  /** Explicit private sign-in pause; viewers must not reconnect automatically. */
  privateSignIn?: boolean;
  id: string;
  projectId: string;
  agentId: string;
  runId: string;
  conversationId?: string;
  status: BrowserSessionStatus;
  profileMode: BrowserProfileMode;
  profileId?: string;
  profileName?: string;
  /** Present while host capacity or a trusted-profile lease is queued. */
  queuePosition?: number;
  queueReason?: "host_capacity" | "profile_in_use";
  controlOwner: BrowserControlOwner;
  /** Monotonic fence for operator input. Stale tabs cannot keep typing. */
  controlEpoch: number;
  capabilities: BrowserCapabilitiesDto;
  url?: string;
  title?: string;
  activePageId?: string;
  pages: BrowserPageDto[];
  pageRevision: number;
  pendingFileChooser?: BrowserPendingFileChooserDto;
  frameRevision: number;
  openedAt: string;
  updatedAt: string;
  failure?: string;
}

/** An operator browser owned by one Chat, or the explicitly shared saved singleton. */
export interface ProjectBrowserSessionDto {
  owner?: BrowserOwner;
  profileMode?: BrowserProfileMode;
  nextRunAgentId?: string;
  location?: "hosted" | "local";
  localPaused?: boolean;
  manualControl?: "manual" | "connecting" | "automation";
  privateSignIn?: boolean;
  id: string;
  projectId: string;
  status: BrowserSessionStatus;
  controlOwner: BrowserControlOwner;
  /** Present only while an exact active Run has borrowed control. */
  controllerAgentId?: string;
  controllerAgentTitle?: string;
  controllerProjectId?: string;
  controllerRunId?: string;
  controlEpoch: number;
  capabilities: BrowserCapabilitiesDto;
  url?: string;
  title?: string;
  activePageId?: string;
  pages: BrowserPageDto[];
  pageRevision: number;
  pendingFileChooser?: BrowserPendingFileChooserDto;
  frameRevision: number;
  openedAt: string;
  updatedAt: string;
  failure?: string;
}

/** Reserved browser ownership namespace, not a chat or a user identity. */
export const SAVED_BROWSER_SCOPE_ID = "saved-browser";
export interface SavedBrowserDto {
  profileId: string;
  promotedAt: string;
}

export interface ProjectBrowserControlRequest extends BrowserControlRequest {
  /** Required when granting the instance-wide saved browser to a chat's Agent. */
  controllerProjectId?: string;
  nextRun?: boolean;
  /** Resolve current versus next Run on the server, without a client health race. */
  currentOrNext?: boolean;
  /** Required when handing control to an agent; ignored when reclaiming it. */
  agentId?: string;
}

export interface ProjectBrowserNavigateRequest {
  url: string;
}

export interface ProjectBrowserOpenRequest {
  url?: string;
  rememberSignIns?: boolean;
}

export interface BrowserControlRequest {
  owner: BrowserControlOwner;
  expectedControlEpoch: number;
}

export interface BrowserViewportSize { width: number; height: number }
export interface BrowserActivityDto {
  pageId: string;
  kind: "click" | "fill";
  x: number;
  y: number;
  width?: number;
  height?: number;
  at: number;
}
export interface BrowserFrameMetadata {
  pageId: string;
  viewport: BrowserViewportSize;
  activity?: BrowserActivityDto;
}
export type BrowserOperatorInputRequest = (
  | { kind: "click"; x: number; y: number; expectedControlEpoch: number }
  | { kind: "type"; text: string; expectedControlEpoch: number }
  | { kind: "key"; key: string; expectedControlEpoch: number }
  | { kind: "scroll"; deltaX: number; deltaY: number; expectedControlEpoch: number }) & {
    expectedPageId?: string;
    expectedViewport?: BrowserViewportSize;
  };

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
  mode: "loopback" | "authenticated" | "trusted_tailnet" | "reverse_proxy";
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
  /** Exact deployed source revision captured when this daemon started. */
  revision: string;
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
    /** Bounded, credential-free identities for authorities preventing restart. */
    blockers: Array<{
      kind: "run" | "provider" | "run_browser" | "project_browser" | "browser_residue" | "project_cleanup" | "agent_cleanup";
      reason: string;
      id?: string;
      projectId?: string;
      agentId?: string;
      runId?: string;
      sessionId?: string;
      status?: string;
    }>;
  };
  checks: {
    daemon: ReadinessCheckDto;
    dataDirectory: ReadinessCheckDto;
    projections: ReadinessCheckDto;
    /** Native descriptor/handle authority required for race-safe artifact reads. */
    artifactFilesystem: ReadinessCheckDto;
    /** Native authority that contains complete provider process trees. */
    processContainment: ReadinessCheckDto;
    /** Browser profile/upload residue awaiting durable cleanup. Diagnostic only. */
    browserResidueCleanup: ReadinessCheckDto;
    runtimes: ReadinessCheckDto;
    communicationMigration: ReadinessCheckDto;
  };
  runtimes: Array<{
    id: string;
    configured: true;
    authentication: "checking" | "authenticated" | "unauthenticated" | "error";
    intakeReady: boolean;
    reachability: "unverified" | "checking" | "reachable" | "degraded";
    detail?: string;
  }>;
}
