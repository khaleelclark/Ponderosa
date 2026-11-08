/** Exact publication selected by an explicit native tool, never by generated prose. */
export type ReplyStreamPublication =
  | { kind: "message"; intent: "broadcast" | "direct_to_user" | "collaboration";
      recipientAgentIds?: string[]; documentTitle?: string; taskDelivery?: "final" | "blocked" }
  | { kind: "request_update"; requestId: string; updateKind: "completed" | "blocked" | "failed" };
export interface ReplyStreamArguments {
  steeringInjectionId?: string;
  publication?: ReplyStreamPublication;
  /** A short provider-authored acknowledgement; only eligible voice inputs accept it. */
  acknowledgement?: string;
}
/** Provisional, explicitly authorized call reply. Never a Communication or context source. */
export interface VoiceReplySnapshot {
  /** Missing means voice for existing persisted snapshots. */
  presentation?: "text" | "voice";
  purpose?: "answer" | "acknowledgement";
  publication?: ReplyStreamPublication;
  /** Canonical route selected by the host; never infer a Chat scope from text. */
  replyIntent?: "broadcast" | "direct_to_user" | "collaboration";
  recipientAgentIds?: string[];
  projectId: string; conversationId: string; agentId: string; messageId: string;
  runId: string; fence: number; streamId: string; itemId?: string; providerTurnId?: string;
  steeringInjectionId?: string;
  sequence: number; text: string;
  state: "open" | "streaming" | "completed" | "failed";
  acceptedAt: string; leasedAt?: string; runStartedAt?: string; firstTextAt?: string;
  completedAt?: string;
  /** Host receipt clocks, never browser monotonic timestamps. */
  submittedAt?: string; firstModelTextAt?: string;
  /** Memory authority changed; automatic canonical fallback must stay silent. */
  failureReason?: "context_changed";
}
/** Host-only invalidation hint, never memory content or an authority grant. */
export interface MemoryChangedEvent { type: "memory_changed"; projectId: string; scope: "project" | "chat" | "global"; generation?: number; conversationId?: string; runId?: string }
export interface VoiceReplyEvent { type: "voice_reply"; reply: VoiceReplySnapshot }
export interface VoiceReplyStatus {
  messageId: string; acceptedAt: string;
  runId?: string; leasedAt?: string; runStartedAt?: string; runStatus?: string;
  /** Exact canonical reply bound to this source obligation, including shared Runs. */
  canonicalReplyEventId?: string;
  memoryExposure?: { state: "disabled" | "pending" | "valid" | "invalid"; runId?: string; sessionResetSeq?: number; projectGeneration?: number; globalGeneration?: number };
  reply?: VoiceReplySnapshot;
}
