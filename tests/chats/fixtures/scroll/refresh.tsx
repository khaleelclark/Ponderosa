import React, { Profiler, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useEventCallback } from '@mui/material/utils';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MainConversationTimeline } from '../../../../apps/web/src/components/ConversationView.parts';
import { createPonderosaTheme } from '../../../../apps/web/src/theme';
import type { MainTimelineEntry } from '../../../../apps/web/src/components/ConversationView.helpers';
const client=new QueryClient({defaultOptions:{queries:{enabled:false,staleTime:Infinity}}});
client.setQueryData(['workspace-preferences'],{});
const theme=createPonderosaTheme('dark');
const at='2026-10-20T12:00:00Z', health=new Map(), noop=()=>{}, title=()=> 'Fixture Agent', agentForHandle=()=>undefined;
const prose='#operator A representative reply with **formatting** and a table.\n\n| Area | Result |\n| --- | --- |\n| Rendering | Preserve links and identities |\n\nThe reader must be able to scroll without reparsing unchanged messages during a background status refresh.\n\n';
const timeline:MainTimelineEntry[]=Array.from({length:100},(_,i)=>({kind:'message',id:`refresh-${i}`,at,message:{id:`refresh-${i}`,conversationId:'fixture',role:'assistant',authorAgentId:'fixture',text:prose.repeat(3),createdAt:at}}));
export function RefreshProbe(){
 const [tick,setTick]=useState(0),[report,setReport]=useState('Compare ?refresh=unstable with ?refresh=stable. Real memoized message rows; no server.'),[navigation,setNavigation]=useState('');
 const durations=useRef<number[]>([]),collect=useRef(false);
 const navigate=()=>setNavigation(`Latest navigation tick: ${tick}`), stableNavigate=useEventCallback(navigate);
 const stable=new URLSearchParams(location.search).get('refresh')==='stable';
 const run=async()=>{
  setReport('Starting; leave this tab visible until the result appears.');await new Promise(resolve=>setTimeout(resolve,2000));
  durations.current=[];collect.current=true;
  for(let i=1;i<=3;i++){await new Promise(resolve=>setTimeout(resolve,200));flushSync(()=>setTick(value=>value+1));}
  collect.current=false;setReport(JSON.stringify({stable,refreshes:durations.current.length,renderMs:durations.current.map(ms=>Number(ms.toFixed(2))),totalMs:Number(durations.current.reduce((a,b)=>a+b,0).toFixed(2))},null,2));
 };
 return <QueryClientProvider client={client}><ThemeProvider theme={theme}><CssBaseline/><main style={{height:'100dvh',display:'flex',flexDirection:'column'}}><header style={{padding:12}}><button onClick={()=>void run().catch(e=>setReport(String(e)))}>Replay three background refreshes</button><button onClick={stable?stableNavigate:navigate}>Check current navigation</button><pre role="status">{report}</pre><p>{navigation}</p></header><section style={{flex:1,minHeight:0,overflow:'auto'}}><Profiler id="messages" onRender={(_id,phase,ms)=>{if(collect.current&&phase==='update')durations.current.push(ms)}}><MainConversationTimeline mainTimeline={timeline} projectId="fixture" healthByAgentId={health} agentTitle={title} agentIdForHandle={agentForHandle} onOpenAgent={stable?stableNavigate:navigate} mentionAgent={noop} markCommunicationVisible={noop} notifications={[]}/></Profiler></section></main></ThemeProvider></QueryClientProvider>;
}
