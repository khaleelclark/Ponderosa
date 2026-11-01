import {PostImportAccessReview,type ImportSettingsResult} from '../PostImportAccessReview';
import {BranchImportFiles} from './BranchImportFiles';
import {branchPackageTarget,branchPackageFileError,mergeBranchImportResults} from './branchPackageFiles';
import {useEffect,useMemo,useRef,useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Accordion,AccordionSummary,AccordionDetails,Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {BranchBindings,BranchDto,EngineDto,InstalledBranchPackage,BranchInstallationPreviewDto,BranchMemoryUpdateSelectionDto} from '@ponderosa/core';
import {requestJson} from '../../api/real';
export function BranchPackageDialog({pkg,branchId,branches,engines,onClose,onInstalled}:{pkg:InstalledBranchPackage;branchId?:string;branches:BranchDto[];engines:EngineDto[];onClose():void;onInstalled(branch:BranchDto):boolean}):JSX.Element{
 const client=useQueryClient(),[bindings,setBindings]=useState<BranchBindings>({agents:{},directories:{workspace:''},engines:pkg.engines??{default:engines[0]?.id??''},triggers:pkg.triggers}),[preview,setPreview]=useState<BranchInstallationPreviewDto>(),[acknowledgeFullImport,setAcknowledgeFullImport]=useState(false),[operationId,setOperationId]=useState(''),[finishError,setFinishError]=useState('');
 useEffect(()=>{generation.current++;setPreview(undefined);setOperationId('');setAcknowledgeFullImport(false);},[pkg,branchId]);
 const [additive,setAdditive]=useState(false),[memorySelection,setMemorySelection]=useState<BranchMemoryUpdateSelectionDto>({newAgents:[],teamChats:[]}),[acknowledgeMemoryUpdate,setAcknowledgeMemoryUpdate]=useState(false);
 const existing=useQuery({queryKey:['branch-memory-update-identities',branchId],queryFn:()=>requestJson<InstalledBranchPackage>(`/api/branches/${branchId}/package?mode=template`),enabled:Boolean(branchId&&pkg.mode==='full'),retry:false});
 useEffect(()=>{setAdditive(false);setMemorySelection({newAgents:[],teamChats:[]});setAcknowledgeMemoryUpdate(false);},[pkg,branchId]);
 const [fileSelections,setFileSelections]=useState<import('@ponderosa/core').BranchImportFileSelections>({});
 const [showSettings,setShowSettings]=useState(false),[settingsReviewed,setSettingsReviewed]=useState(false),[rootAcknowledged,setRootAcknowledged]=useState('');
 const retained=new Set(existing.data?.packageId===pkg.packageId?existing.data.chats.flatMap(chat=>chat.agents.map(agent=>branchPackageTarget(chat.ref,agent.ref))):[]);
 const [rootInventory,setRootInventory]=useState<import('./branchPackageFiles').BranchRootInventory>({});
 const fileError=branchPackageFileError(pkg,fileSelections,retained,rootInventory);
 useEffect(()=>{setFileSelections({});setSettingsReviewed(false);setShowSettings(false);},[pkg,branchId]);
 const [roleRecovery,setRoleRecovery]=useState<import('@ponderosa/core').OutputRoleImportReviewDto>();
 const active=useRef(true),generation=useRef(0),finishing=useRef(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;generation.current++}},[]);
 const current=(token:number)=>active.current&&generation.current===token;
 const dismiss=()=>{active.current=false;generation.current++;onClose()};
 const [parameters,setParameters]=useState<Record<string,string|number|boolean>>(pkg.parameters??{});
 const inventoryContext=JSON.stringify([pkg,branchId,bindings,parameters,additive,memorySelection,Object.entries(fileSelections).filter(([,selection])=>selection.newManagedChatFolderName!==undefined).map(([key,selection])=>[key,selection.newManagedChatFolderName])]);
 useEffect(()=>{setRootInventory({});setPreview(undefined);},[inventoryContext]);
 const dirs=useMemo(()=>[...new Set(['workspace',...pkg.definition.steps.filter(s=>s.kind==='script').map(s=>s.cwdRef)])],[pkg]);
 const engineRefs=useMemo(()=>[...new Set(['default',...pkg.chats.flatMap(c=>c.agents.flatMap(a=>a.definition.agents.map(n=>n.engine))),...Object.values(pkg.definition.templates??{}).flatMap(t=>t.agents.map(a=>a.engine))])],[pkg]);
 const cancelButton=useRef<HTMLButtonElement>(null);
 const review=useMutation({mutationFn:async()=>{const token=generation.current,result=await requestJson<BranchInstallationPreviewDto>('/api/branches/install-preview',{method:'POST',body:JSON.stringify({package:{...pkg,...(Object.keys(parameters).length?{parameters}:{})},bindings,branchId,fileSelections,...(additive?{memorySelection}:{})})});if(!current(token))return;return {result,token}},onSuccess:value=>{if(value&&current(value.token)){setAcknowledgeFullImport(false);setAcknowledgeMemoryUpdate(false);
 const discovered:import('./branchPackageFiles').BranchRootInventory={};
 for(const operation of value.result.operations){
  if(operation.kind!=='retain-content'||!operation.after||typeof operation.after!=='object')continue;
  const after=operation.after as {target?:unknown;groupedAgentRefs?:unknown;workingRootRefs?:unknown};
  if(typeof after.target==='string'&&Array.isArray(after.groupedAgentRefs)&&Array.isArray(after.workingRootRefs)&&after.workingRootRefs.every(ref=>typeof ref==='string'))discovered[after.target]=after.workingRootRefs as string[];
 }
 const expectedGroups=Object.entries(fileSelections).filter(([key,selection])=>selection.newManagedChatFolderName!==undefined&&pkg.chats.find(chat=>chat.ref===JSON.parse(key)[0])!.agents.length>1);
 if(expectedGroups.some(([key])=>!discovered[key]?.length)){setFinishError('The server did not return the canonical grouped working roots. Review with the current grouped installer before continuing.');setPreview(undefined);return;}
 setFinishError('');
 if(Object.entries(discovered).some(([key,roots])=>JSON.stringify(rootInventory[key])!==JSON.stringify(roots))){
  setRootInventory(discovered);
  setFileSelections(current=>Object.fromEntries(Object.entries(current).map(([key,selection])=>{
   if(!discovered[key])return [key,selection];
   const {workingFilesDestination,workingRootDestinations,...rest}=selection;
   return [key,{...rest,workingRootDestinations:Object.fromEntries(discovered[key]!.map(ref=>[ref,'']))}];
  })));
  setPreview(undefined);
 }else setPreview(value.result)}}});
 type InstallationStatus={branchId?:string;state:string;error?:string;workingRootReview?:{chatRef:string;agentRef:string;chatId:string;sharedRoot:string};importResults?:Record<string,ImportSettingsResult>;accessSettingsReview?:{chatRef:string;agentRef:string;chatId:string;review:import('@ponderosa/core').AgentAccessImportReviewDto;agentRefs?:string[]}};
 const apply=useMutation({mutationFn:()=>requestJson<InstallationStatus>(`/api/branches/installations/${preview!.id}/confirm`,{method:'POST',body:JSON.stringify({acknowledgeFullImport,acknowledgeMemoryUpdate,...(roleRecovery?{outputRoleReviewId:roleRecovery.id}:{})})}),onMutate:()=>{setOperationId(preview!.id);return {token:generation.current,id:preview!.id}},onSuccess:async(_status,_variables,context)=>{if(current(context.token))await client.invalidateQueries({queryKey:['branch-installation',context.id]});}});
 const progress=useQuery({queryKey:['branch-installation',operationId],queryFn:()=>requestJson<InstallationStatus>(`/api/branches/installations/${operationId}`),enabled:Boolean(operationId),refetchInterval:query=>['completed','canceled','expired','review_required'].includes(query.state.data?.state??'')?false:3000,retry:false});
 const cancel=useMutation({mutationFn:()=>requestJson<InstallationStatus>(`/api/branches/installations/${operationId}/cancel`,{method:'POST'}),onMutate:()=>({token:generation.current}),onSuccess:async(_status,_variables,context)=>{if(current(context.token))await progress.refetch();}});
 const [accessAction,setAccessAction]=useState<''|'keep_destination'|'use_source'>('');
 const [agentActions,setAgentActions]=useState<Record<string,'keep_destination'|'use_source'>>({});
 const accessSubmitting=useRef(false);
 const accessReview=progress.data?.state==='applying'?progress.data.accessSettingsReview:undefined;
 const accessKey=JSON.stringify([operationId,accessReview?.chatRef,accessReview?.agentRef,accessReview?.chatId,accessReview?.review.reviewSha256,accessReview?.agentRefs]);
 useEffect(()=>{setAccessAction('');setAgentActions({});},[accessKey]);
 const groupedAccess=Boolean(accessReview?.agentRefs);
 const requiredAccessRefs=accessReview?.review.source.filter(source=>source.settings!==undefined).map(source=>source.ref)??[];
 const accessReady=groupedAccess?requiredAccessRefs.every(ref=>agentActions[ref]):Boolean(accessAction);
 const resolveAccess=useMutation({
  mutationFn:async(input:{operationId:string;review:NonNullable<InstallationStatus['accessSettingsReview']>;action:'keep_destination'|'use_source';agentActions?:Record<string,'keep_destination'|'use_source'>})=>requestJson<InstallationStatus>(`/api/branches/installations/${encodeURIComponent(input.operationId)}/access-review`,{method:'POST',body:JSON.stringify({chatRef:input.review.chatRef,agentRef:input.review.agentRef,resolution:{action:input.action,...(input.agentActions?{agentActions:input.agentActions}:{}),reviewSha256:input.review.review.reviewSha256}})}),
  onMutate:()=>({token:generation.current}),
  onSuccess:async(_status,_input,context)=>{if(current(context.token)){setAccessAction('');setAgentActions({});await requestJson(`/api/branches/installations/${encodeURIComponent(_input.operationId)}/confirm`,{method:'POST',body:JSON.stringify({acknowledgeFullImport,acknowledgeMemoryUpdate})});await progress.refetch();}},
  onError:async(_error,_input,context)=>{if(context&&current(context.token)){setAccessAction('');setAgentActions({});await progress.refetch();}},
  onSettled:()=>{accessSubmitting.current=false;},
 });
 const workingRootReview=progress.data?.state==='applying'?progress.data.workingRootReview:undefined;
 const workingRootKey=JSON.stringify([operationId,workingRootReview]);
 useEffect(()=>setRootAcknowledged(''),[workingRootKey]);
 const rootSubmitting=useRef(false);
 const resolveRoot=useMutation({mutationFn:(input:{id:string;review:NonNullable<InstallationStatus['workingRootReview']>})=>requestJson(`/api/branches/installations/${encodeURIComponent(input.id)}/working-root-review`,{method:'POST',body:JSON.stringify({chatRef:input.review.chatRef,agentRef:input.review.agentRef,sharedRoot:input.review.sharedRoot})}),onMutate:()=>({token:generation.current}),onSuccess:async(_data,input,context)=>{if(current(context.token))await requestJson(`/api/branches/installations/${encodeURIComponent(input.id)}/confirm`,{method:'POST',body:JSON.stringify({acknowledgeFullImport,acknowledgeMemoryUpdate})});},onSettled:async(_data,_error,_variables,context)=>{if(context&&current(context.token)){setRootAcknowledged('');await progress.refetch();}rootSubmitting.current=false;}});
 let settingsResult:ImportSettingsResult|undefined,settingsError='';
 try{if(progress.data?.importResults&&Object.keys(progress.data.importResults).length)settingsResult=mergeBranchImportResults(progress.data.importResults);}catch(cause){settingsError=(cause as Error).message;}
 const confirmationRejected=apply.isError&&progress.data?.state==='preview';
 const terminal=['completed','canceled','expired','review_required'].includes(progress.data?.state??'')||confirmationRejected;
 useEffect(()=>{if(progress.data)void handleStatus(progress.data,generation.current,false)},[operationId,progress.dataUpdatedAt,settingsReviewed]);

 async function handleStatus(status:InstallationStatus,token:number,cacheStatus=true){
  if(!current(token))return;
  if(cacheStatus)client.setQueryData(['branch-installation',operationId||preview?.id],status);
  if(status.state==='completed'&&status.branchId){
   if(Object.keys(status.importResults??{}).length&&!settingsReviewed)return;
   if(finishing.current)return;
   finishing.current=true;setFinishError('');
   try{await finish(status.branchId,token);if(!current(token))return}
   catch(e){if(current(token))setFinishError((e as Error).message)}
   finally{if(current(token))finishing.current=false}
  }else{
   await client.invalidateQueries({queryKey:['branches']});
   if(!current(token))return;
  }
 }
 async function finish(id:string,token:number){
  const branch=await requestJson<BranchDto>(`/api/branches/${id}`);
  if(!current(token))return;
  await client.invalidateQueries({queryKey:['branches']});
  if(!current(token))return;
  await client.invalidateQueries({queryKey:['branch-chats',id]});
  if(!current(token))return;
  if(!onInstalled(branch)&&current(token))setFinishError('The workflow was installed, but opening it was canceled. Retry when you are ready.');
 }
 const reviewAgain=()=>{generation.current++;finishing.current=false;setFinishError('');setOperationId('');setAcknowledgeFullImport(false);setAcknowledgeMemoryUpdate(false);setPreview(undefined);apply.reset();cancel.reset();resolveAccess.reset();resolveRoot.reset();setAccessAction('');setSettingsReviewed(false);setShowSettings(false)};
 if(showSettings&&settingsResult)return <Dialog open fullWidth maxWidth="md" disableEscapeKeyDown><DialogTitle>Imported workflow Settings</DialogTitle><DialogContent><Stack spacing={2}>{Object.entries(progress.data?.importResults??{}).filter(([,result])=>result.workingFilesDestination).map(([target,result])=><Typography key={target}>Recovery folder: {result.workingFilesDestination}</Typography>)}<PostImportAccessReview result={settingsResult} onDone={()=>{setShowSettings(false);setSettingsReviewed(true);}}/></Stack></DialogContent></Dialog>;
 return <Dialog open fullWidth maxWidth="md" onClose={()=>{if(!apply.isPending&&!review.isPending)dismiss();}}><DialogTitle>{branchId?'Preview package update':'Import as a new Branch'}</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
  {(review.error||apply.error||cancel.error||resolveAccess.error||resolveRoot.error||progress.error||progress.data?.error||finishError||settingsError)&&<Alert severity="error">{review.error?.message||apply.error?.message||cancel.error?.message||resolveAccess.error?.message||resolveRoot.error?.message||progress.error?.message||progress.data?.error||finishError||settingsError}</Alert>}
  {operationId&&!terminal&&!progress.error&&<Alert severity="info">Applying reviewed update · progress retained across reopening</Alert>}
  {terminal&&<Alert severity={progress.data?.state==='completed'?'success':'warning'}>{progress.data?.state==='completed'?'Workflow import completed. Review the mapped Settings and retained folders before opening it.':confirmationRejected?'The update did not start. Review the package again to retry.':`This update is ${progress.data?.state}. No late package work will be published. Review the package again to retry.`}</Alert>}
  {operationId&&progress.error&&<Alert severity="warning">Update status unavailable · retry status or close · retained progress: workflow status</Alert>}
  <Typography variant="h6">{pkg.definition.name}</Typography>
  {branchId&&<Alert severity="info">Preview required · matching Agents keep history · removed resources drain before deletion</Alert>}
  {!preview?<><Typography>Choose local directories + Engines · secrets excluded</Typography>
   {Object.entries(pkg.definition.parameters??{}).map(([key,p])=>p.type==='secret'?<Alert key={key} severity="info">{p.label??key}: requires a local Engine integration binding; never supplied through this package.</Alert>:<TextField key={key} disabled={review.isPending} label={p.label??key} required={p.required} select={p.type==='boolean'} type={p.type==='number'?'number':'text'} value={parameters[key]??p.default??''} onChange={e=>setParameters({...parameters,[key]:p.type==='number'?Number(e.target.value):p.type==='boolean'?e.target.value==='true':e.target.value})}>{p.type==='boolean'&&[<MenuItem key="true" value="true">Yes</MenuItem>,<MenuItem key="false" value="false">No</MenuItem>]}</TextField>)}
   {branchId&&pkg.mode==='full'&&<><FormControlLabel control={<Checkbox checked={additive} disabled={review.isPending} onChange={(_,checked)=>setAdditive(checked)}/>} label="Select additive memory update"/>{additive&&<>
    {existing.error&&<Alert severity="error">{existing.error.message}</Alert>}
    <Typography variant="body2">Existing Agent memory stays unchanged; select additions below.</Typography>
    {pkg.chats.map(chat=>{const old=existing.data?.chats.find(c=>c.ref===chat.ref);return <Stack key={chat.ref}>{chat.agents.filter(a=>!old?.agents.some(n=>n.ref===a.ref)).map(agent=><FormControlLabel key={agent.ref} label={`Private memory: ${chat.title} · ${agent.definition.agents[0]!.title}`} control={<Checkbox disabled={!existing.data||review.isPending} checked={memorySelection.newAgents.some(a=>a.chatRef===chat.ref&&a.agentRef===agent.ref)} onChange={(_,checked)=>setMemorySelection({...memorySelection,newAgents:checked?[...memorySelection.newAgents,{chatRef:chat.ref,agentRef:agent.ref}]:memorySelection.newAgents.filter(a=>a.chatRef!==chat.ref||a.agentRef!==agent.ref),teamChats:memorySelection.teamChats.filter(ref=>ref!==chat.ref)})}/>}/>)}{old&&<FormControlLabel label={`Team memory: ${chat.title}`} control={<Checkbox disabled={review.isPending||!memorySelection.newAgents.some(a=>a.chatRef===chat.ref)} checked={memorySelection.teamChats.includes(chat.ref)} onChange={(_,checked)=>setMemorySelection({...memorySelection,teamChats:checked?[...memorySelection.teamChats,chat.ref]:memorySelection.teamChats.filter(ref=>ref!==chat.ref)})}/>}/>}</Stack>})}
   </>}</>}
   {pkg.mode==='full'&&<>
    {existing.error&&<Alert severity="error">Could not load retained Agent identities: {existing.error.message}</Alert>}
    <BranchImportFiles pkg={pkg} value={fileSelections} onChange={setFileSelections} retained={retained} inventory={rootInventory} disabled={review.isPending||Boolean(branchId&&existing.isFetching)}/>
    {fileError&&<Alert severity="info">{fileError}</Alert>}
   </>}
   {dirs.map(ref=><TextField key={ref} disabled={review.isPending} label={ref==='workspace'?'Default working directory':`Working directory: ${ref}`} value={bindings.directories[ref]??''} onChange={e=>setBindings({...bindings,directories:{...bindings.directories,[ref]:e.target.value}})}/>)}
   {engineRefs.map(ref=><TextField key={ref} disabled={review.isPending} select label={`Engine: ${ref}`} value={bindings.engines?.[ref]??''} onChange={e=>setBindings({...bindings,engines:{...bindings.engines,[ref]:e.target.value}})}><MenuItem value="">Choose Engine</MenuItem>{engines.map(e=><MenuItem key={e.id} value={e.id}>{e.id}</MenuItem>)}</TextField>)}
   {pkg.definition.steps.filter(s=>s.kind==='branch_call').map(s=><TextField select key={s.id} disabled={review.isPending} label={s.label??s.branchRef} value={bindings.branches?.[s.branchRef]??''} onChange={e=>setBindings({...bindings,branches:{...bindings.branches,[s.branchRef]:e.target.value}})}><MenuItem value="">Choose called Branch</MenuItem>{branches.map(b=><MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}</TextField>)}
  </>:<>{preview.outputRoleReview&&<Alert severity={preview.outputRoleReview.warning?'warning':'info'}>{preview.outputRoleReview.warning??'Imported output roles will be applied.'}</Alert>}{preview.operations.map((op,i)=>op.before!==undefined||op.after!==undefined?<Accordion key={i}><AccordionSummary>{op.resource} · {op.label}</AccordionSummary><AccordionDetails><Typography variant="subtitle2">Before</Typography><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(op.before,null,2)}</Typography><Typography variant="subtitle2">After</Typography><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(op.after,null,2)}</Typography></AccordionDetails></Accordion>:<Typography key={i}>{op.kind==='remove-after-active-executions-drain'?'Remove after active executions drain':op.kind==='preserve-and-update'?'Preserve and update':op.kind==='preserve-context'?'Preserve history':op.kind==='apply-settings'?'Apply settings':op.kind==='create'?'Create':'Replace'} · {op.resource} · {op.label}</Typography>)}{preview.operations.some(op=>op.kind==='remove-after-active-executions-drain')&&<Alert severity="warning">This update removes {preview.operations.filter(op=>op.kind==='remove-after-active-executions-drain'&&op.resource==='Chat').length} Chats and {preview.operations.filter(op=>op.kind==='remove-after-active-executions-drain'&&op.resource==='Agent').length} Agents from the active Branch. Their history will be deleted after existing executions drain.</Alert>}{preview.memoryUpdateReview&&<><Alert severity="warning">Add selected memory; preserve existing memory and permissions. {preview.memoryUpdateReview.excludedRows} unselected source rows stay excluded.</Alert><FormControlLabel control={<Checkbox checked={acknowledgeMemoryUpdate} onChange={(_,checked)=>setAcknowledgeMemoryUpdate(checked)}/>} label="I reviewed the selected incoming and existing destination memory."/></>}{preview.fullImportReview&&<><Alert severity="warning">{preview.fullImportReview.warning}</Alert>{preview.fullImportReview.agents.length?<Stack spacing={1}>{preview.fullImportReview.agents.map((agent,index)=><Accordion key={`${agent.chat}:${agent.agent}:${index}`}><AccordionSummary>{agent.chat} · {agent.agent} · full context</AccordionSummary><AccordionDetails><Stack spacing={1}><Typography>Opening instructions: {agent.initialInstructions.bytes.toLocaleString()} bytes{agent.initialInstructions.truncated?' (preview truncated)':''}</Typography>{agent.initialInstructions.preview&&<Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12,maxHeight:180,overflow:'auto'}}>{agent.initialInstructions.preview}</Typography>}<Typography>History: {agent.history.messages.toLocaleString()} messages · {agent.history.bytes.toLocaleString()} bytes · {agent.history.roles.user} user / {agent.history.roles.assistant} assistant / {agent.history.roles.system} system</Typography><Typography>Files: {agent.artifacts.count.toLocaleString()} · {agent.artifacts.bytes.toLocaleString()} bytes</Typography>{agent.artifacts.items.map((item,itemIndex)=><Typography key={`${item.name}:${itemIndex}`} variant="body2">{item.name} · {item.kind} · {item.mediaType} · {item.bytes.toLocaleString()} bytes</Typography>)}</Stack></AccordionDetails></Accordion>)}</Stack>:<Typography color="text.secondary">No new Agents receive imported context in this update.</Typography>}<FormControlLabel control={<Checkbox checked={acknowledgeFullImport} onChange={(_,checked)=>setAcknowledgeFullImport(checked)}/>} label="I reviewed the imported Agent context and files and want to continue with this full import."/></>}<Alert severity="warning"><Stack spacing={0.5}><Typography>Confirm · apply reviewed changes + declared management permissions</Typography><Typography>Removed Chats/Agents · deleted after execution drain</Typography><Typography>Preserved Agents · accumulated history retained</Typography></Stack></Alert></>}
 {workingRootReview&&<Stack spacing={1} role="group" aria-label="Confirm created live working folder">
  <Typography variant="h6">Confirm actual new working folder</Typography>
  <Typography>{pkg.chats.find(chat=>chat.ref===workingRootReview.chatRef)?.title??workingRootReview.chatRef} · {workingRootReview.sharedRoot}</Typography>
  <Typography>Confirm population of this new locally owned folder · recovery copies separate · source native ownership excluded</Typography>
  <FormControlLabel control={<Checkbox checked={rootAcknowledged===workingRootKey} disabled={resolveRoot.isPending||cancel.isPending} onChange={event=>setRootAcknowledged(event.target.checked?workingRootKey:'')}/>} label="Use this actual new managed working folder"/>
  <Button disabled={rootAcknowledged!==workingRootKey||resolveRoot.isPending||cancel.isPending||progress.isFetching} onClick={()=>{if(rootSubmitting.current)return;rootSubmitting.current=true;resolveRoot.mutate({id:operationId,review:workingRootReview});}}>Confirm working folder</Button>
 </Stack>}
 {progress.data?.state==='completed'&&settingsResult&&!settingsReviewed&&<Button variant="contained" disabled={Boolean(settingsError)} onClick={()=>setShowSettings(true)}>Review imported Settings and folders</Button>}
 {accessReview&&<Stack spacing={1} role="group" aria-label="Review imported Agent restrictions">
  <Typography variant="h6">Review capability restrictions</Typography>
  <Typography>Chat: {pkg.chats.find(chat=>chat.ref===accessReview.chatRef)?.title??accessReview.chatRef} · Agent: {accessReview.agentRef}</Typography>
  {accessReview.review.source.map(source=><Typography key={source.ref} variant="body2">Source {source.ref}: {source.settings?.restrictedCapabilityIds?.join(', ')||'No capability restrictions'}</Typography>)}
  <Typography variant="body2">Destination: {accessReview.review.destination.restrictedCapabilityIds.join(', ')||'No capability restrictions'}</Typography>
  {groupedAccess?requiredAccessRefs.map(ref=><TextField key={ref} select label={`Restrictions: ${pkg.chats.find(chat=>chat.ref===accessReview.chatRef)?.agents.find(agent=>agent.ref===ref)?.definition.agents[0]?.title??ref}`} value={agentActions[ref]??''} disabled={resolveAccess.isPending||cancel.isPending} onChange={event=>setAgentActions(current=>({...current,[ref]:event.target.value as 'keep_destination'|'use_source'}))}><MenuItem value="keep_destination">Keep destination restrictions</MenuItem><MenuItem value="use_source">Apply this Agent's source restrictions</MenuItem></TextField>):<TextField select label="Restrictions for the new Agent" value={accessAction} disabled={resolveAccess.isPending||cancel.isPending} onChange={event=>setAccessAction(event.target.value as typeof accessAction)}><MenuItem value="keep_destination">Keep destination restrictions</MenuItem><MenuItem value="use_source">Apply source restrictions</MenuItem></TextField>}
  <Typography variant="body2">Existing access retained · memory + saved browser: separate choices required</Typography>
  <Button disabled={!accessReady||resolveAccess.isPending||cancel.isPending||progress.isFetching} onClick={()=>{if(accessSubmitting.current||!accessReady)return;accessSubmitting.current=true;resolveAccess.mutate({operationId,review:accessReview,action:groupedAccess?'keep_destination':accessAction as 'keep_destination'|'use_source',...(groupedAccess?{agentActions:Object.fromEntries(requiredAccessRefs.map(ref=>[ref,agentActions[ref]!]))}:{})});}}>Confirm restrictions</Button>
 </Stack>}
 {operationId&&progress.data?.state==='applying'&&progress.data.error&&preview?.outputRoleReview&&<><Button onClick={async()=>{try{setRoleRecovery(await requestJson(`/api/branches/installations/${operationId}/role-review`,{method:'POST'}));}catch(cause){setFinishError((cause as Error).message);}}}>Review output roles again</Button>{roleRecovery&&<><Alert severity="warning">{roleRecovery.warning??'Apply the reviewed output roles.'}</Alert><Button onClick={()=>apply.mutate()}>Confirm output roles</Button></>}</>}
 </Stack></DialogContent><DialogActions>{operationId&&!terminal&&!progress.error?<Button color="error" disabled={cancel.isPending||progress.data?.state==='preview'} onClick={()=>cancel.mutate()}>Stop update</Button>:null}{operationId&&!terminal&&!progress.error?<Button onClick={dismiss}>Continue in background</Button>:null}{operationId&&progress.error?<Button onClick={()=>void progress.refetch()}>Retry status</Button>:null}{operationId&&finishError&&progress.data?.state==='completed'?<Button onClick={()=>void handleStatus(progress.data!,generation.current)}>Retry opening workflow</Button>:null}{(terminal||progress.error)&&<Button onClick={dismiss}>Close</Button>}{terminal&&<Button onClick={reviewAgain}>Review again</Button>}{!operationId&&<Button ref={cancelButton} disabled={apply.isPending} onClick={()=>preview?setPreview(undefined):dismiss()}>{preview?'Back':'Cancel'}</Button>}{!operationId&&(!preview?<Button disabled={review.isPending||Boolean(fileError)||Boolean(branchId&&pkg.mode==='full'&&(!existing.data||existing.isError||existing.isFetching))||Boolean(additive&&!existing.data)} onClick={()=>{review.mutate();cancelButton.current?.focus()}}>Review changes</Button>:<Button variant="contained" disabled={apply.isPending||Boolean(preview.fullImportReview&&!acknowledgeFullImport)||Boolean(preview.memoryUpdateReview&&!acknowledgeMemoryUpdate)} onClick={()=>apply.mutate()}>Confirm {branchId?'update':'import'}</Button>)}</DialogActions></Dialog>;
}
