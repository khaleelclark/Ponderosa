// Isolated real-UI fixture: all API/stream traffic stays mocked, never reaching live Agents.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider,CssBaseline} from '@mui/material';
import {BranchPinecone} from '../src/components/pinecone/BranchPinecone';
import {createPonderosaTheme} from '../src/theme';
import '../src/global.css';
const requests: Array<{path:string;body:Record<string,string>}> = [];
const messages: Array<Record<string,unknown>> = [];
let renderProof = () => {};
let failId = true;
Object.defineProperty(crypto,'randomUUID',{configurable:true,get(){
  if(!failId)return undefined;
  return () => {failId=false;throw new Error('Injected local ID failure');};
}});
class QuietStream {readyState=1;onopen=null;onerror=null;onmessage=null;addEventListener(){}removeEventListener(){}close(){}}
window.EventSource=QuietStream as unknown as typeof EventSource;
window.fetch=async(input,init)=>{
  const path=new URL(String(input),location.origin).pathname;
  let data:unknown={};
  if(init?.method==='POST'){
    const body=JSON.parse(String(init.body));requests.push({path,body});renderProof();
    if(path.endsWith('/messages')){
      if(!messages.length){messages.push({id:'fixture-message',role:'user',communicationIntent:'user_dm',text:body.text,createdAt:new Date().toISOString()});throw new Error('Injected lost acknowledgement');}
      data={messageId:'fixture-message',queued:false};
    }else data={id:'fixture-check'};
  }else if(path.endsWith('/configuration'))data={agents:{spokesperson:'fixture-agent'},directories:{}};
  else if(path.endsWith('/contexts/fixture-chat'))data={branchId:'fixture'};
  else if(path.endsWith('/agents/fixture-agent'))data={agent:{id:'fixture-agent',projectId:'fixture-project',conversationId:'fixture-chat',archived:false},messages,runs:[],decisionEvents:[]};
  else if(path.endsWith('/trigger'))data={id:'fixture-trigger',enabled:true,sourceKind:'schedule',sourceConfig:{everyMs:600000},fullAccess:true};
  else if(path==='/api/branches/fixture')data={id:'fixture',enabled:true,triggerId:'fixture-trigger',activeExecutions:0,bindingRevisionId:'v1'};
  else if(path.endsWith('/engines'))data=[];
  else if(path.endsWith('/notifications'))data={notifications:[],unreadUpdateCount:0,unacknowledgedActionCount:0};
  return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
};
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function Fixture(){
  const [proof,setProof]=React.useState('');
  renderProof=()=>setProof(JSON.stringify({requests,deliveredMessages:messages.length}));
  return <><BranchPinecone route={{branchId:'fixture',tab:'pinecone'}} onNavigate={()=>false}/><pre aria-label="Fixture evidence">{proof}</pre></>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider theme={createPonderosaTheme('dark')}><CssBaseline/><QueryClientProvider client={client}><Fixture/></QueryClientProvider></ThemeProvider>);
