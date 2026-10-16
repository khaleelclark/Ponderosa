/** Provisional, explicitly authorized call reply. Never a Communication or context source. */
export interface VoiceReplySnapshot {
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
export interface MemoryChangedEvent { type: "memory_changed"; projectId: string; scope: "project" | "global"; generation: number }
export interface VoiceReplyEvent { type: "voice_reply"; reply: VoiceReplySnapshot }
export interface VoiceReplyStatus {
  messageId: string; acceptedAt: string;
  runId?: string; leasedAt?: string; runStartedAt?: string; runStatus?: string;
  memoryExposure?: { state: "disabled" | "pending" | "valid" | "invalid"; runId?: string; sessionResetSeq?: number; projectGeneration?: number; globalGeneration?: number };
  reply?: VoiceReplySnapshot;
}
