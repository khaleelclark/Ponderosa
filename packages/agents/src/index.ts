// @ponderosa/agents — the append-only event log + rebuildable SQLite projections
// (SPEC §4/§7). A library consumed by apps/server; exposes no HTTP. Does not import
// from packages/engines except AgentEvent (re-exported through core).

export { AgentStore } from "./store.js";
export { WorkspaceStore } from "./workspace-store.js";
export { CoordinationV3Store } from "./coordination-v3-store.js";
export type {
  CoordinateV3Input,
  CoordinateV3Result,
  UpdateRequestV3Input,
  RequestUpdateV3Result,
  SchedulerLease,
  OutboxItem,
  EnqueueMessageActivationInput,
  CoordinationRequestV3View,
} from "./coordination-v3-store.js";
export type { ConversationDeliveryIntent } from "./store.js";
export { EventLog, readLog, readLogSince, lastSeq } from "./eventlog.js";
export { openDb } from "./db.js";
export {
  artifactContentPath, artifactsDir, attachmentPath, attachmentsDir,
  communicationEventsPath, communicationContextPath,
  communicationProjectionsPath,
  runTriggersPath,
} from "./paths.js";
export type { Db } from "./db.js";

export {
  projectEvent,
  projectAll,
  initProjectionState,
} from "./projectors.js";
export type { ProjectionOp, ProjectionState } from "./projectors.js";

export type { LogEvent, UserMessageEvent, CommunicationProjectionEvent, AgentLifecycleEvent, CoordinationV3ChangedEvent, TurnDoneLogEvent, StoredLogEvent } from "./log-event.js";
export * as schema from "./schema.js";
export type {
  ProjectRow,
  AgentRow,
  MessageRow,
  RunRow,
  WorkItemRow,
  ArtifactRow,
  EventRow,
  CoordinationRequestRow,
  CoordinationJoinRow,
  AgentActivationRow,
  SchedulerRunRow,
} from "./schema.js";
