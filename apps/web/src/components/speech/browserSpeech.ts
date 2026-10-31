export type DictationStatus =
  | "ready"
  | "starting"
  | "listening"
  | "pausing"
  | "paused"
  | "stopping"
  | "stopped"
  | "error";

export interface BrowserSpeechRecognitionAlternative {
  transcript: string;
}

export interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionAlternative;
}

export interface BrowserSpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionResult;
}

export interface BrowserSpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: BrowserSpeechRecognitionResultList;
}

export interface BrowserSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}

export interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  unspokenPunctuation?: boolean;
  onspeechend?: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onstart: (() => void) | null;
  abort(): void;
  start(): void;
  stop(): void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
}

export function speechRecognitionConstructor():
  | BrowserSpeechRecognitionConstructor
  | undefined {
  if (typeof window === "undefined") return undefined;
  const speechWindow = window as SpeechRecognitionWindow;
  return (
    speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
  );
}

export function dictationUnavailableReason(): string | undefined {
  if (typeof window === "undefined") return "Dictation is unavailable.";
  if (!window.isSecureContext) {
    return "Voice dictation requires a secure HTTPS connection.";
  }
  if (!speechRecognitionConstructor()) {
    return "Voice dictation is not supported by this browser.";
  }
  return undefined;
}

export function dictationErrorMessage(
  error: string,
  detail?: string,
): string {
  switch (error) {
    case "not-allowed":
      return "Microphone permission was denied. Allow microphone access in this site’s browser settings, then try again.";
    case "service-not-allowed":
      return "The browser’s speech recognition service is disabled or unavailable.";
    case "audio-capture":
      return "No working microphone was found. Check the browser’s audio input, then try again.";
    case "no-speech":
      return "No speech was detected. Try again and speak after listening begins.";
    case "network":
      return "The browser’s speech recognition service could not connect.";
    case "language-not-supported":
      return "The browser does not support speech recognition for this language.";
    default:
      return detail?.trim() || "Voice dictation stopped because of a browser error.";
  }
}

export function speechSynthesisUnavailableReason(): string | undefined {
  if (typeof window === "undefined") return "Read aloud is unavailable.";
  if (
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    return "Read aloud is not supported by this browser.";
  }
  return undefined;
}
