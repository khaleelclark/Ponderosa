import type { SpeechPreferencesDto } from "@ponderosa/core";
import { monitorSpeechSurfaceAccessibility } from "./speechSurfaceAccessibility";

export type PlaybackStatus = "idle" | "loading" | "speaking" | "paused" | "stopped" | "error";
interface Snapshot { ownerId?: string; status: PlaybackStatus; error?: string }
interface Owner {
  id: string;
  utterance?: SpeechSynthesisUtterance;
  cleanup?: () => void;
}
let active: Owner | undefined;
let snapshot: Snapshot = { status: "idle" };
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => { snapshot = next; for (const listener of listeners) listener(); };
export const subscribeSpeech = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const speechSnapshot = () => snapshot;

function release(owner: Owner): void {
  if (active === owner) active = undefined;
  try { owner.cleanup?.(); } catch { /* Ownership is already fenced. */ }
  if (owner.utterance) {
    owner.utterance.onend = null; owner.utterance.onerror = null; owner.utterance.onstart = null;
    try { window.speechSynthesis.cancel(); } catch { /* Browser cancellation is best-effort after fencing. */ }
  }
}
export function stopSpeech(ownerId?: string): void {
  if (!active || (ownerId && active.id !== ownerId)) return;
  const owner = active;
  try { release(owner); } finally { publish({ ownerId: owner.id, status: "stopped" }); }
}
export function releaseSpeechSurface(ownerId: string): void {
  if (active?.id === ownerId) stopSpeech(ownerId);
}
export function pauseSpeech(): void {
  const owner = active;
  if (!owner) return;
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
    if (active === owner) publish({ ...snapshot, status: "speaking" });
  } catch { fail(owner); }
}
function fail(owner: Owner): void {
  if (active !== owner) return;
  try { release(owner); } finally { publish({ ownerId: owner.id, status: "error", error: "The browser could not read this message aloud." }); }
}
export function startSpeech(id: string, text: string, preferences: SpeechPreferencesDto, surface: () => HTMLElement | null): void {
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
    utterance.onstart = () => { if (active === owner && snapshot.status !== "paused") publish({ ownerId: id, status: "speaking" }); };
    utterance.onend = () => { if (active === owner) stopSpeech(id); };
    utterance.onerror = () => fail(owner);
    // cancel() removes old utterances but preserves the browser's paused state.
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    if (active !== owner) return;
    window.speechSynthesis.speak(utterance);
    if (active === owner) publish({ ownerId: id, status: "speaking" });
  } catch { fail(owner); }
}
