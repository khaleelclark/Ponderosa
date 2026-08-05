import type {
  AssetDto,
  CommunicationActor,
  CommunicationAudience,
  CommunicationIntent,
  CoordinationJoinMode,
  CoordinationJoinState,
  CoordinationJoinWakePolicy,
  CoordinationReplyAuthority,
  CoordinationRequestState,
  CoordinationRequestUpdateKind,
  RequestLifetime,
  TriggerRunBudgetDto,
  TriggerOccurrenceState,
  TriggerSourceConfig,
  TriggerSourceKind,
} from "@ponderosa/core";

export type Actor = { kind: "agent" | "user" | "system" | "supervisor"; id?: string };

export interface RunAuthorizationV3 {
  runId: string;
  agentId: string;
  fencingToken: number;
}

export interface CoordinateV3Input {
  projectId: string;
  /** Team Chat authorization boundary. Provider-authored coordination must set this. */
  conversationId?: string;
  requesterAgentId?: string;
  actorScope: string;
  idempotencyKey: string;
  /** Server-derived authorization to bind one operator retry to the exact
   * terminal context-rollover handoff owned by the original Request. */
  rolloverRecoveryForRequestId?: string;
  /** Required for provider-authored mutations. Checked in the same SQLite
   * transaction as the mutation so cancellation cannot race authorization. */
  runAuthorization?: RunAuthorizationV3;
  requests: Array<{
    requestId?: string;
    recipientAgentId: string;
    lifetime: RequestLifetime;
    communicationEventId?: string;
    payload?: unknown;
    /** Server-derived canonical reply route inherited by requester continuations. */
    replyAuthority?: CoordinationReplyAuthority;
  }>;
  join?: {
    id?: string;
    mode: CoordinationJoinMode;
    quorum?: number;
    satisfyingOutcomes?: CoordinationRequestState[];
    wakePolicy?: CoordinationJoinWakePolicy;
    deadlineAt?: string;
    requestIds?: string[];
    /** Server-derived inbound requests that this join suspends and resumes. */
    continuationRequestIds?: string[];
  };
}

export interface CoordinateV3Result {
  requestIds: string[];
  joinId?: string;
  replayed: boolean;
}

export interface UpdateRequestV3Input {
  requestId: string;
  updateId: string;
  kind: CoordinationRequestUpdateKind;
  actor: Actor;
  /** Provider-authored updates may only target requests attached to this Run. */
  runAuthorization?: RunAuthorizationV3;
  inReplyToUpdateId?: string;
  payload?: unknown;
  artifacts?: RuntimeArtifactInputV3[];
  now?: string;
}

export interface RequestUpdateV3Result {
  requestId: string;
  state: CoordinationRequestState;
  version: number;
  replayed: boolean;
}

export interface CoordinationRequestV3View {
  id: string;
  projectId: string;
  conversationId?: string;
  requesterAgentId?: string;
  recipientAgentId: string;
  state: CoordinationRequestState;
  version: number;
  payload: unknown;
}

export interface CoordinationRequestDeliveryView {
  requestId: string;
  recipientAgentId: string;
  requestState: CoordinationRequestState;
  deliveryState:
    | "queued_for_next_run"
    | "queued_behind_active_run"
    | "attached_to_run"
    | "delivered_to_run"
    | "request_terminal"
    | "delivery_failed"
    | "delivery_uncertain"
    | "delivery_cancelled";
  interruptsActiveRun: false;
}

export interface SchedulerLease {
  runId: string;
  projectId: string;
  agentId: string;
  scopeKey: string;
  fencingToken: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  injectionId: string;
  activationIds: string[];
  activations: Array<{
    id: string;
    kind: string;
    priority: number;
    dispatchPolicy: ActivationDispatchPolicy;
    promptClass: ActivationPromptClass;
    payload: unknown;
    deliveryFailures: number;
    lastDeliveryError?: string;
  }>;
}

export type ActivationDispatchPolicy = "steer_or_run" | "next_run";

export type ActivationPromptClass = "human" | "blocker" | "coordination" | "ordinary";

export type ContextRolloverState =
  | "requested"
  | "handoff_committed"
  | "session_retiring"
  | "continuation_ready"
  | "completed"
  | "failed"
  | "outcome_unknown";

export interface ContextRolloverV3 {
  id: string;
  projectId: string;
  agentId: string;
  state: ContextRolloverState;
  oldProviderSessionId: string;
  providerSessionGeneration: string;
  detectedOccupancy: number;
  aggregateTokens?: number;
  threshold: number;
  contextWindow?: number;
  lowWaterMark: number;
  lowWaterConfirmationRequired: boolean;
  sourceRunId: string;
  sourceActivationIds: string[];
  scopeKey: string;
  conversationId?: string;
  replyAuthority?: CoordinationReplyAuthority;
  handoffEventId?: string;
  continuationActivationId?: string;
  replacementSessionId?: string;
  visibleResponseCommitted: boolean;
  handoffCommittedAt?: string;
  sessionRetiringAt?: string;
  continuationReadyAt?: string;
  replacementSessionAt?: string;
  visibleResponseCommittedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export type ActivationTerminalOutcome = "recipient_unavailable" | "permanent_failure" | "retry_exhausted";

interface RuntimeCommunicationV3InputBase {
  id: string;
  projectId: string;
  scopeKey?: string;
  /** Required for provider-authored communications. */
  runAuthorization?: RunAuthorizationV3;
  artifacts?: RuntimeArtifactInputV3[];
  activation?: {
    agentId: string;
    kind: string;
    priority: number;
    dispatchPolicy: ActivationDispatchPolicy;
    promptClass: ActivationPromptClass;
    dedupeKey?: string;
  };
  activations?: Array<{
    agentId: string;
    kind: string;
    priority: number;
    dispatchPolicy: ActivationDispatchPolicy;
    promptClass: ActivationPromptClass;
    dedupeKey?: string;
  }>;
  now?: string;
}

export type RuntimeCommunicationV3Input = RuntimeCommunicationV3InputBase & (
  | { sender: CommunicationActor; intent: CommunicationIntent; audience: CommunicationAudience; payload: unknown }
  | {
      sender: Extract<CommunicationActor, { kind: "system" }>;
      intent: "managed_child_failure";
      audience: Extract<CommunicationAudience, { kind: "agents" }>;
      payload: {
        text: string;
        childAgentId: string;
        executionId: string;
        failure: string;
      };
    }
  | {
      sender: Extract<CommunicationActor, { kind: "user" }>;
      intent: "correction";
      audience: Extract<CommunicationAudience, { kind: "user_agent" | "user_agents" }>;
      payload: unknown;
    }
);

export interface RuntimeCommunicationV3Result {
  id: string;
  activationId?: string;
  activationIds?: string[];
  artifactIds?: string[];
  replayed: boolean;
}

export interface RuntimeCommunicationV3View {
  id: string;
  projectId: string;
  audience: unknown;
  payload: unknown;
  createdAt: string;
}

export interface RuntimeManagedArtifactAttachmentAuthorizationV3 {
  projectId: string;
  artifactIds: string[];
  sender: CommunicationActor;
  audience: CommunicationAudience;
}

export interface RuntimeArtifactInputV3 {
  id: string;
  role: "long_text" | "document";
  title: string;
  mediaType: "text/markdown";
  blobPath: string;
  blobHash: string;
  byteLength: number;
  originAgentId?: string;
  executionId?: string;
}

export interface RuntimeArtifactV3 extends RuntimeArtifactInputV3 {
  ownerKind: "communication" | "request_update";
  ownerId: string;
  projectId: string;
  createdAt: string;
}

/** Immutable server-owned identity resolved before scheduler mutation. */
export interface RuntimeAttachmentAuthorityV3 {
  attachment: AssetDto & { sha256: string };
  localPath: string;
  contentHash: string;
  byteLength: number;
}

export interface RuntimeAttachmentReservationBindingV3 {
  communicationId: string;
  projectId: string;
  agentId: string;
  attachmentId: string;
  contentHash: string;
  byteLength: number;
  attemptId: string;
}

/** Exact immutable ownership receipt for association rows inserted by one
 * reservation attempt. Matching rows that predated the attempt are excluded. */
export interface RuntimeAttachmentReservationReceiptV3 {
  communicationId: string;
  attemptId: string;
  bindings: readonly Readonly<RuntimeAttachmentReservationBindingV3>[];
}

/** Runtime attachment authority is deliberately richer than a lookup callback:
 * passive canonical Communications must reserve their staged assets durably
 * before the scheduler commits the Communication. */
export interface RuntimeAttachmentAuthorityProviderV3 {
  resolve(projectId: string, agentId: string, attachmentId: string): RuntimeAttachmentAuthorityV3 | undefined;
  reserveCommunication(
    communicationId: string,
    bindings: Array<{ projectId: string; agentId: string; attachmentId: string; contentHash: string; byteLength: number }>,
  ): RuntimeAttachmentReservationReceiptV3;
  compensateCommunication(receipt: RuntimeAttachmentReservationReceiptV3): void;
}

export interface RuntimeArtifactAuthorityV3 {
  artifact: RuntimeArtifactInputV3;
  localPath: string;
  contentHash: string;
  byteLength: number;
}

export interface PendingActivationV3View {
  id: string;
  projectId: string;
  agentId: string;
  kind: string;
  dispatchPolicy: ActivationDispatchPolicy;
  state: "pending" | "retry_pending";
  payload: unknown;
  createdAt: string;
}

export interface TerminalActivationV3View {
  id: string;
  projectId: string;
  agentId: string;
  kind: string;
  state: "failed" | "outcome_unknown" | "cancelled" | "consumed";
  scopeKey?: string;
  communicationEventId?: string;
  communicationIntent?: string;
  supersededByRetry?: boolean;
  outcome: ActivationTerminalOutcome;
  deliveryFailures: number;
  lastDeliveryError?: string;
  terminalAt: string;
}

export interface SettleUnavailableActivationResult {
  settled: boolean;
  replayed: boolean;
  status: "recipient_unavailable" | "not_pending";
}

export interface CoordinationWaitCycleV3 {
  agentIds: string[];
  requestIds: string[];
  oldestRequestAt: string;
}

export interface SteeringLease {
  runId: string;
  projectId: string;
  agentId: string;
  scopeKey: string;
  fencingToken: number;
  injectionId: string;
  providerSessionId?: string;
  activationIds: string[];
  activations: SchedulerLease["activations"];
}

export interface CancellationResult {
  cancelled: boolean;
  replayed: boolean;
  runId?: string;
  fencingToken?: number;
  operationId?: number;
}

export interface SteeringRecoveryDecisionResult {
  accepted: boolean;
  replayed: boolean;
  state: "waiting_for_run" | "recovery_queued" | "not_recoverable";
  agentId?: string;
}

export interface ProviderOperation {
  id: number;
  runId: string;
  operation: "interrupt";
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
}

export interface OutboxItem {
  id: number;
  activationId: string;
  eventKind: string;
  payload: unknown;
  attempts: number;
}

export interface EnqueueMessageActivationInput {
  projectId: string;
  agentId: string;
  scopeKey?: string;
  messageId: string;
  kind: "human" | "urgent" | "ordinary";
  dispatchPolicy?: ActivationDispatchPolicy;
  promptClass?: ActivationPromptClass;
  payload: unknown;
  /** Server-owned durable continuations may bypass ordinary intake backpressure. */
  bypassCapacity?: boolean;
  questionDependency?: { kind: "decision"; id: string };
  now?: string;
}

export type { TriggerOccurrenceState } from "@ponderosa/core";

export interface TriggerFilesystemBurst {
  triggerId: string;
  occurrenceKey: string;
  projectId: string;
  agentId: string;
  startedAt: string;
  lastAt: string;
  eventCount: number;
  changes: Array<{ path: string; types: string[] }>;
  droppedPathEventCount: number;
}

export interface CreateTriggerDefinitionInput {
  id?: string;
  projectId: string;
  conversationId: string;
  agentId: string;
  name: string;
  instructions: string;
  sourceKind: TriggerSourceKind;
  sourceConfig: TriggerSourceConfig;
  enabled?: boolean;
  runBudget?: TriggerRunBudgetDto;
  nextFireAt?: string;
  secretCiphertext?: string;
  secretFingerprint?: string;
  now?: string;
}

export interface UpdateTriggerDefinitionInput {
  name?: string;
  instructions?: string;
  sourceConfig?: TriggerSourceConfig;
  enabled?: boolean;
  runBudget?: TriggerRunBudgetDto | null;
  nextFireAt?: string | null;
  secretCiphertext?: string;
  secretFingerprint?: string;
  now?: string;
}

export interface RecordTriggerOccurrenceInput {
  triggerId: string;
  occurrenceKey: string;
  payload: unknown;
  provenance: { source: string; [key: string]: unknown };
  retryDelayMs?: number;
  payloadMediaType?: string;
  now?: string;
}

export interface TriggerOccurrenceResult {
  occurrenceId: string;
  state: TriggerOccurrenceState;
  activationId?: string;
  replayed: boolean;
}

export interface CoordinationV3StoreOptions {
  /** Backpressure only applies to new external/model-authored intake. Internal
   * terminal outcomes remain writable so quota pressure cannot strand work. */
  maxPendingActivationsPerAgent?: number;
  maxOutboxAttempts?: number;
  maxPendingTriggerOccurrencesPerAgent?: number;
  maxTriggerAttempts?: number;
  /** Server-owned immutable asset authority. Required whenever runtime intake
   * carries canonical attachments or dispatch snapshots. */
  attachmentAuthority?: RuntimeAttachmentAuthorityProviderV3;
  /** Server-owned managed-artifact ledger plus no-follow blob resolver. */
  artifactAuthority?: (
    projectId: string,
    artifact: RuntimeArtifactInputV3,
  ) => RuntimeArtifactAuthorityV3 | undefined;
  /** Existing managed-artifact catalog, content, and audience authority used
   * inside the Communication transaction for agent-authored attachments. */
  managedArtifactAttachmentAuthority?: (
    input: RuntimeManagedArtifactAttachmentAuthorizationV3,
  ) => void;
  /** Revalidates immutable managed bytes after the scheduler transaction has
   * committed so large reads and hashing never hold the SQLite writer fence. */
  managedArtifactAttachmentRevalidator?: (
    input: RuntimeManagedArtifactAttachmentAuthorizationV3,
  ) => void;
}
