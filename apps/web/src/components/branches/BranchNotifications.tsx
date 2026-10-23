import {useNotifications} from "../../hooks/queries";
import {notificationTechnicalFocusId} from '../../technicalFocus';
import type {Route} from '../../routing';
import NotificationsOutlinedIcon from '@mui/icons-material/NotificationsOutlined';
import {Badge,Button,IconButton,Tooltip} from '@mui/material';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';
import type {BranchContextDto,WorkspaceNotificationDto} from '@ponderosa/core';
import {realApi,requestJson} from '../../api/real';
import {queryKeys} from '../../queryKeys';
import {branchWorkspaceRoute,type BranchRoute} from '../../branchesRouting';
import {NotificationPanel} from '../NotificationPanel';
import {notificationNavigationRoute} from '../../notificationNavigation';

/** The shared inbox reads the canonical product-scoped notification endpoint. */
export function BranchNotifications({onNavigate,presentation='icon'}:{onNavigate(route:BranchRoute):void;presentation?:'button'|'icon'}):JSX.Element {
 const [open,setOpen]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState<()=>void>(),client=useQueryClient();
 const query=useNotifications();
 const projects=useQuery({queryKey:['branch-global-projects'],queryFn:()=>realApi.listProjects(),enabled:open});
 const openWorkspace=async(workspace:Route)=>{
  try{setError('');setRetry(undefined);
   if(workspace.kind==='settings'){onNavigate({tab:'workflow',global:workspace.section??'general'});return;}
   if(!('projectId'in workspace)||!workspace.projectId)throw new Error('No Branch Chat is attached to this destination.');
   const chatId='conversationId'in workspace?workspace.conversationId:workspace.kind==='agent'?(await realApi.getAgent(workspace.agentId,1)).agent.conversationId:undefined;
   const chats=await realApi.listConversations(workspace.projectId);
   const chat=chatId?chats.find(chat=>chat.id===chatId):chats.length===1?chats[0]:undefined;
   if(!chat)throw new Error('Choose the specific Branch Chat in this notification.');
   const context=await requestJson<BranchContextDto>(`/api/branches/contexts/${encodeURIComponent(chat.id)}`);
   if(!context.branchId)throw new Error('The Branch for this Chat is unavailable.');
   onNavigate(branchWorkspaceRoute(context,workspace as NonNullable<BranchRoute['workspace']>));
  }catch(e){setError((e as Error).message);setRetry(()=>()=>void openWorkspace(workspace));setOpen(true)}
 };
 const unseen=(query.data?.unacknowledgedActionCount??0)+(query.data?.unreadUpdateCount??0);
 const navigate=async(item:WorkspaceNotificationDto,work=false)=>{
  try{setError('');setRetry(undefined);
   const agentId=item.agentId??(item.action?.kind==='open_agent'?item.action.targetId:undefined);
   const chatId=item.conversationId??(agentId?(await realApi.getAgent(agentId,1)).agent.conversationId:undefined);
   const context=chatId?await requestJson<BranchContextDto>(`/api/branches/contexts/${encodeURIComponent(chatId)}`):undefined;
   const branchId=item.branchId??context?.branchId??(item.action?.kind==='open_branch'?item.action.targetId:undefined);
   const executionId=item.branchExecutionId??context?.executionId;
   if(!branchId)throw new Error('The notification destination is unavailable. Retry after refreshing its Branch.');
   const workspace=notificationNavigationRoute({...item,conversationId:chatId},new Set(item.projectId?[item.projectId]:[]));
   onNavigate({branchId,tab:workspace||chatId?'chats':'executions',...(executionId?{executionId}:{}),...(chatId?{chatId}:{}),...(workspace&&'projectId'in workspace&&workspace.projectId?{workspace:work&&agentId?{kind:'agent',projectId:workspace.projectId,agentId,view:'technical',technicalFocusId:notificationTechnicalFocusId(item)}:work?{kind:'projectWork',projectId:workspace.projectId,conversationId:chatId,focusId:notificationTechnicalFocusId(item)}:workspace as NonNullable<BranchRoute['workspace']>}: {})});
  }catch(e){setError((e as Error).message);setRetry(()=>()=>void navigate(item,work));setOpen(true)}
 };
 return <>
  {presentation==='icon'?<Tooltip title="Notifications"><IconButton aria-label={`Branches notifications${unseen?`, ${unseen} unread`:''}`} onClick={()=>setOpen(true)}><Badge badgeContent={unseen} color="error" max={99}><NotificationsOutlinedIcon/></Badge></IconButton></Tooltip>:<Button onClick={()=>setOpen(true)}>Notifications ({unseen})</Button>}
  <NotificationPanel open={open} projects={projects.data??[]} firstPage={query.data} firstPageRevision={query.successfulFetchRevision} getFirstPageRevision={query.getSuccessfulFetchRevision} onClose={()=>setOpen(false)} onNavigate={route=>void openWorkspace(route)} onOpenNotification={(item,work)=>void navigate(item,work)} productScoped externalError={error||query.error?.message} onRetryExternal={()=>{if(retry){setOpen(false);retry();}else void client.invalidateQueries({queryKey:queryKeys.notifications.all})}} onOpenSettings={()=>onNavigate({tab:'workflow',global:'notifications'})}/>
 </>;
}
