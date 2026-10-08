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
  try { owner.cleanup?.(); } catch { /* Ownership is already fenced. */ }
  if (owner.utterance) {
    owner.utterance.onend = null; owner.utterance.onerror = null; owner.utterance.onstart = null;
    try { if (wasActive) window.speechSynthesis.cancel(); } catch { failed = true; }
  }
  return failed;
}
export function stopSpeech(ownerId?: string): void {
  if (!active || (ownerId && active.id !== ownerId)) return;
  const owner = active;
  const failed = release(owner);
  publish({ ownerId: owner.id, status: "stopped", ...(failed ? { error: "Browser audio cleanup could not be confirmed. Check browser audio controls." } : {}) });
}
export function releaseSpeechSurface(ownerId: string): void {
  if (active?.id === ownerId) stopSpeech(ownerId);
}
export function pauseSpeech(): void {
  if (!active) return;
  clearTimeout(active.startTimer);
  if (active.utterance) window.speechSynthesis.pause();
  publish({ ...snapshot, status: "paused" });
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
export function startSpeech(id: string, text: string, preferences: SpeechPreferencesDto, surface: () => HTMLElement | null, onComplete?: () => void): void {
  abandonPageCapture();
  stopSpeech();
  const owner: Owner = { id };
  active = owner;
  publish({ ownerId: id, status: "loading" });
  try {
    owner.cleanup = monitorSpeechSurfaceAccessibility(surface, () => stopSpeech(id));
    if (active !== owner) return;
    const utterance = new SpeechSynthesisUtterance(text); owner.utterance = utterance;
    utterance.lang = navigator.language || "en-US";
    utterance.rate = preferences.speed;
    utterance.onstart = () => { owner.started = true; clearTimeout(owner.startTimer); if (active === owner) publish({ ownerId: id, status: "speaking" }); };
    utterance.onend = () => { if (active === owner) { stopSpeech(id); onComplete?.(); } };
    utterance.onerror = () => fail(owner);
    owner.startTimer = setTimeout(() => fail(owner), 3_000);
    window.speechSynthesis.speak(utterance);
  } catch { fail(owner); }
}
