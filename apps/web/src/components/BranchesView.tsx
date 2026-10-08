import {BranchExecutionBudget} from "./branches/BranchExecutionBudget";
import {useAppViewport} from '../hooks/useAppViewport';
import {MobileNavigationProvider} from './MobileNavigationContext';
import {BranchOperations,BranchLifecycleStatus,BranchTriggerAudit} from './branches/BranchOperations';
import type {ColorMode} from '../theme';
import {BranchGlobalSettings} from './branches/BranchGlobalSettings';
import {WorkspaceConnectionNotice} from './WorkspaceConnectionNotice';
import {SidebarResourceRow} from './SidebarResourceRow';
import {branchTabs,type BranchRoute} from '../branchesRouting';
import {BranchNavigation,useBranchDraftGuard,useBranchNavigationGuard} from './branches/BranchNavigation';
import {BranchNotifications} from './branches/BranchNotifications';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import MenuIcon from '@mui/icons-material/Menu';
import {BranchPackageDialog} from './branches/BranchPackageDialog';
import type {InstalledBranchPackage} from '@ponderosa/core';
import {BranchSettings} from './branches/BranchSettings';
import {BranchChats} from './branches/BranchChats';
import {WorkspaceConnectionProvider} from './WorkspaceConnectionContext';
import {useWorkspaceStream} from '../hooks/useWorkspaceStream';
import {useEffect,useRef,useState} from 'react';
import {useInfiniteQuery,useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Accordion,AccordionSummary,AccordionDetails,Alert,Box,Button,Chip,Dialog,DialogActions,DialogContent,DialogTitle,Divider,IconButton,MenuItem,Paper,Stack,SwipeableDrawer,Tab,Tabs,TextField,Typography,useMediaQuery,useTheme} from '@mui/material';
import type {BranchBindings,BranchContextDto,BranchDefinition,BranchDeploymentPreviewDto,BranchDto,BranchExecutionDetailDto,BranchExecutionDto,BranchLifecycleDto,BranchVersionDto,BranchVersionSummaryDto,DeployBranchRequest,DeployBranchResponse,TriggerDefinitionDto} from '@ponderosa/core';
import {realApi,requestJson} from '../api/real';
import {WorkflowEditor} from './branches/WorkflowEditor';
import {ExecutionPanel,type ExecutionPanelViewState} from './branches/ExecutionPanel';
import {SemanticStatus,type SemanticStatusKind} from './SemanticStatus';
import {newDefinition,bindDefinitionDirectories,branchDraftRevision,isCurrentWorkflowResponse} from './branches/model';
import {SharedSidebarPanel} from './WorkspaceSidebar.parts';
import {BranchesSidebar} from './branches/BranchesSidebar';
import {restoreWorkspaceSidebarState,serializeWorkspaceSidebarState} from '../workspaceSidebarState';
import {GlobalChatSearch,isGlobalSearchShortcut,type GlobalSearchSelection} from './GlobalChatSearch';
type Context=BranchContextDto;
type Draft={definition:BranchDefinition;bindings:BranchBindings;chatId:string;branchId?:string;expectedVersionId?:string};
const emptyDraft=():Draft=>({definition:newDefinition(),bindings:{agents:{},directories:{}},chatId:''});
const BRANCHES_SIDEBAR_STORAGE_KEY='ponderosa.branchesSidebar.v1';
const BRANCH_CHAT_SEARCH_SCOPES=['all','chats','agents'] as const;
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
function automaticRunSummary(trigger:TriggerDefinitionDto|undefined,loading:boolean):string{
 if(loading)return 'Loading automatic-run state…';
 if(!trigger)return 'Manual runs and calls from other Branches can start this workflow.';
 if(!trigger.enabled)return `Automatic ${trigger.sourceKind} runs are paused. Manual runs and Branch calls remain available while the Branch is enabled.`;
 if(trigger.sourceKind!=='schedule')return `Automatic ${trigger.sourceKind} runs are enabled.`;
 const source=trigger.sourceConfig;
 if(!('scheduleKind' in source))return 'Automatic scheduled runs are enabled.';
 if(source.scheduleKind==='interval'){
  const minutes=source.everyMs/60000,label=minutes<60?`${minutes} minute${minutes===1?'':'s'}`:minutes%60===0?`${minutes/60} hour${minutes===60?'':'s'}`:`${minutes} minutes`;
  return `Automatic runs are enabled every ${label}.`;
 }
 return source.scheduleKind==='cron'?`Automatic calendar runs are enabled in ${source.timezone}.`:'One automatic run is enabled.';
}
function branchDirectoryStatus(branch:BranchDto):{label:string;kind:SemanticStatusKind}{
 const active=branch.activeExecutions??0;
 if(branch.enabled===false)return {label:active?`Disabled · ${active} active`:'Disabled',kind:'disabled'};
 if(active>0)return {label:`Running · ${active}`,kind:'running'};
 if(branch.triggerId)return branch.triggerEnabled?{label:'Automatic',kind:'enabled'}:{label:'Automatic paused',kind:'waiting'};
 return {label:'Manual',kind:'idle'};
}
/** Branches has its own workflow-centered authoring and operations shell. */
type Appearance={colorMode:ColorMode;onToggleColorMode():void};
export function BranchesView(props:Appearance):JSX.Element{return <BranchNavigation>{router=><BranchesWorkspace {...router} {...props}/>}</BranchNavigation>}
function BranchesWorkspace({route,navigate,colorMode,onToggleColorMode}:Appearance&{route:BranchRoute;navigate(route:BranchRoute,replace?:boolean):boolean}):JSX.Element{
 const guard=useBranchNavigationGuard();
 const tab=branchTabs.indexOf(route.tab),executionId=route.executionId??'';
 const setExecutionId=(executionId:string,replace=false)=>navigate({...route,executionId:executionId||undefined},replace);
 useAppViewport();
 const connection=useWorkspaceStream();
 const preferences=useQuery({queryKey:['preferences'],queryFn:()=>realApi.getWorkspacePreferences()});
 const onGlobal=(global:NonNullable<BranchRoute['global']>)=>{navigate({...route,global});setMobileNavOpen(false)};
 const theme=useTheme(),mobileWorkspace=useMediaQuery(theme.breakpoints.down('md'));
 const [mobileNavOpen,setMobileNavOpen]=useState(false),[globalSearchOpen,setGlobalSearchOpen]=useState(false);
 const mobileNavigationButton=useRef<HTMLButtonElement>(null);
 const [sidebarPresentation,setSidebarPresentation]=useState(()=>{try{return restoreWorkspaceSidebarState(localStorage.getItem(BRANCHES_SIDEBAR_STORAGE_KEY))}catch{return restoreWorkspaceSidebarState(null)}});
 const feedback=useRef<HTMLDivElement>(null);
 const [runOpen,setRunOpen]=useState(false);
 const [openingLink,setOpeningLink]=useState(()=>{const params=new URLSearchParams(window.location.search);return Boolean(params.get('branch')||params.get('execution'))});
 const creation=useRef<string>(),actionLocks=useRef(new Set<string>()),[creating,setCreating]=useState(false),[notice,setNotice]=useState('');
 const executionViewStates=useRef(new Map<string,ExecutionPanelViewState>());
 const once=(key:string,action:()=>void)=>{if(actionLocks.current.has(key))return;actionLocks.current.add(key);action()};
 const [advancedDirty,setAdvancedDirty]=useState(false);
 const draftRevision=useRef(''),pendingAdvanced=useRef(false);
 const [install,setInstall]=useState<{pkg:InstalledBranchPackage;branchId?:string}>(),[deployedUpdate,setDeployedUpdate]=useState<{branch:BranchDto;reason:'dirty'|'failed'}>();
 const client=useQueryClient(),selection=useRef(0),savedDraft=useRef<string>(),versionRequest=useRef(0),[draft,setDraft]=useState<Draft>(emptyDraft),[editorKey,setEditorKey]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(false),[search,setSearch]=useState(''),[agentSearch,setAgentSearch]=useState(''),[input,setInput]=useState(''),[occurrenceKey,setOccurrenceKey]=useState(()=>crypto.randomUUID()),[preview,setPreview]=useState<{draftRevision:string;input:DeployBranchRequest;result:BranchDeploymentPreviewDto;expectsNewWebhookSecret:boolean}>(),[secret,setSecret]=useState<{branchId:string;value:string}>(),[secretRecovery,setSecretRecovery]=useState<string>();
 draftRevision.current=branchDraftRevision(draft);pendingAdvanced.current=advancedDirty;
 const branchPages=useInfiniteQuery({queryKey:['branches',search.trim()],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestJson<BranchDto[]>('/api/branches?search='+encodeURIComponent(search.trim())+(pageParam?'&before='+encodeURIComponent(pageParam):'')),getNextPageParam:last=>last.length===100?last.at(-1)?.id:undefined,refetchInterval:5000});
 const branches={...branchPages,data:branchPages.data?.pages.flat()};
 const contextList=useQuery({queryKey:['branch-chats',draft.branchId],queryFn:()=>requestJson<Context[]>(`/api/branches/${draft.branchId}/chats`),enabled:Boolean(draft.branchId),refetchInterval:5000});
 const selectedContext=useQuery({queryKey:['branch-context',draft.chatId],queryFn:()=>requestJson<Context>(`/api/branches/contexts/${draft.chatId}`),enabled:Boolean(draft.chatId)});
 const setTab=(tab:number)=>{
  const next=branchTabs[tab]!;
  const owner=route.chatId?client.getQueryData<Context>(['branch-chat-owner',route.chatId]):undefined;
  const belongsHere=(chat?:Context)=>chat?.id===route.chatId&&chat?.branchId===route.branchId&&!chat?.executionId;
  const persistentChat=Boolean(route.chatId&&(contextList.data?.some(belongsHere)||belongsHere(selectedContext.data)||belongsHere(owner)));
  const clearChat=next==='chats'&&Boolean(route.executionId)&&!persistentChat;
  navigate(next==='chats'?{...route,tab:next,executionId:undefined,...(clearChat?{chatId:undefined,workspace:undefined}:{})}:{...route,tab:next});
 };
 const contexts={...contextList,data:[...(contextList.data??[]),...(selectedContext.data&&!contextList.data?.some(c=>c.id===selectedContext.data!.id)?[selectedContext.data]:[])]};
 const engines=useQuery({queryKey:['engines'],queryFn:()=>realApi.listEngines()});
 const agents=useQuery({queryKey:['branch-agents',draft.branchId,contexts.data?.map(c=>c.id),agentSearch],queryFn:async()=>({items:(await Promise.all((contexts.data??[]).map(c=>realApi.listConversationMembersPage(c.id,{limit:100,search:agentSearch})))).flatMap(p=>p.items)}),enabled:Boolean(draft.branchId),refetchInterval:5000});
 const histories=useInfiniteQuery({queryKey:['branch-executions',draft.branchId,route.executionFilter],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestJson<BranchExecutionDto[]>(`/api/branches/${draft.branchId}/executions?${new URLSearchParams({...pageParam?{before:pageParam}:{},...route.executionFilter?{state:route.executionFilter}:{}})}`),getNextPageParam:last=>last.length===100?last.at(-1)?.id:undefined,enabled:Boolean(draft.branchId),refetchInterval:3000});
 const executions=histories.data?.pages.flat()??[];
 const detailPages=useInfiniteQuery({queryKey:['branch-execution',executionId],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestJson<BranchExecutionDetailDto>(`/api/branch-executions/${executionId}${pageParam?'?cursor='+encodeURIComponent(pageParam):''}`),getNextPageParam:last=>last.nextCursor,enabled:Boolean(executionId),refetchInterval:query=>['completed','canceled','skipped','merged'].includes(query.state.data?.pages[0]?.execution.state??'')?false:2000});
 const [detailLoadTarget,setDetailLoadTarget]=useState(0);
 useEffect(()=>setDetailLoadTarget(0),[executionId]);
 useEffect(()=>{if(detailLoadTarget>(detailPages.data?.pages.length??0)&&detailPages.hasNextPage&&!detailPages.isFetchingNextPage)void detailPages.fetchNextPage()},[detailLoadTarget,detailPages.data?.pages.length,detailPages.hasNextPage,detailPages.isFetchingNextPage]);
 const detail={...detailPages,data:mergeHistory(detailPages.data?.pages)};
 const executionChats=useQuery({queryKey:['branch-execution-chats',draft.branchId,executionId],queryFn:()=>requestJson<Context[]>(`/api/branches/${draft.branchId}/chats?executionId=${encodeURIComponent(executionId)}`),enabled:Boolean(draft.branchId&&executionId&&tab===1&&detail.data?.execution.branchId===draft.branchId),refetchInterval:5000});
 const pinned=useQuery({queryKey:['branch-version',detail.data?.execution.versionId],queryFn:()=>requestJson<BranchVersionDto>(`/api/branches/${detail.data!.execution.branchId}/versions/${detail.data!.execution.versionId}`),enabled:Boolean(detail.data)});
 const versions=useInfiniteQuery({queryKey:['branch-versions',draft.branchId],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestJson<BranchVersionSummaryDto[]>(`/api/branches/${draft.branchId}/versions${pageParam?'?before='+encodeURIComponent(pageParam):''}`),getNextPageParam:last=>last.length===100?last.at(-1)?.id:undefined,enabled:Boolean(draft.branchId)&&tab===2});
 const selectedBranch=useQuery({queryKey:['branch',draft.branchId],queryFn:()=>requestJson<BranchDto>(`/api/branches/${draft.branchId}`),enabled:Boolean(draft.branchId),refetchInterval:5000});
 const current=selectedBranch.data;
 const publishedVersion=useQuery({queryKey:['branch-version',current?.versionId],queryFn:()=>requestJson<BranchVersionDto>(`/api/branches/${current!.id}/versions/${current!.versionId}`),enabled:Boolean(preview&&current?.versionId)});
 const dirty=advancedDirty||Boolean(savedDraft.current&&savedDraft.current!==branchDraftRevision(draft));
 const trigger=useQuery({queryKey:['branch-trigger',current?.triggerId],queryFn:()=>requestJson<TriggerDefinitionDto>(`/api/branches/${current!.id}/trigger`),enabled:Boolean(current?.triggerId),refetchInterval:5000});
 const lifecycle=useQuery({queryKey:['branch-lifecycle-summary',current?.id],queryFn:()=>requestJson<BranchLifecycleDto>(`/api/branches/${current!.id}/lifecycle`),enabled:Boolean(current?.id),refetchInterval:3000});
 const changeChat=(chatId:string)=>setDraft(d=>{const chat=contexts.data?.find(c=>c.id===chatId);return {...d,chatId,bindings:{...d.bindings,agents:{},directories:Object.fromEntries(d.definition.steps.filter(s=>s.kind==='script').map(s=>[s.cwdRef,chat?.workingDirectory??''])),engines:{...d.bindings.engines,default:chat?.defaultEngine??engines.data?.[0]?.id??''}}}});
 async function select(branch:BranchDto,force=false,reconcileBaseline?:string):Promise<boolean>{
  if(!force){navigate({branchId:branch.id,tab:'workflow'});return true;}
  const sequence=++selection.current;setLoading(true);setError('');setSecret(previous=>previous?.branchId===branch.id?previous:undefined);
  try{const [version,bindings]=await Promise.all([branch.versionId?requestJson<BranchVersionDto>(`/api/branches/${branch.id}/versions/${branch.versionId}`):Promise.resolve({definition:{...newDefinition(),name:branch.name}}),requestJson<BranchBindings>(`/api/branches/${branch.id}/configuration${branch.bindingRevisionId?'?revisionId='+encodeURIComponent(branch.bindingRevisionId):''}`)]);
   if(sequence!==selection.current)return false;
   if(reconcileBaseline!==undefined&&(draftRevision.current!==reconcileBaseline||pendingAdvanced.current)){setDeployedUpdate({branch,reason:'dirty'});return false;}
   const next={branchId:branch.id,expectedVersionId:branch.versionId,chatId:branch.chatId,definition:version.definition,bindings};setDraft(()=>{savedDraft.current=branchDraftRevision(next);return next});setAdvancedDirty(false);setDeployedUpdate(undefined);setEditorKey(k=>k+1);setAgentSearch('');setInput('');setRunOpen(false);setNotice('');run.reset();setOccurrenceKey(crypto.randomUUID());
   return true;
  }catch(e){if(sequence===selection.current){setError((e as Error).message);if(reconcileBaseline!==undefined)setDeployedUpdate({branch,reason:'failed'})}return false}finally{if(sequence===selection.current){setLoading(false);setOpeningLink(false)}}
 }
  useEffect(()=>{if(!current||current.id!==draft.branchId||current.versionId===draft.expectedVersionId||deployedUpdate?.reason==='failed'&&deployedUpdate.branch.id===current.id)return;if(dirty){setDeployedUpdate({branch:current,reason:'dirty'});return;}setDeployedUpdate(undefined);void select(current,true,draftRevision.current)},[current?.id,current?.versionId,draft.branchId,draft.expectedVersionId,dirty,deployedUpdate?.reason]);
 useEffect(()=>{let cancelled=false;
  if(!route.branchId&&!route.executionId){selection.current++;setDraft(emptyDraft());savedDraft.current=undefined;setAdvancedDirty(false);setLoading(false);setOpeningLink(false);return;}
  setOpeningLink(route.branchId!==draft.branchId);
  void(async()=>{try{
   const executionBranchId=route.executionId?(await requestJson<BranchExecutionDetailDto>(`/api/branch-executions/${encodeURIComponent(route.executionId)}`)).execution.branchId:undefined;
   if(cancelled)return;
   const id=executionBranchId??route.branchId!;
   if(route.branchId!==id){navigate({...route,branchId:id},true);return;}
   if(id===draft.branchId){setLoading(false);setOpeningLink(false);return;}
   setDeployedUpdate(undefined);
   const branch=await requestJson<BranchDto>(`/api/branches/${encodeURIComponent(id)}`);if(!cancelled)await select(branch,true);
  }catch(e){if(!cancelled){setLoading(false);setError((e as Error).message);setOpeningLink(false)}}})();
  return()=>{cancelled=true;selection.current++};
 },[route.branchId,route.executionId]);
 const review=useMutation({mutationFn:async(startedDraft:Draft)=>{const sequence=selection.current,payload={...startedDraft,bindings:bindDefinitionDirectories(startedDraft.definition,startedDraft.bindings,contexts.data?.find(c=>c.id===startedDraft.chatId)?.workingDirectory),idempotencyKey:crypto.randomUUID()},expectsNewWebhookSecret=startedDraft.definition.trigger.kind==='webhook'&&(!trigger.data||trigger.data.sourceKind!=='webhook'||!trigger.data.secretFingerprint);return {sequence,draftRevision:branchDraftRevision(startedDraft),input:payload,expectsNewWebhookSecret,result:await requestJson<BranchDeploymentPreviewDto>('/api/branches/preview',{method:'POST',body:JSON.stringify(payload)})}},onSuccess:result=>{if(result.sequence===selection.current&&result.draftRevision===draftRevision.current&&!pendingAdvanced.current)setPreview(result)}});
 const deploy=useMutation({mutationFn:()=>{if(!preview||preview.draftRevision!==draftRevision.current||pendingAdvanced.current)throw new Error('The draft changed. Review the current edits before publishing.');return requestJson<DeployBranchResponse>('/api/branches/deploy',{method:'POST',body:JSON.stringify(preview.input)})},onMutate:()=>{selection.current++;setLoading(true)},onSuccess:async branch=>{const expectsNewSecret=preview?.expectsNewWebhookSecret;setPreview(undefined);if(branch.webhookSecret){setSecret({branchId:branch.id,value:branch.webhookSecret});setSecretRecovery(undefined)}else if(expectsNewSecret)setSecretRecovery(branch.id);client.setQueryData<BranchDto>(['branch',branch.id],branch);const synchronized=await select(branch,true);if(synchronized)setNotice('Changes published. New executions use this definition; existing executions keep their snapshot.');else setDeployedUpdate({branch,reason:'failed'});void client.invalidateQueries({queryKey:['branches']});void client.invalidateQueries({queryKey:['branch-versions',branch.id]});void client.invalidateQueries({queryKey:['branch-settings',branch.id]});void client.invalidateQueries({queryKey:['branch-trigger']});void client.invalidateQueries({queryKey:['branch',branch.id]})},onSettled:()=>{setLoading(false);actionLocks.current.delete('deploy')}});
 const run=useMutation({mutationFn:(start:{branchId:string;selection:number;input:string;occurrenceKey:string})=>requestJson<BranchExecutionDto>(`/api/branches/${start.branchId}/executions`,{method:'POST',body:JSON.stringify({occurrenceKey:start.occurrenceKey,input:start.input})}),onSuccess:(execution,start)=>{if(isCurrentWorkflowResponse(start,{branchId:draft.branchId,selection:selection.current})){setExecutionId(execution.id);setRunOpen(false);setNotice(`Run accepted · ${execution.id.slice(0,8)}. Inspect its progress below.`)}void client.invalidateQueries({queryKey:['branch-executions',execution.branchId]});void client.invalidateQueries({queryKey:['branches']})},onSettled:()=>{actionLocks.current.delete('run')}});
 const automatic=useMutation({mutationFn:()=>realApi.updateTrigger(current!.triggerId!,{enabled:!trigger.data!.enabled}),onSuccess:()=>{void client.invalidateQueries({queryKey:['branch-trigger']});void client.invalidateQueries({queryKey:['branches']})}});
 const rotate=useMutation({mutationFn:()=>requestJson<{webhookSecret:string}>(`/api/triggers/${current!.triggerId}/rotate-secret`,{method:'POST'}),onSuccess:result=>{setSecret({branchId:current!.id,value:result.webhookSecret});setSecretRecovery(undefined)}});
 const cancelInstallation=useMutation({mutationFn:(id:string)=>requestJson(`/api/branches/installations/${id}/cancel`,{method:'POST'}),onSuccess:()=>{void client.invalidateQueries({queryKey:['branch-lifecycle-summary']});void client.invalidateQueries({queryKey:['branches']})}});
 const importFile=async(file?:File,update=false)=>{if(!file)return;if(dirty){setError('Publish your current edits or discard them before importing or updating a Branch.');return;}try{if(file.size>96*1024*1024)throw new Error('Package exceeds the 96 MiB limit');const pkg=JSON.parse(await file.text()) as InstalledBranchPackage;if(pkg.schema!=='ponderosa.branch-installation.v1')throw new Error('Choose a portable Branch installation package');setInstall({pkg,...(update?{branchId:draft.branchId}:{})})}catch(e){setError((e as Error).message)}};
 const versionDefinition=async(version:BranchVersionSummaryDto,restore:boolean)=>{if(restore&&dirty){setError('Publish or discard your current edits before restoring another definition.');return;}const started={branchId:version.branchId,selection:selection.current},requestId=++versionRequest.current,startedDraft=draftRevision.current;try{const full=await requestJson<BranchVersionDto>(`/api/branches/${version.branchId}/versions/${version.id}`);if(restore){if(started.selection!==selection.current||requestId!==versionRequest.current||startedDraft!==draftRevision.current||pendingAdvanced.current)return;selection.current++;setDraft(d=>({...d,definition:full.definition,bindings:bindDefinitionDirectories(full.definition,d.bindings,contexts.data?.find(c=>c.id===d.chatId)?.workingDirectory)}));setEditorKey(k=>k+1);setTab(0)}else download(full.definition,'workflow-definition.json')}catch(e){setError((e as Error).message)}};
 const exportFile=async(mode:'template'|'full'='template')=>{try{const pkg=await requestJson<InstalledBranchPackage>(`/api/branches/${draft.branchId}/package?mode=${mode}&includeValues=${mode==='full'}`);download(pkg,`${draft.definition.name.replace(/[^a-z0-9_-]/gi,'_')}.ponderosa.json`)}catch(e){setError((e as Error).message)}};
 const editorGeneration=selection.current;
 const createBranch=async(force=false)=>{if(actionLocks.current.has('create'))return;if(!force){guard(()=>void createBranch(true));return;}actionLocks.current.add('create');setCreating(true);creation.current??=crypto.randomUUID();try{const branch=await requestJson<BranchDto>('/api/branches',{method:'POST',body:JSON.stringify({name:'Untitled Branch',idempotencyKey:creation.current})});savedDraft.current=undefined;setAdvancedDirty(false);requestAnimationFrame(()=>navigate({branchId:branch.id,tab:'workflow'}));creation.current=undefined;setNotice('Branch created. Edit its draft, then review and publish to make it runnable.');void client.invalidateQueries({queryKey:['branches']})}catch(e){setError((e as Error).message)}finally{actionLocks.current.delete('create');setCreating(false)}};
 useEffect(()=>{setPreview(undefined)},[draft,advancedDirty]);
 useEffect(()=>{if(dirty&&notice.startsWith('Changes published.'))setNotice('')},[dirty,notice]);
 useEffect(()=>{try{localStorage.setItem(BRANCHES_SIDEBAR_STORAGE_KEY,serializeWorkspaceSidebarState(sidebarPresentation))}catch{}},[sidebarPresentation]);
 useEffect(()=>{if(!mobileWorkspace&&mobileNavOpen)setMobileNavOpen(false)},[mobileWorkspace,mobileNavOpen]);
 useBranchDraftGuard('workflow',dirty&&!advancedDirty);
 useBranchDraftGuard('workflow-editor',advancedDirty);
 useEffect(()=>{if(tab===1&&!executionId&&executions[0])setExecutionId(executions[0].id,true)},[tab,executionId,executions[0]?.id]);
 const historyExecution=executions.find(e=>e.id===executionId);
 const detailFresh=Boolean(detail.data&&detail.data.execution.branchId===draft.branchId&&route.branchId===draft.branchId&&(!historyExecution||detail.data.execution.revision>=historyExecution.revision));
 const shownExecutions=executions.map(e=>e.id===detail.data?.execution.id&&detail.data.execution.revision>=e.revision?detail.data.execution:e);
 const actionFailure=error||(review.variables&&branchDraftRevision(review.variables)===draftRevision.current&&!advancedDirty?review.error?.message:undefined)||run.error?.message||automatic.error?.message||rotate.error?.message||cancelInstallation.error?.message;
 const failure=actionFailure||branches.error?.message||contexts.error?.message||agents.error?.message||engines.error?.message||selectedBranch.error?.message||trigger.error?.message||lifecycle.error?.message||histories.error?.message||detail.error?.message||pinned.error?.message||versions.error?.message;
 useEffect(()=>{if(actionFailure){feedback.current?.scrollIntoView({block:'center',behavior:'instant'});feedback.current?.focus({preventScroll:true})}},[actionFailure]);
 const closeMobileNavigation=()=>{setMobileNavOpen(false);requestAnimationFrame(()=>mobileNavigationButton.current?.focus())};
 const openGlobalSearch=()=>{setGlobalSearchOpen(true);setMobileNavOpen(false)};
 const openGlobalSearchSelection=async(selection:GlobalSearchSelection)=>{
  if('file'in selection)return;
  try{
   const conversationId=selection.chat.kind==='conversation'?selection.chat.id:(await realApi.getAgent(selection.chat.id,1)).agent.conversationId;
   const context=await requestJson<BranchContextDto>(`/api/branches/contexts/${encodeURIComponent(conversationId)}`);
   if(!context.branchId)throw new Error('This Chat is not owned by a Branch.');
   const focusMessageId='messageId'in selection&&selection.messageId?selection.messageId:undefined;
   const workspace=selection.chat.kind==='conversation'
    ?{kind:'conversation' as const,projectId:context.projectId,conversationId:context.id,...(focusMessageId?{focusMessageId}:{})}
    :{kind:'agent' as const,projectId:context.projectId,agentId:selection.chat.id,...(focusMessageId?{focusMessageId}:{})};
   navigate({branchId:context.branchId,tab:'chats',executionId:context.executionId,chatId:context.id,workspace});
  }catch(cause){setError(cause instanceof Error?cause.message:'The selected Branch Chat could not be opened.')}
 };
 useEffect(()=>{const keydown=(event:KeyboardEvent)=>{if(!isGlobalSearchShortcut(event))return;event.preventDefault();openGlobalSearch()};window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown)},[]);
 const workflowPanel=(drawer:boolean)=><SharedSidebarPanel
      icon={<AccountTreeOutlinedIcon/>}
      title="Workflows"
      total={branchPages.hasNextPage?undefined:branches.data?.length}
      searchLabel="Find a workflow"
      searchValue={search}
      onSearchValueChange={setSearch}
      busy={branches.isPending||branches.isFetching}
      starredRows={null}
      allRows={branches.data?.map(b=>{const status=branchDirectoryStatus(b);return <SidebarResourceRow key={b.id} id={b.id} label={`Open Branch ${b.name} · ${status.label}`} title={b.name} detail={status.label} selected={draft.branchId===b.id} currentPage={draft.branchId===b.id} disabled={loading||openingLink||creating||deploy.isPending} icon={<AccountTreeOutlinedIcon fontSize="small"/>} status={<SemanticStatus status={status.kind} label={status.label}/>} onOpen={()=>{if(loading||openingLink||creating||deploy.isPending)return;if(drawer)closeMobileNavigation();void select(b)}}/>})??null}
      empty={!branches.isPending&&!branches.error&&!branches.data?.length?<Typography variant="body2" color="text.secondary" sx={{px:1,py:2}}>{search.trim()?'No workflows match your search. Try another name.':'Your deployed workflows will appear here.'}</Typography>:undefined}
      collectionFeedback={branches.isPending?<Typography color="text.secondary" sx={{px:1,py:2}}>Loading workflows…</Typography>:undefined}
      loadMoreLabel={branchPages.hasNextPage?'Load more workflows':undefined}
      onLoadMore={branchPages.hasNextPage?()=>void branchPages.fetchNextPage():undefined}
      loadingMore={branchPages.isFetchingNextPage}
      newLabel={creating?'Creating workflow…':'New workflow'}
      onNew={()=>{if(drawer)closeMobileNavigation();void createBranch()}}
      newDisabled={creating||loading||openingLink}
      topContent={<Button component="label" fullWidth color="inherit" startIcon={<FileUploadOutlinedIcon/>} sx={{justifyContent:'flex-start',mb:1,color:'text.secondary'}}>Import workflow<input hidden type="file" accept=".json,application/json" onChange={e=>{if(drawer)closeMobileNavigation();void importFile(e.target.files?.[0]);e.target.value=''}}/></Button>}
      drawer={drawer}
    />;
 return <WorkspaceConnectionProvider value={connection}><MobileNavigationProvider desktopVisible={sidebarPresentation.collapsed} onOpen={()=>mobileWorkspace?setMobileNavOpen(true):setSidebarPresentation(state=>({...state,collapsed:false}))}><Box sx={{height:'var(--ponderosa-app-viewport-block-size, 100dvh)',display:'grid',gridTemplateColumns:{xs:'minmax(0,1fr)',md:'auto minmax(0,1fr)'},overflow:'hidden',bgcolor:'background.default'}}>
  <Box sx={{display:{xs:'none',md:'block'},height:'100%',minHeight:0}}><BranchesSidebar profile={preferences.data?.profile} onGlobal={onGlobal} onHome={()=>navigate({tab:'workflow'})} onSearch={openGlobalSearch} panel={workflowPanel(false)} notifications={!mobileWorkspace?<BranchNotifications onNavigate={navigate}/>:undefined} collapsed={sidebarPresentation.collapsed} width={sidebarPresentation.width} onCollapsedChange={collapsed=>{setSidebarPresentation(state=>({...state,collapsed}));if(collapsed)requestAnimationFrame(()=>mobileNavigationButton.current?.focus())}} onWidthChange={width=>setSidebarPresentation(state=>({...state,width}))}/></Box>
  <Box component="a" href="#main-content" sx={{position:'absolute',left:8,top:-80,zIndex:1500,p:1,bgcolor:'background.paper','&:focus':{top:8}}}>Skip to main content</Box>
  <Box component="main" id="main-content" tabIndex={-1} sx={{minWidth:0,minHeight:0,display:'flex',flexDirection:'column',overflow:'hidden'}}>
   <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} sx={{display:(route.global&&preferences.data)||(tab===3&&draft.branchId)?'none':'flex',flexShrink:0,px:{xs:1.5,sm:2,md:2.5},py:.75,borderBottom:1,borderColor:'divider',minHeight:64}}><Stack direction="row" alignItems="center" gap={1} sx={{minWidth:0}}><IconButton ref={mobileNavigationButton} aria-label="Open workflow navigation" onClick={()=>mobileWorkspace?setMobileNavOpen(true):setSidebarPresentation(state=>({...state,collapsed:false}))} sx={{display:{xs:'inline-flex',md:sidebarPresentation.collapsed?'inline-flex':'none'}}}><MenuIcon/></IconButton><Box sx={{minWidth:0}}><Typography variant="h5" fontWeight={750} noWrap sx={{fontSize:{xs:16,md:20}}}>Ponderosa Branches</Typography><Typography variant="body2" color="text.secondary" sx={{display:{xs:'none',sm:'block'}}}>Build and operate repeatable work.</Typography></Box></Stack><Stack direction="row" gap={0.5} flexShrink={0} sx={{display:{xs:'flex',md:'none'}}}>{mobileWorkspace&&<BranchNotifications onNavigate={navigate}/>}</Stack></Stack>
   <WorkspaceConnectionNotice connection={connection}/>
   {route.global?(preferences.data?<BranchGlobalSettings view={route.global} preferences={preferences.data} engines={engines.data??[]} colorMode={colorMode} onToggleColorMode={onToggleColorMode} onSelect={onGlobal} onClose={()=>navigate({...route,global:undefined})} notificationAction={mobileWorkspace?<BranchNotifications onNavigate={navigate}/>:undefined}/>:<Alert severity={preferences.error?'error':'info'} action={<Button onClick={()=>void preferences.refetch()}>Retry</Button>}>{preferences.error?.message??'Loading Ponderosa settings…'}</Alert>):<Stack spacing={{xs:1.5,md:2}} sx={{p:tab===3?1:{xs:1.5,sm:2,md:3},flex:1,minWidth:0,minHeight:0,overflowY:tab===3?'hidden':'auto',overflowX:'hidden'}}>
    {deployedUpdate&&deployedUpdate.branch.id===draft.branchId&&route.branchId===draft.branchId&&<Alert severity={deployedUpdate.reason==='failed'?'warning':'info'} action={<Button onClick={()=>deployedUpdate.reason==='failed'?void select(deployedUpdate.branch,true):guard(()=>void select(deployedUpdate.branch,true))}>{deployedUpdate.reason==='failed'?'Retry loading':'Load deployed version'}</Button>}>{deployedUpdate.reason==='failed'?'Changes were published, but the deployed workflow could not be loaded. Retry loading before editing.':'The deployed workflow changed while this draft has local edits. Load the deployed version when you are ready.'}</Alert>}{failure&&<Alert ref={feedback} tabIndex={-1} severity="error">{failure}</Alert>}{notice&&<Alert role="status" severity="success" onClose={()=>setNotice('')}>{notice}</Alert>}
    {secret&&secret.branchId===route.branchId&&<Alert severity="success" onClose={()=>setSecret(undefined)}><Typography fontWeight={600}>Save your webhook signing secret</Typography><Typography sx={{fontFamily:'monospace',overflowWrap:'anywhere'}}>{secret.value}</Typography><Typography variant="caption">Shown once. Rotate the secret if you lose it.</Typography></Alert>}
    {secretRecovery===route.branchId&&<Alert severity="warning" onClose={()=>setSecretRecovery(undefined)}>Changes were published, but the webhook signing secret was not returned. Once the workflow loads, rotate its signing secret and save the new value before enabling webhook intake.</Alert>}
    {loading||openingLink?<Typography role="status">Opening workflow…</Typography>:deployedUpdate?.reason==='failed'&&deployedUpdate.branch.id===draft.branchId?<Typography role="status">The published workflow is waiting to be loaded.</Typography>:!draft.branchId?<><Typography>Choose a workflow from the list, or create a Branch to start building.</Typography><BranchOperations branches={branches.data??[]} onNavigate={navigate}/></>:<>
     {tab!==3&&<Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}><Box><Typography variant="h5">{draft.definition.name}</Typography><Typography variant="caption" color="text.secondary">{!draft.branchId?'Create a Branch to start building.':dirty?'Unpublished edits · held in this browser until you publish. Switching tabs keeps these edits; leaving this Branch or reloading discards them.':selectedBranch.isPending?'Loading publication status…':current?.versionId?'Published · no unpublished changes.':'Unpublished draft · publish before running. The Branch exists; edits are held in this browser.'}</Typography></Box><Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>{draft.branchId&&<><Button onClick={()=>void exportFile()}>Export template</Button><Button onClick={()=>void exportFile('full')}>Export full</Button><Button component="label" title="Preview a portable Branch package and reconcile it into this workflow. Nothing changes until you review and confirm.">Apply package update…<input hidden type="file" accept=".json" onChange={e=>{void importFile(e.target.files?.[0],true);e.target.value=''}}/></Button></>}<Button variant="contained" disabled={!draft.branchId||Boolean(current?.versionId&&!dirty)||advancedDirty||review.isPending||deploy.isPending} onClick={()=>{review.reset();deploy.reset();review.mutate(draft)}}>{review.isPending?'Checking changes…':current?.versionId&&!dirty?'No changes to publish':'Review deployment'}</Button></Stack></Stack>}
     {tab!==3&&<Paper variant="outlined" sx={{p:{xs:1.5,md:2},borderRadius:2}}><Stack spacing={1}><Stack direction="row" gap={0.75} flexWrap="wrap"><SemanticStatus status={!current||current.enabled===false?'disabled':'enabled'} label={!current?selectedBranch.error?'Branch unavailable':'Branch loading…':current.enabled===false?'Branch disabled':'Branch enabled'}/><SemanticStatus status={current?.triggerId&&trigger.data?.enabled?'enabled':trigger.error?'needs_attention':trigger.isPending?'waiting':'idle'} label={!current?selectedBranch.error?'Automatic runs unavailable':'Automatic runs loading…':!current.triggerId?'Manual trigger':trigger.error?'Automatic runs unavailable':trigger.isPending?'Automatic runs loading…':trigger.data?.enabled?(current.enabled===false?'Trigger on · Branch paused':'Automatic runs on'):'Automatic runs paused'}/><SemanticStatus status={lifecycle.data?.activeExecutions?'running':lifecycle.error?'needs_attention':lifecycle.isPending?'waiting':'idle'} label={selectedBranch.error||lifecycle.error?'Executions unavailable':!current||lifecycle.isPending?'Executions loading…':`${lifecycle.data?.activeExecutions??0} active executions`}/></Stack><Typography variant="body2">{!current?selectedBranch.error?'The deployed workflow state is temporarily unavailable.':'Loading the deployed workflow state…':current.enabled===false?'This Branch is paused. Its trigger remains configured but cannot start work; waiting Branch callers resume when the Branch is enabled.':trigger.error?'Automatic-run state is temporarily unavailable. Manual runs and Branch calls remain available while the Branch is enabled.':automaticRunSummary(trigger.data,Boolean(current.triggerId&&trigger.isPending))}</Typography>{trigger.data&&<Typography variant="caption" color="text.secondary">Last automatic run: {trigger.data.lastFiredAt?new Date(trigger.data.lastFiredAt).toLocaleString():'None'} · Next automatic run: {current?.enabled===false?'Paused while Branch is disabled':!trigger.data.enabled?'Paused':trigger.data.nextFireAt?new Date(trigger.data.nextFireAt).toLocaleString():'Not scheduled'}</Typography>}</Stack></Paper>}
     {lifecycle.data&&(lifecycle.data.deleting||lifecycle.data.updates.length>0||lifecycle.data.pendingRemoval.length>0)&&<BranchLifecycleStatus lifecycle={lifecycle.data} canceling={cancelInstallation.isPending} onCancelUpdate={id=>cancelInstallation.mutate(id)}/>}
     <Tabs aria-label="Branch views" sx={{flexShrink:0}} value={tab} variant="scrollable" onChange={(_,value)=>setTab(value)}><Tab id="branch-tab-0" aria-controls="branch-panel-0" value={0} label="Workflow"/><Tab id="branch-tab-3" aria-controls="branch-panel-3" value={3} label="Chats" disabled={!draft.branchId}/><Tab id="branch-tab-1" aria-controls="branch-panel-1" value={1} label="Executions" disabled={!current?.versionId}/><Tab id="branch-tab-4" aria-controls="branch-panel-4" value={4} label="Parameters" disabled={!current?.versionId}/><Tab id="branch-tab-2" aria-controls="branch-panel-2" value={2} label="Settings" disabled={!draft.branchId}/></Tabs>
     {advancedDirty&&<Alert severity="warning">Workflow fields have unapplied or invalid edits. Review them in Workflow before deployment.</Alert>}

     <Box role="tabpanel" id="branch-panel-0" aria-labelledby="branch-tab-0" hidden={tab!==0}><WorkflowEditor agentFilter={<TextField size="small" label="Filter Step Agent choices" value={agentSearch} onChange={e=>setAgentSearch(e.target.value)} helperText={agents.isFetching?'Filtering available Agents…':`${agents.data?.items.length??0} matching Agents. Choose a match in the Agent dropdown below.`}/>} onPendingEdits={setAdvancedDirty} key={editorKey} definition={draft.definition} bindings={draft.bindings} chatId={draft.chatId} contexts={contexts.data??[]} agents={agents.data?.items??[]} engines={engines.data??[]} existing={Boolean(draft.branchId)} onDefinition={definition=>{if(editorGeneration===selection.current)setDraft(d=>({...d,definition,bindings:bindDefinitionDirectories(definition,d.bindings,contexts.data?.find(c=>c.id===d.chatId)?.workingDirectory)}))}} onBindings={bindings=>setDraft(d=>({...d,bindings}))} onChat={changeChat}/></Box>
     <Box role="tabpanel" id="branch-panel-1" aria-labelledby="branch-tab-1" hidden={tab!==1}>{tab===1&&<Stack spacing={2}>
      {trigger.data&&<Paper variant="outlined" sx={{p:2}}><Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap"><Typography sx={{flex:1}}>{trigger.data.sourceKind} trigger · {trigger.data.enabled?'Enabled':'Paused'}</Typography><Button disabled={automatic.isPending||(trigger.data.sourceKind==='webhook'&&!trigger.data.secretFingerprint)} onClick={()=>automatic.mutate()}>{trigger.data.enabled?'Pause intake':'Resume intake'}</Button>{trigger.data.sourceKind==='webhook'&&<Button disabled={rotate.isPending} onClick={()=>rotate.mutate()}>Rotate signing secret</Button>}</Stack>{trigger.data.sourceKind==='webhook'&&<><Typography variant="body2" sx={{overflowWrap:'anywhere'}}>{window.location.origin}/api/trigger-webhooks/{trigger.data.id}</Typography>{!trigger.data.secretFingerprint&&<Alert severity="warning" sx={{mt:1}}>Rotate the signing secret to reveal and save it before enabling webhook intake.</Alert>}</>}</Paper>}
      <Accordion slotProps={{transition:{timeout:0,unmountOnExit:true}}} expanded={runOpen||(!executions.length&&!run.isSuccess)} onChange={(_,open)=>setRunOpen(open)}><AccordionSummary expandIcon={<ExpandMoreIcon/>}>Run the deployed workflow</AccordionSummary><AccordionDetails><Stack spacing={2}><TextField label="Workflow input" multiline minRows={3} value={input} disabled={run.isPending} onChange={e=>{setInput(e.target.value);setOccurrenceKey(crypto.randomUUID());run.reset();setNotice('')}}/><Button variant="contained" sx={{alignSelf:'start'}} disabled={!current?.versionId||current.enabled===false||run.isPending||run.isSuccess} onClick={()=>{if(!current?.versionId||current.enabled===false)return;once('run',()=>run.mutate({branchId:draft.branchId!,selection:selection.current,input,occurrenceKey}))}}>{run.isPending?'Submitting…':run.isSuccess?'Run accepted':'Run workflow'}</Button>{run.isSuccess&&<Button sx={{alignSelf:'start'}} onClick={()=>{run.reset();setOccurrenceKey(crypto.randomUUID());setNotice('')}}>Prepare another run</Button>}</Stack></AccordionDetails></Accordion>
      {current&&<BranchExecutionBudget key={current.id} branchId={current.id}/>}
      <Typography variant="h6">Execution history</Typography>
      <TextField select label="Execution status" value={route.executionFilter??''} onChange={e=>navigate({...route,executionFilter:e.target.value||undefined,executionId:undefined})}><MenuItem value="">All statuses</MenuItem>{['queued','running','waiting','completed','failed','canceled','skipped','merged'].map(state=><MenuItem value={state} key={state}>{state}</MenuItem>)}</TextField>
      {histories.error&&<Alert severity="error" action={<Button onClick={()=>void histories.refetch()}>Retry history</Button>}>{histories.error.message}</Alert>}
      {histories.isPending?<Typography>Loading execution history…</Typography>:!executions.length?<Typography color="text.secondary">No executions match this view. Change the status filter or run an enabled, published workflow.</Typography>:<Typography variant="body2">{executions.length}{histories.hasNextPage?'+':''} executions · most recent first. Select an execution to inspect.</Typography>}
      {executions.length>0&&<TextField select label="Execution" value={executionId} onChange={e=>setExecutionId(e.target.value)}><MenuItem value="">Select an execution</MenuItem>{shownExecutions.map(e=><MenuItem key={e.id} value={e.id}>{new Date(e.createdAt).toLocaleString()} · {e.state} · {e.id.slice(0,8)}</MenuItem>)}</TextField>}
      {histories.hasNextPage&&<Button disabled={histories.isFetchingNextPage} onClick={()=>void histories.fetchNextPage()}>Load older executions</Button>}
      {detailPages.hasNextPage&&<Alert severity="info" action={<Stack direction="row"><Button onClick={()=>void detailPages.fetchNextPage()} disabled={detailPages.isFetchingNextPage||detailLoadTarget>(detailPages.data?.pages.length??0)}>Load older details</Button><Button onClick={()=>setDetailLoadTarget((detailPages.data?.pages.length??0)+10)} disabled={detailPages.isFetchingNextPage||detailLoadTarget>(detailPages.data?.pages.length??0)}>Load next 10 pages</Button></Stack>}>Showing bounded execution evidence. Item search and filters cover loaded records; load older pages to inspect the full run.</Alert>}
      {executionId&&!detailFresh&&<Alert severity="info">Refreshing this execution’s details…</Alert>}
      {detailFresh&&detail.data&&<Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
       {executionChats.data?.length?<Button onClick={()=>navigate({...route,tab:'chats',chatId:undefined,workspace:undefined})}>Open {executionChats.data.length} temporary {executionChats.data.length===1?'Chat':'Chats'}</Button>:executionChats.isPending?<Typography variant="body2" color="text.secondary">Checking temporary Chats…</Typography>:!executionChats.error&&<Typography variant="body2" color="text.secondary">No temporary Chats for this execution.</Typography>}
       {executionChats.error&&<Alert severity="warning" action={<Button onClick={()=>void executionChats.refetch()}>Retry</Button>}>Temporary Chats are unavailable right now.</Alert>}
       <Button onClick={()=>navigate({...route,tab:'chats',executionId:undefined,chatId:undefined,workspace:undefined})}>Manage persistent Chats</Button>
      </Stack>}
      {current?.triggerId&&<BranchTriggerAudit triggerId={current.triggerId} branchId={current.id} onNavigate={navigate}/>}
      {detailFresh&&detail.data&&<ExecutionPanel key={detail.data.execution.id} viewStates={executionViewStates.current} detail={detail.data} definition={pinned.data?.definition} executions={executions} projectId={contexts.data?.find(c=>c.id===draft.chatId)?.projectId}/>}
     </Stack>}</Box>
     <Box role="tabpanel" id="branch-panel-3" aria-labelledby="branch-tab-3" hidden={tab!==3} sx={{display:tab===3?'flex':'none',flex:1,minHeight:0}}>{tab===3&&draft.branchId&&<BranchChats key={draft.branchId} branchId={draft.branchId} engines={engines.data??[]} executionId={route.executionId} branchRoute={route} onNavigate={navigate} notificationAction={mobileWorkspace?<BranchNotifications onNavigate={navigate}/>:undefined}/>}</Box>
     <Box role="tabpanel" id="branch-panel-4" aria-labelledby="branch-tab-4" hidden={tab!==4}>{tab===4&&current&&<BranchSettings key={`${current.id}:4`} branch={current} definition={draft.definition} parameters onDeleted={()=>{setDraft(emptyDraft());savedDraft.current=undefined;navigate({tab:'workflow'});void client.invalidateQueries({queryKey:['branches']})}}/>}</Box>
     <Box role="tabpanel" id="branch-panel-2" aria-labelledby="branch-tab-2" hidden={tab!==2}>{tab===2&&current&&<BranchSettings key={`${current.id}:2`} branch={current} definition={draft.definition} onDeleted={()=>{setDraft(emptyDraft());savedDraft.current=undefined;navigate({tab:'workflow'});void client.invalidateQueries({queryKey:['branches']})}}/>}</Box>
     {tab===2&&<Stack spacing={1}><Typography color="text.secondary">Each deployment is immutable. Restore a definition as a draft, then review and deploy it as a new version.</Typography>{versions.data?.pages.flat().map(version=><Paper variant="outlined" key={version.id} sx={{p:2}}><Stack direction="row" alignItems="center" gap={1} flexWrap="wrap"><Typography sx={{flex:1}}>{new Date(version.createdAt).toLocaleString()}</Typography>{version.id===current?.versionId&&<Chip size="small" label="Deployed"/>}<Button onClick={()=>void versionDefinition(version,false)}>View definition</Button><Button onClick={()=>void versionDefinition(version,true)}>Use as draft</Button></Stack></Paper>)}{versions.hasNextPage&&<Button onClick={()=>void versions.fetchNextPage()}>Load older versions</Button>}</Stack>}
    </>}
   </Stack>}
  </Box>
  {mobileWorkspace&&<SwipeableDrawer open={mobileNavOpen} onOpen={()=>setMobileNavOpen(true)} onClose={closeMobileNavigation} disableDiscovery disableSwipeToOpen={false} swipeAreaWidth={24} SwipeAreaProps={{style:{touchAction:'pan-y'}}} hysteresis={0.25} PaperProps={{sx:{width:'auto',maxWidth:'100vw',height:'100dvh',overflow:'hidden'}}}><BranchesSidebar profile={preferences.data?.profile} onGlobal={onGlobal} onHome={()=>navigate({tab:'workflow'})} onSearch={openGlobalSearch} drawer panel={workflowPanel(true)} onDismiss={closeMobileNavigation}/></SwipeableDrawer>}
  <GlobalChatSearch open={globalSearchOpen} product="branches" title="Search Branch Chats" scopes={BRANCH_CHAT_SEARCH_SCOPES} onClose={()=>setGlobalSearchOpen(false)} onSelect={selection=>void openGlobalSearchSelection(selection)}/>
  {install&&<BranchPackageDialog pkg={install.pkg} branchId={install.branchId} branches={branches.data??[]} engines={engines.data??[]} onClose={()=>setInstall(undefined)} onInstalled={branch=>{if(branch.id!==route.branchId){const accepted=navigate({branchId:branch.id,tab:'workflow'});if(accepted)setInstall(undefined);return accepted}return guard(()=>{setInstall(undefined);void select(branch,true,draftRevision.current)})}}/>}
  <Dialog open={Boolean(preview)} onClose={()=>{if(!deploy.isPending)setPreview(undefined)}} fullWidth maxWidth="md"><DialogTitle>Review deployment</DialogTitle><DialogContent><Stack spacing={2}>{deploy.error&&<Alert severity="error">{deploy.error.message}{preview?.input.definition.trigger.kind==='webhook'&&<Typography variant="body2">The server may already have published this workflow. If a retry loads it without a signing secret, rotate the secret before enabling webhook intake.</Typography>}</Alert>}<Typography>{preview?.input.definition.name}</Typography>{preview?.result.operations.filter(op=>op.kind!=='unchanged').map((op,i)=><Accordion key={i}><AccordionSummary><Stack direction="row" spacing={1}><Chip label={op.kind==='detach'?'Remove':op.kind==='create'?'Add':'Change'} size="small"/><Typography>{op.resource} · {deploymentOperationLabel(op,preview.input.definition,publishedVersion.data?.definition)}</Typography></Stack></AccordionSummary><AccordionDetails>{op.before!==undefined&&<><Typography fontWeight={600}>Before</Typography><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto'}}>{op.before}</Typography></>}{op.after!==undefined&&<><Typography fontWeight={600}>After</Typography><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto'}}>{op.after}</Typography></>}</AccordionDetails></Accordion>)}{preview?.result.operations.some(op=>op.kind==='unchanged')&&<Accordion><AccordionSummary>Unchanged local bindings</AccordionSummary><AccordionDetails>{preview.result.operations.filter(op=>op.kind==='unchanged').map((op,i)=><Typography key={i} sx={{overflowWrap:'anywhere'}}>{op.resource} · {deploymentOperationLabel(op,preview.input.definition,publishedVersion.data?.definition)}: {op.after??op.before}</Typography>)}</AccordionDetails></Accordion>}{Boolean(current?.versionId)&&preview?.result.operations.every(op=>op.kind==='unchanged')&&<Typography>No definition or binding changes.</Typography>}<Divider/>{preview?.result.notes.map(note=><Typography key={note} variant="body2" color="text.secondary">{note}</Typography>)}</Stack></DialogContent><DialogActions><Button disabled={deploy.isPending} onClick={()=>setPreview(undefined)}>Back to editing</Button><Button variant="contained" disabled={deploy.isPending||advancedDirty||Boolean(current?.versionId)&&preview?.result.operations.every(op=>op.kind==='unchanged')} onClick={()=>once('deploy',()=>deploy.mutate())}>{deploy.isPending?'Publishing changes…':'Publish workflow'}</Button></DialogActions></Dialog>

 </Box></MobileNavigationProvider></WorkspaceConnectionProvider>;
}
