import type { SpeechPreferencesDto } from "@ponderosa/core";
import { abandonPageCapture } from "./captureCoordinator";
import { monitorSpeechSurfaceAccessibility } from "./speechSurfaceAccessibility";

export type PlaybackStatus = "idle" | "loading" | "speaking" | "paused" | "stopped" | "error";
interface Snapshot { ownerId?: string; status: PlaybackStatus; error?: string }
interface Owner {
  id: string;
  utterance?: SpeechSynthesisUtterance;
  cleanup?: () => void;
  startTimer?: ReturnType<typeof setTimeout>;
  started?: boolean;
  audioUsed?: boolean;
  queue?: string[];
  finished?: boolean;
  pump?: () => void;
  checking?: boolean;
}
let active: Owner | undefined;
let snapshot: Snapshot = { status: "idle" };
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => { snapshot = next; for (const listener of listeners) listener(); };
export const subscribeSpeech = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const speechSnapshot = () => snapshot;

function release(owner: Owner): boolean {
  let failed = false;
  const wasActive = active === owner;
  if (wasActive) active = undefined;
  clearTimeout(owner.startTimer);
  if (owner.queue) owner.queue.length = 0;
  owner.pump = undefined;
  try { owner.cleanup?.(); } catch { /* Ownership is already fenced. */ }
  if (owner.utterance) {
    owner.utterance.onend = null; owner.utterance.onerror = null; owner.utterance.onstart = null;

  }
  try { if (wasActive && owner.audioUsed) window.speechSynthesis.cancel(); } catch { failed = true; }
  return failed;
}
export function stopSpeech(ownerId?: string): boolean {
  if (!active || (ownerId && active.id !== ownerId)) return true;
  const owner = active;
  const failed = release(owner);
  publish({ ownerId: owner.id, status: "stopped", ...(failed ? { error: "Browser audio cleanup could not be confirmed. Check browser audio controls." } : {}) });
  return !failed;
}
export function releaseSpeechSurface(ownerId: string): void {
  if (active?.id === ownerId) stopSpeech(ownerId);
}
export function pauseSpeech(): void {
  const owner = active;
  if (!owner) return;
  clearTimeout(owner.startTimer);
  try {
    if (owner.utterance) window.speechSynthesis.pause();
    if (active === owner) publish({ ...snapshot, status: "paused" });
  } catch { fail(owner); }
}
export async function resumeSpeech(): Promise<void> {
  const owner = active;
  if (!owner) return;
  try {
    if (owner.utterance) window.speechSynthesis.resume();
    if (active === owner) {
      if (!owner.started) owner.startTimer = setTimeout(() => fail(owner), 3_000);
      publish({ ...snapshot, status: owner.started ? "speaking" : "loading" });
    }
  } catch { fail(owner); }
}
function fail(owner: Owner): void {
  if (active !== owner) return;
  try { release(owner); } finally { publish({ ownerId: owner.id, status: "error", error: "The browser could not read this message aloud." }); }
}
export interface SpeechQueue { append(text: string): boolean; finish(): void; stop(): void }
/** One owner across all phrases, including gaps; capture never resumes between them. */
export function startSpeechQueue(id: string, preferences: SpeechPreferencesDto, surface: () => HTMLElement | null, onComplete?: () => void, onStart?: (text: string) => void, beforePhrase?: () => Promise<boolean>): SpeechQueue {
  abandonPageCapture(); stopSpeech();
  if (active) return { append: () => false, finish() {}, stop() {} };
  const owner: Owner = { id, queue: [], finished: false };
  active = owner; publish({ ownerId: id, status: "loading" });
  let queuedCharacters = 0;
  const pump = async () => {
    if (active !== owner || owner.utterance || owner.checking) return;
    const text = owner.queue!.shift();
    if (!text) {
      if (owner.finished) { const settled = stopSpeech(id); if (settled) onComplete?.(); }
      else publish({ ownerId: id, status: "loading" });
      return;
    }
    queuedCharacters -= text.length;
    try {
      if (beforePhrase) {
        owner.checking = true;
        let permitted = false;
        try { permitted = await beforePhrase(); } finally { owner.checking = false; }
        // A stopped/replaced owner never gains authority from a delayed response.
        if (active !== owner) return;
        if (!permitted) { fail(owner); return; }
      }
      if (active !== owner) return;
      const utterance = new SpeechSynthesisUtterance(text); owner.utterance = utterance; owner.started = false; owner.audioUsed = true;
      utterance.lang = navigator.language || "en-US"; utterance.rate = preferences.speed;
      const current = () => active === owner && owner.utterance === utterance;
      utterance.onstart = () => { if (!current()) return; owner.started = true; clearTimeout(owner.startTimer); if (snapshot.status !== "paused") publish({ ownerId: id, status: "speaking" }); onStart?.(text); };
      utterance.onend = () => {
        if (!current()) return;
        if (!owner.started) { fail(owner); return; }
        clearTimeout(owner.startTimer);
        utterance.onstart = null; utterance.onend = null; utterance.onerror = null;
        owner.utterance = undefined; pump();
      };
      utterance.onerror = () => { if (current()) fail(owner); };
      owner.startTimer = setTimeout(() => fail(owner), 3_000);
      if (!current()) return;
      // cancel() preserves the browser paused state across owners.
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      if (!current()) return;
      window.speechSynthesis.speak(utterance);
    } catch { fail(owner); }
  };
  owner.pump = pump;
  try { if (active === owner) owner.cleanup = monitorSpeechSurfaceAccessibility(surface, () => stopSpeech(id)); } catch { fail(owner); }
  return {
    append(text) {
      if (active !== owner || owner.finished || !text.trim()) return false;
      if (owner.queue!.length >= 64 || queuedCharacters + text.length > 10_000) { fail(owner); return false; }
      owner.queue!.push(text); queuedCharacters += text.length; pump(); return active === owner;
    },
    finish() { if (active === owner) { owner.finished = true; pump(); } },
    stop() { if (active === owner) stopSpeech(id); },
  };
}
export function startSpeech(id: string, text: string, preferences: SpeechPreferencesDto, surface: () => HTMLElement | null, onComplete?: () => void, onStart?: () => void): void {
  const queue = startSpeechQueue(id, preferences, surface, onComplete, onStart);
  queue.append(text); queue.finish();
}
