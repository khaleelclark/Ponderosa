import { canonicalizeProviderText, LONG_TEXT_MAX_UTF8_BYTES, utf8ByteLength, type AgentEvent, type VoiceReplySnapshot } from "@ponderosa/core";

/** The tool chooses the reply route before any candidate bytes can be exposed.
 * Candidate events alone never authorize publication. State belongs to one ActiveRun. */
export class VoiceReplyStream {
  readonly snapshot: VoiceReplySnapshot;
  private completeText?: string;
  private emittedLength = 0;
  private items = 0;
  private broken = false;
  private acknowledged = false;
  private rawText = "";
  constructor(initial: VoiceReplySnapshot, private readonly steeringIds: readonly string[] = [], private readonly authorizingOperationId?: string) { this.snapshot = initial; }
  authorizationResult(): { authorized: true; streamId: string; instruction: string } | { authorized: false; error: string } {
    if (this.broken) return { authorized: false, error: "voice reply authority invalidated; use ordinary ponderosa_message" };
    return { authorized: true, streamId: this.snapshot.streamId,
      instruction: "Write one final answer now. Its explicitly authorized bytes will stream to this exact voice DM. Successful completion publishes one canonical reply through ponderosa_message authority. Do not publish a duplicate or call any other tool. Missing phase/deltas use completed-text fallback." };
  }
  observeWork(event: AgentEvent): boolean {
    // Only the exact operation that armed this stream and its successful acknowledgement
    // are exempt. Tool names/suffixes and arbitrary result prose confer no exemption.
    if (event.type === "tool_call" && event.id === this.authorizingOperationId && event.name === "ponderosa_voice_reply") return false;
    if (event.type === "tool_result" && event.id === this.authorizingOperationId && event.isError === false &&
        event.voiceReplyStreamId === this.snapshot.streamId) { this.acknowledged = true; return false; }
    return ["work_start", "command", "file_change", "tool_call", "tool_result", "error"].includes(event.type) && this.invalidate();
  }
  accept(event: Extract<AgentEvent, { type: "response_text" }>, now: string): boolean {
    const s = this.snapshot;
    if (event.phase === "commentary" || this.broken) return false;
    if (!this.acknowledged) return this.invalidate();
    if (event.kind === "start") {
      if (++this.items !== 1) { this.invalidate(); return true; }
      s.itemId = event.itemId; s.providerTurnId = event.providerTurnId;
    }
    if (s.itemId !== event.itemId || s.providerTurnId !== event.providerTurnId) return false;
    if (event.kind === "delta") {
      if (s.state === "failed") return false;
      if (this.completeText !== undefined) return false;
      if (this.rawText.length + event.text.length > 10_000) { this.failTransport(); return true; }
      // Unknown phase cannot start speech; its completed snapshot is the fallback.
      if (event.phase !== "final_answer") return false;
      this.rawText += event.text;
      s.text = canonicalizeProviderText(this.rawText, this.steeringIds).trimStart();
      if (s.text && !s.firstTextAt) s.firstTextAt = now;
      if (s.text.length - this.emittedLength < 80 && !/[.!?;]["”']?\s*$/u.test(s.text) && this.emittedLength) return false;
      s.state = "streaming";
    } else if (event.kind === "complete") {
      if (utf8ByteLength(event.text) > LONG_TEXT_MAX_UTF8_BYTES || !event.text.trim()) { this.invalidate(); return true; }
      this.completeText = canonicalizeProviderText(event.text, this.steeringIds).trim();
      if (!s.firstTextAt) s.firstTextAt = now;
      // Reconcile the authoritative completion; clients check any spoken prefix.
      if (s.state === "failed") return false; // Canonical fallback still owns the complete item.
      if (this.completeText.length > 10_000) { this.failTransport(); return true; }
      s.text = this.completeText;
    } else return false;
    if (s.sequence >= 255) { this.failTransport(); return true; }
    this.emittedLength = s.text.length; s.sequence++; return true;
  }
  private failTransport(): void { this.snapshot.state = "failed"; this.snapshot.sequence++; this.rawText = ""; }
  invalidate(reason?: "context_changed"): boolean {
    if (this.broken && (!reason || this.snapshot.failureReason === reason)) return false;
    this.broken = true; this.snapshot.state = "failed";
    if (reason) this.snapshot.failureReason = reason;
    this.snapshot.sequence++; return true;
  }
  finalText(): string | undefined { return this.broken ? undefined : this.completeText?.trim(); }
  complete(at: string): void { if (this.broken) return; this.snapshot.state = "completed"; this.snapshot.completedAt = at; this.snapshot.sequence++; }
}
