import {useAgentHealth} from '../../hooks/queries';
import {mergeAgentStatuses} from '../../agents';
import {queryKeys} from '../../queryKeys';
import {useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Alert,Button,Dialog,DialogActions,DialogContent,DialogTitle,Stack,Typography} from '@mui/material';
import type {AgentDto,BranchContextDto,EngineDto} from '@ponderosa/core';
import {AgentCreateForm} from '../AgentCreateDialog';
import {AgentRoleSettings} from '../AgentDetail.settings';
import {AgentsTab} from '../AgentsTab';
import {NewChatComposer} from '../NewChatComposer';
import {createClientId} from '../../clientId';
import {realApi,requestJson} from '../../api/real';
import {readCreationAttempts,sameCreationOwner} from '../chatCreationAttempts';
import type {AgentSetupRequest} from './AgentStepFields';
/** Real-resource creation composes the shared Chat, Agent and team owners; it never publishes a workflow. */
export function WorkflowAgentSetup({branchId,chatId,request,engines,onComplete,onClose,onPendingChange}:{branchId:string;chatId:string;request:AgentSetupRequest;engines:EngineDto[];onComplete(agent:AgentDto):void;onClose():void;onPendingChange(pending:boolean):void}):JSX.Element {
 const client=useQueryClient(),[selectedChat,setSelectedChat]=useState(chatId),[root,setRoot]=useState<AgentDto|undefined>(request.kind==='organization'?request.agent:undefined),[memberManager,setMemberManager]=useState<string>(),[editing,setEditing]=useState(request.kind==='edit'?request.agent:undefined),[pending,setPending]=useState(false),locked=useRef(false);
 const owner={product:'branches' as const,branchId};
 const [creationKey]=useState(()=>readCreationAttempts().find(attempt=>sameCreationOwner(attempt.owner,owner)&&!attempt.chat)?.key??createClientId());
 const context=useQuery({queryKey:['branch-context',selectedChat],queryFn:()=>requestJson<BranchContextDto>(`/api/branches/contexts/${selectedChat}`),enabled:Boolean(selectedChat)});
 const chat=context.data,eligible=chat?.branchId===branchId&&!chat.executionId;
 const project=useQuery({queryKey:['project',chat?.projectId],queryFn:()=>realApi.getProject(chat!.projectId),enabled:eligible});
 const roster=useQuery({queryKey:['branch-step-team',branchId,chat?.projectId],queryFn:()=>realApi.listAgents(chat!.projectId),enabled:Boolean(root&&eligible)});
 const health=useAgentHealth(chat?.projectId,Boolean(root&&eligible));
 const reportPending=(value:boolean)=>{locked.current=value;setPending(value);onPendingChange(value)};
 const close=()=>{if(!locked.current)onClose()};
 const refresh=()=>{void client.invalidateQueries({queryKey:['branch-agents',branchId]});void client.invalidateQueries({queryKey:['branch-step-team',branchId]});void client.invalidateQueries({queryKey:['branch-chats',branchId]});if(chat)void client.invalidateQueries({queryKey:queryKeys.agents.health(chat.projectId)})};
 return <Dialog open fullWidth maxWidth={root?'md':'sm'} onClose={close} disableEscapeKeyDown={pending}><DialogTitle>{editing?'Edit Agent':root?'Team Setup':request.kind==='organization'?'New Organization':'New Agent'}</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
  {editing?<><Typography variant="subtitle2">{editing.title}</Typography><AgentRoleSettings agent={editing} onSaved={()=>{refresh();void client.invalidateQueries({queryKey:['branch-step-agent',editing.id]})}}/></>:!selectedChat?<NewChatComposer creationKey={creationKey} owner={owner} inline engines={engines} onPendingChange={reportPending} onCreated={(_projectId,id)=>{setSelectedChat(id);return true}} onCancel={close}/>:context.error?<Alert severity="error" action={<Button onClick={()=>void context.refetch()}>Retry</Button>}>{context.error.message}</Alert>:chat&&!eligible?<Alert severity="error">Choose A Persistent Chat In This Branch Before Creating An Agent.</Alert>:project.error?<Alert severity="error" action={<Button onClick={()=>void project.refetch()}>Retry</Button>}>{project.error.message}</Alert>:!project.data?<Typography role="status">Loading Agent Setup…</Typography>:!root||memberManager?<AgentCreateForm key={memberManager??'root'} projects={[project.data]} engines={engines} fixedProjectId={chat!.projectId} fixedConversationId={chat!.id} initialManagerAgentId={memberManager} workflowSetup onPendingChange={reportPending} onCancel={()=>memberManager?setMemberManager(undefined):close()} onCreated={(_projectId,agent)=>{refresh();if(memberManager){setMemberManager(undefined);return;}if(request.kind==='organization')setRoot(agent);else onComplete(agent)}}/>:<>
   {roster.error&&<Alert severity="error" action={<Button onClick={()=>void roster.refetch()}>Retry</Button>}>{roster.error.message}</Alert>}
   <Stack direction="row" alignItems="center" gap={1}><Typography sx={{flex:1}} fontWeight={600}>{root.title}</Typography><Button onClick={()=>setEditing(root)}>Edit Agent…</Button></Stack>
   <AgentsTab agents={roster.data??[root]} relationshipAgents={roster.data??[root]} projectId={chat!.projectId} engines={engines} conversations={[chat!]} scopeConversationId={chat!.id} organizationRootAgentId={root.id} statusByAgentId={mergeAgentStatuses(roster.data??[root],health.data?.agents??[],new Map())} healthByAgentId={new Map((health.data?.agents??[]).map(agent=>[agent.agentId,agent]))} onOpenAgent={id=>setEditing(roster.data?.find(agent=>agent.id===id))} onOpenAgentSettings={id=>setEditing(roster.data?.find(agent=>agent.id===id))} onNewAgent={managerId=>setMemberManager(managerId??root.id)} selectionAllowed={false} collection={{title:'Team Setup',variant:'embedded'}}/>
  </>}
 </Stack></DialogContent>{(editing||root&&!memberManager||!project.data)&&<DialogActions>
  {editing&&root?<Button disabled={pending} onClick={()=>setEditing(undefined)}>Back To Team Setup</Button>:<Button disabled={pending} onClick={close}>{editing?'Close':'Cancel'}</Button>}
  {root&&!editing&&!memberManager&&<Button variant="contained" disabled={pending} onClick={()=>onComplete(root)}>Use Organization</Button>}
 </DialogActions>}</Dialog>;
}
