import {createClientId} from '../../clientId';
import type {BranchRoute} from '../../branchesRouting';
import {useBranchDraftGuard,useBranchNavigationGuard} from './BranchNavigation';
import {AgentOrganizationDialog} from '../AgentDetail.parts';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Alert,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,Menu,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {AgentDto,BranchContextDto,ConversationDto,EngineDto} from '@ponderosa/core';
import {realApi,requestJson} from '../../api/real';
import type {ProjectRoute} from '../../routeRegistry';
import type {Route} from '../../routing';
import {ProjectShell} from '../ProjectShell';
import {WorkspaceHeaderPreferenceProvider} from '../WorkspaceFrame';
import {MobileNavigationButton} from '../MobileNavigationContext';
import {AgentCreateSurface} from '../AgentCreateDialog';
import {CapabilityPolicyEditor} from '../CapabilityPolicyEditor';
/** Shared interaction surfaces receive scoped transport and navigation from their product shell. */
export function BranchChats({branchId,engines,executionId,branchRoute,onNavigate,notificationAction}:{branchId:string;engines:EngineDto[];executionId?:string;branchRoute:BranchRoute;onNavigate(route:BranchRoute,replace?:boolean):void;notificationAction?:ReactNode}):JSX.Element {
 const guard=useBranchNavigationGuard();
 const [actions,setActions]=useState<HTMLElement>();
 const chatId=branchRoute.chatId??'',route=branchRoute.workspace;
 const setRoute=(workspace:ProjectRoute|undefined)=>onNavigate({...branchRoute,workspace});
 const setChatId=(chatId:string)=>onNavigate({...branchRoute,chatId:chatId||undefined,workspace:undefined});
 const openChat=(id:string,projectId:string,replace=false)=>onNavigate({...branchRoute,chatId:id,workspace:{kind:'conversation',projectId,conversationId:id}},replace);
 const [organization,setOrganization]=useState(false),[member,setMember]=useState<AgentDto>(),[manager,setManager]=useState(''),[saved,setSaved]=useState(''),[capabilities,setCapabilities]=useState<{kind:'chat'|'agent';id:string;title:string}>(),[capabilityDirty,setCapabilityDirty]=useState(false);
 useBranchDraftGuard('chat-capabilities',capabilityDirty);
 const client=useQueryClient(),[create,setCreate]=useState(false),[title,setTitle]=useState(''),[folder,setFolder]=useState(''),[engine,setEngine]=useState(engines[0]?.id??''),[agentCreate,setAgentCreate]=useState<{managerAgentId?:string}>(),[error,setError]=useState('');
 const chats=useQuery({queryKey:['branch-chats',branchId,executionId],queryFn:()=>requestJson<BranchContextDto[]>(`/api/branches/${branchId}/chats${executionId?'?executionId='+encodeURIComponent(executionId):''}`),refetchInterval:5000});
 const owner=useQuery({queryKey:['branch-chat-owner',chatId],queryFn:()=>requestJson<BranchContextDto>(`/api/branches/contexts/${chatId}`),enabled:Boolean(chatId),retry:false});
 const listedChat=chats.data?.find(c=>c.id===chatId),ownerMatches=owner.data?.branchId===branchId&&(owner.data.executionId??undefined)===(executionId??undefined),chat=listedChat??(ownerMatches?owner.data:undefined),project=useQuery({queryKey:['project',chat?.projectId],queryFn:()=>realApi.getProject(chat!.projectId),enabled:Boolean(chat)});
 const preferences=useQuery({queryKey:['preferences'],queryFn:()=>realApi.getWorkspacePreferences()});
 useEffect(()=>{if(!engine&&engines[0])setEngine(engines[0].id)},[engine,engines]);
 const members=useQuery({queryKey:['branch-org',branchId,chatId],queryFn:async()=>{const agents:AgentDto[]=[];let cursor:string|undefined;do{const page=await realApi.listConversationMembersPage(chatId,{limit:100,cursor});agents.push(...page.items);cursor=page.hasMore?page.cursor:undefined;}while(cursor);return {agents};},enabled:Boolean(chatId)&&(organization||Boolean(executionId))});
 useEffect(()=>{if(!chatId&&chats.data?.length===1){const c=chats.data[0]!;openChat(c.id,c.projectId,true)}},[chatId,chats.data]);
 useEffect(()=>{const context=owner.data,targetExecution=context?.executionId??undefined;if(chatId&&context?.branchId&&(context.branchId!==branchId||targetExecution!==(executionId??undefined)))onNavigate({branchId:context.branchId,tab:'chats',executionId:targetExecution,chatId:context.id,workspace:{kind:'conversation',projectId:context.projectId,conversationId:context.id}},true)},[branchId,chatId,executionId,owner.data]);
 const saveManager=useMutation({mutationFn:()=>realApi.updateAgentOrganization(member!.id,{managerAgentId:manager||null}),onSuccess:updated=>{setMember(undefined);setSaved(`Reporting line saved for ${updated.title}.`);void members.refetch();void client.invalidateQueries({queryKey:['agents']});void client.invalidateQueries({queryKey:['branch-agents']})}});
 const creation=useRef<{payload:string;key:string}>();
 const createChat=useMutation({mutationFn:()=>{const payload=JSON.stringify({label:title||'New Chat',hostPath:folder||undefined,defaultEngine:engine});if(creation.current?.payload!==payload)creation.current={payload,key:createClientId()};return requestJson<ConversationDto>(`/api/branches/${branchId}/chats`,{method:'POST',headers:{'idempotency-key':creation.current.key},body:payload})},onSuccess:created=>{creation.current=undefined;setCreate(false);onNavigate({...branchRoute,chatId:created.id,workspace:{kind:'conversation',projectId:created.projectId,conversationId:created.id}});void client.invalidateQueries({queryKey:['branch-chats',branchId]})}});
 const embeddedHeaderReady=Boolean(chat&&project.data&&preferences.data);
 const workspaceRoute:ProjectRoute|undefined=chat?(route?.projectId===chat.projectId&&(!executionId||route.kind==='conversation'||route.kind==='agent')?route:{kind:'conversation',projectId:chat.projectId,conversationId:chat.id}):undefined;
 const embeddedHeaderSuppliesNavigation=Boolean(embeddedHeaderReady&&workspaceRoute&&['conversation','agent','project'].includes(workspaceRoute.kind));
 const navigate=(next:Route)=>{
   if('projectId' in next && next.projectId===chat?.projectId&&(!executionId||next.kind==='conversation'||next.kind==='agent')){setRoute(next as ProjectRoute);return;}
   if(next.kind==='home'){setChatId('');return;}
   setError('This view belongs outside the selected Branch Chat.');
 };
 return <Stack spacing={1} sx={{flex:1,minHeight:0,minWidth:0,overflow:'hidden'}}>
  <Stack direction="row" gap={1} alignItems="center" sx={{flexShrink:0}}>{!embeddedHeaderSuppliesNavigation&&<MobileNavigationButton/>}<TextField select size="small" label={executionId?'Execution Chat':'Branch Chat'} value={chatId} sx={{flex:1,minWidth:0}} onChange={e=>{const c=chats.data?.find(c=>c.id===e.target.value);if(c)openChat(c.id,c.projectId)}}><MenuItem value="">Choose Chat</MenuItem>{chats.data?.map(c=><MenuItem key={c.id} value={c.id}>{c.title}</MenuItem>)}</TextField>{executionId&&<Button size="small" onClick={()=>onNavigate({...branchRoute,executionId:undefined,chatId:undefined,workspace:undefined})}>Persistent Chats</Button>}{!executionId&&<Button aria-haspopup="menu" aria-expanded={Boolean(actions)} onClick={e=>setActions(e.currentTarget)}>Chat actions</Button>}{notificationAction}</Stack>
  <Menu anchorEl={actions} open={Boolean(actions)} onClose={()=>setActions(undefined)}>
   {!executionId&&<MenuItem onClick={()=>{setActions(undefined);setCreate(true)}}>Create Chat</MenuItem>}
   {chat&&<><MenuItem onClick={()=>{setActions(undefined);setRoute({kind:'conversation',projectId:chat.projectId,conversationId:chat.id})}}>Conversation</MenuItem><MenuItem onClick={()=>{setActions(undefined);setOrganization(true)}}>Agents</MenuItem><MenuItem onClick={()=>{setActions(undefined);setCapabilities({kind:'chat',id:chat.id,title:chat.title})}}>Chat capabilities</MenuItem><MenuItem onClick={()=>{setActions(undefined);setOrganization(true)}}>Manage reporting lines</MenuItem><MenuItem onClick={()=>{setActions(undefined);setAgentCreate({})}}>Create / import Agent</MenuItem></>}
  </Menu>
  {error&&<Alert severity="error" onClose={()=>setError('')}>{error}</Alert>}
  {chats.error&&<Alert severity="error" action={<Button onClick={()=>void chats.refetch()}>Retry Chats</Button>}>Chats could not be loaded. {chats.error.message}</Alert>}
  {chatId&&owner.error&&!listedChat&&<Alert severity="error" action={<Button onClick={()=>setChatId('')}>Choose another Chat</Button>}>This Chat is unavailable or no longer belongs to a Branch.</Alert>}
  {executionId&&chat&&members.data?.agents.some(agent=>agent.archived)&&<Alert severity="info">Temporary Agents are archived after their workflow work finishes. Their history remains available for inspection here: {members.data.agents.filter(agent=>agent.archived).map(agent=><Button key={agent.id} onClick={()=>setRoute({kind:'agent',projectId:chat.projectId,agentId:agent.id})}>{agent.title} · View history</Button>)}</Alert>}
  {chat&&project.error&&<Alert severity="error" action={<Button onClick={()=>void project.refetch()}>Retry Chat workspace</Button>}>The Chat workspace could not be loaded. {project.error.message}</Alert>}
  {chat&&preferences.error&&<Alert severity="error" action={<Button onClick={()=>void preferences.refetch()}>Retry preferences</Button>}>Workspace preferences could not be loaded. {preferences.error.message}</Alert>}
  {chats.isPending&&<Typography>Loading Chats…</Typography>}{chatId&&owner.isPending&&!listedChat&&<Typography>Locating Chat…</Typography>}{saved&&<Alert severity="success" onClose={()=>setSaved('')}>{saved}</Alert>}
  {chats.isSuccess&&!chats.data.length&&<Typography color="text.secondary">{executionId?'No temporary Chats for this execution. Open Persistent Chats to inspect this workflow’s standing Agents.':'Create a Chat when this Branch needs persistent Agents. Script-only workflows do not need one.'}</Typography>}
  {chats.isSuccess&&chats.data.length>1&&!chatId&&<Typography color="text.secondary">Choose a Chat to inspect or work with its Agents.</Typography>}
  {owner.data?.branchId&&(owner.data.branchId!==branchId||(owner.data.executionId??undefined)!==(executionId??undefined))&&<Typography>Opening the Chat’s owning workflow execution…</Typography>}
  {chat&&project.data&&preferences.data&&<>
   <Box sx={{flex:1,minHeight:0,minWidth:0,display:'flex',flexDirection:'column',overflow:'hidden'}}><WorkspaceHeaderPreferenceProvider storageKey="ponderosa.branches-header.collapsed.v1"><ProjectShell projectId={chat.projectId} project={project.data} route={workspaceRoute!} engines={engines} notifications={[]} preferences={preferences.data}
    executionAudit={Boolean(executionId)} routedAgentOverride={executionId&&workspaceRoute?.kind==='agent'?members.data?.agents.find(agent=>agent.id===workspaceRoute.agentId&&agent.archived):undefined}
    onPreferences={patch=>{void realApi.updateWorkspacePreferences(patch).then(()=>client.invalidateQueries({queryKey:['preferences']})).catch(e=>setError(e.message))}}
    onRenameConversation={c=>{if(executionId){setError('Execution Chats are available for inspection only.');return;}const name=window.prompt('Chat name',c.title);if(name)void realApi.updateConversation(c.id,{title:name}).then(()=>client.invalidateQueries({queryKey:['branch-chats',branchId]})).catch(e=>setError(e.message))}}
    onDeleteConversation={()=>setError('Remove Branch-owned Chats through a reviewed Branch update.')}
    onOpenEngineStatus={()=>onNavigate({...branchRoute,global:'status'})}
    navigate={navigate} onProjectDeleted={()=>{setChatId('');void chats.refetch()}}
    navigationFallback={embeddedHeaderSuppliesNavigation?<MobileNavigationButton/>:undefined}
    onCreate={(kind,context)=>{if(executionId){setError('Execution Chats are available for inspection only.');return;}if(kind==='agent')setAgentCreate({managerAgentId:context.managerAgentId});else if(kind==='chat')setCreate(true);else setError('Configure the Branch trigger in Workflow.')}}/></WorkspaceHeaderPreferenceProvider></Box>
   <Dialog open={Boolean(agentCreate)} onClose={()=>setAgentCreate(undefined)} fullWidth maxWidth="md"><DialogTitle>Create or import an Agent</DialogTitle><DialogContent>{agentCreate&&<AgentCreateSurface projects={[project.data]} engines={engines} fixedProjectId={chat.projectId} fixedConversationId={chat.id} initialManagerAgentId={agentCreate.managerAgentId} onCancel={()=>setAgentCreate(undefined)} onCreated={(_p,a)=>{setAgentCreate(undefined);setRoute({kind:'agent',projectId:chat.projectId,agentId:a.id})}} onImported={(_p,id)=>{setAgentCreate(undefined);setRoute({kind:'agent',projectId:chat.projectId,agentId:id})}}/>}</DialogContent></Dialog>
  </>}
  <Dialog transitionDuration={0} open={organization} onClose={()=>setOrganization(false)} fullWidth maxWidth="sm"><DialogTitle>Reporting lines · {chat?.title}</DialogTitle><DialogContent><Stack spacing={2}>{members.isPending&&<Typography>Loading organization…</Typography>}{members.error&&<Alert severity="error">{members.error.message}</Alert>}{members.data?.agents.map(a=><Stack key={a.id} direction="row" spacing={2} alignItems="center"><Box sx={{flex:1}}><Typography fontWeight={600}>{a.title}</Typography><Typography variant="body2">{a.archived?'Archived · history only':a.managerAgentId?`Reports to ${members.data.agents.find(m=>m.id===a.managerAgentId)?.title??'another Agent'}`:'Reports to you'}</Typography></Box>{!a.archived&&<><Button onClick={()=>setCapabilities({kind:'agent',id:a.id,title:a.title})}>Capabilities</Button><Button onClick={()=>{setMember(a);setManager(a.managerAgentId??'');saveManager.reset()}}>Change manager</Button></>}</Stack>)}<Button onClick={()=>setOrganization(false)}>Done</Button></Stack></DialogContent></Dialog>
  {member&&<AgentOrganizationDialog open agent={member} agents={members.data?.agents??[]} organizationParentId={manager} setOrganizationParentId={setManager} updateOrganization={saveManager} onClose={()=>{if(!saveManager.isPending)setMember(undefined)}}/>}
  <Dialog open={create} onClose={()=>{if(!createChat.isPending)setCreate(false)}} fullWidth><DialogTitle>Create a Branch Chat</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>{createChat.error&&<Alert severity="error">{createChat.error.message}</Alert>}<TextField label="Chat name" value={title} onChange={e=>setTitle(e.target.value)}/><TextField label="Working directory (optional)" value={folder} onChange={e=>setFolder(e.target.value)} helperText="Leave empty for a managed folder."/><TextField select label="Engine" value={engine} onChange={e=>setEngine(e.target.value)}>{engines.map(e=><MenuItem value={e.id} key={e.id}>{e.id}</MenuItem>)}</TextField><Button variant="contained" disabled={createChat.isPending||!engine} onClick={()=>createChat.mutate()}>{createChat.isPending?'Creating Chat…':'Create Chat'}</Button></Stack></DialogContent></Dialog>
  <Dialog open={Boolean(capabilities)} onClose={()=>guard(()=>setCapabilities(undefined))} fullWidth maxWidth="md"><DialogTitle>{capabilities?.title} capabilities</DialogTitle><DialogContent dividers>{capabilities&&<CapabilityPolicyEditor scopeKind={capabilities.kind} onDirtyChange={setCapabilityDirty} endpoint={capabilities.kind==='chat'?`/api/branches/${branchId}/chats/${capabilities.id}/capabilities`:`/api/branches/${branchId}/agents/${capabilities.id}/capabilities`}/>}</DialogContent><DialogActions><Button onClick={()=>guard(()=>setCapabilities(undefined))}>Done</Button></DialogActions></Dialog>
 </Stack>;
}
