/** Provisional, explicitly authorized call reply. Never a Communication or context source. */
export interface VoiceReplySnapshot {
  projectId: string; conversationId: string; agentId: string; messageId: string;
  runId: string; fence: number; streamId: string; itemId?: string; providerTurnId?: string;
  steeringInjectionId?: string;
  sequence: number; text: string;
  state: "open" | "streaming" | "completed" | "failed";
  acceptedAt: string; leasedAt?: string; runStartedAt?: string; firstTextAt?: string;
  completedAt?: string;
}
export interface VoiceReplyEvent { type: "voice_reply"; reply: VoiceReplySnapshot }
export interface VoiceReplyStatus {
  messageId: string; acceptedAt: string;
  runId?: string; leasedAt?: string; runStartedAt?: string; runStatus?: string;
  reply?: VoiceReplySnapshot;
}
