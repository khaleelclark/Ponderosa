import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../src/api";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { ConversationView } from "../src/components/ConversationView";
import { useWorkspaceStream } from "../src/hooks/useWorkspaceStream";
import { AgentDetail } from "../src/components/AgentDetail";
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
// Synthetic browser speech only: these shims never touch a microphone/service.
const stats = { spoken: [] as string[], starts: 0, stops: 0, echoCapture: 0 };
let recognition: any; let utterance: any; const recognitions: any[] = []; const utterances: any[] = [];
const timers = new Set<number>();
const setTimer = window.setTimeout.bind(window), clearTimer = window.clearTimeout.bind(window);
window.setTimeout = ((fn: () => void, ms: number, ...args: any[]) => {
  const track = [120000,1500,5000,3000,200].includes(ms);
  let id: number;
  id = setTimer(() => { timers.delete(id); fn(...args); }, ms);
  if (track) timers.add(id); return id;
}) as any;
window.clearTimeout = ((id: number) => { timers.delete(id); clearTimer(id); }) as any;
const intervals = new Set<number>(); const phraseIntervals = new Set<number>();
const setIntervalNative=window.setInterval.bind(window),clearIntervalNative=window.clearInterval.bind(window);
window.setInterval=((fn:TimerHandler,ms?:number,...args:any[])=>{const id=setIntervalNative(fn,ms,...args);if(ms===5000||ms===900)intervals.add(id);if(ms===900)phraseIntervals.add(id);return id;}) as any;
window.clearInterval=((id:number)=>{intervals.delete(id);phraseIntervals.delete(id);clearIntervalNative(id);}) as any;
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
  start() { stats.starts++; this.onstart?.(); }
  stop() { stats.stops++; this.onend?.(); }
  abort() { stats.stops++; }
}
Object.defineProperty(window, "SpeechRecognition", { value: Recognition, configurable: true });
Object.defineProperty(window, "SpeechSynthesisUtterance", { value: class { constructor(public text: string) { utterances.push(this); } }, configurable: true });
Object.defineProperty(window, "speechSynthesis", { value: {
  speak(item: any) { utterance=item; if(recognitions.some(r=>r.onresult))stats.echoCapture++; stats.spoken.push(item.text); item.onstart?.(); }, cancel() {}, pause() {}, resume() {},
}, configurable: true });
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const preferences=await api.getWorkspacePreferences();
client.setQueryData(queryKeys.workspacePreferences.all, preferences);
let context=await (await fetch("/review-context")).json();
document.body.innerHTML = '<div id="root"></div><div id="read" style="width:100px;height:30px">Read aloud</div>';
let update: (value: typeof context) => void;
function WorkspaceEvents() { useWorkspaceStream(); return null; }
function Fixture() {
  const [current,setCurrent] = useState(context); update = next => { context=next; flushSync(() => setCurrent(next)); };
  const noop=()=>{};
  return <QueryClientProvider client={client}><MutationNotificationProvider><WorkspaceEvents /><div style={{height:700,display:"flex",flexDirection:"column"}}>{current.surface === "chat" ? <ConversationView
    conversationId={current.conversationId} engines={current.engines} engineCapabilities={[]}
    onRefreshCapabilities={noop} statusByAgentId={new Map()} healthByAgentId={new Map()}
    projectAgents={current.agents} preferences={preferences} onPreferences={noop}
    onOpenProject={noop} onOpenProjectBrowser={noop} onOpenAgent={noop} onAgentsDeleted={noop}
    onOpenAgentWork={noop} onOpenBrowser={noop} onNewAgent={noop} onNavigateTrigger={noop}
    onCreateTrigger={noop} onDeleted={noop}
  /> : <AgentDetail
    agentId={current.selectedAgentId} projectId={current.projectId} auditOnly={current.auditOnly} initialView={current.view ?? "chat"}
    engines={current.engines} engineCapabilities={[]} agents={current.agents} conversations={current.conversations}
    statusByAgentId={new Map()} healthByAgentId={new Map()} onRefreshCapabilities={noop}
    onOpenTechnicalDetails={noop} onOpenProject={noop} onOpenAgent={noop} onOpenAgentSettings={noop}
    onOpenCommunicationSource={noop} onOpenMaster={noop} onOpenArtifact={noop} onOpenReview={noop}
    onOpenBrowser={noop} onNewSubagent={noop} onCreateTrigger={noop} onDeleted={noop} onAgentsDeleted={noop}
  />}</div></MutationNotificationProvider></QueryClientProvider>;
}
let app = createRoot(document.getElementById("root")!); app.render(<React.StrictMode><Fixture /></React.StrictMode>);
Object.assign(window, { voiceTest: { stats,
  final(text: string) { recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); },
  recognized(text: string) { this.final(text); recognition.onend?.(); }, complete() { utterance.onend?.(); },
  listenerCounts() {return Object.fromEntries([...listeners].map(([key,set])=>[key,set.size]));},
  resources() { return {recognition:recognitions.filter(r=>r.onresult || r.onend || r.onstart || r.onerror || r.onspeechend).length,synthesis:utterances.filter(u=>u.onend || u.onstart || u.onerror).length,timers:timers.size,intervals:intervals.size,phraseIntervals:phraseIntervals.size,monitors:monitors.size}; },
  // Archive only the owned disposable fixture Agent through the real API;
  // wait for its canonical projection rather than racing a remount/cache patch.
  async archived() { await api.updateAgent(context.selectedAgentId, {archived:true}); await client.invalidateQueries({queryKey:queryKeys.agents.detailPrefix(context.selectedAgentId)}); },
  mode(patch: object) { update({...context,...patch}); },
  unmount() { if (document.getElementById("root")?.childNodes.length) app.unmount(); client.clear(); },
} });
