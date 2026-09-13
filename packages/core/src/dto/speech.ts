/** Shared product boundary: no model paths, URLs, or runtime arguments. */
export const SPEECH_VOICES = [
  { id: "voice_1", label: "Willow", language: "en-US" },
  { id: "voice_2", label: "Cedar", language: "en-US" },
  { id: "voice_3", label: "Hazel", language: "en-GB" },
] as const;
export type SpeechVoiceId = typeof SPEECH_VOICES[number]["id"];
export interface SpeechPreferencesDto {
  engine: "browser" | "kokoro";
  /** Distinguishes an operator choice from the pre-install default. */
  engineExplicit: boolean;
  kokoroVoice: SpeechVoiceId;
  speed: number;
  localVoiceSuggestion: "unseen" | "dismissed" | "accepted";
}
export const DEFAULT_SPEECH_PREFERENCES: Readonly<SpeechPreferencesDto> = {
  engine: "browser", engineExplicit: false, kokoroVoice: "voice_1", speed: 1,
  localVoiceSuggestion: "unseen",
};
export const SPEECH_LIMITS = {
  segmentCharacters: 200, segmentBytes: 800, playbackCharacters: 20_000,
  segmentTimeoutMs: 15_000, startupTimeoutMs: 15_000,
  outputBytes: 2_880_000, cacheBytes: 32 * 1024 * 1024,
  cacheEntries: 128, cacheAgeMs: 30 * 60 * 1000, queuedJobs: 2,
} as const;
export const SPEECH_PREVIEW_TEXT = "Hello. Your update is ready, and you can review it whenever you like.";
export interface SpeechStatusDto {
  browserFallbackAvailable: true;
  kokoro: {
    state: "not_installed" | "downloading" | "verifying" | "installing" | "ready" |
      "update_available" | "repair_required" | "removing" | "unsupported";
    version?: string;
    progress?: { completedBytes: number; totalBytes?: number };
    installedBytes?: number;
    downloadBytes?: number;
    estimatedInstalledBytes?: number;
    reason?: string;
    platformQualified: boolean;
    packageSource?: "host_package" | "download";
  };
  voices: typeof SPEECH_VOICES;
  cacheBytes: number;
}
export interface SynthesizeSpeechRequest {
  text: string;
  voice: SpeechVoiceId;
  language: "en-US" | "en-GB";
  speed: number;
  segmentId: string;
  priority?: "interactive" | "prefetch";
}
export function validSpeechPreferences(value: unknown): value is SpeechPreferencesDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(k => ["engine", "engineExplicit", "kokoroVoice", "speed", "localVoiceSuggestion"].includes(k)) &&
    (v.engine === "browser" || v.engine === "kokoro") && typeof v.engineExplicit === "boolean" &&
    SPEECH_VOICES.some(voice => voice.id === v.kokoroVoice) &&
    typeof v.speed === "number" && Number.isFinite(v.speed) && v.speed >= .75 && v.speed <= 1.25 &&
    ["unseen", "dismissed", "accepted"].includes(String(v.localVoiceSuggestion));
}

/** Segments cleaned plain text only. No canonical message mutation. */
export function segmentSpeechText(text: string): string[] {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (Array.from(normalized).length > SPEECH_LIMITS.playbackCharacters) throw new Error("This message is too long to read aloud.");
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(normalized)].map(s => s.segment.trim()).filter(Boolean);
  const result: string[] = [];
  for (const sentence of sentences) {
    let remaining = Array.from(sentence);
    while (remaining.length > SPEECH_LIMITS.segmentCharacters) {
      const prefix = remaining.slice(0, SPEECH_LIMITS.segmentCharacters).join("");
      const matches = [...prefix.matchAll(/[;,]\s|\s/gu)];
      const boundary = matches.filter(m => m.index! >= prefix.length / 2).at(-1);
      const count = boundary ? Array.from(prefix.slice(0, boundary.index! + 1)).length : SPEECH_LIMITS.segmentCharacters;
      result.push(remaining.slice(0, count).join("").trim());
      remaining = remaining.slice(count);
    }
    const tail = remaining.join("").trim();
    if (!tail) continue;
    const last = result.at(-1);
    if (last && Array.from(last + " " + tail).length <= SPEECH_LIMITS.segmentCharacters) result[result.length - 1] = last + " " + tail;
    else result.push(tail);
  }
  return result;
}
