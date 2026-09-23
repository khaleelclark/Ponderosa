import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useWorkspaceStream } from "../src/hooks/useWorkspaceStream";
import type { ProjectDto, WorkspacePreferencesDto } from "@ponderosa/core";
import { WorkspaceSidebar } from "../src/components/WorkspaceSidebar";
import { WorkspaceRefreshProvider, useReportWorkspaceRefresh } from "../src/components/WorkspaceRefreshContext";
import { WorkspaceConnectionNotice } from "../src/components/WorkspaceConnectionNotice";
import { MobileWorkspaceDrawer } from "../src/App.mobile";
import { WorkspacePreferencesWriter } from "../src/workspacePreferencesWriter";
import type { Route } from "../src/routing";
import { api } from "../src/api";
import { queryKeys } from "../src/queryKeys";
const projects=["P1","P2"].map(id=>({id,label:id,hostPath:`/tmp/${id}`,createdAt:"2026-01-01"})) as ProjectDto[];
const names=["Alpha","Beta","Gamma","Delta",...Array.from({length:24},(_,i)=>`Chat ${i+5}`)];
const chats=names.map((title,i)=>({kind:"conversation",project:projects[i%2]!,conversation:{id:title,title,projectId:projects[i%2]!.id,createdAt:"2026-01-01"},runningAgentCount:i===1?1:0}));
const requests: unknown[]=[];
const agents = ["Parent", "Child"].map((title,index)=>({kind:"agent",project:projects[0],health:{agentId:title,status:"idle"},agent:{id:title,title,projectId:"P1",conversationId:"Alpha",activeEngine:"codex",status:"idle",managerAgentId:index?"Parent":undefined,createdAt:"2026-01-01"}}));
const triggers = [{kind:"trigger",project:projects[0],trigger:{id:"Timer",name:"Timer",projectId:"P1",agentId:"Parent",enabled:true,kind:"schedule",createdAt:"2026-01-01"}}];
let working=true;
api.getWorkspaceDirectory=(async(kind:string,options:{projectId?:string;cursor?:string;search?:string;summary?:boolean;active?:boolean})=>{
  requests.push({kind,...options});
  if(location.search.includes("loading"))await new Promise(resolve=>setTimeout(resolve,1000));
  if(kind==="agent" && options.active)return {kind,starredItems:[],items:[],total:working && (!options.projectId || options.projectId==="P2")?31:0,history:{hasMore:false}};
  const all=kind==="project"?projects.map(project=>({kind,project,runningAgentCount:0})):kind==="conversation"?chats.filter(item=>!options.search||item.conversation.title.toLowerCase().includes(options.search.toLowerCase())):kind==="agent"?agents:kind==="trigger"?triggers:[];
  const offset=Number(options.cursor??0),more=!options.summary && offset+25<all.length;
  return {kind,starredItems:[],items:options.summary?[]:all.slice(offset,offset+25),total:all.length,history:{hasMore:more,...(more?{cursor:String(offset+25)}:{})}};
}) as typeof api.getWorkspaceDirectory;
api.getNotificationProjection=(async()=>({workspace:{},allMessages:{importantCount:0,ordinaryCount:0,totalCount:0},projects:{},conversations:{}})) as typeof api.getNotificationProjection;
api.markProjectUsed=(async()=>({})) as typeof api.markProjectUsed;
api.getConversation=(async(id:string)=>({conversation:chats.find(item=>item.conversation.id===id)!.conversation})) as typeof api.getConversation;
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
function App(){
  const [collapsed,setCollapsed]=useState(false);
  const [drawerOpen,setDrawerOpen]=useState(false);
  const [route,setRoute]=useState<Route>({kind:"home"});
  const [navigationCount,setNavigationCount]=useState(0);
  const [preferences,setPreferences]=useState<WorkspacePreferencesDto>(()=>JSON.parse(localStorage.getItem("fixture-preferences")??"null")??{revision:1,profile:{displayName:"Tester",handle:"tester",avatarId:"default-user"},starredProjectIds:[],projectOrder:[],chatOrder:[],agentOrder:[],triggerOrder:[],starredResourceIds:["conversation:Alpha"],chatFolders:[],projectFolders:[{id:"old",name:"Untouched",projectIds:["P1","P2"],expanded:true}]});
  const current=useRef(preferences);current.current=preferences;
  const server=useRef(preferences);
  const [action,setAction]=useState("");
  const [writer]=useState(()=>new WorkspacePreferencesWriter({read:()=>current.current,publish:value=>{current.current=value;setPreferences(value);},refresh:async()=>server.current,write:async patch=>{
    if(patch.chatFolders && patch.chatFoldersRevision!==server.current.revision)throw {status:409};
    const {chatFoldersRevision:_revision,...changes}=patch;
    server.current={...server.current,...changes,revision:server.current.revision+1};localStorage.setItem("fixture-preferences",JSON.stringify(server.current));return server.current;
  }}));
  return <ThemeProvider theme={createTheme({palette:{mode:"dark"},components:{MuiIconButton:{styleOverrides:{root:{minHeight:44}}}}})}><CssBaseline />
    {location.search.includes("gestures") ? <><button onClick={()=>setDrawerOpen(true)}>Open navigation</button><span id="drawer-open">{String(drawerOpen)}</span>
      <MobileWorkspaceDrawer open={drawerOpen} onOpenChange={setDrawerOpen} projects={projects} preferences={preferences} route={route} notifications={[]}
        onNavigate={next=>{setNavigationCount(count=>count+1);setRoute(next);}} onCreate={()=>{}} onPreferences={patch=>writer.enqueue(patch)} onConversationAction={()=>{}} onProjectDeleted={()=>{}} onSearch={()=>{}} onOpenNotifications={()=>{}} onOpenEngineStatus={()=>{}} />
    </> : <div style={{height:900,display:"flex",maxWidth:"100vw"}}><WorkspaceSidebar projects={projects} preferences={preferences} route={route} notifications={[]}
      drawer={innerWidth<600} width={350} collapsed={collapsed} onCollapsedChange={setCollapsed} onNavigate={next=>{setNavigationCount(count=>count+1);setRoute(next);}} onCreate={(kind,context)=>setAction(JSON.stringify({kind,context}))}
      onPreferences={patch=>writer.enqueue(patch)} onRenameConversation={conversation=>setAction(`rename:${conversation.id}`)} onDeleteConversation={conversation=>setAction(`delete:${conversation.id}`)} onProjectDeleted={()=>{}}
      onDismiss={()=>{}} />
    </div>}<div style={{maxWidth:"100vw",overflow:"auto"}}><pre id="preferences">{JSON.stringify(preferences)}</pre><pre id="route">{JSON.stringify(route)}</pre><pre id="action">{action}</pre></div>
    <span id="navigation-count">{navigationCount}</span><button onClick={()=>setAction(JSON.stringify(requests))}>Inspect requests</button>
    <button onClick={()=>{working=false;void client.invalidateQueries({queryKey:queryKeys.workspaceDirectory.all});}}>Finish all work</button>
    <button onClick={()=>{working=true;void client.invalidateQueries({queryKey:queryKeys.workspaceDirectory.all});}}>Start work</button>
  </ThemeProvider>;
}
let bootstrapReads=0;
function BootstrapProbe(){
  const query=useQuery({queryKey:["workspace-preferences"],queryFn:async()=>{const value=++bootstrapReads;await new Promise(resolve=>setTimeout(resolve,value===1?300:30));return value;}});
  const connection=useWorkspaceStream();
  return <><span id="bootstrap-data">{query.data}</span><span id="bootstrap-phase">{String(connection.phaseEvidenceFresh)}</span><button onClick={connection.retry}>Retry stream</button></>;
}
if(location.search.includes("bootstrap"))api.subscribeWorkspace=(_cursor,handlers)=>{
  const timer=setTimeout(()=>handlers.onStatus?.({instanceId:"fixture-instance",cursor:10000,reset:false,snapshot:true}),50);
  return {close:()=>clearTimeout(timer)};
};
function StatusProbe(){
  const [failed,setFailed]=useState(true);
  const [stale,setStale]=useState(true);
  useReportWorkspaceRefresh(failed?"Chats failed to refresh":undefined,()=>setFailed(false));
  return <><WorkspaceConnectionNotice connection={{status:stale?"stale":"live",prolongedDisconnect:false,phaseEvidenceFresh:!stale,retry:()=>setStale(false)} as any}/><span id="recovered">{String(!failed&&!stale)}</span></>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}>{location.search.includes("status")?<ThemeProvider theme={createTheme()}><WorkspaceRefreshProvider><StatusProbe/></WorkspaceRefreshProvider></ThemeProvider>:location.search.includes("bootstrap")?<BootstrapProbe/>:<App />}</QueryClientProvider>);
