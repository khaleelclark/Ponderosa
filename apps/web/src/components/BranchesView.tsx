import {useMutationNotification} from './MutationNotifications';
import {ConfirmDialog,TextInputDialog} from './ConfirmationDialogs';
import {PrimaryHeaderActionsProvider} from './PrimaryHeaderActions';
import {CompactWorkspaceHeader} from './WorkspaceFrame';
import {BranchWorkspaceHeader} from './branches/BranchWorkspaceHeader';
import {useWorkspaceFont} from "../hooks/useWorkspaceFont";
import {BranchHome} from './branches/BranchHome';
import { BranchFolders } from './branches/BranchFolders';
import { WorkspacePreferencesWriter } from '../workspacePreferencesWriter';
import { useWorkspacePreferences } from '../hooks/queries';
import { queryKeys } from '../queryKeys';
import {normalizeResetPages} from '../collections';
import {markWorkspaceResourceUsed} from '../workspaceRecency';
import { starredWorkspaceResources, toggleWorkspaceResourceStar, changedWorkspaceDirectoryKinds } from '../resourcePreferences';
import {createClientId} from '../clientId';
import {useAppViewport} from '../hooks/useAppViewport';
import {MobileNavigationProvider} from './MobileNavigationContext';
import {BranchLifecycleStatus,BranchTriggerAudit} from './branches/BranchOperations';
import {BranchRunHistory} from './branches/BranchRunHistory';
import type {ColorMode} from '../theme';
import {SettingsSidebarPanel} from './WorkspaceSidebar.chrome';
import {BranchGlobalSettings} from './branches/BranchGlobalSettings';
import {WorkspaceConnectionNotice} from './WorkspaceConnectionNotice';
import {SidebarResourceRow} from './SidebarResourceRow';
import {branchRoutePath,branchWorkspaceRoute,branchSettingsSection,type BranchRoute} from '../branchesRouting';
import {BranchNavigation,useBranchDraftGuard,useBranchNavigationGuard,useBranchWorkflowLeaveGuard} from './branches/BranchNavigation';
import {BranchNotifications} from './branches/BranchNotifications';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import AddIcon from '@mui/icons-material/Add';
import {BranchPackageDialog} from './branches/BranchPackageDialog';
import {AGENT_PACKAGE_MAX_BYTES,AGENT_PACKAGE_LIMIT_LABEL,INLINE_TEXT_MAX_CODE_POINTS,normalizeCanonicalText,unicodeCodePointLength,type InstalledBranchPackage} from '@ponderosa/core';
import {BranchSettings,BranchAvailability} from './branches/BranchSettings';
import {BranchChats} from './branches/BranchChats';
import {WorkspaceConnectionProvider} from './WorkspaceConnectionContext';
import {useWorkspaceStream} from '../hooks/useWorkspaceStream';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useInfiniteQuery,useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Accordion,AccordionSummary,AccordionDetails,Alert,Box,Button,Chip,Dialog,DialogActions,DialogContent,DialogTitle,Divider,Paper,Stack,SwipeableDrawer,TextField,Typography,useMediaQuery,useTheme} from '@mui/material';
import type {BranchBindings,BranchContextDto,BranchDefinition,BranchDeploymentPreviewDto,BranchDto,BranchExecutionDetailDto,BranchExecutionDto,BranchLifecycleDto,BranchVersionDto,BranchVersionSummaryDto,DeployBranchRequest,DeployBranchResponse,TriggerDefinitionDto} from '@ponderosa/core';
import {ApiRequestError} from '../api/types';
import {realApi,requestJson,requestCollectionPage} from '../api/real';
import {WorkflowEditor,WorkflowExecutionSettings} from './branches/WorkflowEditor';
import {emptyWorkflowHistory,moveWorkflowHistory,recordWorkflowEdit,type WorkflowDraftEdit} from './branches/workflow-history';
import type {CanvasViewState} from './branches/WorkflowCanvas';
import {ExecutionPanel,type ExecutionPanelViewState} from './branches/ExecutionPanel';
import {BranchDirectoryStatus} from './branches/BranchDirectoryStatus';
import {newDefinition,bindDefinitionDirectories,branchDraftRevision,isCurrentWorkflowResponse} from './branches/model';
import {SharedSidebarPanel} from './WorkspaceSidebar.parts';
import {BranchesSidebar} from './branches/BranchesSidebar';
import {restoreWorkspaceSidebarState,serializeWorkspaceSidebarState} from '../workspaceSidebarState';
import {GlobalChatSearch,isGlobalSearchShortcut,routeForGlobalSearchSelection,type GlobalSearchSelection} from './GlobalChatSearch';
type Context=BranchContextDto;
type Draft={definition:BranchDefinition;bindings:BranchBindings;chatId:string;branchId?:string;expectedVersionId?:string};
type DiscardIntent={branchId:string;selection:number;revision:string;edits:number};
type RunIntent={branchId:string;selection:number;route:BranchRoute;input:string;occurrenceKey:string};
async function readWorkflowDraft(branch:BranchDto):Promise<Draft>{
 const [version,bindings]=await Promise.all([branch.versionId?requestJson<BranchVersionDto>(`/api/branches/${branch.id}/versions/${branch.versionId}`,{cache:'no-store'}):Promise.resolve({definition:{...newDefinition(),name:branch.name}}),requestJson<BranchBindings>(`/api/branches/${branch.id}/configuration${branch.bindingRevisionId?'?revisionId='+encodeURIComponent(branch.bindingRevisionId):''}`,{cache:'no-store'})]);
 return {branchId:branch.id,expectedVersionId:branch.versionId,chatId:branch.chatId,definition:version.definition,bindings};
}
const emptyDraft=():Draft=>({definition:newDefinition(),bindings:{agents:{},directories:{}},chatId:''});
const BRANCHES_SIDEBAR_STORAGE_KEY='ponderosa.branchesSidebar.v1';
function deploymentOperationLabel(operation:BranchDeploymentPreviewDto['operations'][number],definition:BranchDefinition,previous?:BranchDefinition):string{
 if(operation.resource!=='Called Branch')return operation.ref;
 const steps=operation.kind==='detach'?previous?.steps:definition.steps;
 const labels=steps?.filter(step=>step.kind==='branch_call'&&step.branchRef===operation.ref).map(step=>step.label?.trim()||step.id)??[];
 return labels.length?labels.join(', '):operation.ref;
}
function download(value:unknown,name:string):void{const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function mergeHistory(pages:BranchExecutionDetailDto[]|undefined):BranchExecutionDetailDto|undefined{
 if(!pages?.length)return undefined;const first=pages[0]!;
 const merge=<T,>(select:(p:BranchExecutionDetailDto)=>T[],id:(row:T)=>string):T[]=>{const rows=new Map<string,T>();for(const page of [...pages].reverse())for(const row of select(page))rows.set(id(row),row);return [...rows.values()]};
 return {...first,steps:merge(p=>p.steps,r=>r.id),attempts:merge(p=>p.attempts,r=>r.id),gates:merge(p=>p.gates,r=>r.id),paths:merge(p=>p.paths,r=>r.id),resources:merge(p=>p.resources,r=>r.stepExecutionId),decisions:merge(p=>p.decisions??[],r=>r.id),sealedResults:merge(p=>p.sealedResults??[],r=>r.id),maps:merge(p=>p.maps??[],r=>r.id),mapItems:merge(p=>p.mapItems??[],r=>r.id)};
}
/** Branches has its own workflow-centered authoring and operations shell. */
type Appearance={colorMode:ColorMode;onToggleColorMode():void};
export function BranchesView(props:Appearance):JSX.Element{return <BranchNavigation>{router=><BranchesWorkspace {...router} {...props}/>}</BranchNavigation>}
function BranchesWorkspace({route,navigate,colorMode,onToggleColorMode}:Appearance&{route:BranchRoute;navigate(route:BranchRoute,replace?:boolean,onAccepted?:()=>void):boolean}):JSX.Element{
 const guard=useBranchNavigationGuard(),notify=useMutationNotification();
 const tab=route.tab,executionId=route.executionId??'';
 useAppViewport();
 const client=useQueryClient();
 const preferenceWriter=useRef<WorkspacePreferencesWriter>();
 if(!preferenceWriter.current)preferenceWriter.current=new WorkspacePreferencesWriter({
  read:()=>client.getQueryData(queryKeys.workspacePreferences.all),
  publish:value=>client.setQueryData(queryKeys.workspacePreferences.all,value),
  write:patch=>realApi.updateWorkspacePreferences(patch),refresh:()=>realApi.getWorkspacePreferences(),
  onSuccess:(previous,value,patch)=>{void client.invalidateQueries({queryKey:['branches']});for(const kind of changedWorkspaceDirectoryKinds(previous,value))void client.invalidateQueries({queryKey:queryKeys.workspaceDirectory.kind(kind)});if(patch.starredResourceIds!==undefined||patch.starredProjectIds!==undefined)void client.invalidateQueries({queryKey:queryKeys.workspaceResourceRecency.all});if(patch.claudeModelOptions!==undefined){void client.invalidateQueries({queryKey:queryKeys.engines.all});void client.invalidateQueries({queryKey:['engine-models']});}},
  onError:reason=>setError(`Could not save sidebar preferences: ${(reason as Error).message}`),
 });
 const connection=useWorkspaceStream({projectPreferences:value=>preferenceWriter.current!.projectCanonical(value)});
 const preferences=useWorkspacePreferences(preferenceWriter.current);
 useWorkspaceFont(preferences.data?.fontFamily);
 const onGlobal=(global:NonNullable<BranchRoute['global']>)=>{navigate({...route,global},false,()=>setMobileNavOpen(false))};
 const health=useQuery({queryKey:queryKeys.health.all,queryFn:()=>realApi.getHealth(),enabled:Boolean(route.global),staleTime:60000});
 const theme=useTheme(),mobileWorkspace=useMediaQuery(theme.breakpoints.down('md'));
 const [mobileNavOpen,setMobileNavOpen]=useState(false),[globalSearchOpen,setGlobalSearchOpen]=useState(false);
 const sharedNavigationButton=useRef<HTMLButtonElement>(null),workflowImportInput=useRef<HTMLInputElement>(null),packageUpdateInput=useRef<HTMLInputElement>(null),packageUpdateSelection=useRef(0);
 const [sidebarPresentation,setSidebarPresentation]=useState(()=>{try{return restoreWorkspaceSidebarState(localStorage.getItem(BRANCHES_SIDEBAR_STORAGE_KEY))}catch{return restoreWorkspaceSidebarState(null)}});
 const feedback=useRef<HTMLDivElement>(null);
 const [runOpen,setRunOpen]=useState(false);
 const [renameId,setRenameId]=useState<string>();
 const [openingAttempt,setOpeningAttempt]=useState(0);
 const [openingLink,setOpeningLink]=useState(()=>{const params=new URLSearchParams(window.location.search);return Boolean(params.get('branch')||params.get('execution'))});
 const creation=useRef<string>(),actionLocks=useRef(new Set<string>()),[creating,setCreating]=useState(false);
 const executionViewStates=useRef(new Map<string,ExecutionPanelViewState>());
 const once=<T,>(key:string,action:()=>T):T|undefined=>{if(actionLocks.current.has(key))return;actionLocks.current.add(key);return action()};
 const [advancedDirty,setAdvancedDirty]=useState(false);
 const draftRevision=useRef(''),pendingAdvanced=useRef(false),workflowEdits=useRef(0);
 const reportPendingEdits=useCallback((pending:boolean)=>{workflowEdits.current++;pendingAdvanced.current=pending;setAdvancedDirty(pending)},[]);
 const [discardIntent,setDiscardIntent]=useState<DiscardIntent>();
 const [install,setInstall]=useState<{pkg:InstalledBranchPackage;branchId?:string}>(),[deployedUpdate,setDeployedUpdate]=useState<{branch:BranchDto;reason:'dirty'|'failed'}>();
 const routeOwner=useRef(route);routeOwner.current=route;
 const selection=useRef(0),savedDraft=useRef<string>(),versionRequest=useRef(0),[draft,updateDraft]=useState<Draft>(emptyDraft),[editorKey,setEditorKey]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(false),[search,setSearch]=useState(''),[input,setInput]=useState(''),[occurrenceKey,setOccurrenceKey]=useState(()=>createClientId()),[preview,setPreview]=useState<{draftRevision:string;input:DeployBranchRequest;result:BranchDeploymentPreviewDto;expectsNewWebhookSecret:boolean}>(),[secret,setSecret]=useState<{branchId:string;value:string}>(),[secretRecovery,setSecretRecovery]=useState<string>();
 const currentDraft=useRef(draft);currentDraft.current=draft;
 const workflowLeave=useRef<{kind:'save'|'discard';branchId:string;draft:Draft;revision:string;complete(success:boolean):void;attempt?:NonNullable<typeof preview>;discard?:DiscardIntent}>();
 const finishWorkflowLeave=(success=false,intent=workflowLeave.current)=>{if(!intent||workflowLeave.current!==intent)return;workflowLeave.current=undefined;intent.complete(success&&routeOwner.current.branchId===intent.branchId&&!routeOwner.current.global&&currentDraft.current.branchId===intent.branchId&&!pendingAdvanced.current&&draftRevision.current===savedDraft.current)};
 const draftHistory=useRef(emptyWorkflowHistory()),canvasViews=useRef(new Map<string,CanvasViewState>());
 const setDraft=(value:Draft|((draft:Draft)=>Draft),record=true)=>{const before=currentDraft.current,next=typeof value==='function'?value(before):value;if(record)draftHistory.current=recordWorkflowEdit(draftHistory.current,before,next);currentDraft.current=next;draftRevision.current=branchDraftRevision(next);workflowEdits.current++;updateDraft(next)};
 draftRevision.current=branchDraftRevision(draft);pendingAdvanced.current=advancedDirty;
 const branchPages=useInfiniteQuery({queryKey:['branches',search.trim(),preferences.data?.branchSort,preferences.data?.branchOrder],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestCollectionPage<BranchDto>('/api/branches?search='+encodeURIComponent(search.trim())+(pageParam?'&cursor='+encodeURIComponent(pageParam):'')),getNextPageParam:last=>last.hasMore?last.cursor:undefined,select:normalizeResetPages,refetchInterval:5000});
 const organizedIds=[...new Set([...(preferences.data?.starredResourceIds??[]).filter(id=>id.startsWith('branch:')),...(preferences.data?.branchFolders??[]).flatMap(folder=>folder.branchIds.map(id=>`branch:${id}`))])].sort();
 const organizedKey=JSON.stringify([organizedIds,preferences.data?.branchSort,preferences.data?.branchOrder]);
 const organized=useQuery({queryKey:['branches','organized',search.trim(),organizedKey],enabled:Boolean(preferences.data&&organizedIds.length),queryFn:()=>requestJson<BranchDto[]>('/api/branches?section=organized&search='+encodeURIComponent(search.trim())),refetchInterval:5000});
 const branches={...branchPages,data:branchPages.data?Array.from(new Map([...(organized.data??[]),...branchPages.data.pages.flatMap(page=>page.items)].map(branch=>[branch.id,branch])).values()):undefined};
 const contextList=useQuery({queryKey:['branch-chats',draft.branchId],queryFn:()=>requestJson<Context[]>(`/api/branches/${draft.branchId}/chats`),enabled:Boolean(draft.branchId),refetchInterval:5000});
 const selectedContext=useQuery({queryKey:['branch-context',draft.chatId],queryFn:()=>requestJson<Context>(`/api/branches/contexts/${draft.chatId}`),enabled:Boolean(draft.chatId)});
 const setTab=(next:BranchRoute['tab'])=>{
  const owner=route.chatId?client.getQueryData<Context>(['branch-chat-owner',route.chatId]):undefined;
  const belongsHere=(chat?:Context)=>chat?.id===route.chatId&&chat?.branchId===route.branchId&&!chat?.executionId;
  const persistentChat=Boolean(route.chatId&&(contextList.data?.some(belongsHere)||belongsHere(selectedContext.data)||belongsHere(owner)));
  const clearChat=next==='chats'&&Boolean(route.executionId)&&!persistentChat;
  navigate(next==='chats'?{...route,settingsSection:undefined,tab:next,executionId:undefined,...(clearChat?{chatId:undefined,workspace:undefined}:{})}:{...route,settingsSection:undefined,tab:next});
 };
 const contexts={...contextList,data:[...(contextList.data??[]),...(selectedContext.data&&!contextList.data?.some(c=>c.id===selectedContext.data!.id)?[selectedContext.data]:[])]};
 const engines=useQuery({queryKey:['engines'],queryFn:()=>realApi.listEngines()});
 const agents=useQuery({queryKey:['branch-agents',draft.branchId],queryFn:()=>requestCollectionPage<import('@ponderosa/core').AgentDto>(`/api/branches/${draft.branchId}/agents?limit=100`),enabled:Boolean(draft.branchId),refetchInterval:5000});
 const histories=useInfiniteQuery({queryKey:['branch-executions',draft.branchId,route.executionFilter],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestJson<BranchExecutionDto[]>(`/api/branches/${draft.branchId}/executions?${new URLSearchParams({...pageParam?{before:pageParam}:{},...route.executionFilter?{state:route.executionFilter}:{}})}`),getNextPageParam:last=>last.length===100?last.at(-1)?.id:undefined,enabled:Boolean(draft.branchId),refetchInterval:3000});
 const executions=histories.data?.pages.flat()??[];
 const detailPages=useInfiniteQuery({queryKey:['branch-execution',executionId],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestJson<BranchExecutionDetailDto>(`/api/branch-executions/${executionId}${pageParam?'?cursor='+encodeURIComponent(pageParam):''}`),getNextPageParam:last=>last.nextCursor,enabled:Boolean(executionId),refetchInterval:query=>['completed','canceled','skipped','merged'].includes(query.state.data?.pages[0]?.execution.state??'')?false:2000});
 const [detailLoadTarget,setDetailLoadTarget]=useState(0);
 useEffect(()=>setDetailLoadTarget(0),[executionId]);
 useEffect(()=>{if(detailLoadTarget>(detailPages.data?.pages.length??0)&&detailPages.hasNextPage&&!detailPages.isFetchingNextPage&&!detailPages.isFetchNextPageError)void detailPages.fetchNextPage()},[detailLoadTarget,detailPages.data?.pages.length,detailPages.hasNextPage,detailPages.isFetchingNextPage,detailPages.isFetchNextPageError]);
 const detail={...detailPages,data:mergeHistory(detailPages.data?.pages)};
 const executionChats=useQuery({queryKey:['branch-execution-chats',draft.branchId,executionId],queryFn:()=>requestJson<Context[]>(`/api/branches/${draft.branchId}/chats?executionId=${encodeURIComponent(executionId)}`),enabled:Boolean(draft.branchId&&executionId&&tab==='executions'&&detail.data?.execution.id===executionId&&detail.data.execution.branchId===draft.branchId),refetchInterval:5000});
 const pinned=useQuery({queryKey:['branch-version',detail.data?.execution.versionId],queryFn:()=>requestJson<BranchVersionDto>(`/api/branches/${detail.data!.execution.branchId}/versions/${detail.data!.execution.versionId}`),enabled:Boolean(detail.data)});
 const [historyBranch,setHistoryBranch]=useState<string>(),[jsonOpen,setJsonOpen]=useState(false),[validationRequest,setValidationRequest]=useState(0);
 useEffect(()=>{setHistoryBranch(undefined);setJsonOpen(false);setValidationRequest(0)},[draft.branchId]);
 const versions=useInfiniteQuery({queryKey:['branch-versions',draft.branchId],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestJson<BranchVersionSummaryDto[]>(`/api/branches/${draft.branchId}/versions${pageParam?'?before='+encodeURIComponent(pageParam):''}`),getNextPageParam:last=>last.length===100?last.at(-1)?.id:undefined,enabled:Boolean(draft.branchId)&&historyBranch===draft.branchId});
 const settingsPanel=useRef<HTMLDivElement>(null);
 const selectedBranch=useQuery({queryKey:['branch',draft.branchId],queryFn:()=>requestJson<BranchDto>(`/api/branches/${draft.branchId}`),enabled:Boolean(draft.branchId),refetchInterval:5000});
 const current=selectedBranch.data;
 useEffect(()=>{if(current)void client.invalidateQueries({queryKey:['branch-settings',current.id]})},[current?.id,current?.versionId,client]);
 const publishedVersion=useQuery({queryKey:['branch-version',current?.versionId],queryFn:()=>requestJson<BranchVersionDto>(`/api/branches/${current!.id}/versions/${current!.versionId}`),enabled:Boolean((preview||tab==='settings')&&current?.versionId)});
 const dirty=advancedDirty||Boolean(savedDraft.current&&savedDraft.current!==branchDraftRevision(draft));
 const trigger=useQuery({queryKey:['branch-trigger',current?.triggerId],queryFn:()=>requestJson<TriggerDefinitionDto>(`/api/branches/${current!.id}/trigger`),enabled:Boolean(current?.triggerId),refetchInterval:5000});
 const lifecycle=useQuery({queryKey:['branch-lifecycle-summary',current?.id],queryFn:()=>requestJson<BranchLifecycleDto>(`/api/branches/${current!.id}/lifecycle`),enabled:Boolean(current?.id),refetchInterval:3000});
 const changeChat=(chatId:string)=>setDraft(d=>{const chat=contexts.data?.find(c=>c.id===chatId);return {...d,chatId,bindings:{...d.bindings,agents:{},directories:Object.fromEntries(d.definition.steps.filter(s=>s.kind==='script').map(s=>[s.cwdRef,chat?.workingDirectory??''])),engines:{...d.bindings.engines,default:chat?.defaultEngine??engines.data?.[0]?.id??''}}}});
 const resetWorkflowBaseline=(next:Draft)=>{savedDraft.current=branchDraftRevision(next);draftHistory.current=emptyWorkflowHistory();setDraft(next,false);pendingAdvanced.current=false;setAdvancedDirty(false);setDeployedUpdate(undefined);setEditorKey(k=>k+1)};
 async function select(branch:BranchDto,force=false,reconcileBaseline?:string):Promise<boolean>{
  if(!force){navigate({branchId:branch.id,tab:'workflow'});return true;}
  const sequence=++selection.current;setLoading(true);setError('');setSecret(previous=>previous?.branchId===branch.id?previous:undefined);
  try{const next=await readWorkflowDraft(branch);
   if(sequence!==selection.current)return false;
   if(reconcileBaseline!==undefined&&(draftRevision.current!==reconcileBaseline||pendingAdvanced.current)){setDeployedUpdate({branch,reason:'dirty'});return false;}
   if(currentDraft.current.branchId!==branch.id){setInput('');setRunOpen(false);run.reset();setOccurrenceKey(createClientId())}
   resetWorkflowBaseline(next);
   return true;
  }catch(e){if(sequence===selection.current){setError((e as Error).message);if(reconcileBaseline!==undefined)setDeployedUpdate({branch,reason:'failed'})}return false}finally{if(sequence===selection.current){setLoading(false);setOpeningLink(false)}}
 }
 const reloadWorkflow=async(branchId:string)=>{const revision=draftRevision.current,generation=selection.current;try{const branch=await requestJson<BranchDto>(`/api/branches/${branchId}`,{cache:'no-store'});if(routeOwner.current.branchId===branchId&&!routeOwner.current.global&&selection.current===generation&&draftRevision.current===revision&&!pendingAdvanced.current)await select(branch,true,revision)}catch(error){if(routeOwner.current.branchId===branchId&&!routeOwner.current.global&&selection.current===generation&&draftRevision.current===revision)setError((error as Error).message)}};
  useEffect(()=>{if(!current||current.id!==draft.branchId||current.versionId===draft.expectedVersionId||deployedUpdate?.reason==='failed'&&deployedUpdate.branch.id===current.id)return;if(renameId===current.id)return;if(dirty){setDeployedUpdate({branch:current,reason:'dirty'});return;}setDeployedUpdate(undefined);void select(current,true,draftRevision.current)},[current?.id,current?.versionId,draft.branchId,draft.expectedVersionId,dirty,deployedUpdate?.reason,renameId]);
 useEffect(()=>{let cancelled=false;
  if(!route.branchId&&!route.executionId){selection.current++;draftHistory.current=emptyWorkflowHistory();setDraft(emptyDraft(),false);savedDraft.current=undefined;setAdvancedDirty(false);setLoading(false);setOpeningLink(false);return;}
  setOpeningLink(Boolean(route.executionId&&!draft.branchId)||route.branchId!==draft.branchId);
  void(async()=>{try{
   const executionBranchId=route.executionId?(await requestJson<BranchExecutionDetailDto>(`/api/branch-executions/${encodeURIComponent(route.executionId)}`)).execution.branchId:undefined;
   if(cancelled)return;
   const id=executionBranchId??route.branchId!;
   if(route.branchId!==id){navigate({...route,branchId:id},true);return;}
   if(id===draft.branchId){setLoading(false);setOpeningLink(false);return;}
   setDeployedUpdate(undefined);
   const branch=await requestJson<BranchDto>(`/api/branches/${encodeURIComponent(id)}`);
   if(!cancelled&&await select(branch,true)&&!cancelled)markWorkspaceResourceUsed(client,'branch',id);
  }catch(e){if(!cancelled){setLoading(false);setError((e as Error).message);setOpeningLink(false)}}})();
  return()=>{cancelled=true;selection.current++};
 },[route.branchId,route.executionId,openingAttempt]);
 const review=useMutation({mutationFn:async(startedDraft:Draft)=>{const sequence=selection.current,payload={...startedDraft,bindings:bindDefinitionDirectories(startedDraft.definition,startedDraft.bindings,contexts.data?.find(c=>c.id===startedDraft.chatId)?.workingDirectory),idempotencyKey:createClientId()},expectsNewWebhookSecret=startedDraft.definition.trigger.kind==='webhook'&&(!trigger.data||trigger.data.sourceKind!=='webhook'||!trigger.data.secretFingerprint);return {sequence,draftRevision:branchDraftRevision(startedDraft),input:payload,expectsNewWebhookSecret,result:await requestJson<BranchDeploymentPreviewDto>('/api/branches/preview',{method:'POST',body:JSON.stringify(payload)})}},onSuccess:(result,startedDraft)=>{const leaving=workflowLeave.current?.kind==='save'&&workflowLeave.current.draft===startedDraft?workflowLeave.current:undefined;if(result.sequence===selection.current&&result.draftRevision===draftRevision.current&&!pendingAdvanced.current){if(leaving)leaving.attempt=result;setPreview(result)}else if(leaving)finishWorkflowLeave(false,leaving)},onError:(_error,startedDraft)=>{if(workflowLeave.current?.draft===startedDraft)finishWorkflowLeave()},onSettled:()=>actionLocks.current.delete('review')});
 const deploy=useMutation({mutationFn:(attempt:NonNullable<typeof preview>)=>requestJson<DeployBranchResponse>('/api/branches/deploy',{method:'POST',body:JSON.stringify(attempt.input)}),onSuccess:async(branch,attempt)=>{
  const leaving=workflowLeave.current?.attempt===attempt?workflowLeave.current:undefined;let synchronized=false;
  if(branch.webhookSecret){setSecret({branchId:branch.id,value:branch.webhookSecret});setSecretRecovery(undefined)}else if(attempt.expectsNewWebhookSecret)setSecretRecovery(branch.id);
  client.setQueryData<BranchDto>(['branch',branch.id],branch);
  if(routeOwner.current.branchId===branch.id&&!routeOwner.current.global){setPreview(undefined);if(attempt.draftRevision===draftRevision.current&&!pendingAdvanced.current){synchronized=await select(branch,true,attempt.draftRevision);if(synchronized)notify({message:'Workflow Saved',key:`workflow-save:${branch.id}`})}else setDeployedUpdate({branch,reason:'dirty'})}
  if(leaving)finishWorkflowLeave(synchronized,leaving);
  void client.invalidateQueries({queryKey:['branches']});void client.invalidateQueries({queryKey:['branch-versions',branch.id]});void client.invalidateQueries({queryKey:['branch-trigger']});void client.invalidateQueries({queryKey:['branch',branch.id]})
 },onError:(_error,attempt)=>{if(workflowLeave.current?.attempt===attempt)finishWorkflowLeave()},onSettled:()=>actionLocks.current.delete('deploy')});
 // A returned 4xx has settled; discard still reads its possibly committed canonical baseline. Lost/5xx responses require the same idempotent publication retry.
 const publicationUnconfirmed=deploy.isError&&!(deploy.error instanceof ApiRequestError&&deploy.error.status>=400&&deploy.error.status<500)&&deploy.variables?.input.branchId===draft.branchId;
 const ownsDiscard=(intent:DiscardIntent)=>intent.branchId===routeOwner.current.branchId&&!routeOwner.current.global&&intent.selection===selection.current&&intent.revision===draftRevision.current&&intent.edits===workflowEdits.current;
 const discard=useMutation({mutationFn:async(intent:DiscardIntent)=>{
  if(!ownsDiscard(intent)||deploy.isPending||publicationUnconfirmed)throw new Error('The workflow or publication changed. Keep these edits and review again before discarding.');
  const branch=await requestJson<BranchDto>(`/api/branches/${intent.branchId}`,{cache:'no-store'}),next=await readWorkflowDraft(branch);
  const verified=await requestJson<BranchDto>(`/api/branches/${intent.branchId}`,{cache:'no-store'});
  if(branch.id!==intent.branchId||verified.id!==branch.id||verified.versionId!==branch.versionId||verified.bindingRevisionId!==branch.bindingRevisionId||verified.chatId!==branch.chatId||verified.name!==branch.name)throw new Error('The published workflow changed while loading. Your edits are retained; retry discard.');
  if(!ownsDiscard(intent))throw new Error('The workflow changed while loading. Your newer edits are retained; close this confirmation and review them.');
  return {branch:verified,next};
 },onSuccess:({branch,next},intent)=>{const leaving=workflowLeave.current?.discard===intent?workflowLeave.current:undefined;if(!ownsDiscard(intent)){if(leaving)finishWorkflowLeave(false,leaving);return;}selection.current++;resetWorkflowBaseline(next);setPreview(undefined);review.reset();setDiscardIntent(undefined);client.setQueryData(['branch',branch.id],branch);if(leaving)finishWorkflowLeave(true,leaving)},onError:(error,intent)=>{if(workflowLeave.current?.discard===intent){setError(error.message);finishWorkflowLeave()}},onSettled:()=>actionLocks.current.delete('discard')});
 useEffect(()=>{if(route.tab!=='settings'||!(review.error instanceof ApiRequestError))return;const issue=(review.error.body as {issues?:import('@ponderosa/core').BranchValidationIssue[]})?.issues?.[0];if(issue?.section==='settings')settingsPanel.current?.querySelector<HTMLElement>('[aria-invalid="true"], :invalid')?.focus()},[route.tab,review.error]);
 const historyLocked=loading||openingLink||advancedDirty||review.isPending||deploy.isPending||discard.isPending||publicationUnconfirmed;
 const moveDraftHistory=(direction:'undo'|'redo')=>{if(editorGeneration!==selection.current||historyLocked||['review','deploy','discard'].some(key=>actionLocks.current.has(key)))return;const moved=moveWorkflowHistory(draftHistory.current,currentDraft.current,direction);if(!moved)return;draftHistory.current=moved.history;setDraft(d=>({...d,...moved.draft}),false)};
 const undoRedo={canUndo:!historyLocked&&draftHistory.current.past.length>0,canRedo:!historyLocked&&draftHistory.current.future.length>0,onUndo:()=>moveDraftHistory('undo'),onRedo:()=>moveDraftHistory('redo')};
 const discardDisabled=!dirty||loading||openingLink||review.isPending||deploy.isPending||discard.isPending||publicationUnconfirmed;
 const requestDiscard=()=>{if(discardDisabled||routeOwner.current.branchId!==draft.branchId||routeOwner.current.global)return;finishWorkflowLeave();discard.reset();setDiscardIntent({branchId:draft.branchId!,selection:selection.current,revision:draftRevision.current,edits:workflowEdits.current})};
 useEffect(()=>{if(discardIntent&&(discardIntent.branchId!==route.branchId||route.global))setDiscardIntent(undefined)},[discardIntent,route.branchId,route.global]);

 const run=useMutation({mutationFn:(start:RunIntent)=>requestJson<BranchExecutionDto>(`/api/branches/${start.branchId}/executions`,{method:'POST',body:JSON.stringify({occurrenceKey:start.occurrenceKey,input:start.input})}),onSuccess:(execution,start)=>{if(routeOwner.current===start.route&&!routeOwner.current.global&&execution.branchId===start.branchId&&isCurrentWorkflowResponse(start,{branchId:currentDraft.current.branchId,selection:selection.current})){const accepted=navigate({branchId:start.branchId,tab:'executions',executionId:execution.id,...(start.route.executionFilter?{executionFilter:start.route.executionFilter}:{})},false,()=>setRunOpen(false));if(accepted)setRunOpen(false);notify({message:'Run Accepted',key:`workflow-run:${execution.branchId}`})}void client.invalidateQueries({queryKey:['branch-executions',execution.branchId]});void client.invalidateQueries({queryKey:['branches']})},onSettled:()=>{actionLocks.current.delete('run')}});
 const runAccepted=Boolean(run.isSuccess&&run.data?.branchId===draft.branchId);
 const runUnconfirmed=Boolean(run.isError&&run.variables?.branchId===draft.branchId&&!(run.error instanceof ApiRequestError&&run.error.status>=400&&run.error.status<500));
 const runInputError=unicodeCodePointLength(normalizeCanonicalText(input))>INLINE_TEXT_MAX_CODE_POINTS?'Run Input must be 10,000 characters or fewer. Use a managed artifact reference for larger input.':undefined;
 const runUnavailable=!current&&selectedBranch.isPending?'Checking workflow availability…':selectedBranch.error?'Workflow availability could not be verified. Retry loading the workflow.':!current?.versionId?'Save Workflow before running this unpublished workflow.':current.enabled===false?'This Branch is disabled. Enable it in Workflow trigger settings before running it.':lifecycle.data?.deleting?'This workflow is being deleted.':undefined;
 const openRun=()=>{if(run.isPending||actionLocks.current.has('run')||routeOwner.current.global||routeOwner.current.branchId!==draft.branchId||currentDraft.current.branchId!==draft.branchId)return;if(run.isSuccess||run.isError&&!runUnconfirmed){run.reset();setOccurrenceKey(createClientId())}setRunOpen(true)};
 const submitRun=()=>{if(run.isPending||loading||openingLink||routeOwner.current.global||routeOwner.current.branchId!==draft.branchId||currentDraft.current.branchId!==draft.branchId)return;if(runAccepted&&run.data){const accepted=navigate({branchId:draft.branchId,tab:'executions',executionId:run.data.id,...(run.variables?.route.executionFilter?{executionFilter:run.variables.route.executionFilter}:{})},false,()=>setRunOpen(false));if(accepted)setRunOpen(false);return;}if(!runUnconfirmed&&(runUnavailable||runInputError))return;const start=runUnconfirmed?{...run.variables!,selection:selection.current,route:routeOwner.current}:{branchId:draft.branchId!,selection:selection.current,route:routeOwner.current,input,occurrenceKey};return once('run',()=>run.mutateAsync(start))};
 const automatic=useMutation({mutationFn:()=>requestJson(`/api/branches/${current!.id}/trigger`,{method:'PATCH',body:JSON.stringify({enabled:!trigger.data!.enabled,reviewedTrigger:trigger.data})}),onSuccess:()=>{void client.invalidateQueries({queryKey:['branch-trigger']});void client.invalidateQueries({queryKey:['branches']})}});
 const rotate=useMutation({mutationFn:()=>requestJson<{webhookSecret:string}>(`/api/branches/${current!.id}/trigger/rotate-secret`,{method:'POST'}),onSuccess:result=>{setSecret({branchId:current!.id,value:result.webhookSecret});setSecretRecovery(undefined)}});
 const cancelInstallation=useMutation({mutationFn:(id:string)=>requestJson(`/api/branches/installations/${id}/cancel`,{method:'POST'}),onSuccess:()=>{void client.invalidateQueries({queryKey:['branch-lifecycle-summary']});void client.invalidateQueries({queryKey:['branches']})}});
 const importFile=async(file?:File,update=false)=>{if(!file)return;if(dirty){setError('Publish your current edits or discard them before importing or updating a Branch.');return;}const startedSelection=selection.current,startedRevision=draftRevision.current;try{if(file.size>AGENT_PACKAGE_MAX_BYTES)throw new Error(`Package exceeds the ${AGENT_PACKAGE_LIMIT_LABEL} limit`);const pkg=await requestJson<InstalledBranchPackage>('/api/branches/import-preview',{method:'POST',body:await file.text()});if(startedSelection!==selection.current||startedRevision!==draftRevision.current||pendingAdvanced.current)return;if(pkg.schema!=='ponderosa.branch-installation.v1')throw new Error('Choose a portable Branch installation package');setInstall({pkg,...(update?{branchId:draft.branchId}:{})})}catch(e){setError((e as Error).message)}};
 const versionDefinition=async(version:BranchVersionSummaryDto,restore:boolean)=>{if(restore&&dirty){setError('Publish or discard your current edits before restoring another definition.');return;}const started={branchId:version.branchId,selection:selection.current},requestId=++versionRequest.current,startedDraft=draftRevision.current;setError('');try{const full=await requestJson<BranchVersionDto>(`/api/branches/${version.branchId}/versions/${version.id}`);if(restore){if(started.selection!==selection.current||requestId!==versionRequest.current||startedDraft!==draftRevision.current||pendingAdvanced.current)return;selection.current++;setDraft(d=>({...d,definition:full.definition,bindings:bindDefinitionDirectories(full.definition,d.bindings,contexts.data?.find(c=>c.id===d.chatId)?.workingDirectory)}));setEditorKey(k=>k+1);setHistoryBranch(undefined);setTab('workflow')}else download(full.definition,'workflow-definition.json')}catch(e){if(started.selection===selection.current&&requestId===versionRequest.current)setError((e as Error).message)}};
 const exportFile=async(mode:'template'|'full'='template')=>{try{const pkg=await requestJson<InstalledBranchPackage>(`/api/branches/${draft.branchId}/package?mode=${mode}&includeValues=${mode==='full'}`);download(pkg,`${draft.definition.name.replace(/[^a-z0-9_-]/gi,'_')}.ponderosa.json`)}catch(e){setError((e as Error).message)}};
 const reviewChanges=()=>{if(discard.isPending)return;if(publicationUnconfirmed&&deploy.variables){setPreview(deploy.variables);return;}if(advancedDirty){setTab('workflow');return;}if(!current||current.id!==draft.branchId||review.isPending||deploy.isPending)return;setValidationRequest(value=>value+1);once('review',()=>{review.reset();deploy.reset();review.mutate(draft)})};
 const publishChanges=()=>{if(!preview||discard.isPending)return;if(!(publicationUnconfirmed&&preview===deploy.variables)&&(preview.draftRevision!==draftRevision.current||pendingAdvanced.current)){setError('The draft changed. Review the current edits before publishing.');return;}once('deploy',()=>deploy.mutate(preview))};
 const saveDisabled=!current||Boolean(current.versionId&&!dirty)||advancedDirty||loading||openingLink||review.isPending||deploy.isPending||discard.isPending;
 const saveBeforeLeaving=(complete:(success:boolean)=>void)=>{if(saveDisabled||workflowLeave.current||routeOwner.current.branchId!==draft.branchId||routeOwner.current.global){complete(false);return;}workflowLeave.current={kind:'save',branchId:draft.branchId!,draft,revision:draftRevision.current,complete,...(publicationUnconfirmed?{attempt:deploy.variables}:{})};reviewChanges()};
 const discardBeforeLeaving=(complete:(success:boolean)=>void)=>{if(discardDisabled||workflowLeave.current||routeOwner.current.branchId!==draft.branchId||routeOwner.current.global){complete(false);return;}const intent={branchId:draft.branchId!,selection:selection.current,revision:draftRevision.current,edits:workflowEdits.current};workflowLeave.current={kind:'discard',branchId:draft.branchId!,draft,revision:draftRevision.current,complete,discard:intent};discard.reset();once('discard',()=>discard.mutate(intent))};
 useBranchWorkflowLeaveGuard({branchId:draft.branchId,save:saveBeforeLeaving,discard:discardBeforeLeaving,pending:review.isPending||deploy.isPending||discard.isPending,canSave:!saveDisabled,canDiscard:!discardDisabled});
 useEffect(()=>{const intent=workflowLeave.current;if(intent&&(route.branchId!==intent.branchId||route.global||intent.revision!==draftRevision.current&&draftRevision.current!==savedDraft.current||pendingAdvanced.current))finishWorkflowLeave()},[route.branchId,route.global,draft,advancedDirty]);
 useEffect(()=>()=>finishWorkflowLeave(),[]);
 const editorGeneration=selection.current;
 const requestRename=(branch:BranchDto)=>{if(loading||openingLink||creating||review.isPending||deploy.isPending)return;if(branch.id===draft.branchId&&branch.id===route.branchId){setRenameId(branch.id);return;}navigate({branchId:branch.id,tab:'workflow'},false,()=>setRenameId(branch.id))};
 useEffect(()=>{if(renameId&&(renameId!==route.branchId||route.global))setRenameId(undefined)},[renameId,route.branchId,route.global]);
 const applyRename=(name:string)=>{if(!renameId||routeOwner.current.global||renameId!==routeOwner.current.branchId||renameId!==draft.branchId||editorGeneration!==selection.current||loading||openingLink||review.isPending||deploy.isPending)return;setDraft(d=>({...d,definition:{...d.definition,name:name.trim()}}));setRenameId(undefined)};

 const branchDeleted=(branchId:string,generation:number)=>{const owner=routeOwner.current;if(owner.branchId!==branchId||owner.global||selection.current!==generation)return false;const settled=++selection.current;savedDraft.current=undefined;draftHistory.current=emptyWorkflowHistory();canvasViews.current.delete(branchId);setDraft(emptyDraft(),false);setAdvancedDirty(false);setPreview(undefined);client.removeQueries({queryKey:['branch',branchId],exact:true});requestAnimationFrame(()=>{if(routeOwner.current===owner&&selection.current===settled)navigate({tab:'workflow'},true)});return true};
 const createBranch=async(force=false)=>{if(actionLocks.current.has('create'))return;if(!force){guard(()=>void createBranch(true),true);return;}actionLocks.current.add('create');setCreating(true);creation.current??=createClientId();try{const branch=await requestJson<BranchDto>('/api/branches',{method:'POST',body:JSON.stringify({name:'Untitled Branch',idempotencyKey:creation.current})});requestAnimationFrame(()=>navigate({branchId:branch.id,tab:'workflow'}));creation.current=undefined;notify({message:'Workflow Created',key:'workflow-create'});void client.invalidateQueries({queryKey:['branches']})}catch(e){setError((e as Error).message)}finally{actionLocks.current.delete('create');setCreating(false)}};
 useEffect(()=>{setPreview(undefined)},[draft,advancedDirty]);
 useEffect(()=>{try{localStorage.setItem(BRANCHES_SIDEBAR_STORAGE_KEY,serializeWorkspaceSidebarState(sidebarPresentation))}catch{}},[sidebarPresentation]);
 useEffect(()=>{if(!mobileWorkspace&&mobileNavOpen)setMobileNavOpen(false)},[mobileWorkspace,mobileNavOpen]);
 useBranchDraftGuard('workflow',dirty&&!advancedDirty);
 useBranchDraftGuard('workflow-editor',advancedDirty);
 const historyExecution=executions.find(e=>e.id===executionId);
 useEffect(()=>{if(historyExecution&&detail.data?.execution.id===historyExecution.id&&detail.data.execution.revision<historyExecution.revision)void detailPages.refetch()},[historyExecution?.id,historyExecution?.revision,detail.data?.execution.revision]);
 const detailOwned=Boolean(detail.data&&detail.data.execution.id===executionId&&detail.data.execution.branchId===draft.branchId&&route.branchId===draft.branchId);
 const detailFresh=detailOwned&&!detail.error&&(!historyExecution||detail.data!.execution.revision>=historyExecution.revision);
 const openingWorkspace=(loading||openingLink)&&!(tab==='executions'&&detailOwned);
 const shownExecutions=executions.map(e=>e.id===detail.data?.execution.id&&detail.data.execution.revision>=e.revision?detail.data.execution:e);
 const actionFailure=error||(review.variables&&branchDraftRevision(review.variables)===draftRevision.current&&!advancedDirty?review.error?.message:undefined)||run.error?.message||automatic.error?.message||rotate.error?.message||cancelInstallation.error?.message;
 const failedOpening=Boolean(error&&!openingLink&&!loading&&(route.branchId||route.executionId)&&(!draft.branchId||route.branchId!==draft.branchId));
 const failure=actionFailure||branches.error?.message||contexts.error?.message||agents.error?.message||engines.error?.message||selectedBranch.error?.message||trigger.error?.message||lifecycle.error?.message;
 useEffect(()=>{if(actionFailure){feedback.current?.scrollIntoView({block:'center',behavior:'instant'});feedback.current?.focus({preventScroll:true});if(review.error&&actionFailure===review.error.message&&review.variables&&branchDraftRevision(review.variables)===draftRevision.current&&!advancedDirty)setValidationRequest(value=>value+1)}},[actionFailure]);
 const closeMobileNavigation=()=>setMobileNavOpen(false);
 const openGlobalSearch=()=>{setGlobalSearchOpen(true);setMobileNavOpen(false)};
 const openGlobalSearchSelection=async(selection:GlobalSearchSelection)=>{
  try{
   const conversationId='file'in selection?selection.file.conversationId:selection.chat.kind==='conversation'?selection.chat.id:(await realApi.getAgent(selection.chat.id,1)).agent.conversationId;
   const context=await requestJson<BranchContextDto>(`/api/branches/contexts/${encodeURIComponent(conversationId)}`);
   const workspace=routeForGlobalSearchSelection(selection);
   if(!('projectId'in workspace))throw new Error('The selected destination has no Chat owner.');
   navigate(branchWorkspaceRoute(context,workspace as NonNullable<BranchRoute['workspace']>));
  }catch(cause){setError(cause instanceof Error?cause.message:'The selected Branch Chat could not be opened.')}
 };
 useEffect(()=>{const keydown=(event:KeyboardEvent)=>{if(!isGlobalSearchShortcut(event))return;event.preventDefault();openGlobalSearch()};window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown)},[]);
 const workflowPanel=(drawer:boolean)=>preferences.data?<BranchFolders branches={branches.data??[]} preferences={preferences.data} filtering={Boolean(search.trim())}
    onRename={requestRename} onPreferences={patch=>preferenceWriter.current!.enqueue(patch)}
    renderRow={b=><SidebarResourceRow href={branchRoutePath({branchId:b.id,tab:'workflow'})} id={b.id} label={`Open Branch ${b.name}`} title={b.name} selected={draft.branchId===b.id} icon={<AccountTreeOutlinedIcon fontSize="small"/>} status={<BranchDirectoryStatus branch={b} delayed={Boolean(branches.error||organized.error||connection.prolongedDisconnect)}/>}
      starred={starredWorkspaceResources(preferences.data!).has(`branch:${b.id}`)} onStar={()=>preferenceWriter.current!.enqueue(toggleWorkspaceResourceStar(client.getQueryData(queryKeys.workspacePreferences.all)??preferences.data!,'branch',b.id))}
      onOpen={()=>{if(loading||openingLink||creating||deploy.isPending)return;if(drawer)closeMobileNavigation();void select(b)}}/>}>
    {({starredRows,allRows})=><SharedSidebarPanel
      icon={<AccountTreeOutlinedIcon/>}
      title="Workflows"
      total={branchPages.hasNextPage?undefined:branches.data?.length}
      searchLabel="Find a workflow"
      searchValue={search}
      onSearchValueChange={setSearch}
      busy={branches.isPending||branches.isFetching}
      starredRows={starredRows}
      allRows={allRows}
      sort={preferences.data?.branchSort??'last_used'}
      onSort={branchSort=>preferenceWriter.current!.enqueue({branchSort})}
      empty={!branches.isPending&&!branches.error&&!branches.data?.length?<Typography variant="body2" color="text.secondary" sx={{px:1,py:2}}>{search.trim()?'No workflows match your search. Try another name.':'Your deployed workflows will appear here.'}</Typography>:undefined}
      collectionFeedback={branches.error||organized.error?<Alert severity="error" action={<Button onClick={()=>{void branchPages.refetch();void organized.refetch()}}>Retry</Button>}>Workflow list could not be loaded.</Alert>:branches.isPending?<Typography color="text.secondary" sx={{px:1,py:2}}>Loading workflows…</Typography>:undefined}
      loadMoreLabel={branchPages.hasNextPage?'Load more workflows':undefined}
      onLoadMore={branchPages.hasNextPage?()=>void branchPages.fetchNextPage():undefined}
      loadingMore={branchPages.isFetchingNextPage}
      topContent={<Box sx={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:.5,mb:1,'& .MuiButton-root':{minWidth:0,minHeight:44,px:.75,fontSize:12,color:'text.secondary'},'& .MuiButton-startIcon':{ml:0,mr:.5},'& .MuiButton-startIcon > *':{fontSize:18}}}>
       <Button color="inherit" startIcon={<AddIcon/>} disabled={creating||loading||openingLink} onClick={()=>{if(drawer)closeMobileNavigation();void createBranch()}}>{creating?'Creating workflow…':'New workflow'}</Button>
       <Button color="inherit" startIcon={<FileUploadOutlinedIcon/>} onClick={()=>workflowImportInput.current?.click()}>Import workflow</Button>
      </Box>}
      drawer={drawer}
    />}</BranchFolders>:<Alert severity={preferences.error?'error':'info'} action={preferences.error?<Button onClick={()=>void preferences.refetch()}>Retry</Button>:undefined}>{preferences.error?'Sidebar preferences could not be loaded.':'Loading workflows…'}</Alert>;
 const home=!route.global&&!route.branchId&&!route.executionId&&!draft.branchId&&!loading&&!openingLink;
 const editorAvailable=!loading&&!openingLink&&!failedOpening&&Boolean(draft.branchId)&&!(deployedUpdate?.reason==='failed'&&deployedUpdate.branch.id===draft.branchId);
 const workflowFeedback=<>
    {deployedUpdate&&deployedUpdate.branch.id===draft.branchId&&route.branchId===draft.branchId&&<Alert severity={deployedUpdate.reason==='failed'?'warning':'info'} action={<Button onClick={()=>deployedUpdate.reason==='failed'?void reloadWorkflow(deployedUpdate.branch.id):guard(()=>void reloadWorkflow(deployedUpdate.branch.id),true)}>{deployedUpdate.reason==='failed'?'Retry loading':'Load deployed version'}</Button>}>{deployedUpdate.reason==='failed'?'Changes were published, but the deployed workflow could not be loaded. Retry loading before editing.':'The deployed workflow changed while this draft has local edits. Load the deployed version when you are ready.'}</Alert>}{failure&&<Alert ref={feedback} tabIndex={-1} severity="error" action={failedOpening?<Button color="inherit" onClick={()=>{setError('');setOpeningLink(true);setOpeningAttempt(value=>value+1)}}>Retry opening workflow</Button>:undefined}>{failure}</Alert>}
    {publicationUnconfirmed&&<Alert severity="warning" action={<Button onClick={reviewChanges}>Review publication</Button>}>Publication outcome is unconfirmed. Retry the same publication to reconcile it before discarding edits.</Alert>}
    {secret&&secret.branchId===route.branchId&&<Alert severity="success" onClose={()=>setSecret(undefined)}><Typography fontWeight={600}>Save your webhook signing secret</Typography><Typography sx={{fontFamily:'monospace',overflowWrap:'anywhere'}}>{secret.value}</Typography><Typography variant="caption">Shown once. Rotate the secret if you lose it.</Typography></Alert>}
    {secretRecovery&&secretRecovery===route.branchId&&<Alert severity="warning" onClose={()=>setSecretRecovery(undefined)}>Changes were published, but the webhook signing secret was not returned. Once the workflow loads, rotate its signing secret and save the new value before enabling webhook intake.</Alert>}
     {editorAvailable&&lifecycle.data&&(lifecycle.data.deleting||lifecycle.data.updates.length>0||lifecycle.data.pendingRemoval.length>0)&&<BranchLifecycleStatus lifecycle={lifecycle.data} canceling={cancelInstallation.isPending} onCancelUpdate={id=>cancelInstallation.mutate(id)}/>}

     {editorAvailable&&advancedDirty&&<Alert severity="warning">Workflow fields have unapplied or invalid edits. Review them in Workflow before deployment.</Alert>}

 </>;
 const sidebarPanel=(drawer:boolean)=>route.global?<SettingsSidebarPanel route={{kind:'settings',section:branchSettingsSection(route.global)}} version={health.data?.version} onNavigate={next=>{if(next.kind==='settings')onGlobal(next.section??'general')}} hrefForRoute={next=>branchRoutePath({...route,global:next.kind==='settings'?next.section??'general':undefined})}/>:workflowPanel(drawer);
 return <WorkspaceConnectionProvider value={connection}><Box sx={{height:'var(--ponderosa-app-viewport-block-size, 100dvh)',minHeight:0}}><PrimaryHeaderActionsProvider onOpenProviderSettings={()=>onGlobal('providers')}><MobileNavigationProvider buttonRef={sharedNavigationButton} desktopVisible={sidebarPresentation.collapsed} onOpen={()=>mobileWorkspace?setMobileNavOpen(true):setSidebarPresentation(state=>({...state,collapsed:false}))}><Box sx={{height:'100%',display:'grid',gridTemplateColumns:{xs:'minmax(0,1fr)',md:'auto minmax(0,1fr)'},overflow:'hidden',bgcolor:'background.default'}}>
  <Box sx={{display:{xs:'none',md:'block'},height:'100%',minHeight:0}}><BranchesSidebar profile={preferences.data?.profile} onGlobal={onGlobal} onHome={()=>navigate({tab:'workflow'})} onSearch={openGlobalSearch} panel={sidebarPanel(false)} notifications={!mobileWorkspace?<BranchNotifications onNavigate={navigate}/>:undefined} collapsed={sidebarPresentation.collapsed} width={sidebarPresentation.width} onCollapsedChange={collapsed=>{setSidebarPresentation(state=>({...state,collapsed}));if(collapsed)requestAnimationFrame(()=>sharedNavigationButton.current?.focus())}} onWidthChange={width=>setSidebarPresentation(state=>({...state,width}))}/></Box>
  <input ref={workflowImportInput} hidden type="file" accept=".json,application/json" onChange={e=>{if(mobileNavOpen)closeMobileNavigation();void importFile(e.target.files?.[0]);e.target.value=''}}/>
  <Box component="a" href="#main-content" sx={{position:'absolute',left:8,top:-80,zIndex:1500,p:1,bgcolor:'background.paper','&:focus':{top:8}}}>Skip to main content</Box>
  <Box component="main" id="main-content" tabIndex={-1} sx={{position:'relative',minWidth:0,minHeight:0,display:'flex',flexDirection:'column',overflow:'hidden',...(dirty&&!route.global&&route.branchId===draft.branchId?{'&::after':{content:'""',position:'absolute',inset:0,border:'1px solid',borderColor:'warning.main',pointerEvents:'none',zIndex:1}}:{})}}>
   {!route.global&&draft.branchId&&route.branchId===draft.branchId&&!openingWorkspace&&<BranchWorkspaceHeader name={draft.definition.name} tab={route.tab} published={Boolean(current?.versionId)} dirty={dirty} runCounts={lifecycle.data?.runCounts} executionsUnavailable={Boolean(selectedBranch.error||lifecycle.error)} onRun={openRun} runPending={run.isPending} onTab={setTab} discardDisabled={discardDisabled} onDiscard={requestDiscard} onRename={()=>current&&requestRename(current)} onHistory={()=>setHistoryBranch(draft.branchId)} onEditJson={()=>setJsonOpen(true)} onExport={exportFile} onUpdate={()=>{packageUpdateSelection.current=selection.current;packageUpdateInput.current?.click()}}/>}
   {!route.global&&!home&&(openingWorkspace||failedOpening||!draft.branchId||route.branchId!==draft.branchId)&&<CompactWorkspaceHeader icon={<AccountTreeOutlinedIcon/>} title={failedOpening?'Workflow unavailable':'Opening workflow…'}/>}
   <input ref={packageUpdateInput} hidden type="file" accept=".json,application/json" onChange={e=>{if(packageUpdateSelection.current===selection.current)void importFile(e.target.files?.[0],true);e.target.value=''}}/>
   <WorkspaceConnectionNotice connection={connection}/>
   {route.global?(preferences.data?<BranchGlobalSettings view={route.global} preferences={preferences.data} engines={engines.data??[]} colorMode={colorMode} onToggleColorMode={onToggleColorMode} onClose={()=>navigate({...route,global:undefined})}/>:<Alert severity={preferences.error?'error':'info'} action={<Button onClick={()=>void preferences.refetch()}>Retry</Button>}>{preferences.error?.message??'Loading Ponderosa settings…'}</Alert>):<Stack spacing={home||tab==='workflow'||tab==='executions'?0:{xs:1.5,md:2}} sx={{p:home||tab==='workflow'||tab==='executions'?0:tab==='chats'?1:{xs:1.5,sm:2,md:3},flex:1,minWidth:0,minHeight:0,overflowY:home||tab==='workflow'||tab==='chats'||tab==='executions'?'hidden':'auto',overflowX:'hidden'}}>
    {tab==='workflow'?<Box data-workflow-feedback sx={{maxHeight:'40%',flexShrink:0,overflowY:'auto','&:empty':{display:'none'},'& > * + *':{mt:1.5}}}>{workflowFeedback}</Box>:workflowFeedback}
    {openingWorkspace?<Typography role="status">Opening workflow…</Typography>:failedOpening?<Typography role="status">This workflow could not be opened. Retry loading it to continue.</Typography>:deployedUpdate?.reason==='failed'&&deployedUpdate.branch.id===draft.branchId&&!(tab==='executions'&&detailOwned)?<Typography role="status">The published workflow is waiting to be loaded.</Typography>:!draft.branchId?<BranchHome engines={engines.data??[]} enginesLoaded={Boolean(engines.data)} enginesError={engines.error?.message} onRetryEngines={()=>void engines.refetch()} onNavigate={navigate} onCreate={()=>void createBranch()} onImport={()=>workflowImportInput.current?.click()} creating={creating}/>:<>
     <Box role="tabpanel" id="branch-workflow-panel" aria-labelledby="branch-workflow-tab" hidden={tab!=='workflow'} sx={{display:tab==='workflow'?'flex':'none',flex:1,minHeight:0,minWidth:0}}><WorkflowEditor editing={dirty} saveControl={<Button variant="contained" disabled={saveDisabled} aria-busy={review.isPending||deploy.isPending||discard.isPending||undefined} onClick={reviewChanges}>Save Workflow</Button>} canvasViews={canvasViews.current} undoRedo={undoRedo} onDraft={(edit:WorkflowDraftEdit)=>{if(editorGeneration===selection.current)setDraft(d=>{const definition=edit.definition??d.definition,bindings=edit.bindings??d.bindings;return {...d,definition,bindings:edit.definition?bindDefinitionDirectories(definition,bindings,contexts.data?.find(c=>c.id===d.chatId)?.workingDirectory):bindings}})}} branchId={draft.branchId??''} onSettingsIssue={()=>setTab('settings')} validationIssues={review.error instanceof ApiRequestError&&review.variables&&branchDraftRevision(review.variables)===draftRevision.current?(review.error.body as {issues?:import("@ponderosa/core").BranchValidationIssue[]})?.issues:undefined} active={tab==='workflow'&&!route.global&&!loading&&!openingLink} onInvalidStep={()=>setTab('workflow')} jsonOpen={jsonOpen} onCloseJson={()=>setJsonOpen(false)} validationRequest={validationRequest} triggerDirty={Boolean(savedDraft.current&&(JSON.stringify(JSON.parse(savedDraft.current).definition.trigger)!==JSON.stringify(draft.definition.trigger)||JSON.stringify(JSON.parse(savedDraft.current).bindings.triggers)!==JSON.stringify(draft.bindings.triggers)))} intake={trigger.data&&<Paper variant="outlined" sx={{p:2}}><Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap"><Typography sx={{flex:1}}>Published {trigger.data.sourceKind} intake · {trigger.data.enabled?'Enabled':'Paused'}</Typography><Button disabled={automatic.isPending||(trigger.data.sourceKind==='webhook'&&!trigger.data.secretFingerprint)} onClick={()=>automatic.mutate()}>{trigger.data.enabled?'Pause intake':'Resume intake'}</Button>{trigger.data.sourceKind==='webhook'&&<Button disabled={rotate.isPending} onClick={()=>rotate.mutate()}>Rotate signing secret</Button>}</Stack><Typography variant="caption" color="text.secondary">Last automatic run: {trigger.data.lastFiredAt?new Date(trigger.data.lastFiredAt).toLocaleString():'None'} · Next automatic run: {current?.enabled===false?'Paused while Branch is disabled':!trigger.data.enabled?'Paused':trigger.data.nextFireAt?new Date(trigger.data.nextFireAt).toLocaleString():'Not scheduled'}</Typography>{trigger.data.sourceKind==='webhook'&&<><Typography variant="body2" sx={{overflowWrap:'anywhere'}}>{window.location.origin}/api/trigger-webhooks/{trigger.data.id}</Typography>{!trigger.data.secretFingerprint&&<Alert severity="warning" sx={{mt:1}}>Rotate the signing secret to reveal and save it before enabling webhook intake.</Alert>}</>}</Paper>} availability={current&&<BranchAvailability key={current.id} branch={current} disabled={!lifecycle.data||Boolean(lifecycle.error)||lifecycle.data.deleting||lifecycle.data.updates.length>0}/>} onPendingEdits={reportPendingEdits} key={editorKey} definition={draft.definition} bindings={draft.bindings} chatId={draft.chatId} contexts={contexts.data??[]} agents={agents.data?.items??[]} engines={engines.data??[]} existing={Boolean(draft.branchId)} onDefinition={definition=>{if(editorGeneration===selection.current)setDraft(d=>({...d,definition,bindings:bindDefinitionDirectories(definition,d.bindings,contexts.data?.find(c=>c.id===d.chatId)?.workingDirectory)}))}} onBindings={bindings=>{if(editorGeneration===selection.current)setDraft(d=>({...d,bindings}))}} onChat={changeChat}/></Box>
     <Box role="tabpanel" id="branch-executions-panel" aria-labelledby="branch-executions-tab" hidden={tab!=='executions'} sx={{display:tab==='executions'?'flex':'none',flex:1,minHeight:0,minWidth:0}}>
      <BranchRunHistory key={draft.branchId} runs={shownExecutions} selectedId={executionId} selectedRun={detailOwned?detail.data?.execution:undefined} filter={route.executionFilter} onFilter={value=>navigate({...route,executionFilter:value||undefined})} onSelect={id=>navigate({...route,tab:'executions',executionId:id,chatId:undefined,workspace:undefined})} loading={histories.isPending} error={histories.error} onRetry={()=>void histories.refetch()} hasMore={histories.hasNextPage} loadingMore={histories.isFetchingNextPage} onMore={()=>void histories.fetchNextPage()} triggerEvents={<BranchTriggerAudit branchId={draft.branchId} onNavigate={navigate} diagnostics={lifecycle.data?.sourceDiagnostics}/>}>
       <Stack spacing={2}>
        {detail.error?<Alert severity="error" action={<Button onClick={()=>void detail.refetch()}>Retry Run</Button>}>This Run is unavailable. {detail.error.message}</Alert>:executionId&&!detailOwned?<Typography role="status">Loading this Run…</Typography>:null}
        {tab==='executions'&&detailOwned&&detail.data&&<>
         <ExecutionPanel key={detail.data.execution.id} authorityFresh={detailFresh} viewStates={executionViewStates.current} detail={detail.data} definition={pinned.data?.id===detail.data.execution.versionId&&pinned.data.branchId===detail.data.execution.branchId?pinned.data.definition:undefined} onBudgetSettings={branchId=>navigate({branchId:branchId??draft.branchId,tab:'settings',settingsSection:'execution-controls'})} runLinks={<Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
          {executionChats.data?.length?<Button onClick={()=>navigate({...route,tab:'chats',chatId:undefined,workspace:undefined})}>Open {executionChats.data.length} Temporary {executionChats.data.length===1?'Chat':'Chats'}</Button>:executionChats.isPending?<Typography variant="body2" color="text.secondary">Checking temporary Chats…</Typography>:!executionChats.error&&<Typography variant="body2" color="text.secondary">No temporary Chats for this Run.</Typography>}
          {executionChats.error&&<Alert severity="warning" action={<Button onClick={()=>void executionChats.refetch()}>Retry</Button>}>Temporary Chats are unavailable right now.</Alert>}
          <Button onClick={()=>navigate({...route,tab:'chats',executionId:undefined,chatId:undefined,workspace:undefined})}>Manage Persistent Chats</Button>
         </Stack>} evidenceControls={<>
          {pinned.error?<Alert severity="error" action={<Button onClick={()=>void pinned.refetch()}>Retry Run Graph</Button>}>The published Run Graph could not be loaded. {pinned.error.message}</Alert>:pinned.isPending?<Typography role="status">Loading the published Run Graph…</Typography>:null}
          {detailPages.isFetchNextPageError&&<Alert severity="error" action={<Button disabled={detailPages.isFetchingNextPage} onClick={()=>{setDetailLoadTarget(0);void detailPages.fetchNextPage()}}>Retry Older Details</Button>}>Older audit evidence could not be loaded. The history shown is incomplete.</Alert>}
          {detailPages.hasNextPage&&<Alert severity="info" action={<Stack direction="row" useFlexGap flexWrap="wrap"><Button onClick={()=>void detailPages.fetchNextPage()} disabled={detailPages.isFetchingNextPage||detailLoadTarget>(detailPages.data?.pages.length??0)}>Load Older Details</Button><Button onClick={()=>setDetailLoadTarget((detailPages.data?.pages.length??0)+10)} disabled={detailPages.isFetchingNextPage||detailLoadTarget>(detailPages.data?.pages.length??0)}>Load Next 10 Pages</Button></Stack>}>Showing bounded audit evidence. Item search and filters cover loaded records; load older pages to inspect the full Run. Current required actions are retrieved separately.</Alert>}
         </>}/>

        </>}
       </Stack>
      </BranchRunHistory>
     </Box>
     <Box role="tabpanel" id="branch-chats-panel" aria-labelledby="branch-chats-tab" hidden={tab!=='chats'} sx={{display:tab==='chats'?'flex':'none',flex:1,minHeight:0}}>{tab==='chats'&&draft.branchId&&<BranchChats key={draft.branchId} branchId={draft.branchId} engines={engines.data??[]} enginesLoaded={Boolean(engines.data)} executionId={route.executionId} branchRoute={route} onNavigate={navigate}/>}</Box>

    </>}
    {current&&route.branchId===draft.branchId&&current.id===draft.branchId&&<Box ref={settingsPanel} role="tabpanel" id="branch-settings-panel" aria-labelledby="branch-settings-tab" hidden={tab!=='settings'||loading||openingLink||deployedUpdate?.reason==='failed'}><BranchSettings executionSettings={<WorkflowExecutionSettings definition={draft.definition} bindings={draft.bindings} agents={agents.data?.items??[]} contexts={contexts.data??[]} onDefinition={definition=>{if(editorGeneration===selection.current)setDraft(d=>({...d,definition}))}} onBindings={bindings=>{if(editorGeneration===selection.current)setDraft(d=>({...d,bindings}))}}/>} key={current.id} branch={current} definition={!publishedVersion.error&&publishedVersion.data?.id===current.versionId&&publishedVersion.data.branchId===current.id?publishedVersion.data.definition:undefined} active={tab==='settings'&&!loading&&!openingLink&&deployedUpdate?.reason!=='failed'} focusVariables={route.settingsSection==='variables'} focusExecutionControls={route.settingsSection==='execution-controls'} variablesFeedback={current.versionId&&(publishedVersion.error?<Alert severity="error" action={<Button onClick={()=>void publishedVersion.refetch()}>Retry variables</Button>}>Published workflow variables could not be loaded. {publishedVersion.error.message}</Alert>:publishedVersion.isPending?<Typography role="status">Loading published variables…</Typography>:undefined)} onDeleted={()=>branchDeleted(current.id,editorGeneration)}/></Box>}
   </Stack>}
  </Box>
  {mobileWorkspace&&<SwipeableDrawer open={mobileNavOpen} onOpen={()=>setMobileNavOpen(true)} onClose={closeMobileNavigation} SlideProps={{onExited:()=>{if(!globalSearchOpen&&document.activeElement===document.body)sharedNavigationButton.current?.focus({preventScroll:true})}}} disableDiscovery disableSwipeToOpen={false} swipeAreaWidth={24} SwipeAreaProps={{style:{touchAction:'pan-y'}}} hysteresis={0.25} PaperProps={{sx:{width:'auto',maxWidth:'100vw',height:'100dvh',overflow:'hidden'}}}><BranchesSidebar profile={preferences.data?.profile} onGlobal={onGlobal} onHome={()=>{navigate({tab:'workflow'},false,closeMobileNavigation)}} onSearch={openGlobalSearch} notifications={<BranchNotifications onNavigate={next=>{navigate(next,false,closeMobileNavigation)}}/>} drawer panel={sidebarPanel(true)} onDismiss={closeMobileNavigation}/></SwipeableDrawer>}
  <GlobalChatSearch open={globalSearchOpen} onClose={()=>setGlobalSearchOpen(false)} onSelect={selection=>void openGlobalSearchSelection(selection)}/>
  <ConfirmDialog open={runOpen&&Boolean(draft.branchId&&draft.branchId===route.branchId&&!route.global)} title={dirty&&current?.versionId?'Run Published Workflow':'Run Workflow'} confirmLabel={runAccepted?'View Run':runUnconfirmed?'Retry Run Submission':dirty&&current?.versionId?'Run Published Workflow':'Run Workflow'} pendingLabel="Submitting…" pending={run.isPending} error={run.error?.message} confirmDisabled={!runAccepted&&!runUnconfirmed&&Boolean(runUnavailable||runInputError)} maxWidth="sm" onCancel={()=>setRunOpen(false)} onConfirm={submitRun}>
   <Stack spacing={2} sx={{pt:1}}>
    {dirty&&current?.versionId&&<Alert severity="info">This run uses the published workflow. Your unpublished edits are not included.</Alert>}
    {runUnconfirmed&&<Alert severity="warning">The submission outcome is not confirmed. Retry sends the same Run Input and submission key safely; it does not create a separate run.</Alert>}
    {runAccepted&&<Alert severity="success">Run Accepted. Your unsaved settings are protected; open the accepted Run when you are ready.</Alert>}
    {runUnavailable&&!runUnconfirmed&&!runAccepted&&<Alert severity="warning" action={<Button onClick={()=>{setRunOpen(false);setTab('workflow')}}>Open Workflow</Button>}>{runUnavailable}</Alert>}
    <TextField autoFocus label="Run Input" helperText={runInputError??'Optional input for this run. Saved Workflow Variables and the configured schedule stay unchanged.'} error={Boolean(runInputError)} multiline minRows={3} value={input} disabled={run.isPending||runUnconfirmed||runAccepted} onChange={event=>{if(run.isError&&!runUnconfirmed){run.reset();setOccurrenceKey(createClientId())}setInput(event.target.value)}}/>
   </Stack>
  </ConfirmDialog>
  {renameId&&renameId===draft.branchId&&renameId===route.branchId&&!loading&&!openingLink&&<TextInputDialog key={renameId} open title="Rename workflow" label="Workflow name" confirmLabel="Apply to draft" initialValue={draft.definition.name} pending={review.isPending||deploy.isPending} validate={value=>!value.trim()?'Enter a workflow name.':value.trim().length>240?'Use 240 characters or fewer.':undefined} helperText="Review and publish to apply this name." onCancel={()=>setRenameId(undefined)} onConfirm={applyRename}/>}
  {install&&<BranchPackageDialog pkg={install.pkg} branchId={install.branchId} branches={branches.data??[]} engines={engines.data??[]} onClose={()=>setInstall(undefined)} onInstalled={branch=>{if(branch.id!==route.branchId){const accepted=navigate({branchId:branch.id,tab:'workflow'});if(accepted)setInstall(undefined);return accepted}return guard(()=>{setInstall(undefined);void reloadWorkflow(branch.id)},true)}}/>}
  <Dialog open={Boolean(draft.branchId&&historyBranch===draft.branchId)} onClose={()=>setHistoryBranch(undefined)} fullWidth maxWidth="md"><DialogTitle>Version history</DialogTitle><DialogContent>{error&&<Alert severity="error">{error}</Alert>}<Stack spacing={1}>
      <Typography color="text.secondary">Restore a previous definition as a draft. Review and publish to apply it.</Typography>
      {versions.error&&<Alert severity="error" action={<Button onClick={()=>void versions.refetch()}>Retry versions</Button>}>Version history could not be loaded. {versions.error.message}</Alert>}
      {versions.isPending?<Typography role="status">Loading version history…</Typography>:!versions.error&&!versions.data?.pages.flat().length&&<Typography color="text.secondary">No published versions yet.</Typography>}{versions.data?.pages.flat().map(version=><Paper variant="outlined" key={version.id} sx={{p:2}}><Stack direction="row" alignItems="center" gap={1} flexWrap="wrap"><Typography sx={{flex:1}}>{new Date(version.createdAt).toLocaleString()}</Typography>{version.id===current?.versionId&&<Chip size="small" label="Deployed"/>}<Button onClick={()=>void versionDefinition(version,false)}>Download definition</Button><Button onClick={()=>void versionDefinition(version,true)}>Use as draft</Button></Stack></Paper>)}{versions.hasNextPage&&<Button onClick={()=>void versions.fetchNextPage()}>Load older versions</Button>}</Stack></DialogContent><DialogActions><Button onClick={()=>setHistoryBranch(undefined)}>Close</Button></DialogActions></Dialog>
  <Dialog open={Boolean(preview)} onClose={()=>{if(!deploy.isPending&&!discard.isPending){finishWorkflowLeave();setPreview(undefined)}}} fullWidth maxWidth="md"><DialogTitle>Review deployment</DialogTitle><DialogContent><Stack spacing={2}>{deploy.error&&<Alert severity="error">{deploy.error.message}{preview?.input.definition.trigger.kind==='webhook'&&<Typography variant="body2">The server may already have published this workflow. If a retry loads it without a signing secret, rotate the secret before enabling webhook intake.</Typography>}</Alert>}<Typography>{preview?.input.definition.name}</Typography>{preview?.result.operations.filter(op=>op.kind!=='unchanged').map((op,i)=><Accordion key={i}><AccordionSummary><Stack direction="row" spacing={1}><Chip label={op.kind==='detach'?'Remove':op.kind==='create'?'Add':'Change'} size="small"/><Typography>{op.resource} · {deploymentOperationLabel(op,preview.input.definition,publishedVersion.data?.definition)}</Typography></Stack></AccordionSummary><AccordionDetails>{op.before!==undefined&&<><Typography fontWeight={600}>Before</Typography><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto'}}>{op.before}</Typography></>}{op.after!==undefined&&<><Typography fontWeight={600}>After</Typography><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto'}}>{op.after}</Typography></>}</AccordionDetails></Accordion>)}{preview?.result.operations.some(op=>op.kind==='unchanged')&&<Accordion><AccordionSummary>Unchanged local bindings</AccordionSummary><AccordionDetails>{preview.result.operations.filter(op=>op.kind==='unchanged').map((op,i)=><Typography key={i} sx={{overflowWrap:'anywhere'}}>{op.resource} · {deploymentOperationLabel(op,preview.input.definition,publishedVersion.data?.definition)}: {op.after??op.before}</Typography>)}</AccordionDetails></Accordion>}{Boolean(current?.versionId)&&preview?.result.operations.every(op=>op.kind==='unchanged')&&<Typography>No definition or binding changes.</Typography>}<Divider/>{preview?.result.notes.map(note=><Typography key={note} variant="body2" color="text.secondary">{note}</Typography>)}</Stack></DialogContent><DialogActions sx={{gap:1,flexWrap:'wrap'}}><Button color="error" sx={{mr:'auto'}} disabled={discardDisabled} onClick={requestDiscard}>Discard changes</Button><Button disabled={deploy.isPending||discard.isPending} onClick={()=>{finishWorkflowLeave();setPreview(undefined)}}>Back to editing</Button><Button variant="contained" disabled={deploy.isPending||discard.isPending||!publicationUnconfirmed&&(advancedDirty||Boolean(current?.versionId)&&preview?.result.operations.every(op=>op.kind==='unchanged'))} onClick={publishChanges}>{deploy.isPending?'Publishing changes…':'Publish workflow'}</Button></DialogActions></Dialog>
  <ConfirmDialog open={Boolean(discardIntent&&discardIntent.branchId===route.branchId&&!route.global)} title={`Discard changes to “${draft.definition.name}”?`} confirmLabel="Discard changes" pendingLabel="Discarding changes…" pending={discard.isPending} error={discard.error?.message} onCancel={()=>setDiscardIntent(undefined)} onConfirm={()=>{if(discardIntent)once('discard',()=>discard.mutate(discardIntent))}}>Discard all unpublished workflow edits? Published work and independent settings are kept.</ConfirmDialog>

 </Box></MobileNavigationProvider></PrimaryHeaderActionsProvider></Box></WorkspaceConnectionProvider>;
}
