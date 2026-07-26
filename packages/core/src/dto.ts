// REST DTOs for the API surface (SPEC §8). These cross the UI↔server boundary and
// MUST stay JSON-serializable and free of Node-only types — apps/web imports them
// directly so the SSE/REST contract is typechecked end to end (SPEC §6, §1).

import type {
  EngineId,
  EffortOption,
  EngineModelOption,
  EngineModelValidationError,
  ModelOption,
} from "./adapter.js";
import type { AgentEvent, BrowserControlOwner, BrowserSessionStatus, TokenUsage, WorkItemStatus } from "./events.js";
import type { CommunicationDocumentReference, VerifiedCitationRecord } from "./communication.js";
import type {
  AgentLifecycleReason,
  AgentLifecycleStatus,
  AgentRunStatus,
  HistoryPageDto,
  HistoryWindowDto,
} from "./dto/common.js";
import type {
  ArtifactDto,
  ArtifactKind,
  ChangedFileDto,
  ImageAttachmentDto,
} from "./dto/artifacts.js";
import type {
  ProviderInputSourceManifest,
} from "./dto/provider-engine.js";
import type {
  AgentPresetDto,
  ProjectDto,
  ProjectSort,
} from "./dto/projects.js";
import type {
  CreateTriggerRequest,
} from "./dto/triggers.js";
import type {
  AgentDto,
  AgentState,
} from "./dto/agents.js";
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
  decision?: Pick<DecisionDto, "id" | "mode" | "options" | "allowOther" | "status">;
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

export interface ResolveDecisionRequest { optionId?: string; text?: string }

export type WorkspaceEvent =
  | { type: "preferences_updated"; preferences: WorkspacePreferencesDto }
  | { type: "project_changed"; projectId: string; action: "created" | "updated" | "deleted" | "used" }
  | { type: "conversation_changed"; projectId: string; conversationId: string; action: "created" | "updated" | "deleted" | "used" | "message" }
  | { type: "draft_changed"; conversationId: string; revision: number; cleared: boolean }
  | { type: "draft_conflict"; conversationId: string; revision: number }
  | { type: "notification_changed"; notificationId?: string; conversationId?: string; action: "created" | "updated" | "read" | "cleared" }
  | { type: "queued_message_changed"; conversationId: string; deliveryId: string; action: "queued" | "edited" | "steered" | "cancelled" | "started" }
  | { type: "message_delivery_changed"; /** Absent on legacy persisted events. */ projectId?: string; agentId: string; conversationIds?: string[] }
  | { type: "coordination_changed"; projectId: string; agentId: string }
  | { type: "trigger_changed"; projectId: string; agentId: string; triggerId: string; action: "created" | "updated" | "deleted" | "occurrence" }
  | { type: "usage_changed"; projectId: string; agentId: string; conversationIds: string[]; seq: number; executionId?: string }
  | { type: "agent_event"; projectId: string; agentId: string; conversationIds: string[]; seq: number; eventType: string; category: "lifecycle" | "message" | "task" | "artifact" | "file" | "state" | "usage"; executionId?: string }
  | { type: "runtime_capabilities_changed"; projectId: string; engineId: EngineId }
  | { type: "push_subscription_changed"; deviceId: string; action: "upserted" | "deleted" }
  | { type: "push_delivery_changed"; notificationId: string; deviceId: string; action: "delivered" | "retry_scheduled" | "abandoned" };

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

export interface WorkspaceEventEnvelope {
  id: number;
  ts: string;
  event: WorkspaceEvent;
  replayed?: boolean;
}

/** Stream identity and high-water mark, sent before replay on every connection. */
export interface WorkspaceStreamStatusDto {
  instanceId: string;
  cursor: number;
  reset: boolean;
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

// ─── Conversations ────────────────────────────────────────────────────────────

/** A model-agnostic project conversation that can include many agents. */
export interface ConversationDto {
  id: string;
  projectId: string;
  title: string;
  defaultEngine?: EngineId;
  defaultModel?: string;
  defaultEffort?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Present only on a deletion-surviving audit identity with no live authority. */
  deletedAt?: string;
}

/** POST /api/projects/:id/conversations body. */
export interface CreateConversationRequest {
  title: string;
  defaultEngine?: EngineId;
  defaultModel?: string;
  defaultEffort?: string;
}

/** PATCH /api/conversations/:id body. */
export interface UpdateConversationRequest {
  title?: string;
  defaultEngine?: EngineId | null;
  defaultModel?: string | null;
  defaultEffort?: string | null;
  archived?: boolean;
}

/** Compact execution-scoped file provenance shown beside an agent response. */
export interface ResponseFileActivityDto {
  path: string;
  kind: "create" | "edit" | "delete";
  status: "in_progress" | "completed";
  /** Sequence of the latest canonical file_change event for this path and Run. */
  sourceSeq: number;
  /** Canonical persisted Artifact projection for the source event, when available. */
  artifactId?: string;
  /** Distinguishes a downloadable generated result from an execution diff. */
  artifactKind?: ArtifactKind;
  /** True only when the persisted artifact contains a focused textual diff. */
  previewable: boolean;
  /** Unified-diff line totals when the engine supplied a textual diff. */
  additions?: number;
  deletions?: number;
}

export interface AgentMentionBindingDto {
  /** Display handle captured when the message was authored. */
  handle: string;
  /** Immutable recipient identity used to resolve its current name. */
  agentId: string;
}

/** A message in the project-level conversation (a team group chat). */
export interface ConversationMessageDto {
  id: string;
  /** Canonical cross-surface event identity, absent only on pre-migration history. */
  communicationEventId?: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  /** Immutable server traversal key used to merge tied-timestamp history pages. */
  canonicalOrderKey?: string;
  /**
   * The agent (agent) that authored this message, when it came from an agent
   * reporting back into the group chat (finished/stuck). Absent for the manager's
   * own messages.
   */
  authorAgentId?: string;
  /** Stable recipients bound to the #handles captured in the authored text. */
  agentMentions?: AgentMentionBindingDto[];
  attachments?: ImageAttachmentDto[];
  document?: CommunicationDocumentReference;
  citations?: VerifiedCitationDto[];
  executionId?: string;
  fileActivity?: ResponseFileActivityDto[];
  correctionOfMessageId?: string;
  correctedByMessageId?: string;
  /** Latest append-only edit projected under this message's stable identity. */
  editedAt?: string;
  editRevision?: number;
  /** Durable per-recipient delivery evidence for operator-authored messages. */
  deliveryReceipts?: MessageDeliveryReceiptDto[];
}

export type MessageDeliveryReceiptState =
  | "queued"
  | "steering"
  | "started"
  | "delivered"
  | "processed"
  | "unconfirmed"
  | "waiting_for_run"
  | "recovery_queued"
  | "recovering"
  | "recovered"
  | "undelivered"
  | "failed"
  | "cancelled";

/** Operational receipt; the authored Communication remains immutable. */
export interface MessageDeliveryReceiptDto {
  activationId: string;
  targetAgentId: string;
  state: MessageDeliveryReceiptState;
  updatedAt: string;
  /** Number of durable attempts for this message/recipient pair. */
  attemptCount: number;
  /** Only the latest terminal attempt may be retried. */
  canRetry?: true;
  /** The provider may have received this attempt despite missing acknowledgement. */
  retryMayDuplicate?: true;
  injectionId?: string;
  recoveryAt?: string;
  canLetCurrentRunFinish?: boolean;
  recoveryActivationId?: string;
}

export interface CancelMessageDeliveryRequest {
  idempotencyKey: string;
}

export interface CancelMessageDeliveryResponse {
  cancelled: boolean;
  replayed: boolean;
  state: "cancelled" | "not_cancellable";
  targetAgentId?: string;
}

export interface LetCurrentRunFinishRequest {
  idempotencyKey: string;
}

export interface LetCurrentRunFinishResponse {
  accepted: boolean;
  replayed: boolean;
  state: "waiting_for_run" | "recovery_queued" | "not_recoverable";
}

export interface RetryMessageDeliveryRequest {
  idempotencyKey: string;
}

export type RetryMessageDeliveryRejectionReason =
  | "not_found"
  | "stale_attempt"
  | "not_terminal"
  | "not_operator_message"
  | "recipient_unavailable";

export interface RetryMessageDeliveryResponse {
  accepted: boolean;
  replayed: boolean;
  state: "queued" | "not_retryable";
  activationId?: string;
  targetAgentId?: string;
  retryMayDuplicate?: true;
  rejectionReason?: RetryMessageDeliveryRejectionReason;
}

/** Engine-agnostic citation metadata emitted only after edge normalization/verification. */
export type VerifiedCitationDto = VerifiedCitationRecord;

/** Authenticated, short-lived browser registration for one loopback app origin. */
export interface CreateLinkPreviewRequest {
  url: string;
  projectId: string;
  agentId: string;
  runId: string;
  conversationId?: string;
}

export interface LinkPreviewDto {
  id: string;
  /** Same-origin Ponderosa URL; never exposes proxy credentials to the target app. */
  openUrl: string;
  targetOrigin: string;
  expiresAt: string;
}

/** The two communication projections available for one project conversation. */
export type ConversationChannel = "main" | "collaboration";

/** The private, opt-in agent-collaboration projection. */
export interface CollaborationViewDto {
  messages: ConversationMessageDto[];
  agents: AgentDto[];
  operations?: TeamOperationalEventDto[];
  history?: HistoryWindowDto;
  /** Team operational activity is paged independently from human messages. */
  operationHistory?: HistoryWindowDto;
}

export interface TeamOperationalEventDto {
  id: string;
  kind: "run" | "activation" | "request" | "join" | "trigger" | "decision" | "organization";
  state: string;
  text: string;
  agentIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** One canonical record shown in the read-only Agent work inspector. */
export interface AgentWorkItemDto {
  /** Namespaced stable identifier, for example `request:<uuid>`. */
  id: string;
  recordId: string;
  /** Alternate canonical references that may open this item (for example a scheduler Run ID). */
  referenceIds: string[];
  kind: "request" | "join" | "activation" | "run" | "trigger" | "decision";
  state: string;
  title: string;
  summary: string;
  agentIds: string[];
  /** Request roles remain explicit even when requester and recipient match. */
  requesterAgentId?: string;
  recipientAgentId?: string;
  /** Other canonical records structurally connected to this record. */
  relatedItemIds: string[];
  /** Loaded on demand so the summary projection stays lightweight. */
  details?: Array<{ label: string; value: string }>;
  createdAt: string;
  updatedAt: string;
}

/** A connected component of canonical coordination records. */
export interface AgentWorkTraceDto {
  id: string;
  state: "active" | "attention" | "finished";
  title: string;
  summary: string;
  agentIds: string[];
  itemIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** GET /api/projects/:id/agent-work response. This is a projection only. */
export interface AgentWorkInspectorDto {
  projectId: string;
  conversationId?: string;
  agentId?: string;
  generatedAt: string;
  /** True when the bounded relationship expansion omitted older connected records. */
  truncated?: boolean;
  agents: Array<{ id: string; title: string }>;
  traces: AgentWorkTraceDto[];
  items: AgentWorkItemDto[];
}

/** Technical fields for one canonical Agent work record. */
export interface AgentWorkItemDetailsDto {
  projectId: string;
  itemId: string;
  recordId: string;
  details: Array<{ label: string; value: string }>;
}

/** GET /api/conversations/:id response. */
export interface ConversationDecisionEventDto {
  kind: "decision" | "decision_response";
  id: string;
  createdAt: string;
  /** Canonical Decision state that owns this timeline event. */
  decision: DecisionDto;
}

export interface ConversationDetailDto {
  conversation: ConversationDto;
  messages: ConversationMessageDto[];
  agents: AgentDto[];
  /** Canonical Decision events for this Chat; they are not Communications. */
  decisionEvents?: ConversationDecisionEventDto[];
  history?: HistoryWindowDto;
}

/** POST /api/conversations/:id/messages body. */
export interface CreateConversationMessageRequest {
  role?: "user" | "assistant" | "system";
  text: string;
  attachments?: ImageAttachmentDto[];
  /** Stable across transport retries; absent is accepted for legacy clients. */
  idempotencyKey?: string;
}

/** POST /api/conversations/:id/collaboration/messages body. */
export interface CreateCollaborationMessageRequest {
  text: string;
  /** Stable IDs resolved by the client; display handles are never routing input. */
  recipientAgentIds: string[];
  /** Target-owned asset copies for safe delivery to each addressed runtime. */
  recipientAttachments?: Array<{ agentId: string; attachmentIds: string[] }>;
  /** Stable across transport retries so a collaboration message is appended once. */
  idempotencyKey?: string;
}

/** POST collaboration message response; recipients are the immutable resolved audience. */
export interface CreateCollaborationMessageResponse {
  message: ConversationMessageDto;
  audience: "mention" | "everyone";
  notifiedAgentIds: string[];
}

export interface CreateMultiAgentDirectMessageRequest {
  text: string;
  recipients: Array<{ agentId: string; attachmentIds?: string[] }>;
  /** Stable across retries; one user action creates one message and N deliveries. */
  idempotencyKey: string;
  activeRunDelivery?: "steer" | "queue";
}

export interface MultiAgentDirectMessageResponse {
  messageId: string;
  replayed: boolean;
  recipients: Array<{ agentId: string; queued: boolean; deliveryId?: string; state?: "queued" | "steered" | "started" }>;
}

export interface QueuedConversationMessageDto {
  deliveryId: string;
  messageId: string;
  conversationId: string;
  targetAgentId: string;
  text: string;
  position: number;
  createdAt: string;
  status: "queued" | "cancelled";
  cancelledAt?: string;
}

export interface CancelQueuedMessageRequest {
  /** Stable across retries so a repeated cancellation returns the same outcome. */
  idempotencyKey: string;
}

export interface CancelQueuedMessageResponse {
  cancelled: boolean;
  replayed: boolean;
  status: "cancelled" | "delivery_started";
}

export interface EditQueuedMessageRequest {
  text: string;
  /** Stable across retries so repeated saves cannot apply conflicting edits. */
  idempotencyKey: string;
}

export interface EditQueuedMessageResponse {
  edited: boolean;
  replayed: boolean;
  status: "edited" | "delivery_started";
}

export interface SteerQueuedMessageRequest {
  /** Stable across retries so repeated clicks cannot create extra steering work. */
  idempotencyKey: string;
}

export interface SteerQueuedMessageResponse {
  steered: boolean;
  replayed: boolean;
  status: "steered" | "delivery_started";
}

export interface CancelAgentRunRequest {
  /** Exact Run observed by the caller. A successor Run is never cancelled. */
  targetRunId: string;
  /** Stable across retries so a repeated stop cannot append another lifecycle event. */
  idempotencyKey: string;
}

export interface CancelAgentRunResponse {
  cancelled: boolean;
  replayed: boolean;
}

export interface CorrectConversationMessageRequest {
  text: string;
  idempotencyKey: string;
  /** Directed corrections queue; passive Broadcast edits never redeliver. */
  activeRunDelivery?: "queue";
}

export interface CorrectConversationMessageResponse {
  originalMessageId: string;
  correctionMessageId: string;
  replayed: boolean;
  queued: boolean;
}

// ─── Messages / Runs / Work items / Artifacts ────────────────────────────────

/** A Chat-pane message (SPEC §7 `messages`). Intent/conversation only. */
export interface MessageDto {
  id: string;
  /** Canonical cross-surface event identity, absent only on pre-migration history. */
  communicationEventId?: string;
  /** Immutable Project-chat scope of the canonical communication, when present. */
  conversationId?: string;
  agentId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** Stable agent author for explicit agent communication shown in this audit. */
  authorAgentId?: string;
  /** Stable recipients bound to the #handles captured in the authored text. */
  agentMentions?: AgentMentionBindingDto[];
  /** Originating provider execution for agent-authored communication. */
  executionId?: string;
  attachments?: ImageAttachmentDto[];
  document?: CommunicationDocumentReference;
  citations?: VerifiedCitationDto[];
  /** Durable per-recipient delivery evidence for operator-authored messages. */
  deliveryReceipts?: MessageDeliveryReceiptDto[];
}

/** Structural reason one Run was activated; never inferred from message text. */
export type AgentRunWakeCause =
  | "project_request"
  | "direct_message"
  | "collaboration"
  | "trigger"
  | "decision"
  | "managed_failure";

/** One canonical execution of an Agent. */
export interface AgentRunDto {
  id: string;
  agentId: string;
  title: string;
  status: AgentRunStatus;
  reason: AgentLifecycleReason;
  engine: EngineId;
  model?: string;
  effort?: string;
  communicationEventId?: string;
  wakeCause?: AgentRunWakeCause;
  /** Provider-reported usage. Missing means the run was not metered, never zero. */
  usage?: TokenUsage;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Hash and sources of the exact text Ponderosa submitted to the provider. */
  providerInput?: {
    promptHash: string;
    sourceManifest: ProviderInputSourceManifest;
    exactPromptAvailable: true;
  };
}

/** Optional engine-reported progress inside a Run; never a Run itself. */
export interface WorkItemDto {
  id: string;
  agentId: string;
  executionId?: string;
  title: string;
  status: WorkItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ContextRolloverTriggeredEvent {
  type: "context_rollover_triggered";
  executionId: string;
  usedTokens: number;
  threshold: number;
}

export type AgentActivityEvent = Extract<AgentEvent, {
  type: "command" | "file_change" | "test_result" | "tool_call" | "tool_result" | "error" |
    "browser_session" | "browser_action" | "browser_console" | "browser_screenshot";
}> | ContextRolloverTriggeredEvent;

/** Canonical, refresh-safe execution activity projected from the agent event log. */
export interface AgentActivityDto {
  id: string;
  agentId: string;
  executionId?: string;
  seq: number;
  createdAt: string;
  event: AgentActivityEvent;
  /** Structured proof that a tool result is a bounded preview, with an exact
   * authorized retrieval route for the immutable canonical event. */
  outputPreview?: {
    truncated: true;
    previewUtf8Bytes: number;
    totalUtf8Bytes: number;
    sha256: string;
    retrievalUrl: string;
  };
}

export interface AgentActivityOutputDto {
  agentId: string;
  activityId: string;
  seq: number;
  /** One UTF-8-aligned immutable page, never the unbounded canonical payload. */
  output: string;
  pageUtf8Bytes: number;
  startUtf8Byte: number;
  endUtf8Byte: number;
  totalUtf8Bytes: number;
  sha256: string;
  nextCursor?: string;
}

export type AgentTelemetryStream = "runOutput" | "activity" | "changedFiles" | "runs" | "workItems" | "artifacts";

export type AgentTelemetryPageDto =
  | ({ stream: "runOutput" } & HistoryPageDto<RunOutputDto>)
  | ({ stream: "activity" } & HistoryPageDto<AgentActivityDto>)
  | ({ stream: "changedFiles" } & HistoryPageDto<ChangedFileDto>)
  | ({ stream: "runs" } & HistoryPageDto<AgentRunDto>)
  | ({ stream: "workItems" } & HistoryPageDto<WorkItemDto>)
  | ({ stream: "artifacts" } & HistoryPageDto<ArtifactDto>);

export interface AgentOutputEvent {
  type: "agent_output";
  executionId: string;
  text: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
}

export type AgentExecutionDeltaEvent =
  | (Extract<AgentEvent, { type: "text" }> & { executionId?: string })
  | (Extract<AgentEvent, { type: "reasoning" }> & { executionId?: string });

export interface RunOutputDto {
  id: string;
  agentId: string;
  executionId: string;
  kind: "response" | "reasoning";
  text: string;
  completed: boolean;
  seq: number;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: string;
  /** Canonical file changes attributed to this exact Run, never a working-tree snapshot. */
  fileActivity?: ResponseFileActivityDto[];
}

export interface AgentCoordinationV3Dto {
  availability: "running" | "runnable" | "waiting" | "idle";
  requests: Array<{
    id: string;
    direction: "outbound" | "inbound";
    counterpartyAgentId?: string;
    state: string;
    version: number;
    deadlineAt?: string;
    updatedAt: string;
  }>;
  joins: Array<{
    id: string;
    mode: "all" | "any" | "quorum";
    wakePolicy: "each_result" | "final_only";
    quorum: number;
    state: "open" | "satisfied" | "impossible" | "expired" | "cancelled";
    completed: number;
    total: number;
    deadlineAt?: string;
    updatedAt: string;
  }>;
  activations: Array<{
    id: string;
    kind: string;
    priority: number;
    state: string;
    createdAt: string;
  }>;
  activeRun?: {
    id: string;
    status: string;
    fencingToken: number;
    promptInjectionState: "not_injected" | "injecting" | "injected";
    providerContextDisposition: "fresh_task" | "continued_session" | "reseeded";
    leaseExpiresAt: string;
  };
}

/**
 * GET /api/agents/:id — the full agent view. Chat contains only explicit
 * communications; Work log contains execution-scoped ordinary output.
 */
export interface AgentDetailDto {
  agent: AgentDto;
  messages: MessageDto[];
  runOutput: RunOutputDto[];
  activity: AgentActivityDto[];
  changedFiles: ChangedFileDto[];
  runs: AgentRunDto[];
  /** Sum of authoritative finalized Run intervals. Active Runs and idle wall time are excluded. */
  finalizedWorkDurationMs?: number;
  coordinationV3?: AgentCoordinationV3Dto;
  workItems: WorkItemDto[];
  artifacts: ArtifactDto[];
  state: AgentState;
  /** Every execution stream advances independently; loading old activity must
   * not rehydrate or widen unrelated Runs, files, or results. */
  telemetryHistory?: Partial<Record<AgentTelemetryStream, HistoryWindowDto>>;
  history?: HistoryWindowDto;
}

// ─── Messaging / runs ────────────────────────────────────────────────────────

/** POST /api/agents/:id/messages body — send a user turn. */
export interface SendMessageRequest {
  text: string;
  /** Stable across an exact transport retry so long-text artifact publication is idempotent. */
  idempotencyKey?: string;
  attachmentIds?: string[];
  model?: string;
  effort?: string;
  /** Set by a conversation client when this turn originated in that room. */
  sourceChannel?: "main";
  /** A plain Conversation request is shared context while still starting this agent. */
  shareWithOrganization?: boolean;
  /** Membership used for this main-chat turn; omitted by direct/legacy callers. */
  sourceConversationId?: string;
  /**
   * How a direct message should be delivered if this agent has an active turn.
   * Steering is the interactive default; queueing is always an explicit user choice.
   */
  activeRunDelivery?: "steer" | "queue";
}

/** POST /api/agents/:id/messages response when a turn starts immediately. */
export interface StartedMessageResponse {
  queued: false;
  runId: string;
  /** Which path started: fresh session (`seed`) or resumed (`continue`). */
  mode: "seed" | "continue" | "steer";
  /** True when the message was accepted by the already-active engine turn. */
  steered?: boolean;
  communicationEventId?: string;
}

/** POST /api/agents/:id/messages response when another turn is still active. */
export interface QueuedMessageResponse {
  queued: true;
  /** One-based position among follow-ups waiting for this agent. */
  position: number;
  communicationEventId?: string;
}

/** A message either starts now or is accepted into the per-agent FIFO queue. */
export type SendMessageResponse = StartedMessageResponse | QueuedMessageResponse;

/** Internal source/projection channel after the server has routed an intent. */
export type AgentMessageChannel = "individual" | "main" | "collaboration";

interface AgentMessageRequestBase {
  text: string;
  /** Exact prompt-injection fence supplied by the latest steering prompt. */
  steeringInjectionId?: string;
  /** Optional long-form Markdown; `text` remains the concise scoped summary. */
  document?: { title: string; content: string; mediaType?: "text/markdown" };
  /** External sources are normalized into canonical citation metadata at the server edge. */
  citations?: Array<{ url: string; title: string }>;
  /** Stable across a transport retry so every durable effect occurs once. */
  idempotencyKey?: string;
}

/** POST /api/agent-messages body. The server derives the author from the capability. */
export type SendAgentMessageRequest = AgentMessageRequestBase & (
  | { intent?: undefined; recipientAgentIds?: never }
  | { intent: "broadcast"; recipientAgentIds?: never }
  | { intent: "direct_to_user"; recipientAgentIds?: never }
  | {
      intent: "collaboration";
      /** Stable agent IDs; display handles are presentation only. Must be non-empty. */
      recipientAgentIds: string[];
      /** Urgent collaboration may steer; ordinary collaboration queues. */
      urgency?: "ordinary" | "urgent";
    }
);

export interface CommunicationDocumentContentDto extends CommunicationDocumentReference {
  content: string;
}

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
    /** Linux procfs descriptor bridge required for race-safe artifact reads. */
    artifactFilesystem: ReadinessCheckDto;
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

// ─── Global chat search ─────────────────────────────────────────────────────

export interface GlobalChatTargetDto {
  kind: "conversation" | "agent";
  id: string;
  title: string;
}

export interface GlobalChatSearchAuthorDto {
  kind: "user" | "agent" | "system";
  label: string;
  agentId?: string;
}

export interface SearchHighlightRangeDto {
  start: number;
  length: number;
}

/** One human-facing message match from a rebuildable communication projection. */
export interface GlobalChatSearchResultDto {
  project: Pick<ProjectDto, "id" | "label">;
  chat: GlobalChatTargetDto;
  messageId: string;
  communicationEventId?: string;
  author: GlobalChatSearchAuthorDto;
  timestamp: string;
  snippet: string;
  highlights: SearchHighlightRangeDto[];
  unread: boolean;
}

export interface RecentGlobalChatDto {
  project: Pick<ProjectDto, "id" | "label">;
  chat: GlobalChatTargetDto;
  lastActivityAt: string;
  snippet?: string;
  unreadCount: number;
}

/** GET /api/search?q= response. Empty queries return unread messages + recent chats. */
export interface GlobalChatSearchResponseDto {
  query: string;
  results: GlobalChatSearchResultDto[];
  recentChats: RecentGlobalChatDto[];
  scannedMessages: number;
  truncated: boolean;
}

// ─── Messages ───────────────────────────────────────────────────────────────────────

export type AllChatSourceDto =
  | { kind: "project" | "team"; conversationId: string; title: string }
  | { kind: "agent"; agentId: string; title: string };

/** One canonical authored communication in the workspace-wide aggregate view. */
export interface AllChatItemDto {
  communicationEventId: string;
  messageId: string;
  project: Pick<ProjectDto, "id" | "label">;
  source: AllChatSourceDto;
  author: GlobalChatSearchAuthorDto;
  text: string;
  createdAt: string;
  /** Present only when this source item determines one exact active DM target. */
  directMessageAgent?: Pick<AgentDto, "id" | "title">;
}

/** One canonical Decision event projected into the workspace-wide aggregate timeline. */
export interface AllChatDecisionEventDto {
  kind: "decision" | "decision_response";
  id: string;
  createdAt: string;
  decision: DecisionDto;
  project: Pick<ProjectDto, "id" | "label">;
  source: { kind: "project"; conversationId: string; title: string };
}

/** GET /api/all-chat response. Canonical items are oldest-first for timeline prepend. */
export interface AllChatPageDto {
  items: AllChatItemDto[];
  decisions?: AllChatDecisionEventDto[];
  history: HistoryWindowDto;
}

export * from "./dto/common.js";

export * from "./dto/artifacts.js";

export * from "./dto/provider-engine.js";

export * from "./dto/projects.js";

export * from "./dto/triggers.js";

export * from "./dto/agents.js";
