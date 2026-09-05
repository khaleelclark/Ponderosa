// @ponderosa/agents — the append-only event log + rebuildable SQLite projections
// (SPEC §4/§7). A library consumed by apps/server; exposes no HTTP. Does not import
// from packages/engines except AgentEvent (re-exported through core).

export { AgentStore, AgentDeletionConflictError } from "./store.js";
export type {
  AgentCreationArtifactIdentity,
  AgentCreationOperation,
  AgentCreationOperationStatus,
} from "./store.js";
export { normalizeAgentTitle } from "./agent-identity.js";
export { WorkspaceStore, draftRevisionConflicts } from "./workspace-store.js";
export type { PushDeliveryRecord } from "./workspace-store.js";
export { highlightedSearchSnippet, searchProjectedChatMessages } from "./chat-search.js";
export type { ProjectedChatSearchCandidate, ProjectedChatSearchOptions } from "./chat-search.js";
export {
  CompactionHistoryQueryError,
  MAX_HISTORY_EXCERPT_UTF8_BYTES,
  MAX_HISTORY_READ_MESSAGES,
  MAX_HISTORY_READ_RESPONSE_UTF8_BYTES,
  MAX_HISTORY_SEARCH_RESPONSE_UTF8_BYTES,
  MAX_HISTORY_SEARCH_RESULTS,
  MAX_CONTEXT_ROLLOVER_TAIL_MESSAGES,
  MAX_CONTEXT_ROLLOVER_TAIL_UTF8_BYTES,
  bindContextRolloverBoundary,
  hasCompactionHistory,
  indexCompactionHistoryMessage,
  normalizeCompactionHistoryQuery,
  readCompactionHistory,
  reconcileCompactionHistoryIndex,
  searchCompactionHistory,
  resolveContextRolloverTail,
} from "./compaction-history-retrieval.js";
export type {
  CompactionHistoryBoundary,
  CompactionHistoryRetrievalAudit,
  ContextRolloverBoundaryBinding,
  ContextRolloverTailBinding,
  ReadCompactionHistoryInput,
  SearchCompactionHistoryInput,
  ResolvedContextRolloverTailMessage,
} from "./compaction-history-retrieval.js";
export {
  CoordinationV3Store,
  MAX_CONTEXT_ROLLOVER_REPLACEMENT_PROVIDER_INPUT_UTF8_BYTES,
} from "./coordination-v3-store.js";
export { PendingActivationCapacityError } from "./coordination-v3-activation.js";
export { CoordinationIdempotencyConflictError } from "./coordination-v3-errors.js";
export type {
  CoordinateV3Input,
  CoordinateV3Result,
  UpdateRequestV3Input,
  RequestUpdateV3Result,
  SchedulerLease,
  SteeringLease,
  ProviderOperation,
  CancellationResult,
  RuntimeCommunicationV3Input,
  RuntimeCommunicationV3Result,
  RuntimeArtifactInputV3,
  RuntimeArtifactV3,
  RuntimeArtifactAuthorityV3,
  RuntimeAttachmentAuthorityV3,
  RuntimeAttachmentAuthorityProviderV3,
  RuntimeAttachmentReservationBindingV3,
  RuntimeAttachmentReservationReceiptV3,
  ActivationDispatchPolicy,
  ActivationPromptClass,
  ActivationTerminalOutcome,
  TerminalActivationV3View,
  CommunicationAttentionActivationCursor,
  CommunicationAttentionActivationV3View,
  CoordinationAttentionCandidateCursor,
  CoordinationAttentionCandidateKind,
  CoordinationAttentionCandidateV3View,
  SettleUnavailableActivationResult,
  OutboxItem,
  EnqueueMessageActivationInput,
  CoordinationRequestV3View,
  CreateTriggerDefinitionInput,
  UpdateTriggerDefinitionInput,
  RecordTriggerOccurrenceInput,
  TriggerOccurrenceResult,
  TriggerOccurrenceState,
  TriggerFilesystemBurst,
  ContextRolloverState,
  ContextRolloverV3,
  CommunicationV4NextRunDelivery,
  NextRunDeliveryMaintenanceResult,
  OperatorNextRunDeliveryReceipt,
  PublishAgentNextRunDeliveryInput,
  PublishNextRunDeliveryResult,
  PublishOperatorNextRunDeliveryInput,
  ReplayAgentNextRunDeliveryInput,
} from "./coordination-v3-store.js";
export type { ConversationDeliveryIntent, ManagedArtifactAccess } from "./store.js";
export type { AgentDeletionReceipt, ProjectDeletionReceipt, AgentManagementAuthorization } from "./store.js";
export type { ManagementOperation, ManagementOperationProgress, ManagementPlan } from "./store-types.js";
export { EventLog, readLog, readLogSince, lastSeq } from "./eventlog.js";
export { appendFsyncedJsonl, readRepairableJsonl, writeAtomicFsyncedJsonl } from "./append-jsonl.js";
export { openDb } from "./db.js";
export { stableJson } from "./coordination-v3-canonical-json.js";
export {
  artifactContentPath, artifactsDir, managedArtifactsDir, managedArtifactsLogPath, managedArtifactContentPath, attachmentPath, attachmentsDir,
  communicationEventsPath,
  communicationProjectionsPath, communicationRevisionsPath,
} from "./paths.js";
export {
  MANAGED_ARTIFACT_MAX_BYTES,
  publishManagedArtifactContent,
  publishManagedArtifactContentAsync,
  publishManagedArtifactContents,
  publishManagedArtifactContentsAsync,
  removeManagedArtifactContent,
  openManagedArtifactContent,
  readManagedArtifactContent,
  repairManagedArtifactContent,
  type ManagedArtifactFile,
  type ManagedArtifactContentHandle,
  type ManagedArtifactBatchInput,
} from "./managed-artifact-files.js";
export type { Db } from "./db.js";
export {
  AgentWorkingCopyUnavailableError,
  resolveAgentWorkingCopy,
  sharedWorkingCopy,
  type ResolvedAgentWorkingCopy,
} from "./working-copy.js";

export {
  projectEvent,
  projectAll,
  initProjectionState,
} from "./projectors.js";
export type { ProjectionOp, ProjectionState } from "./projectors.js";

export type { LogEvent, UserMessageEvent, CommunicationProjectionEvent, CompactionHistoryRetrievalEvent, AgentLifecycleEvent, CoordinationV3ChangedEvent, GeneratedArtifactEvent, TurnDoneLogEvent, StoredLogEvent } from "./log-event.js";
export * as schema from "./schema.js";
export type {
  ProjectRow,
  AgentRow,
  MessageRow,
  RunRow,
  WorkItemRow,
  ArtifactRow,
  EventRow,
} from "./schema.js";
