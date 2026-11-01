/** Provisional, explicitly authorized call reply. Never a Communication or context source. */
export interface VoiceReplySnapshot {
  /** Missing means voice for existing persisted snapshots. */
  presentation?: "text" | "voice";
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
  memoryExposure?: { state: "disabled" | "pending" | "valid" | "invalid"; runId?: string; sessionResetSeq?: number; projectGeneration?: number; globalGeneration?: number };
  reply?: VoiceReplySnapshot;
}
