import { DEFAULT_SPEECH_PREFERENCES } from "@ponderosa/core";
import * as coordinator from "../src/components/speech/speechCoordinator";
const stats = { requests: 0, starts: 0, cancels: 0, completions: 0 };
let utterance: any;
Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { constructor(public text: string) {} } });
Object.defineProperty(window, "speechSynthesis", { value: {
  speak(item: any) { utterance = item; stats.starts++; item.onstart?.(); },
  cancel() { stats.cancels++; }, pause() {}, resume() {},
} });
window.fetch = async () => { stats.requests++; throw new Error("Speech must not use a server"); };
document.body.innerHTML = '<div id="one" style="width:300px;height:60px">Message one</div><div id="two" style="width:300px;height:60px">Message two</div>';
Object.assign(window, { speechTest: {
  ...coordinator, stats,
  start(id: string) { coordinator.startSpeech(id, "Hello.", DEFAULT_SPEECH_PREFERENCES, () => document.getElementById(id), () => stats.completions++); },
  end() { utterance.onend?.(); },
  fail() { utterance.onerror?.(); },
  staleEnd() { return utterance.onend; },
} });
