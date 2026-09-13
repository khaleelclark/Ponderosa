import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider,Box,CssBaseline} from '@mui/material';
import '@fontsource-variable/inter';
import {Composer} from '../../src/components/chat/Composer';
import {ComposerRuntimeSelector} from '../../src/components/ComposerRuntimeSelector';
import {useAppViewport} from '../../src/hooks/useAppViewport';
import {createPonderosaTheme} from '../../src/theme';
import '../../src/global.css';
import {ChatMessageBody} from '../../src/components/chat/ChatMessages';
import {TabbedWorkspaceFrame} from '../../src/components/WorkspaceFrame';
import {ProjectSidebarHeader} from '../../src/components/ProjectNavigation';
import {HomeView} from '../../src/components/HomeView';
import {classifyWebPushState,webPushEnableBlockReason} from '../../src/pushNotifications';
import type {ProjectDto} from '@ponderosa/core';

const binding={agentId:'boston',projectId:'project',handle:'Boston',currentHandle:'Boston',currentTitle:'Boston'};
function Fixture(){
 useAppViewport();
 const [sent,setSent]=useState<string[]>([]);
 const mention=new URLSearchParams(location.search).has('mention');
 return <Box id="app-frame" sx={{height:{xs:'var(--ponderosa-app-viewport-block-size, 100dvh)',md:'100%'},display:'flex',flexDirection:'column',minHeight:0}}>
  <div style={{flex:'1 1 0',overflow:'auto'}}><button id="dismiss">Dismiss keyboard</button><p>Isolated conversation. No real messages or provider calls.</p></div>
  <div id="composer"><Composer enableVoiceDictation disabled={false} running={false} destinationMode="project-chat"
   capabilities={Array.from({length:20},(_,i)=>({id:`skill-${i}`,kind:'skill' as const,label:`Example skill ${i}`,description:'Long description that should not crowd the mobile list.',status:'available' as const,insertText:`$skill-${i}`}))}
   controls={<ComposerRuntimeSelector engine="codex" engines={[{id:'codex',label:'Codex'}]} model="astra" models={[{id:'astra',label:'GPT-6-Astra'}]} effort="medium" efforts={[{id:'medium',label:'Medium'}]} onModelChange={()=>{}} onEffortChange={()=>{}} />}
   draftStorageKey="mobile-ios-fixture" mentionHandles={['Boston']} mentionBindings={[binding]}
   defaultDestination={mention?{handle:'Boston',selectionKey:'reply1',binding}:undefined}
   onSend={async(text)=>{setSent(previous=>[...previous,text]);}} /></div>
  <output id="sent" style={{display:'none'}}>{JSON.stringify(sent)}</output>
 </Box>;
}
function AuditFixture(){
 const project={id:'project',label:'A Project With A Recognizable Long Name',hostPath:'/disposable'} as ProjectDto;
 const [tab,setTab]=useState('chat');
 const noop=()=>{};
 const push=[
  {ios:true,standalone:false,supported:false,secure:true,permission:'unsupported' as const},
  {ios:true,standalone:true,supported:true,secure:true,permission:'default' as const},
  {ios:true,standalone:true,supported:true,secure:true,permission:'denied' as const},
  {ios:false,standalone:false,supported:true,secure:true,permission:'default' as const},
 ].map(p=>{const state=classifyWebPushState(p);return {...state,blocked:Boolean(webPushEnableBlockReason(state))};});
 return <div style={{height:'100%',overflowY:'auto'}}>
  <TabbedWorkspaceFrame icon={<span>C</span>} title="Mobile audit chat" tabs={{value:tab,onChange:setTab,label:'Chat views',items:[{value:'chat',label:'Chat'},{value:'team',label:'Team Chat'}]}} />
  <div id="navigation" style={{width:'calc(100% - 64px)',maxWidth:326}}><ProjectSidebarHeader project={project} drawer overviewActive={false} section="chats" counts={{chats:3,agents:5,triggers:1}} runningCount={0} unreadCount={0} onSectionChange={noop} onOpenOverview={noop} onOpenBrowser={noop} onRename={noop} onOpenSettings={noop} onDelete={noop}/></div>
  <div id="markdown" style={{padding:12}}><ChatMessageBody text={'Reading should be comfortable.\n\n| Item | Notes | Status |\n| --- | --- | --- |\n| Example | '+ 'longtoken'.repeat(40) +' | Running |\n\n```text\n'+ 'code'.repeat(60) +'\n```'} /></div>
  <div className="chat-message-action-buttons"><button className="MuiIconButton-root" aria-label="Action target">Copy</button></div>
  <HomeView projects={[project]} projectsLoaded engines={[]} notifications={[]} onNavigate={noop} onCreateProject={noop} onOpenInbox={noop}/>
  <output id="push" style={{display:'none'}}>{JSON.stringify(push)}</output>
 </div>;
}
const params=new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(<ThemeProvider theme={createPonderosaTheme(params.has('light')?'light':'dark')}><CssBaseline/><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{params.has('audit')?<AuditFixture/>:<Fixture/>}</QueryClientProvider></ThemeProvider>);
