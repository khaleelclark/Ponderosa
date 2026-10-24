import ChatIcon from "@mui/icons-material/ChatBubbleOutline";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
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
import {AgentOrganizationDialog} from '../AgentDetail.parts';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useMutation,useQuery,useQueryClient,useInfiniteQuery} from '@tanstack/react-query';
import {Alert,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,Menu,MenuItem,IconButton,Tooltip,List,ListItem,ListItemButton,ListItemText,Stack,TextField,Typography} from '@mui/material';
import type {AgentDto,BranchContextDto,EngineDto} from '@ponderosa/core';
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
 const [actions,setActions]=useState<HTMLElement>();
 const [picker,setPicker]=useState(false),[search,setSearch]=useState('');
 const searchText=search.trim();
 useEffect(()=>{setPicker(false);setSearch('')},[branchId,executionId]);
 const route=branchRoute.workspace;
 const routeAgentId=route&&'agentId'in route?route.agentId:undefined;
 const routedAgent=useQuery({queryKey:['branch-routed-agent-owner',routeAgentId],queryFn:()=>realApi.getAgent(routeAgentId!,1),enabled:Boolean(routeAgentId),retry:false});
 const chatId=(route&&'conversationId'in route?route.conversationId:undefined)??(routeAgentId?routedAgent.data?.agent.conversationId:branchRoute.chatId)??'';
 const setRoute=(workspace:ProjectRoute|undefined)=>onNavigate({...branchRoute,workspace});
 const setChatId=(chatId:string)=>onNavigate({...branchRoute,creationKey:undefined,chatId:chatId||undefined,workspace:undefined});
 const openChat=(id:string,projectId:string,replace=false)=>onNavigate({...branchRoute,creationKey:undefined,chatId:id,workspace:{kind:'conversation',projectId,conversationId:id}},replace);
 const [organization,setOrganization]=useState(false),[member,setMember]=useState<AgentDto>(),[manager,setManager]=useState(''),[saved,setSaved]=useState(''),[capabilities,setCapabilities]=useState<{kind:'chat'|'agent';id:string;title:string}>(),[capabilityDirty,setCapabilityDirty]=useState(false);
 useBranchDraftGuard('chat-capabilities',capabilityDirty);
 const client=useQueryClient(),[agentCreate,setAgentCreate]=useState<{managerAgentId?:string}>(),[error,setError]=useState('');
 const chatPages=useInfiniteQuery({queryKey:['branch-chats',branchId,executionId,'pages'],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestCollectionPage<BranchContextDto>(`/api/branches/${branchId}/chats?limit=100${executionId?'&executionId='+encodeURIComponent(executionId):''}${pageParam?'&cursor='+encodeURIComponent(pageParam):''}`),getNextPageParam:last=>last.hasMore?last.cursor:undefined,select:normalizeResetPages,refetchInterval:5000});
 const searches=useInfiniteQuery({queryKey:['branch-chats',branchId,executionId,'search',searchText],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestCollectionPage<BranchContextDto>(`/api/branches/${branchId}/chats?limit=100&search=${encodeURIComponent(searchText)}${executionId?'&executionId='+encodeURIComponent(executionId):''}${pageParam?'&cursor='+encodeURIComponent(pageParam):''}`),getNextPageParam:last=>last.hasMore?last.cursor:undefined,select:normalizeResetPages,enabled:picker&&Boolean(searchText),refetchInterval:picker&&searchText?5000:false});
 const chats={...chatPages,data:chatPages.data?uniqueBy(chatPages.data.pages.flatMap(page=>page.items),chat=>chat.id):undefined};
 const choices=searchText?searches:chatPages,choiceRows=uniqueBy(choices.data?.pages.flatMap(page=>page.items)??[],chat=>chat.id);
 const chatCount=chatPages.data?.pages[0]?.total;
 const [browserRequest,setBrowserRequest]=useState<ProjectBrowserRequest>(),browserRequestSequence=useRef(0);
 const owner=useQuery({queryKey:['branch-chat-owner',chatId],queryFn:()=>requestJson<BranchContextDto>(`/api/branches/contexts/${chatId}`),enabled:Boolean(chatId),retry:false,refetchInterval:5000});
 const listedChat=chats.data?.find(c=>c.id===chatId),ownerMatches=!(owner.error instanceof ApiRequestError&&[404,410].includes(owner.error.status))&&owner.data?.branchId===branchId&&(owner.data.executionId??undefined)===(executionId??undefined),chat=listedChat??(ownerMatches?owner.data:undefined),project=useQuery({queryKey:['project',chat?.projectId],queryFn:()=>realApi.getProject(chat!.projectId),enabled:Boolean(chat)});
 const preferences=useWorkspacePreferences(),preferenceWriter=useWorkspacePreferencesWriter();
 const members=useQuery({queryKey:['branch-org',branchId,chatId],queryFn:async()=>{const agents:AgentDto[]=[];let cursor:string|undefined;do{const page=await realApi.listConversationMembersPage(chatId,{limit:100,cursor});agents.push(...page.items);cursor=page.hasMore?page.cursor:undefined;}while(cursor);return {agents};},enabled:Boolean(chatId)&&(organization||Boolean(executionId))});
 useEffect(()=>{if(!branchRoute.creationKey&&!chatId&&chats.data?.length===1){const c=chats.data[0]!;openChat(c.id,c.projectId,true)}},[chatId,chats.data,branchRoute.creationKey]);
 useEffect(()=>{const context=owner.data,targetExecution=context?.executionId??undefined;if(!branchRoute.creationKey&&chatId&&context?.branchId&&(context.branchId!==branchId||targetExecution!==(executionId??undefined)||branchRoute.chatId!==context.id))onNavigate({branchId:context.branchId,tab:'chats',executionId:targetExecution,chatId:context.id,workspace:route?.projectId===context.projectId?route:{kind:'conversation',projectId:context.projectId,conversationId:context.id}},true)},[branchId,chatId,executionId,owner.data,branchRoute.chatId,branchRoute.creationKey,route]);
 const saveManager=useMutation({mutationFn:()=>realApi.updateAgentOrganization(member!.id,{managerAgentId:manager||null}),onSuccess:updated=>{setMember(undefined);setSaved(`Reporting line saved for ${updated.title}.`);void members.refetch();void client.invalidateQueries({queryKey:['agents']});void client.invalidateQueries({queryKey:['branch-agents']})}});
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
 const workspaceRoute:ProjectRoute|undefined=chat?(route?.projectId===chat.projectId&&(!executionId||['conversation','agent','workspaceFile','review','projectWork'].includes(route.kind))?route:{kind:'conversation',projectId:chat.projectId,conversationId:chat.id}):undefined;
 const navigate=(next:Route)=>{
   if('projectId' in next && next.projectId===chat?.projectId&&(!executionId||['conversation','agent','workspaceFile','review','projectWork'].includes(next.kind))){setRoute(next as ProjectRoute);return;}
   if(next.kind==='home'){if(chat&&route?.kind==='browser')setRoute({kind:'conversation',projectId:chat.projectId,conversationId:chat.id});else setChatId('');return;}
   setError('This view belongs outside the selected Branch Chat.');
 };
 return <Stack spacing={1} sx={{flex:1,minHeight:0,minWidth:0,overflow:'hidden'}}>
  <Stack direction="row" gap={1} alignItems="center" sx={{flexShrink:0,minWidth:0}}><Button size="small" startIcon={<ChatIcon/>} endIcon={<ArrowDropDownIcon/>} aria-haspopup="dialog" onClick={()=>{setSearch('');setPicker(true)}} sx={{whiteSpace:'nowrap'}}>{executionId?'Execution Chats':'Chats'} ({chatCount??(chatPages.error?'?':'…')})</Button>{executionId&&<Button size="small" onClick={()=>onNavigate({...branchRoute,executionId:undefined,chatId:undefined,workspace:undefined})}>Persistent Chats</Button>}{!executionId&&<Tooltip title="New Chat"><span><IconButton aria-label="New Chat" disabled={Boolean(creationKey)} onClick={startChat}><AddIcon/></IconButton></span></Tooltip>}{!executionId&&chat&&<Tooltip title="Chat actions"><IconButton aria-label="Chat actions" aria-haspopup="menu" aria-expanded={Boolean(actions)} onClick={e=>setActions(e.currentTarget)}><MoreHorizIcon/></IconButton></Tooltip>}{notificationAction}</Stack>
  <Dialog open={picker} onClose={()=>setPicker(false)} fullWidth maxWidth="sm"><DialogTitle>{executionId?'Execution Chats':'Chats'}</DialogTitle><DialogContent dividers><Stack spacing={1}>
   <TextField autoFocus size="small" label="Search Chats" value={search} onChange={event=>setSearch(event.target.value)} slotProps={{htmlInput:{maxLength:200}}}/>
   {choices.isPending&&<Typography role="status">Loading Chats…</Typography>}
   {choices.error&&<Alert severity="error" action={<Button onClick={()=>void choices.refetch()}>Retry</Button>}>Chats could not be loaded. {choices.error.message}</Alert>}
   {choices.isSuccess&&!choiceRows.length&&<Typography color="text.secondary">{searchText?'No Chats match this search.':'No Chats in this scope.'}</Typography>}
   <List disablePadding aria-label="Choose Chat">{choiceRows.map(c=><ListItem key={c.id} disablePadding><ListItemButton component="button" type="button" selected={c.id===chatId} aria-current={c.id===chatId?'true':undefined} onClick={()=>chooseChat(c)} sx={{width:'100%',borderRadius:1}}><ListItemText primary={c.title} secondary={`${c.id.slice(0,8)} · ${new Date(c.updatedAt).toLocaleString()}`} slotProps={{primary:{sx:{overflowWrap:'anywhere'}},secondary:{sx:{overflowWrap:'anywhere'}}}}/></ListItemButton></ListItem>)}</List>
   {choices.hasNextPage&&<Button disabled={choices.isFetchingNextPage} onClick={()=>void choices.fetchNextPage()}>Load more Chats</Button>}
  </Stack></DialogContent><DialogActions><Button onClick={()=>setPicker(false)}>Close</Button></DialogActions></Dialog>
  <Menu anchorEl={actions} open={Boolean(actions)} onClose={()=>setActions(undefined)}>
   {chat&&<><MenuItem onClick={()=>{setActions(undefined);setRoute({kind:'conversation',projectId:chat.projectId,conversationId:chat.id})}}>Conversation</MenuItem><MenuItem onClick={()=>{setActions(undefined);setOrganization(true)}}>Agents</MenuItem>{!executionId&&<><MenuItem onClick={()=>{setActions(undefined);setCapabilities({kind:'chat',id:chat.id,title:chat.title})}}>Chat capabilities</MenuItem><MenuItem onClick={()=>{setActions(undefined);setOrganization(true)}}>Manage reporting lines</MenuItem><MenuItem onClick={()=>{setActions(undefined);setAgentCreate({})}}>Create / import Agent</MenuItem></>}</>}
  </Menu>
  {creationKey&&<NewChatComposer key={creationKey} creationKey={creationKey} owner={creationOwner} inline engines={engines} enginesLoaded={enginesLoaded} onCreated={created} onCancel={()=>onNavigate({...branchRoute,creationKey:undefined},true)} onConfigureProvider={()=>onNavigate({...branchRoute,global:'providers'})}/>}
  {!creationKey&&creationAllowed&&pendingAttempt&&<Button onClick={startChat}>Retry opening Chat</Button>}
  {routedAgent.error&&<Alert severity="error" action={<Button onClick={()=>void routedAgent.refetch()}>Retry Agent</Button>}>The linked Agent is unavailable in Branches.</Alert>}
  {error&&<Alert severity="error" onClose={()=>setError('')}>{error}</Alert>}
  {chats.error&&<Alert severity="error" action={<Button onClick={()=>void chats.refetch()}>Retry Chats</Button>}>Chats could not be loaded. {chats.error.message}</Alert>}
  {chatId&&owner.error&&!listedChat&&<Alert severity="error" action={<Button onClick={()=>setChatId('')}>Choose another Chat</Button>}>This Chat is unavailable or no longer belongs to a Branch.</Alert>}
  {chat&&project.error&&<Alert severity="error" action={<Button onClick={()=>void project.refetch()}>Retry Chat workspace</Button>}>The Chat workspace could not be loaded. {project.error.message}</Alert>}
  {chat&&preferences.error&&<Alert severity="error" action={<Button onClick={()=>void preferences.refetch()}>Retry preferences</Button>}>Workspace preferences could not be loaded. {preferences.error.message}</Alert>}
  {chats.isPending&&<Typography>Loading Chats…</Typography>}{chatId&&owner.isPending&&!listedChat&&<Typography>Locating Chat…</Typography>}{saved&&<Alert severity="success" onClose={()=>setSaved('')}>{saved}</Alert>}
  {chats.isSuccess&&!chats.data?.length&&<Typography color="text.secondary">{executionId?'No temporary Chats for this execution. Open Persistent Chats to inspect this workflow’s standing Agents.':'Create a Chat when this Branch needs persistent Agents. Script-only workflows do not need one.'}</Typography>}
  {chats.isSuccess&&(chats.data?.length??0)>1&&!chatId&&<Typography color="text.secondary">Choose a Chat to inspect or work with its Agents.</Typography>}
  {owner.data?.branchId&&(owner.data.branchId!==branchId||(owner.data.executionId??undefined)!==(executionId??undefined))&&<Typography>Opening the Chat’s owning workflow execution…</Typography>}
  {chat&&project.data&&preferences.data&&<>
   <Box sx={{flex:1,minHeight:0,minWidth:0,display:'flex',flexDirection:'column',overflow:'hidden'}}><WorkspaceReadOnlyContext.Provider value={Boolean(executionId)}><ProjectBrowserContext.Provider value={{projectId:chat.projectId,open:url=>{setBrowserRequest({url,requestId:++browserRequestSequence.current});setRoute({kind:'browser',projectId:chat.projectId,conversationId:chat.id})},openAgent:(agentId,runId)=>setRoute({kind:'browser',projectId:chat.projectId,agentId,runId})}}><PrimaryHeaderActionsScope onPresenceChange={onHeaderReady}><ProjectShell projectId={chat.projectId} project={project.data} route={workspaceRoute!} engines={engines} notifications={[]} preferences={preferences.data}
    onPreferences={patch=>{void preferenceWriter.enqueueAndWait(patch).catch((e:Error)=>setError(e.message))}}
    onRenameConversation={c=>{if(executionId){setError('Execution Chats are available for inspection only.');return;}const name=window.prompt('Chat name',c.title);if(name)void realApi.updateConversation(c.id,{title:name}).then(()=>client.invalidateQueries({queryKey:['branch-chats',branchId]})).catch(e=>setError(e.message))}}
    onDeleteConversation={()=>setError('Remove Branch-owned Chats through a reviewed Branch update.')}
    decisionReviewAction={<BranchNotifications onNavigate={onNavigate} presentation="button" label="View decision"/>}
    onOpenEngineStatus={()=>onNavigate({...branchRoute,global:'status'})}
    browserRequest={browserRequest} onBrowserRequestHandled={id=>setBrowserRequest(current=>consumeProjectBrowserRequest(current,id))}
    navigate={navigate} onProjectDeleted={()=>{setChatId('');void chats.refetch()}}
    onCreate={(kind,context)=>{if(executionId){setError('Execution Chats are available for inspection only.');return;}if(kind==='agent')setAgentCreate({managerAgentId:context.managerAgentId});else if(kind==='chat')startChat();else setError('Configure the Branch trigger in Workflow.')}}/></PrimaryHeaderActionsScope></ProjectBrowserContext.Provider></WorkspaceReadOnlyContext.Provider></Box>
   <Dialog open={Boolean(agentCreate)} onClose={()=>setAgentCreate(undefined)} fullWidth maxWidth="md"><DialogTitle>Create or import an Agent</DialogTitle><DialogContent>{agentCreate&&<AgentCreateSurface projects={[project.data]} engines={engines} fixedProjectId={chat.projectId} fixedConversationId={chat.id} initialManagerAgentId={agentCreate.managerAgentId} onCancel={()=>setAgentCreate(undefined)} onCreated={(_p,a)=>{setAgentCreate(undefined);setRoute({kind:'agent',projectId:chat.projectId,agentId:a.id})}} onImported={(_p,id)=>{setAgentCreate(undefined);setRoute({kind:'agent',projectId:chat.projectId,agentId:id})}}/>}</DialogContent></Dialog>
  </>}
  <Dialog transitionDuration={0} open={organization} onClose={()=>setOrganization(false)} fullWidth maxWidth="sm"><DialogTitle>Reporting lines · {chat?.title}</DialogTitle><DialogContent><Stack spacing={2}>{members.isPending&&<Typography>Loading organization…</Typography>}{members.error&&<Alert severity="error">{members.error.message}</Alert>}{members.data?.agents.map(a=><Stack key={a.id} direction="row" spacing={2} alignItems="center"><Box sx={{flex:1}}><Typography fontWeight={600}>{a.title}</Typography><Typography variant="body2">{a.managerAgentId?`Reports to ${members.data.agents.find(m=>m.id===a.managerAgentId)?.title??'another Agent'}`:'Reports to you'}</Typography></Box>{executionId?<Button onClick={()=>setRoute({kind:'agent',projectId:chat!.projectId,agentId:a.id})}>Inspect Agent</Button>:<><Button onClick={()=>setCapabilities({kind:'agent',id:a.id,title:a.title})}>Capabilities</Button><Button onClick={()=>{setMember(a);setManager(a.managerAgentId??'');saveManager.reset()}}>Change manager</Button></>}</Stack>)}<Button onClick={()=>setOrganization(false)}>Done</Button></Stack></DialogContent></Dialog>
  {member&&<AgentOrganizationDialog open agent={member} agents={members.data?.agents??[]} organizationParentId={manager} setOrganizationParentId={setManager} updateOrganization={saveManager} onClose={()=>{if(!saveManager.isPending)setMember(undefined)}}/>}
  <Dialog open={Boolean(capabilities)} onClose={()=>guard(()=>setCapabilities(undefined))} fullWidth maxWidth="md"><DialogTitle>{capabilities?.title} capabilities</DialogTitle><DialogContent dividers>{capabilities&&<CapabilityPolicyEditor scopeKind={capabilities.kind} onDirtyChange={setCapabilityDirty} endpoint={capabilities.kind==='chat'?`/api/branches/${branchId}/chats/${capabilities.id}/capabilities`:`/api/branches/${branchId}/agents/${capabilities.id}/capabilities`}/>}</DialogContent><DialogActions><Button onClick={()=>guard(()=>setCapabilities(undefined))}>Done</Button></DialogActions></Dialog>
 </Stack>;
}
