import {CssBaseline,ThemeProvider} from '@mui/material';
import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
import {createRoot} from 'react-dom/client';
import {useAgentStream} from '../src/hooks/useAgentStream';
import {AgentDetailHeader} from '../src/components/AgentDetail.header';
import type {AgentDto} from '@ponderosa/core';
import {queryKeys} from '../src/queryKeys';
import {createPonderosaTheme} from '../src/theme';

declare global {interface Window {canonicalRefreshes:number}}
window.canonicalRefreshes=0;
sessionStorage.setItem('ponderosa.agent.stream-cursors.v1',JSON.stringify([
  ['agent',{lastSeq:145,instanceId:'instance',updatedAt:Date.now()}],
]));
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
const startedAt=new Date(Date.now()-60_000).toISOString();
const agent={id:'agent',projectId:'project',title:'Mesa Verde',handle:'Mesa-Verde'} as AgentDto;
const noop=()=>{};
function Probe() {
  const stream=useAgentStream('agent','project');
  useQuery({queryKey:queryKeys.agents.detailPrefix('agent'),queryFn:async()=>{
    window.canonicalRefreshes++;return {agent:{id:'agent',projectId:'project'},
      messages:[],runOutput:[],activity:[],changedFiles:[],runs:[],workItems:[],artifacts:[]};
  }});
  return <main>
    <div id="connection">{stream.connected?'connected':'disconnected'}</div>
    <AgentDetailHeader agent={agent} chats={[]} lineageLabel="" status="running"
      connectionStatus={stream.connectionStatus} phaseEvidenceFresh={false} startedAt={startedAt}
      agentNameForId={()=>undefined} running stopping={false} tab="chat" showSubagents={false}
      showAutomations={false} transcriptMarkdown="" transcriptTitle="disposable"
      onOpenProject={noop} onOpenChat={noop} onOpenAgent={noop} onStop={noop} onExportPackage={noop}
      onNotice={noop} onOpenTechnical={noop} onRename={noop} onCreateAgent={noop}
      onChangeReportingLine={noop} onDelete={noop} onTabChange={noop}/>
  </main>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider theme={createPonderosaTheme('dark')}>
  <CssBaseline/><QueryClientProvider client={client}><Probe/></QueryClientProvider>
</ThemeProvider>);
