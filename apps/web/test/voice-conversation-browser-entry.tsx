import React, { useState } from "react";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { createPonderosaTheme } from "../src/theme";
const theme = createPonderosaTheme("dark");
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_SPEECH_PREFERENCES } from "@ponderosa/core";
import { api } from "../src/api";
import { DictationControls } from "../src/components/speech/DictationControls";
import { startSpeech, startSpeechQueue, stopSpeech } from "../src/components/speech/speechCoordinator";
import { prepareVoiceCallAttempt } from "../src/components/speech/voiceCallAttempt";
import { durableSubmissionFingerprint } from "../src/components/idempotentAttempt";
import { readBrowserStorage } from "../src/browserStorage";
import { queryKeys } from "../src/queryKeys";
const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
for (const [target,label] of [[window,"window"],[document,"document"]] as const) {
  const add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target);
  target.addEventListener=((type: string,listener: EventListenerOrEventListenerObject,options: any)=>{
    if (["pagehide","popstate","hashchange","visibilitychange","resize"].includes(type)) {
      const key=label+":"+type;if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key)!.add(listener);
    }
    add(type,listener,options);
  }) as typeof target.addEventListener;
  target.removeEventListener=((type: string,listener: EventListenerOrEventListenerObject,options: any)=>{
    listeners.get(label+":"+type)?.delete(listener);remove(type,listener,options);
  }) as typeof target.removeEventListener;
}
const stats = { sends: [] as any[], spoken: [] as string[], starts: 0, stops: 0, fail: false, waiting: false, finalOnStop: false, hangStop: false, hangStart: false, hangSpeech: false, failSpeech: false, holdSend: false, holdRead: false, noWindow: false, ambiguous: false, artifact: false, wrongReply: false, blocked: false, fastDeadline: false, storageDenied: false, echoCapture: 0, reads: 0, cancelThrows: false, failureStatus: undefined as number | undefined };
let recognition: any; let utterance: any; const recognitions: any[] = []; const utterances: any[] = [];
let sendResolve: (() => void) | undefined; let readResolve: (() => void) | undefined;
const timers = new Set<number>();
const setTimer = window.setTimeout.bind(window), clearTimer = window.clearTimeout.bind(window);
window.setTimeout = ((fn: () => void, ms: number, ...args: any[]) => {
  const track = [120000,1500,5000,3000,200].includes(ms);
  let id: number;
  id = setTimer(() => { timers.delete(id); fn(...args); }, ms === 120000 && stats.fastDeadline ? 100 : ms);
  if (track) timers.add(id); return id;
}) as any;
window.clearTimeout = ((id: number) => { timers.delete(id); clearTimer(id); }) as any;
const intervals = new Set<number>(); const phraseIntervals = new Set<number>();
const setIntervalNative = window.setInterval.bind(window), clearIntervalNative = window.clearInterval.bind(window);
window.setInterval = ((fn: TimerHandler, ms?: number, ...args: any[]) => {
  const id = setIntervalNative(fn, ms, ...args); if (ms === 5000 || ms === 900) intervals.add(id); if(ms===900)phraseIntervals.add(id); return id;
}) as any;
window.clearInterval = ((id: number) => { intervals.delete(id); phraseIntervals.delete(id); clearIntervalNative(id); }) as any;
const monitors = new Set<object>();
for (const name of ["MutationObserver", "ResizeObserver"] as const) {
  const Native = window[name];
  Object.defineProperty(window, name, { value: class extends Native {
    observe(...args: any[]) {
      const [target,options] = args;
      if (name === "MutationObserver" ? options?.attributeFilter?.includes("inert") : target?.classList?.contains("MuiDialogContent-root") || target?.querySelector?.("button[aria-label*=voice],button[aria-label*=Voice]") || target?.id === "read") monitors.add(this);
      (super.observe as any)(...args);
    }
    disconnect() { monitors.delete(this); super.disconnect(); }
  }, configurable: true });
}
class Recognition {
  onstart?: () => void; onend?: () => void; onresult?: (e: unknown) => void;
  constructor() { recognition = this; recognitions.push(this); }
  start() { stats.starts++; if (!stats.hangStart) this.onstart?.(); }
  stop() { stats.stops++; if (stats.hangStop) return; if (stats.finalOnStop) this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Final words on finish" } }] }); this.onend?.(); }
  abort() { stats.stops++; }
}
Object.defineProperty(window, "SpeechRecognition", { value: Recognition, configurable: true });
Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { constructor(public text: string) { utterances.push(this); } }, configurable: true });
Object.defineProperty(window, "speechSynthesis", { value: {
  speak(item: any) { utterance = item; stats.spoken.push(item.text); if (recognitions.some(r => r.onresult)) stats.echoCapture++; if (stats.failSpeech) item.onerror?.(); else if (!stats.hangSpeech) item.onstart?.(); }, cancel() { if (stats.cancelThrows) throw Error("Synthetic audio cleanup failure"); }, pause() {}, resume() {},
}, configurable: true });
const storageGet = Storage.prototype.getItem, storageSet = Storage.prototype.setItem;
Storage.prototype.getItem = function(k) { if (stats.storageDenied) throw Error("denied"); return storageGet.call(this,k); };
Storage.prototype.setItem = function(k,v) { if (stats.storageDenied) throw Error("denied"); storageSet.call(this,k,v); };
window.sessionStorage.setItem("ponderosa.workspace.instance.v1", "fixture-server-one");
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
client.setQueryData(queryKeys.workspacePreferences.all, { speech: DEFAULT_SPEECH_PREFERENCES });
let context = { projectId: "project", conversationId: "chat", agents: [{ id: "agent", projectId: "project", conversationId: "chat", title: "Test Agent", archived: false } as any], selectedAgentId: "agent", lockAgent: true };
const streamHandlers = new Set<any>();
let recovered = false;
const cancelledRuns: any[] = [];
api.cancelRun = async (_id, payload) => { cancelledRuns.push(payload); return {} as any; };
api.subscribeAgent = (_id, _cursor, handlers) => { streamHandlers.add(handlers); return { close() { streamHandlers.delete(handlers); } }; };
api.getVoiceReplyStatus = async () => ({ messageId: currentMessageId, acceptedAt: "2026-10-10T00:00:00.000Z", runId: "run", runStartedAt: "2026-10-10T00:00:00.050Z" });
let canonicalText = "Your exact reply.";
let currentMessageId = "message"; const messageIds = new Map<string, string>();
const sent = () => ({ id: currentMessageId, conversationId: context.conversationId, role: "user", text: stats.sends.at(-1)?.text ?? "", communicationIntent: "user_dm", deliveryReceipts: [{ targetAgentId: "agent", state: recovered ? "recovered" : stats.waiting ? "started" : "processed", executionId: "run", ...(recovered ? { recoveryExecutionId: "recovery-run" } : {}) }] });
api.sendMultiAgentDirectMessage = async (_id, request) => {
  stats.sends.push(structuredClone(request));
  if (!messageIds.has(request.idempotencyKey!)) messageIds.set(request.idempotencyKey!, `message-${messageIds.size + 1}`);
  currentMessageId = messageIds.get(request.idempotencyKey!)!;
  if (stats.holdSend) await new Promise<void>(resolve => { sendResolve = resolve; });
  if (stats.fail) throw Object.assign(new Error("Simulated lost response"), { status: stats.failureStatus });
  return { messageId: currentMessageId, message: sent(), replayed: false, recipients: [{ agentId: "agent", queued: stats.waiting }] } as any;
};
api.getConversation = async () => {
  stats.reads++;
  if (stats.holdRead) await new Promise<void>(resolve => { readResolve = resolve; });
  const reply = { id: `reply-${currentMessageId}`, conversationId: context.conversationId, role: "assistant", authorAgentId: stats.wrongReply ? "other" : "agent", communicationIntent: "user_dm", executionId: recovered ? "recovery-run" : "run", text: canonicalText, ...(stats.artifact ? {document: {artifactId:"artifact"}} : {}) };
  return { conversation: { id: context.conversationId, projectId: context.projectId, archived: stats.blocked }, agents: context.agents, messages: [...(stats.noWindow ? [] : [sent()]),reply,...(stats.ambiguous ? [{...reply,id:"second"}] : [])] } as any;
};
document.body.innerHTML = '<div id="root"></div><div id="read" style="width:100px;height:30px">Read aloud</div>';
let update: (value: typeof context) => void;
function Fixture() {
  const [current,setCurrent] = useState(context); update = next => { context=next; flushSync(() => setCurrent(next)); };
  return <ThemeProvider theme={theme}><CssBaseline /><QueryClientProvider client={client}><DictationControls disabled={false} onFinalTranscript={text => { document.getElementById("draft")!.textContent += text; }} onSettlingChange={() => {}} talkContext={current} /><div id="draft" /></QueryClientProvider></ThemeProvider>;
}
let app = createRoot(document.getElementById("root")!); app.render(<React.StrictMode><Fixture /></React.StrictMode>);
Object.assign(window, { voiceTest: { stats,
  cancelledRuns,
  recover() { recovered = true; stats.waiting = false; return client.invalidateQueries({queryKey:queryKeys.conversations.detailPrefix(context.conversationId)}); },
  stream(text: string, sequence: number, patch = {}) {
    const reply = { projectId: context.projectId, conversationId: context.conversationId, agentId: "agent", messageId: currentMessageId,
      runId: "run", fence: 1, streamId: "stream", itemId: "item", providerTurnId: "provider-turn", sequence, text, state: "streaming",
      acceptedAt: "2026-10-10T00:00:00.000Z", runStartedAt: "2026-10-10T00:00:00.050Z", firstTextAt: "2026-10-10T00:00:00.100Z", ...patch };
    for (const handlers of streamHandlers) handlers.onEvent({ agentId: "agent", seq: sequence, ts: "fixture", event: { type: "voice_reply", reply } });
  },
  canonical(text: string) { canonicalText = text; stats.waiting = false; return this.wake(); },
  streamCount() { return streamHandlers.size; },
  audioStart() { utterance?.onstart?.(); },
  lateAudio() { return { start: utterance?.onstart, end: utterance?.onend }; },
  queue() { const q = startSpeechQueue("queue-test", DEFAULT_SPEECH_PREFERENCES, () => document.getElementById("read")); q.append("First."); q.append("Second."); q.finish(); return q; },
  final(text: string) { recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); },
  interim(text: string) { recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: text } }] }); },
  recognized(text: string) { this.final(text); recognition.onend?.(); },
  speechEnd() { recognition.onspeechend?.(); }, emptyEnd() { recognition.onend?.(); },
  complete() { utterance.onend?.(); }, failPlayback() { utterance.onerror?.(); },
  wake() { return client.invalidateQueries({queryKey:queryKeys.conversations.detailPrefix(context.conversationId)}); },
  wakeOther() { return client.invalidateQueries({queryKey:queryKeys.conversations.detailPrefix("unrelated")}); },
  staleResult() { return recognition.onresult; }, staleEnd() { return recognition.onend; },
  staleSpeech() { return utterance.onend; }, startCallback() { return recognition.onstart; },
  failRecognition(error: string) { recognition.onerror?.({error}); },
  releaseSend() { stats.holdSend=false; sendResolve?.(); }, releaseRead() { stats.holdRead=false; readResolve?.(); },
  async seedLegacy(text: string, patch = {}) {
    const route = {origin:location.origin,product:"/api/conversations",projectId:"project",conversationId:"chat",agentId:"agent"};
    const a = await prepareVoiceCallAttempt(route,text,()=> "legacy-key");
    const {idempotencyKey, ...identity} = a.marker;
    const {voiceReply, ...request} = a.request;
    sessionStorage.setItem(`ponderosa.voice.pending.v1:${JSON.stringify(route)}`,JSON.stringify({...identity,fingerprint:await durableSubmissionFingerprint(request),version:1,request,...patch}));
  },
  fallbackMarker() { const route={origin:location.origin,product:"/api/conversations",projectId:"project",conversationId:"chat",agentId:"agent"}; return readBrowserStorage("sessionStorage",`ponderosa.voice.pending.v1:${JSON.stringify(route)}`); },
  remount() { app=createRoot(document.getElementById("root")!);app.render(<React.StrictMode><Fixture /></React.StrictMode>); },
  listenerCounts() {return Object.fromEntries([...listeners].map(([key,set])=>[key,set.size]));},
  resources() { return {recognition:recognitions.filter(r=>r.onresult || r.onend || r.onstart || r.onerror || r.onspeechend).length,synthesis:utterances.filter(u=>u.onend || u.onstart || u.onerror).length,timers:timers.size,intervals:intervals.size,phraseIntervals:phraseIntervals.size,monitors:monitors.size}; },
  readAloud() { startSpeech("fixture-read", "Ordinary read aloud", DEFAULT_SPEECH_PREFERENCES, () => document.getElementById("read")); }, stopRead() {stopSpeech("fixture-read");},
  sharedAgents(single = false) { update({...context,selectedAgentId:undefined,lockAgent:false,agents:[context.agents[0],...(!single ? [{...context.agents[0],id:"other",title:"Other Agent"}] : []),{...context.agents[0],id:"archived",archived:true}]} as any); },
  deleteAgent() { update({...context,agents:[]}); }, switchChat() { update({...context,conversationId:"other-chat",agents:context.agents.map(a=>({...a,conversationId:"other-chat"}))}); },
  unmount() { if (document.getElementById("root")?.childNodes.length) app.unmount(); }, noSTT() { Object.defineProperty(window,"SpeechRecognition",{value:undefined,configurable:true}); },
  insecure() { Object.defineProperty(window,"isSecureContext",{value:false,configurable:true}); },
  noTTS() { Object.defineProperty(window,"speechSynthesis",{value:undefined,configurable:true}); },
} });
