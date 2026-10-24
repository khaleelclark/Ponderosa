import ChatIcon from "@mui/icons-material/ChatBubbleOutline";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import {markWorkspaceResourceUsed} from "../../workspaceRecency";
import {normalizeResetPages,uniqueBy} from "../../collections";
import AddIcon from "@mui/icons-material/Add";
import {NewChatComposer} from "../NewChatComposer";
import {readCreationAttempts, sameCreationOwner} from "../chatCreationAttempts";
import {PrimaryHeaderActionsScope} from '../PrimaryHeaderActions';
import {BranchNotifications} from "./BranchNotifications";
import {useWorkspacePreferences,useWorkspacePreferencesWriter} from '../../hooks/queries';
import {createClientId} from '../../clientId';
import type {BranchRoute} from '../../branchesRouting';
import {useBranchDraftGuard,useBranchNavigationGuard} from './BranchNavigation';
import {ResourceSettingsContext} from '../ResourceSettingsContext';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {useQuery,useQueryClient,useInfiniteQuery} from '@tanstack/react-query';
import {Alert,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,IconButton,Tooltip,List,ListItem,ListItemButton,ListItemText,Stack,TextField,Typography} from '@mui/material';
import type {BranchContextDto,EngineDto} from '@ponderosa/core';
import {realApi,requestJson,requestCollectionPage} from '../../api/real';
import type {ProjectRoute} from '../../routeRegistry';
import type {Route} from '../../routing';
import {ProjectShell} from '../ProjectShell';
import {ProjectBrowserContext,consumeProjectBrowserRequest,type ProjectBrowserRequest} from '../ProjectBrowserContext';
import {WorkspaceReadOnlyContext} from '../WorkspaceReadOnlyContext';
import {ApiRequestError} from '../../api/types';
import {AgentCreateSurface} from '../AgentCreateDialog';
import {CapabilityPolicyEditor} from '../CapabilityPolicyEditor';
/** Shared interaction surfaces receive scoped transport and navigation from their product shell. */
export function BranchChats({branchId,engines,executionId,branchRoute,onNavigate,notificationAction,onHeaderReady,enginesLoaded=true}:{branchId:string;engines:EngineDto[];enginesLoaded?:boolean;executionId?:string;branchRoute:BranchRoute;onNavigate(route:BranchRoute,replace?:boolean):boolean;notificationAction?:ReactNode;onHeaderReady?(ready:boolean):void}):JSX.Element {
 const guard=useBranchNavigationGuard();
 const active=useRef(false);useLayoutEffect(()=>{active.current=true;return()=>{active.current=false}},[]);
 const [picker,setPicker]=useState(false),[search,setSearch]=useState('');
 const searchText=search.trim();
 useEffect(()=>{setPicker(false);setSearch('')},[branchId,executionId]);
 const route=branchRoute.workspace;
 const routeAgentId=route&&'agentId'in route?route.agentId:undefined;
 const routedAgent=useQuery({queryKey:['branch-routed-agent-owner',routeAgentId],queryFn:()=>realApi.getAgent(routeAgentId!,1),enabled:Boolean(routeAgentId),retry:false});
 const chatId=(route&&'conversationId'in route?route.conversationId:undefined)??(routeAgentId?routedAgent.data?.agent.conversationId:branchRoute.chatId)??'';
 const setRoute=(workspace:ProjectRoute|undefined,replace=false)=>onNavigate({...branchRoute,workspace},replace);
 const setChatId=(chatId:string)=>onNavigate({...branchRoute,creationKey:undefined,chatId:chatId||undefined,workspace:undefined});
 const openChat=(id:string,projectId:string,replace=false)=>onNavigate({...branchRoute,creationKey:undefined,chatId:id,workspace:{kind:'conversation',projectId,conversationId:id}},replace);
 const [capabilityDirty,setCapabilityDirty]=useState(false);
 useBranchDraftGuard('chat-capabilities',capabilityDirty);
 const client=useQueryClient(),[agentCreate,setAgentCreate]=useState<{projectId:string;conversationId:string;managerAgentId?:string}>(),[agentCreatePending,setAgentCreatePending]=useState(false),[error,setError]=useState('');
 const chatPages=useInfiniteQuery({queryKey:['branch-chats',branchId,executionId,'pages'],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestCollectionPage<BranchContextDto>(`/api/branches/${branchId}/chats?limit=100${executionId?'&executionId='+encodeURIComponent(executionId):''}${pageParam?'&cursor='+encodeURIComponent(pageParam):''}`),getNextPageParam:last=>last.hasMore?last.cursor:undefined,select:normalizeResetPages,refetchInterval:5000});
 const searches=useInfiniteQuery({queryKey:['branch-chats',branchId,executionId,'search',searchText],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestCollectionPage<BranchContextDto>(`/api/branches/${branchId}/chats?limit=100&search=${encodeURIComponent(searchText)}${executionId?'&executionId='+encodeURIComponent(executionId):''}${pageParam?'&cursor='+encodeURIComponent(pageParam):''}`),getNextPageParam:last=>last.hasMore?last.cursor:undefined,select:normalizeResetPages,enabled:picker&&Boolean(searchText),refetchInterval:picker&&searchText?5000:false});
 const chats={...chatPages,data:chatPages.data?uniqueBy(chatPages.data.pages.flatMap(page=>page.items),chat=>chat.id):undefined};
 const choices=searchText?searches:chatPages,choiceRows=uniqueBy(choices.data?.pages.flatMap(page=>page.items)??[],chat=>chat.id);
 const chatCount=chatPages.data?.pages[0]?.total;
 const [browserRequest,setBrowserRequest]=useState<ProjectBrowserRequest>(),browserRequestSequence=useRef(0);
 const owner=useQuery({queryKey:['branch-chat-owner',chatId],queryFn:()=>requestJson<BranchContextDto>(`/api/branches/contexts/${chatId}`),enabled:Boolean(chatId),retry:false,refetchInterval:5000});
 const listedChat=chats.data?.find(c=>c.id===chatId),ownerMatches=!(owner.error instanceof ApiRequestError&&[404,410].includes(owner.error.status))&&owner.data?.branchId===branchId&&(owner.data.executionId??undefined)===(executionId??undefined),chat=listedChat??(ownerMatches?owner.data:undefined),project=useQuery({queryKey:['project',chat?.projectId],queryFn:()=>realApi.getProject(chat!.projectId),enabled:Boolean(chat)});
 const preferences=useWorkspacePreferences(),preferenceWriter=useWorkspacePreferencesWriter();
 useEffect(()=>{if(!branchRoute.creationKey&&!routeAgentId&&!chatId&&chats.data?.length===1){const c=chats.data[0]!;openChat(c.id,c.projectId,true)}},[chatId,chats.data,branchRoute.creationKey,routeAgentId]);
 useEffect(()=>{const context=owner.data,targetExecution=context?.executionId??undefined;if(!branchRoute.creationKey&&chatId&&context?.branchId&&(context.branchId!==branchId||targetExecution!==(executionId??undefined)||branchRoute.chatId!==context.id))onNavigate({branchId:context.branchId,tab:'chats',executionId:targetExecution,chatId:context.id,workspace:route?.projectId===context.projectId?route:{kind:'conversation',projectId:context.projectId,conversationId:context.id}},true)},[branchId,chatId,executionId,owner.data,branchRoute.chatId,branchRoute.creationKey,route]);
 const creationOwner={product:'branches' as const,branchId};
 const pendingAttempt=readCreationAttempts().find(item=>sameCreationOwner(item.owner,creationOwner)&&!item.chat);
 const creationAllowed=branchRoute.branchId===branchId&&branchRoute.tab==='chats'&&!branchRoute.global&&!executionId;
 const creationKey=creationAllowed?branchRoute.creationKey:undefined;
 const starting=useRef(false),currentRoute=useRef(branchRoute);currentRoute.current=branchRoute;
 useEffect(()=>{starting.current=false},[creationKey]);
 const startChat=()=>{if(!creationAllowed||creationKey||starting.current)return;starting.current=true;if(!onNavigate({...branchRoute,creationKey:pendingAttempt?.key??createClientId()}))starting.current=false;};
 const usedChat=useRef<string>();
 const recordSelectedChatUse=()=>{const current=currentRoute.current,id=current.branchId===branchId&&current.tab==='chats'&&!current.global&&!executionId&&ownerMatches?chatId:undefined;if(usedChat.current===id)return;usedChat.current=id;if(id)void markWorkspaceResourceUsed(client,'conversation',id).then(()=>client.invalidateQueries({queryKey:['branch-chats',branchId]}));};
 useEffect(recordSelectedChatUse,[branchId,chatId,ownerMatches,branchRoute.tab,branchRoute.global,branchRoute.branchId,executionId]);
 const chooseChat=(chat:BranchContextDto)=>{const current=currentRoute.current;if(current.branchId===branchId&&current.tab==='chats'&&!current.global&&(current.executionId??undefined)===(executionId??undefined)&&openChat(chat.id,chat.projectId))setPicker(false);};
 const created=(projectId:string,conversationId:string)=>{const current=currentRoute.current;if(current.branchId!==branchId||current.tab!=='chats'||current.global||current.executionId||current.creationKey!==creationKey)return false;return onNavigate({...current,creationKey:undefined,chatId:conversationId,workspace:{kind:'conversation',projectId,conversationId}},true);};
 const currentAgentCreate=useRef(agentCreate);currentAgentCreate.current=agentCreate;
 useBranchDraftGuard('agent-create',agentCreatePending);
 useEffect(()=>{if(agentCreate&&agentCreate.conversationId!==chatId){setAgentCreate(undefined);setAgentCreatePending(false)}},[chatId,agentCreate]);
 const closeAgentCreate=()=>{if(!active.current||currentAgentCreate.current!==agentCreate)return false;setAgentCreatePending(false);setAgentCreate(undefined);return true;};
 const [completedNavigation,setCompletedNavigation]=useState<{owner:BranchRoute;next:BranchRoute;created?:boolean}>();
 useEffect(()=>{if(!completedNavigation)return;setCompletedNavigation(undefined);if(active.current&&!agentCreate&&!agentCreatePending&&currentRoute.current===completedNavigation.owner&&onNavigate(completedNavigation.next)===false&&completedNavigation.created)setError('Agent was created. Open it from Agents after saving or discarding the current edits.');},[completedNavigation,agentCreate,agentCreatePending,onNavigate]);
 const agentCreated=(projectId:string,agentId:string)=>{const current=currentRoute.current;void client.invalidateQueries({queryKey:['branch-agents',branchId]});if(!active.current||currentAgentCreate.current!==agentCreate||current.branchId!==branchId||current.tab!=='chats'||current.global||current.executionId||current.chatId!==agentCreate?.conversationId||projectId!==agentCreate?.projectId)return;if(closeAgentCreate())setCompletedNavigation({owner:current,next:{...current,workspace:{kind:'agent',projectId,agentId}},created:true});};
 const resourceDeleted=(removed:Extract<ProjectRoute,{kind:'agent'|'conversation'}>)=>{void client.invalidateQueries({queryKey:['branch-chats',branchId]});void client.invalidateQueries({queryKey:['branch-agents',branchId]});const current=currentRoute.current;if(!active.current||current.branchId!==branchId||current.tab!=='chats'||current.global||current.executionId||removed.projectId!==chat?.projectId||current.chatId!==chat?.id)return;const next=removed.kind==='conversation'&&current.chatId===removed.conversationId?{...current,chatId:undefined,workspace:undefined}:removed.kind==='agent'&&current.workspace?.kind==='agent'&&current.workspace.agentId===removed.agentId?{...current,workspace:{kind:'conversation' as const,projectId:chat!.projectId,conversationId:chat!.id}}:undefined;if(next){setCompletedNavigation({owner:current,next});setCapabilityDirty(false);}};
 const workspaceRoute:ProjectRoute|undefined=chat?(route?.projectId===chat.projectId&&(!executionId||['conversation','agent','workspaceFile','review','projectWork'].includes(route.kind))?route:{kind:'conversation',projectId:chat.projectId,conversationId:chat.id}):undefined;
 const navigate=(next:Route,options?:{replace?:boolean})=>{
   if('projectId' in next && next.projectId===chat?.projectId&&(!executionId||['conversation','agent','workspaceFile','review','projectWork'].includes(next.kind)))return setRoute(next as ProjectRoute,options?.replace);
   if(next.kind==='home')return chat&&route?.kind==='browser'?setRoute({kind:'conversation',projectId:chat.projectId,conversationId:chat.id}):setChatId('');
   setError('This view belongs outside the selected Branch Chat.');return false;
 };
 return <Stack spacing={1} sx={{flex:1,minHeight:0,minWidth:0,overflow:'hidden'}}>
  <Stack direction="row" gap={1} alignItems="center" sx={{flexShrink:0,minWidth:0}}><Button size="small" startIcon={<ChatIcon/>} endIcon={<ArrowDropDownIcon/>} aria-haspopup="dialog" onClick={()=>{setSearch('');setPicker(true)}} sx={{whiteSpace:'nowrap'}}>{executionId?'Execution Chats':'Chats'} ({chatCount??(chatPages.error?'?':'…')})</Button>{executionId&&<Button size="small" onClick={()=>onNavigate({...branchRoute,executionId:undefined,chatId:undefined,workspace:undefined})}>Persistent Chats</Button>}{!executionId&&<Tooltip title="New Chat"><span><IconButton aria-label="New Chat" disabled={Boolean(creationKey)} onClick={startChat}><AddIcon/></IconButton></span></Tooltip>}{notificationAction}</Stack>
  <Dialog open={picker} onClose={()=>setPicker(false)} fullWidth maxWidth="sm"><DialogTitle>{executionId?'Execution Chats':'Chats'}</DialogTitle><DialogContent dividers><Stack spacing={1}>
   <TextField autoFocus size="small" label="Search Chats" value={search} onChange={event=>setSearch(event.target.value)} slotProps={{htmlInput:{maxLength:200}}}/>
   {choices.isPending&&<Typography role="status">Loading Chats…</Typography>}
   {choices.error&&<Alert severity="error" action={<Button onClick={()=>void choices.refetch()}>Retry</Button>}>Chats could not be loaded. {choices.error.message}</Alert>}
   {choices.isSuccess&&!choiceRows.length&&<Typography color="text.secondary">{searchText?'No Chats match this search.':'No Chats in this scope.'}</Typography>}
   <List disablePadding aria-label="Choose Chat">{choiceRows.map(c=><ListItem key={c.id} disablePadding><ListItemButton component="button" type="button" selected={c.id===chatId} aria-current={c.id===chatId?'true':undefined} onClick={()=>chooseChat(c)} sx={{width:'100%',borderRadius:1}}><ListItemText primary={c.title} secondary={`${c.id.slice(0,8)} · ${new Date(c.updatedAt).toLocaleString()}`} slotProps={{primary:{sx:{overflowWrap:'anywhere'}},secondary:{sx:{overflowWrap:'anywhere'}}}}/></ListItemButton></ListItem>)}</List>
   {choices.hasNextPage&&<Button disabled={choices.isFetchingNextPage} onClick={()=>void choices.fetchNextPage()}>Load more Chats</Button>}
  </Stack></DialogContent><DialogActions><Button onClick={()=>setPicker(false)}>Close</Button></DialogActions></Dialog>
  {creationKey&&<NewChatComposer key={creationKey} creationKey={creationKey} owner={creationOwner} inline engines={engines} enginesLoaded={enginesLoaded} onCreated={created} onCancel={()=>onNavigate({...branchRoute,creationKey:undefined},true)} onConfigureProvider={()=>onNavigate({...branchRoute,global:'providers'})}/>}
  {!creationKey&&creationAllowed&&pendingAttempt&&<Button onClick={startChat}>Retry opening Chat</Button>}
  {routedAgent.error&&<Alert severity="error" action={<Button onClick={()=>void routedAgent.refetch()}>Retry Agent</Button>}>The linked Agent is unavailable in Branches.</Alert>}
  {error&&<Alert severity="error" onClose={()=>setError('')}>{error}</Alert>}
  {chats.error&&<Alert severity="error" action={<Button onClick={()=>void chats.refetch()}>Retry Chats</Button>}>Chats could not be loaded. {chats.error.message}</Alert>}
  {chatId&&owner.error&&!listedChat&&<Alert severity="error" action={<Button onClick={()=>setChatId('')}>Choose another Chat</Button>}>This Chat is unavailable or no longer belongs to a Branch.</Alert>}
  {chat&&project.error&&<Alert severity="error" action={<Button onClick={()=>void project.refetch()}>Retry Chat workspace</Button>}>The Chat workspace could not be loaded. {project.error.message}</Alert>}
  {chat&&preferences.error&&<Alert severity="error" action={<Button onClick={()=>void preferences.refetch()}>Retry preferences</Button>}>Workspace preferences could not be loaded. {preferences.error.message}</Alert>}
  {chats.isPending&&<Typography>Loading Chats…</Typography>}{chatId&&owner.isPending&&!listedChat&&<Typography>Locating Chat…</Typography>}
  {chats.isSuccess&&!chats.data?.length&&<Typography color="text.secondary">{executionId?'No temporary Chats for this execution. Open Persistent Chats to inspect this workflow’s standing Agents.':'Create a Chat when this Branch needs persistent Agents. Script-only workflows do not need one.'}</Typography>}
  {chats.isSuccess&&(chats.data?.length??0)>1&&!chatId&&<Typography color="text.secondary">Choose a Chat to inspect or work with its Agents.</Typography>}
  {owner.data?.branchId&&(owner.data.branchId!==branchId||(owner.data.executionId??undefined)!==(executionId??undefined))&&<Typography>Opening the Chat’s owning workflow execution…</Typography>}
  {chat&&project.data&&preferences.data&&<>
   <Box sx={{flex:1,minHeight:0,minWidth:0,display:'flex',flexDirection:'column',overflow:'hidden'}}><WorkspaceReadOnlyContext.Provider value={Boolean(executionId)}><ProjectBrowserContext.Provider value={{projectId:chat.projectId,open:url=>{setBrowserRequest({url,requestId:++browserRequestSequence.current});setRoute({kind:'browser',projectId:chat.projectId,conversationId:chat.id})},openAgent:(agentId,runId)=>setRoute({kind:'browser',projectId:chat.projectId,agentId,runId})}}><ResourceSettingsContext.Provider value={executionId?{}:{render:(kind,id)=><CapabilityPolicyEditor key={`${kind}:${id}`} scopeKind={kind} onDirtyChange={setCapabilityDirty} endpoint={`/api/branches/${branchId}/${kind==='chat'?'chats':'agents'}/${id}/capabilities`}/>,confirmClose:()=>!capabilityDirty||guard(()=>{})}}><PrimaryHeaderActionsScope onPresenceChange={onHeaderReady}><ProjectShell projectId={chat.projectId} project={project.data} route={workspaceRoute!} engines={engines} preferences={preferences.data}
    onPreferences={patch=>{void preferenceWriter.enqueueAndWait(patch).catch((e:Error)=>setError(e.message))}}
    decisionReviewAction={<BranchNotifications onNavigate={onNavigate} presentation="button" label="View decision"/>}
    browserRequest={browserRequest} onBrowserRequestHandled={id=>setBrowserRequest(current=>consumeProjectBrowserRequest(current,id))}
    navigate={navigate} onResourceDeleted={resourceDeleted}
    onCreate={(kind,context)=>{if(executionId){setError('Execution Chats are available for inspection only.');return;}if(kind==='agent'&&context.projectId===chat.projectId&&context.conversationId===chat.id)setAgentCreate({projectId:chat.projectId,conversationId:chat.id,managerAgentId:context.managerAgentId});else if(kind==='chat')startChat();else setError('Configure the Branch trigger in Workflow.')}}/></PrimaryHeaderActionsScope></ResourceSettingsContext.Provider></ProjectBrowserContext.Provider></WorkspaceReadOnlyContext.Provider></Box>
   <Dialog open={Boolean(agentCreate&&agentCreate.conversationId===chat.id)} onClose={agentCreatePending?undefined:closeAgentCreate} fullWidth maxWidth="md"><DialogTitle>Create or import an Agent</DialogTitle><DialogContent>{agentCreate?.conversationId===chat.id&&<AgentCreateSurface projects={[project.data]} engines={engines} fixedProjectId={agentCreate.projectId} fixedConversationId={agentCreate.conversationId} initialManagerAgentId={agentCreate.managerAgentId} onPendingChange={pending=>{if(active.current&&currentAgentCreate.current===agentCreate)setAgentCreatePending(pending)}} onCancel={closeAgentCreate} onImportSubmitted={closeAgentCreate} onCreated={(projectId,a)=>agentCreated(projectId,a.id)} onImported={agentCreated}/>}</DialogContent></Dialog>
  </>}
 </Stack>;
}
