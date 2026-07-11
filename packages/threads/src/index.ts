// @ponderosa/threads — the append-only event log + rebuildable SQLite projections
// (SPEC §4/§7). A library consumed by apps/server; exposes no HTTP. Does not import
// from packages/engines except AgentEvent (re-exported through core).

export { ThreadStore } from "./store.js";
export type { MasterChatDeliveryIntent } from "./store.js";
export { EventLog, readLog, readLogSince, lastSeq } from "./eventlog.js";
export { openDb } from "./db.js";
export { artifactContentPath, artifactsDir } from "./paths.js";
export type { Db } from "./db.js";

export {
  projectEvent,
  projectAll,
  initProjectionState,
} from "./projectors.js";
export type { ProjectionOp, ProjectionState } from "./projectors.js";

export type { LogEvent, UserMessageEvent, StoredLogEvent } from "./log-event.js";
export * as schema from "./schema.js";
export type {
  ProjectRow,
  ThreadRow,
  MessageRow,
  TaskRow,
  ArtifactRow,
  EventRow,
} from "./schema.js";
