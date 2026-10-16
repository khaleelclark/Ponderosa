import type { VoiceReplySnapshot } from "@ponderosa/core";
import { speakableMessageText } from "./speechText.js";

/** Ordered cumulative snapshots make reconnect gaps repairable without token replay. */
export class VoicePhraseBuffer {
  private sequence = -1;
  private identity?: string;
  private text = "";
  private consumed = 0;
  private closed = false;
  private startedOffset = 0;
  private queuedOffsets: number[] = [];
  started(): void { this.startedOffset = this.queuedOffsets.shift() ?? this.startedOffset; }
  discardQueued(): void { this.queuedOffsets.length = 0; this.consumed = this.startedOffset; }
  get spokenPrefix(): string { return this.text.slice(0, this.consumed); }
  accept(reply: VoiceReplySnapshot): string[] {
    if (this.closed || reply.sequence <= this.sequence) return [];
    const identity = JSON.stringify([reply.messageId, reply.agentId, reply.runId, reply.fence, reply.streamId, reply.itemId, reply.providerTurnId]);
    if (this.identity && this.identity !== identity) throw new Error("The response stream changed. Continue in Chat.");
    // The open snapshot has no item yet; only bind once actual text is qualified.
    if (!reply.itemId || !reply.text) return [];
    if (reply.text.length > 10_000 || !reply.text.startsWith(this.spokenPrefix)) throw new Error("The completed reply changed after speech. Read it in Chat.");
    this.identity = identity; this.sequence = reply.sequence; this.text = reply.text;
    if (reply.state === "failed") { this.closed = true; return []; }
    return this.phrases(false);
  }
  flush(): string[] { return this.closed ? [] : this.phrases(false, true); }
  finish(canonicalText: string): string[] {
    if (!canonicalText.startsWith(this.spokenPrefix)) throw new Error("The canonical reply differs from the spoken response. Read it in Chat.");
    this.text = canonicalText;
    const phrases = this.phrases(true); this.closed = true; return phrases;
  }
  private phrases(final: boolean, timed = false): string[] {
    const out: string[] = [];
    while (this.consumed < this.text.length) {
      const tail = this.text.slice(this.consumed);
      // Hold unfinished Markdown/code until the canonical tail can be sanitized.
      if (!final && /[`\[\]<>*_#|]/u.test(tail)) break;
      let end = final ? tail.length : 0;
      if (!final) {
        const sentence = /[!?;](?:["”']?)(?=\s)|\.(?:["”']?)(?=\s)/gu;
        for (const m of tail.matchAll(sentence)) {
          const prefix = tail.slice(0, m.index);
          if (/\b(?:Mr|Mrs|Dr|Ms|Prof|e\.g|i\.e)$/iu.test(prefix) || /(?:^|\s)[A-Z]$/u.test(prefix)) continue;
          end = m.index! + m[0].length; break;
        }
        if (!end && (tail.length >= 240 || timed && tail.length >= 80)) {
          const bounded = tail.slice(0, 240);
          const comma = bounded.lastIndexOf(", ");
          end = comma >= 60 ? comma + 1 : bounded.lastIndexOf(" ");
          if (end < 60) end = 0;
        }
      }
      if (!end) break;
      const raw = tail.slice(0, end);
      this.consumed += end;
      // Avoid reading fenced code and raw URLs; keep their actual content in Chat.
      const clean = speakableMessageText(raw.replace(/```[\s\S]*?(?:```|$)/gu, " ").replace(/`[^`]*`/gu, " ").replace(/https?:\/\/\S+/gu, " "));
      if (clean) { out.push(clean); this.queuedOffsets.push(this.consumed); }
      if (final) break;
    }
    return out;
  }
}
export interface VoiceTiming {
  acceptedAt?: string; runStartedAt?: string; leasedAt?: string; firstTextAt?: string; completedAt?: string;
  settled?: number; firstPhraseStart?: number;
  firstReceived?: number; firstCommitted?: number; firstAudio?: number; sentObserved?: number; acceptedObserved?: number;
}
const paired = (a?: string, b?: string) => {
  const ms = a && b ? Date.parse(b) - Date.parse(a) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms)} ms` : "unavailable";
};
/** Never subtract a browser monotonic clock from a server timestamp. */
export function voiceTimingText(t: VoiceTiming): string {
  const localPair = (start?: number) => start !== undefined && t.firstAudio !== undefined &&
    Number.isFinite(start) && Number.isFinite(t.firstAudio) && start <= t.firstAudio
    ? `${Math.round(t.firstAudio - start)} ms` : "unavailable";
  const local = localPair(t.firstCommitted);
  const receipt = localPair(t.firstReceived);
  const browserTotal = t.acceptedObserved !== undefined && t.firstAudio !== undefined ? `${Math.round(t.firstAudio - t.acceptedObserved)} ms` : "unavailable";
  const window = t.sentObserved !== undefined && t.acceptedObserved !== undefined && t.firstAudio !== undefined &&
    t.firstAudio >= t.acceptedObserved && t.acceptedObserved >= t.sentObserved
    ? `${Math.round(t.firstAudio - t.acceptedObserved)}–${Math.round(t.firstAudio - t.sentObserved)} ms` : "unavailable";
  return `Recognition settled → first phrase start ${t.settled !== undefined && t.firstPhraseStart !== undefined && t.firstPhraseStart >= t.settled ? `${Math.round(t.firstPhraseStart-t.settled)} ms` : "unavailable"} (browser onstart). Acceptance → Run start ${paired(t.acceptedAt, t.runStartedAt)} (lease ${paired(t.acceptedAt, t.leasedAt)}; preparation ${paired(t.leasedAt, t.runStartedAt)}) · Run start → first reply text ${paired(t.runStartedAt, t.firstTextAt)} · visible reply DOM commit → browser audio start ${local} · first reply text receipt → browser audio start ${receipt} · acceptance → canonical completion ${paired(t.acceptedAt, t.completedAt)}. Acceptance → browser audio start ${window} (HTTP acceptance window, browser clock). Observed acceptance → browser audio start ${browserTotal} (network arrival excluded).`;
}
