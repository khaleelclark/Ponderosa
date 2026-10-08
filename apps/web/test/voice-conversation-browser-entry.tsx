import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_SPEECH_PREFERENCES } from "@ponderosa/core";
import { api } from "../src/api";
import { DictationControls } from "../src/components/speech/DictationControls";
import { queryKeys } from "../src/queryKeys";
const stats = { sends: [] as unknown[], spoken: [] as string[], starts: 0, stops: 0, fail: false, waiting: false, finalOnStop: false, hangStop: false };
let recognition: any; let utterance: any;
class Recognition {
  onstart?: () => void; onend?: () => void; onresult?: (e: unknown) => void;
  constructor() { recognition = this; }
  start() { stats.starts++; this.onstart?.(); }
  stop() { stats.stops++; if (stats.hangStop) return; if (stats.finalOnStop) this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Final words on pause" } }] }); this.onend?.(); }
  abort() { stats.stops++; }
}
Object.defineProperty(window, "SpeechRecognition", { value: Recognition });
Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { constructor(public text: string) {} } });
Object.defineProperty(window, "speechSynthesis", { value: {
  speak(item: any) { utterance = item; stats.spoken.push(item.text); item.onstart?.(); }, cancel() {}, pause() {}, resume() {},
} });
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
client.setQueryData(queryKeys.workspacePreferences.all, { speech: DEFAULT_SPEECH_PREFERENCES });
api.sendMultiAgentDirectMessage = async (_id, request) => {
  stats.sends.push(request);
  if (stats.fail) throw new Error("Simulated lost response");
  return { messageId: "message", replayed: false, recipients: [{ agentId: "agent", queued: false }] };
};
api.getConversation = async () => ({ messages: [
  { id: "message", conversationId: "chat", role: "user", deliveryReceipts: [{ targetAgentId: "agent", state: stats.waiting ? "started" : "processed", executionId: "run" }] },
  { id: "reply", conversationId: "chat", role: "assistant", authorAgentId: "agent", communicationIntent: "user_dm", executionId: "run", text: "Your exact reply." },
] }) as any;
document.body.innerHTML = '<div id="root"></div>';
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><DictationControls disabled={false} onFinalTranscript={text => { document.getElementById("draft")!.textContent += text; }} onSettlingChange={() => {}} talkContext={{ projectId: "project", conversationId: "chat", agents: [{ id: "agent", title: "Test Agent", archived: false } as any] }} /><div id="draft" /></QueryClientProvider>);
Object.assign(window, { voiceTest: { stats,
  recognized(text: string) { recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); recognition.onend?.(); },
  complete() { utterance.onend?.(); },
  staleResult() { return recognition.onresult; },
  staleEnd() { return recognition.onend; },
  failRecognition(error: string) { recognition.onerror?.({error}); },
} });
