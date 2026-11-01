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
