/** Browser read-aloud preferences. */
export interface SpeechPreferencesDto { speed: number }
export const DEFAULT_SPEECH_PREFERENCES: Readonly<SpeechPreferencesDto> = { speed: 1 };
export function validSpeechPreferences(value: unknown): value is SpeechPreferencesDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => key === "speed") &&
    typeof v.speed === "number" && Number.isFinite(v.speed) && v.speed >= .75 && v.speed <= 1.25;
}
/** Drop retired provider fields from saved preferences without rewriting history. */
export function normalizeSpeechPreferences(value: unknown): SpeechPreferencesDto {
  const speed = value && typeof value === "object" ? (value as Record<string, unknown>).speed : undefined;
  return { speed: typeof speed === "number" && Number.isFinite(speed) && speed >= .75 && speed <= 1.25 ? speed : 1 };
}
