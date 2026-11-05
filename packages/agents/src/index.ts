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
  createOfflineWebDeploymentBackup,
  assertWebOnlyDeploymentCompatibility,
  restoreOfflineDataDirectoryBackup,
  type DataDirectoryBackupManifest,
  type WebDeploymentBackupManifest,
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

export { BranchStore, branchDeletionErrorResourceId } from "./branch-store.js";
export { validateBranchTemplate } from "./branch-template.js";
export { branchRequirements, exportBranchPackage, importBranchPackage } from "./branch-package.js";
export * from "./branch-parameters.js";
export { validateBranchDefinition, validateBranchBindings } from "./branch-definition.js";
export { branchDefinitionChanges } from "./branch-definition-diff.js";
export {branchSharedState,branchStateResult,validateBranchStateSeal} from './branch-shared-state.js';
export type { BranchResourceProvision, BranchActionLease, BranchGateNotificationEvent, BranchScriptLease } from "./branch-store.js";
export { BranchTriggerStore } from "./branch-trigger-store.js";
export type * from "./branch-trigger-types.js";
export { CapabilityPolicyStore, CapabilityPolicyRevisionConflictError } from "./capability-policy-store.js";

export {REQUEST_SOURCE_LINEAGE_CTE,requestSourceLineageBody} from "./coordination-v3-request-lineage.js";

export {BRANCH_LIVE_REQUEST_LINEAGE_CTE,branchStartedRequestRunSql,readBranchRunCounts,readBranchWorkingStepCount} from "./branch-run-status.js";

export { ContextRecoveryConflictError } from "./coordination-v3-context-recovery-authority.js";

export { beginSourceCapture, assertSourceCapture, commitSourceCapture, releaseSourceCapture, beginSourceMutation, withSourceMutation, touchSourceMutation, SourceCaptureChangedError } from "./source-capture-boundary.js";
export type { SourceCaptureToken } from "./source-capture-boundary.js";
export {sourceMutationState,reconcileSourceMutation} from './source-capture-boundary.js';

export {resourceCapture,retainedResourceCapture,resourceCaptureFrontierHash,receiptMatchesSource,type BranchResourceCapture} from './branch-resource-capture.js';

export type {CoordinationDestinationAuthority} from './coordination-v3-destination-admission-authority.js';
export {destinationAdmissionHeld,requireDestinationAdmitted} from './coordination-v3-destination-staging.js';
export {creationId as workspaceCreationId} from './store-workspace-catalog-authority.js';

export {encodeIssuedResourceContinuation,issuedResourceContinuationSupported,readIssuedResourceContinuation,reconstructIssuedResourceContinuation} from './branch-issued-resource-continuation.js';

export {destinationDisclosurePolicy} from './coordination-v3-destination-admission-authority.js';

export type {CoordinationDestinationReconciliationAuthority,CoordinationDestinationGroupReconciliationAuthority} from './coordination-v3-destination-reconciliation.js';
export {BranchCustodyLifecycle,type BranchCustodyReference} from './branch-custody-lifecycle.js';

export type {CoordinationDestinationGroupAuthority} from './coordination-v3-destination-admission-authority.js';

export {readIssuedGroup,readIssuedGroupCaptureAudit} from './branch-issued-group-capture.js';
export {readProviderExitEvidence,verifyRetainedProviderExitEvidence} from './provider-exit-evidence.js';

export {readGroupCaptureDisposition,type BranchGroupCaptureAbandonInput,type BranchGroupPackageRetirementProof,type BranchGroupPackageInventory} from './branch-group-custody-disposition.js';

export {fenceBranchGenerationExit,generationExitHeld,requireGenerationExitOpen,type BranchGenerationExitFenceInput} from './branch-generation-exit-fence.js';

export {generationExitKey,readGenerationExitCapture,type BranchPriorGenerationEnvelope} from './branch-generation-exit-capture.js';

export {readDestinationHistoricalPartition,destinationHistoricalFacts} from './coordination-v3-historical-partition.js';

export {previewIssuedTreeCapture,reserveIssuedTreeCapture,sealIssuedTreeMember,readIssuedTreeCapture,issuedTreeFreshOwnerMap} from './branch-issued-tree-capture.js';

export {captureGenerationOneHost,generationOneEvidence,generationHistoricalSelections,MAX_RETAINED_RESOURCE_GENERATIONS,type GenerationOneProof} from './branch-resource-generation-one.js';

export {issuedCaptureRetryBudget} from './branch-issued-resource-capture.js';

export {readGroupAuditJournal,listGroupAuditJournals} from './branch-group-journal-retention.js';

export {issuedGroupOwners,issuedGroupResources,issuedGroupHost} from './branch-issued-group-capture.js';

export { CoordinationV3SourceEffectsAuthority, SourceEffectConflictError } from "./coordination-v3-source-effects-authority.js";
export {groupOwnerReviewEvidence} from './branch-group-review-evidence.js';

export { NativeTaskStopAuthority } from "./native-task-stop-authority.js";
export {captureBranchRuntimeData,validateBranchRuntimeData,readRuntimeImportFacts} from './branch-runtime-package.js';

export {validateBranchExecutionTree,planBranchExecutionTree,insertBranchExecutionTree,readBranchExecutionTree,readHeldTreeForContinuation} from './branch-runtime-tree-package.js';

export {enableProviderStartCoverage,holdProviderStart,admitProviderStart,settleProviderStart,requireProviderStartsDrained,sealProviderNeverStarted} from './provider-start-journal.js';

export {renderUnfinishedHumanTaskContext} from "./coordination-v3-task-objective.js";

export {hasRetainedTemporaryChatScope} from './branch-host-cut.js';

export {makeWorkingFileTransportPart,type WorkingFileTransportPart} from "./working-file-transport.js";
export { readBranchExpertCopy } from "./branch-expert-copy.js";
export type { BranchExpertCopyReceipt } from "./branch-expert-copy.js";

export { requireGenerationExitDeletionReady } from "./branch-generation-exit-deletion.js";

export {portableBase64ByteLength,portableArtifactByteLength,decodePortableMetadataArtifact} from './portable-artifact-original.js';

export { safeWorkingCopyFailure, safeWorkingCopyFailureCode, safeStoredWorkingCopy, recordWorkingCopyGitFailure, carryWorkingCopyGitFailure, isStoredWorkingCopyGitFailure } from "./working-copy-failure.js";
