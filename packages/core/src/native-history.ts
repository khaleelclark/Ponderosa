/** Native history is context, never scheduler/Request/grant authority. */
export interface NativeFileCheckpoint {
  sessionId: string;
  messageId: string;
}
export interface NativeFileRewindResult {
  sessionId: string;
  messageId: string;
  dryRun: boolean;
  outcome: "completed" | "outcome_unknown";
  canRewind?: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  skippedLinks?: number;
}
export interface NativeTranscriptForkResult {
  sourceSessionId: string;
  throughId: string;
  /** Distinct native conversation/thread ID, not a session-tree root ID. */
  sessionId?: string;
  outcome: "completed" | "outcome_unknown";
  /** Fork output must be bound by the host before any executable turn. */
  contextAccepted: false;
  sourceWork: "unchanged";
  replayAuthorized: false;
}
export interface NativeHistoryCatalog {
  /** Session startup configuration, exposed after supported native init; not backup proof. */
  trackingEnabled?: boolean;
  sessionId: string;
  checkpoints: NativeFileCheckpoint[];
  /** Completed native turn IDs (Codex) or assistant message UUIDs (Claude). */
  forkPoints: string[];
  fileRewindSupported: boolean;
  transcriptForkSupported: boolean;
}
export interface NativeTranscriptSeed {
  sourceSessionId: string;
  throughId: string;
  newSessionId: string;
}

export interface HistoryBoundary {
  agentId:string;projectId:string;conversationId:string;engine:string;sessionId:string;
  runId:string;fence:number;toolContractHash:string;rootPath:string;
}
export interface HistoryReceipt {
  id:string; key:string; kind:"preview"|"rewind"|"fork"; boundary:HistoryBoundary;
  state:"prepared"|"started"|"completed"|"opened"|"cancelled";
  requestHash?:string;inputHash:string; createdAt:string; targetAgentId?:string; throughId?:string;
  newSessionId?:string; targetRunId?:string; targetFence?:number; result?:NativeHistoryResult;
}

export type NativeRewindAncestor = [path:string,dev:number,ino:number,mode:number,uid:number,gid:number];
export type NativeRewindFileFact = {path:string;ancestors:NativeRewindAncestor[]} & (
  {type:"absent"} | {type:"file";dev:number;ino:number;mode:number;uid:number;gid:number;size:number;hash:string});
export interface NativeHistoryResult {
  native?:NativeFileRewindResult;facts?:NativeRewindFileFact[];boundaryHash?:string;
  nativeSessionId?:string;contextAccepted?:false;replayAuthorized?:false;
}
export interface NativeHistoryTrackingPreference {
  enabled:boolean;appliesTo:"next_native_session";updatedAt?:string;
}
export interface NativeHistoryTrackingResponse {
  preference:NativeHistoryTrackingPreference;
  /** Present only when the retained native catalog can be read safely. */
  currentSession?:{sessionId:string;trackingEnabled:boolean};
}
export interface NativeHistoryEligibleTarget {agentId:string}
export interface NativeHistoryInventory {
  boundary:HistoryBoundary;boundaryHash:string;catalog:NativeHistoryCatalog;held:boolean;
  eligibleTargets:NativeHistoryEligibleTarget[];
}
export type NativeHistoryOperationRequest = {idempotencyKey:string;boundaryHash:string} & (
  {operation:"preview";checkpointId:string} |
  {operation:"rewind";checkpointId:string;previewKey:string;acknowledgeFileChanges:true} |
  {operation:"fork";targetAgentId:string;throughId:string;acknowledgeHistoryCopy:true});
export interface NativeHistoryOperationResponse {
  receipt:HistoryReceipt;replayed?:boolean;replayAuthorized?:false;sourceWork?:"unchanged";
  nextAction?:string;outcome?:"outcome_unknown";error?:string;
}
export interface NativeHistoryCancelRequest {key:string}
export interface NativeHistoryCancelResponse {receipt:HistoryReceipt;nativeInvoked:false}
export interface NativeHistoryTrackingRequest {enabled:boolean}
export interface NativeHistoryError {error:string;replayAuthorized?:false}
