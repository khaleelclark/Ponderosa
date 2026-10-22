import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { startSpeechQueue, stopSpeech } from '../src/components/speech/speechCoordinator';
import { VoiceConversation } from '../src/components/speech/VoiceConversation';
import { api } from '../src/api';
import { setStandaloneProductScope } from '../src/api/productScope';
import { createPonderosaTheme } from '../src/theme';
import { queryKeys } from '../src/queryKeys';
const standalone=new URL(location.href).searchParams.get('surface')==='standalone';
if(standalone)setStandaloneProductScope('branches');
const receipts:any[]=[];const utterances:any[]=[];let current:any;
const nativeFetch=window.fetch.bind(window);
window.fetch=(async(...args:Parameters<typeof fetch>)=>{
 const response=await nativeFetch(...args);
 if(String(args[0]).includes('/voice-replies/')){
  const status=await response.clone().json();receipts.push({stage:'exposure_guard_result',at:performance.now(),state:status.memoryExposure?.state});
 }
 return response;
}) as typeof fetch;

let dropMemoryHints=false; let suppressPoll=false;
const intervals=new Map<number,number|undefined>();
const nativeInterval=window.setInterval.bind(window),nativeClearInterval=window.clearInterval.bind(window);
window.setInterval=((fn:any,delay?:number,...args:any[])=>{const id=nativeInterval(delay===250?()=>{if(!suppressPoll)fn(...args);}:fn,delay,...args);intervals.set(id,delay);return id;}) as typeof window.setInterval;
window.clearInterval=((id?:number)=>{if(id!==undefined)intervals.delete(id);nativeClearInterval(id);}) as typeof window.clearInterval;
const sources:EventSource[]=[];const NativeEventSource=window.EventSource;
Object.defineProperty(window,'EventSource',{value:class extends NativeEventSource {constructor(url:string,options?:EventSourceInit){super(url,options);sources.push(this);this.addEventListener('message',event=>{if(dropMemoryHints&&JSON.parse((event as MessageEvent).data).event?.type==='memory_changed'){receipts.push({stage:'dropped_hint',at:performance.now()});event.stopImmediatePropagation();}});this.addEventListener('open',()=>receipts.push({stage:'sse_open',at:performance.now()}));}},configurable:true});
class Recognition { start(){throw Error('No microphone allowed in this fixture');} stop(){} abort(){} }
Object.defineProperty(window,'SpeechRecognition',{value:Recognition,configurable:true});
Object.defineProperty(window,'SpeechSynthesisUtterance',{value:class {constructor(public text:string){utterances.push(this);receipts.push({stage:'utterance_prepared_mock',at:performance.now(),text});}},configurable:true});
Object.defineProperty(window,'speechSynthesis',{value:{speak(u:any){current=u;receipts.push({stage:'queued_mock',at:performance.now(),text:u.text});setTimeout(()=>{if(u.onstart){receipts.push({stage:'onstart_mock',at:performance.now(),text:u.text});u.onstart();}},20);},cancel(){receipts.push({stage:'cancel_mock',at:performance.now()});},pause(){},resume(){}},configurable:true});
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
client.setQueryData(queryKeys.workspacePreferences.all,await api.getWorkspacePreferences());
const context=await(await fetch('/fixture-context')).json();
document.body.innerHTML='<div id="root"></div>';
const observer=new MutationObserver(()=>{const node=document.querySelector('[aria-label="Streaming reply"]');if(node?.textContent&&!receipts.some(x=>x.stage==='ui_text'))receipts.push({stage:'ui_text',at:performance.now(),text:node.textContent});});
observer.observe(document.body,{subtree:true,childList:true,characterData:true});
const app=createRoot(document.getElementById('root')!);
app.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><VoiceConversation open {...context} standalone={standalone} onClose={()=>app.unmount()}/></QueryClientProvider></ThemeProvider>);
Object.assign(window,{incrementalFixture:{receipts,dropHints(){dropMemoryHints=true;},suppressPoll(){suppressPoll=true;},liveStreams(){return sources.filter(s=>s.readyState!==EventSource.CLOSED).length;},async guardRace(mode:string){
 const before=receipts.filter(x=>x.stage==='queued_mock').length;let resolve!:(allowed:boolean)=>void;let checks=0;
 const gate=new Promise<boolean>(r=>resolve=r),prefs={speed:1} as any;
 const queue=startSpeechQueue('old-guard',prefs,()=>document.querySelector('[role=dialog]') as HTMLElement,undefined,undefined,()=>{checks++;return gate;});
 queue.append('Never speak old phrase.');queue.append('Never speak queued phrase.');queue.finish();
 if(mode==='replacement'){const next=startSpeechQueue('new-guard',prefs,()=>document.querySelector('[role=dialog]') as HTMLElement);next.stop();}else stopSpeech('old-guard');
 resolve(true);await Promise.resolve();await Promise.resolve();
 return {checks,queued:receipts.filter(x=>x.stage==='queued_mock').length-before};
},observation(){return {streams:sources.filter(s=>s.readyState!==EventSource.CLOSED).length,exposureTimers:[...intervals.values()].filter(ms=>ms===250).length,conversationObservers:client.getQueryCache().findAll().filter(q=>q.queryKey.includes('voice-reply')).reduce((n,q)=>n+q.getObserversCount(),0)};},nativeError(){current?.onerror?.(new Event('error'));},externalStop(){stopSpeech();},reconnect(){for(const source of sources)if(source.readyState!==EventSource.CLOSED)source.onerror?.call(source,new Event("error"));},complete(){current?.onend?.();},saveLate(){return {start:current?.onstart,end:current?.onend};},async wake(){await client.invalidateQueries({queryKey:queryKeys.conversations.detailPrefix(context.conversationId)});},unmount(){app.unmount();client.clear();observer.disconnect();},handlers(){return utterances.filter(u=>u.onstart||u.onend||u.onerror).length;}}});
