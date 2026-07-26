import type { EngineId } from "../adapter.js";
import type { CommunicationDocumentReference, VerifiedCitationRecord } from "../communication.js";
import type { AgentDto } from "./agents.js";
import type { ArtifactKind, ImageAttachmentDto } from "./artifacts.js";
import type { HistoryWindowDto } from "./common.js";
import type { ProjectDto } from "./projects.js";
import type { DecisionDto } from "./workspace.js";

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
