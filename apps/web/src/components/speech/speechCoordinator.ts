import { segmentSpeechText, SPEECH_VOICES, type SpeechPreferencesDto } from "@ponderosa/core";
import { synthesizeSpeech } from "./speechApi";
import { monitorSpeechSurfaceAccessibility } from "./speechSurfaceAccessibility";

export type PlaybackStatus = "idle" | "loading" | "speaking" | "paused" | "stopped" | "error";
interface Snapshot { ownerId?: string; status: PlaybackStatus; error?: string; engine?: "browser" | "kokoro" }
interface Owner {
  id: string;
  engine: "browser" | "kokoro";
  controller: AbortController;
  audio?: HTMLAudioElement;
  utterance?: SpeechSynthesisUtterance;
  urls: Set<string>;
  cleanup?: () => void;
  handedOff: boolean;
  handoffTimer?: ReturnType<typeof setTimeout>;
  paused: boolean;
  resume?: () => void;
}
let active: Owner | undefined;
let snapshot: Snapshot = { status: "idle" };
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => { snapshot = next; for (const listener of listeners) listener(); };
export const subscribeSpeech = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const speechSnapshot = () => snapshot;

function release(owner: Owner): void {
  if (active === owner) active = undefined;
  owner.controller.abort();
  clearTimeout(owner.handoffTimer);
  try { owner.cleanup?.(); } catch { /* Ownership is already fenced. */ }
  owner.resume?.();
  if (owner.audio) { owner.audio.pause(); owner.audio.removeAttribute("src"); owner.audio.load(); }
  if (owner.utterance) {
    owner.utterance.onend = null; owner.utterance.onerror = null; owner.utterance.onstart = null;
    try { window.speechSynthesis.cancel(); } catch { /* Browser cancellation is best-effort after fencing. */ }
  }
  for (const url of owner.urls) URL.revokeObjectURL(url);
  owner.urls.clear();
}
export function stopSpeech(ownerId?: string): void {
  if (!active || (ownerId && active.id !== ownerId)) return;
  const owner = active;
  try { release(owner); } finally { publish({ ownerId: owner.id, engine: owner.engine, status: "stopped" }); }
}
export function releaseSpeechSurface(ownerId: string): void {
  if (active?.id === ownerId && !active.handedOff) stopSpeech(ownerId);
}
export function handoffSpeechToSettings(): void {
  if (active) {
    const owner = active;
    owner.cleanup?.(); owner.cleanup = undefined; owner.handedOff = true;
    clearTimeout(owner.handoffTimer);
    owner.handoffTimer = setTimeout(() => { if (active === owner) stopSpeech(owner.id); }, 5000);
  }
}
export function stopHandedOffSpeech(): void { if (active?.handedOff) stopSpeech(); }
export function attachSettingsSpeechSurface(element: HTMLElement): () => void {
  const owner = active;
  if (!owner?.handedOff) return () => {};
  clearTimeout(owner.handoffTimer);
  owner.cleanup = monitorSpeechSurfaceAccessibility(() => element, () => stopSpeech(owner.id));
  return () => { if (active === owner) stopSpeech(owner.id); };
}
export function pauseSpeech(): void {
  if (!active) return;
  active.paused = true;
  if (active.audio) active.audio.pause(); else if (active.utterance) window.speechSynthesis.pause();
  publish({ ...snapshot, status: "paused" });
}
export async function resumeSpeech(): Promise<void> {
  const owner = active;
  if (!owner) return;
  owner.paused = false;
  owner.resume?.(); owner.resume = undefined;
  try {
    if (owner.audio?.src) await owner.audio.play(); else if (owner.utterance) window.speechSynthesis.resume();
    if (active === owner) publish({ ...snapshot, status: "speaking" });
  } catch { fail(owner); }
}
function fail(owner: Owner): void {
  if (active !== owner) return;
  try { release(owner); } finally { publish({ ownerId: owner.id, engine: owner.engine, status: "error", error: owner.engine === "kokoro" ? "Local speech stopped. Use browser voice or try again." : "The browser could not read this message aloud." }); }
}
async function localPlayback(owner: Owner, text: string, preferences: SpeechPreferencesDto): Promise<void> {
  const segments = segmentSpeechText(text);
  if (!segments.length) throw new Error("No speakable text");
  const voice = SPEECH_VOICES.find(item => item.id === preferences.kokoroVoice)!;
  const load = (index: number) => synthesizeSpeech({ text: segments[index]!, voice: voice.id, language: voice.language, speed: preferences.speed, segmentId: `${crypto.randomUUID()}-${index}`, priority: index === 0 ? "interactive" : "prefetch" }, owner.controller.signal);
  let next = load(0);
  // One segment playing plus one prefetched blob: no unbounded audio queue.
  for (let index = 0; index < segments.length; index++) {
    const blob = await next;
    if (active !== owner) return;
    if (index + 1 < segments.length) { next = load(index + 1); void next.catch(() => {}); }
    if (owner.paused) await new Promise<void>(resolve => { owner.resume = resolve; });
    if (active !== owner) return;
    const url = URL.createObjectURL(blob); owner.urls.add(url);
    const audio = owner.audio!;
    audio.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clean(); resolve(); };
        const clean = () => { audio.onended = null; audio.onerror = null; owner.controller.signal.removeEventListener("abort", abort); };
        audio.onended = () => { clean(); resolve(); };
        audio.onerror = () => { clean(); reject(new Error("Audio playback failed")); };
        owner.controller.signal.addEventListener("abort", abort, { once: true });
        void audio.play().then(() => { if (active === owner && !owner.paused) publish({ ownerId: owner.id, engine: owner.engine, status: "speaking" }); }, error => { clean(); reject(error); });
      });
    } finally { audio.removeAttribute("src"); audio.load(); if (owner.urls.delete(url)) URL.revokeObjectURL(url); }
    if (active !== owner) return;
  }
  stopSpeech(owner.id);
}
export function startSpeech(id: string, text: string, engine: "browser" | "kokoro", preferences: SpeechPreferencesDto, surface: () => HTMLElement | null): void {
  stopSpeech();
  const owner: Owner = { id, engine, controller: new AbortController(), urls: new Set(), handedOff: false, paused: false };
  active = owner;
  publish({ ownerId: id, engine, status: "loading" });
  try {
    owner.cleanup = monitorSpeechSurfaceAccessibility(surface, () => stopSpeech(id));
    if (active !== owner) return;
    if (engine === "kokoro") {
      owner.audio = new Audio();
      void localPlayback(owner, text, preferences).catch(() => fail(owner));
    } else {
      const utterance = new SpeechSynthesisUtterance(text); owner.utterance = utterance;
      utterance.lang = navigator.language || "en-US";
      utterance.rate = preferences.speed;
      utterance.onstart = () => { if (active === owner) publish({ ownerId: id, engine, status: "speaking" }); };
      utterance.onend = () => { if (active === owner) stopSpeech(id); };
      utterance.onerror = () => fail(owner);
      window.speechSynthesis.speak(utterance);
      if (active === owner) publish({ ownerId: id, engine, status: "speaking" });
    }
  } catch { fail(owner); }
}
