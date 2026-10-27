// @ponderosa/agents — authored event-log authority, canonical V3 SQLite
// coordination/scheduler state, and rebuildable UI projections. Consumed by
// apps/server; exposes no HTTP and imports shared AgentEvent through core.

export { AgentEventPersistenceError } from "./store-event-projection.js";
export { AgentStore, AgentDeletionConflictError } from "./store.js";
export { communicationMentionBindings } from "./store-mention-bindings.js";
export { readRetainedChatAttachment, retainedChatAttachmentContent, retainChatAttachment, presentRetainedChatAttachment } from "./chat-attachment-retention.js";
export { CommunicationRevisionValidationError } from "./store-communication-journal-authority.js";
export { ProjectDeletionInProgressError } from "./store-workspace-catalog-authority.js";
export type {
  AgentCreationArtifactIdentity,
  AgentCreationOperation,
  AgentCreationOperationStatus,
} from "./store.js";
export { normalizeAgentTitle } from "./agent-identity.js";
export { workspaceRecencyCte, WorkspaceStore, draftRevisionConflicts } from "./workspace-store.js";
export type { PushDeliveryRecord } from "./workspace-store.js";
export { highlightedSearchSnippet, searchProjectedChatMessages } from "./chat-search.js";
export type { ProjectedChatSearchCandidate, ProjectedChatSearchOptions } from "./chat-search.js";
export { managedWorkspacePath } from "./managed-workspaces.js";
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
export type {
  AgentDeletionReceipt,
  ConversationDeletionReceipt,
  ProjectDeletionReceipt,
  AgentManagementAuthorization,
} from "./store.js";
export type { ManagementOperation, ManagementOperationProgress, ManagementPlan } from "./store-types.js";
export { EventLog, readLog, readLogSince, lastSeq } from "./eventlog.js";
export { appendFsyncedJsonl, readRepairableJsonl, writeAtomicFsyncedJsonl } from "./append-jsonl.js";
export {artifactAgentProductSql,managedArtifactProductSql} from './artifact-product-scope.js';
export {activeChatOwnerSql,activeChatProductSql,chatProductSql,activeAgentOwnerSql,activeAgentProductSql,projectProductSql,type ProductScope} from './product-scope-sql.js';
export { pathEntryExists, validateDeletionTombstone } from "./deletion-tombstone-ownership.js";
export { openDb } from "./db.js";
export {
  createOfflineDataDirectoryBackup,
  restoreOfflineDataDirectoryBackup,
  type DataDirectoryBackupManifest,
} from "./data-directory-backup.js";
export { stableJson } from "./coordination-v3-canonical-json.js";
export {
  artifactContentPath, artifactsDir, managedArtifactsDir, managedArtifactsLogPath, managedArtifactContentPath, managedArtifactStorageFilename, managedArtifactStorageFilenames, attachmentPath, attachmentsDir,
  importedAgentHistoryPath,
  communicationEventsPath,
  communicationProjectionsPath, communicationRevisionsPath,
} from "./paths.js";
export {
  MANAGED_ARTIFACT_MAX_BYTES,
  publishManagedArtifactContent,
  publishManagedArtifactContentAsync,
  publishManagedArtifactContents,
  publishManagedArtifactContentsAsync,
  readManagedArtifactContentsAsync,
  removeManagedArtifactContent,
  openManagedArtifactContent,
  readManagedArtifactContent,
  repairManagedArtifactContent,
  type ManagedArtifactFile,
  type ManagedArtifactContentHandle,
  type ManagedArtifactBatchInput,
  type ManagedArtifactReadInput,
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

export { admitDataDirectory, shareStateAdmission, requireAdmittedDatabase, readCurrentStateIdentity, StateAdmission, StateAdmissionError } from "./state-admission.js";

export { inspectCurrentState } from "./state-admission.js";

export { BranchStore } from "./branch-store.js";
export { validateBranchTemplate } from "./branch-template.js";
export { branchRequirements, exportBranchPackage, importBranchPackage } from "./branch-package.js";
export * from "./branch-parameters.js";
export { validateBranchDefinition, validateBranchBindings } from "./branch-definition.js";
export { branchDefinitionChanges } from "./branch-definition-diff.js";
export type { BranchResourceProvision, BranchActionLease, BranchGateNotificationEvent, BranchScriptLease } from "./branch-store.js";
export { BranchTriggerStore } from "./branch-trigger-store.js";
export type * from "./branch-trigger-types.js";
export { CapabilityPolicyStore, CapabilityPolicyRevisionConflictError } from "./capability-policy-store.js";

export {REQUEST_SOURCE_LINEAGE_CTE} from "./coordination-v3-request-lineage.js";
