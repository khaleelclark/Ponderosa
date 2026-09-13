import { DEFAULT_SPEECH_PREFERENCES } from "@ponderosa/core";
import * as coordinator from "../src/components/speech/speechCoordinator";

const stats = { requests: 0, aborts: 0, urls: 0, revokes: 0, browserStarts: 0, browserCancels: 0, delay: false };
const audios: FakeAudio[] = [];
class FakeAudio {
  src = ""; paused = true; onended: null | (() => void) = null; onerror: null | (() => void) = null;
  constructor() { audios.push(this); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() { this.src = ""; }
}
if (!new URLSearchParams(location.search).has("native")) {
Object.defineProperty(window, "Audio", { value: FakeAudio });
Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { onstart?: () => void; onend?: () => void; onerror?: () => void } });
Object.defineProperty(window, "speechSynthesis", { value: { speak(utterance: { onstart?(): void }) { stats.browserStarts++; utterance.onstart?.(); }, cancel() { stats.browserCancels++; }, pause() {}, resume() {} } });
URL.createObjectURL = () => { stats.urls++; return `blob:test-${stats.urls}`; };
URL.revokeObjectURL = () => { stats.revokes++; };
window.fetch = async (url, options) => {
  if (url !== "/api/speech/synthesize") throw new Error("Unexpected network request");
  stats.requests++;
  if (stats.delay) await new Promise<void>((resolve, reject) => { options?.signal?.addEventListener("abort", () => { stats.aborts++; reject(new DOMException("Aborted", "AbortError")); }, { once: true }); });
  return new Response(new Blob([new Uint8Array(48)]), { headers: { "Content-Type": "audio/wav", "Content-Length": "48" } });
};
}
document.body.innerHTML = '<div id="one" style="width:300px;height:60px">Message one</div><div id="two" style="width:300px;height:60px">Settings</div>';
const playButton=document.createElement("button");playButton.id="native-play";playButton.textContent="Read local voice";document.body.append(playButton);
playButton.onclick=()=>coordinator.startSpeech("one","Hello. Your update is ready, and you can review it whenever you like.","kokoro",DEFAULT_SPEECH_PREFERENCES,()=>document.getElementById("one"));
Object.assign(window, { speechTest: {
  ...coordinator, stats,
  start(id: string, engine: "browser" | "kokoro", text = "Hello. This is a short message.") { coordinator.startSpeech(id, text, engine, DEFAULT_SPEECH_PREFERENCES, () => document.getElementById(id)); },
  endAudio() { audios.at(-1)?.onended?.(); },
  handoff() { coordinator.handoffSpeechToSettings(); coordinator.attachSettingsSpeechSurface(document.getElementById("two")!); },
} });
