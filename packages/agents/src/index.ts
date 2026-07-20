// @ponderosa/agents — the append-only event log + rebuildable SQLite projections
// (SPEC §4/§7). A library consumed by apps/server; exposes no HTTP. Does not import
// from packages/engines except AgentEvent (re-exported through core).

export { AgentStore, AgentDeletionConflictError } from "./store.js";
export { WorkspaceStore } from "./workspace-store.js";
export type { PushDeliveryRecord } from "./workspace-store.js";
export { highlightedSearchSnippet, searchProjectedChatMessages } from "./chat-search.js";
export type { ProjectedChatSearchCandidate, ProjectedChatSearchOptions } from "./chat-search.js";
export { CoordinationV3Store } from "./coordination-v3-store.js";
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
} from "./coordination-v3-store.js";
export type { ConversationDeliveryIntent, ManagedArtifactAccess } from "./store.js";
export type { AgentDeletionReceipt, ProjectDeletionReceipt, AgentManagementAuthorization } from "./store.js";
export { EventLog, readLog, readLogSince, lastSeq } from "./eventlog.js";
export { openDb } from "./db.js";
export {
  artifactContentPath, artifactsDir, managedArtifactsDir, managedArtifactsLogPath, managedArtifactContentPath, attachmentPath, attachmentsDir,
  communicationEventsPath,
  communicationProjectionsPath, communicationRevisionsPath,
} from "./paths.js";
export {
  MANAGED_ARTIFACT_MAX_BYTES,
  publishManagedArtifactContent,
  openManagedArtifactContent,
  readManagedArtifactContent,
  repairManagedArtifactContent,
  type ManagedArtifactFile,
  type ManagedArtifactContentHandle,
  type ManagedArtifactAsyncReadFaults,
} from "./managed-artifact-files.js";
export type { Db } from "./db.js";

export {
  projectEvent,
  projectAll,
  initProjectionState,
} from "./projectors.js";
export type { ProjectionOp, ProjectionState } from "./projectors.js";

export type { LogEvent, UserMessageEvent, CommunicationProjectionEvent, AgentLifecycleEvent, CoordinationV3ChangedEvent, GeneratedArtifactEvent, TurnDoneLogEvent, StoredLogEvent } from "./log-event.js";
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
