import { SPEECH_LIMITS } from "@ponderosa/core";

interface Entry { priority: "interactive" | "prefetch"; start(): void; cancel(): void }
/** One job plus two bounded waiters; interactive audio precedes prefetch. */
export class SpeechAdmission {
  private active = false;
  private queue: Entry[] = [];
  private closed = false;
  async run<T>(priority: "interactive" | "prefetch", signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Speech is closed.");
    if (this.active) {
      if (this.queue.length >= SPEECH_LIMITS.queuedJobs) throw new Error("Speech queue is full.");
      await new Promise<void>((resolve, reject) => {
        const clear = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); };
        const cancel = () => { this.queue = this.queue.filter(item => item !== entry); clear(); reject(new Error("Speech queue wait cancelled.")); };
        const entry: Entry = { priority, start: () => { clear(); resolve(); }, cancel };
        const timer = setTimeout(cancel, SPEECH_LIMITS.segmentTimeoutMs);
        signal.addEventListener("abort", cancel, { once: true });
        this.queue.push(entry);
      });
    } else this.active = true;
    try { signal.throwIfAborted(); return await work(); }
    finally {
      const next = this.queue.find(item => item.priority === "interactive") ?? this.queue[0];
      if (next) { this.queue = this.queue.filter(item => item !== next); next.start(); }
      else this.active = false;
    }
  }
  close(): void { this.closed = true; for (const entry of [...this.queue]) entry.cancel(); }
}
