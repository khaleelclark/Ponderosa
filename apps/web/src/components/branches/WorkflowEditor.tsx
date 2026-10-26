import {useBranchDraftGuard} from './BranchNavigation';
import type {AgentSetupRequest} from './AgentStepFields';
import {TriggerSourceFields,useTriggerSourceDraft} from '../TriggerSourceFields';
import {ParameterDefinitions} from './ParameterDefinitions';
import {lazy,Suspense,type ReactNode} from 'react';
const WorkflowAgentSetup=lazy(()=>import('./WorkflowAgentSetup').then(module=>({default:module.WorkflowAgentSetup})));

import { requestJson } from "../../api/real";
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Accordion,AccordionDetails,AccordionSummary,Alert,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,Drawer,FormControlLabel,IconButton,Menu,MenuItem,Stack,Switch,TextField,Tooltip,Typography} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import type {AgentDto,BranchBindings,BranchDefinition,ConversationDto,EngineDto,TriggerSourceConfig} from '@ponderosa/core';
import type {CanvasViewState,WorkflowUndoRedo} from './WorkflowCanvas';
const WorkflowCanvas=lazy(()=>import('./WorkflowCanvas').then(module=>({default:module.WorkflowCanvas})));
import {guidedInsertionRestriction,insertGuidedStep,type GuidedInsertionTarget,type GuidedStepKind} from './guided-operations';
import {removeWorkflowNode} from './model';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import {Unstable_TrapFocus as FocusTrap} from '@mui/material';
import {advancedSettingsNeedAttention,FailureEditor,NodeEditor} from './NodeEditor';
import {changeAgentTarget} from './model';
function BranchTriggerSource({kind,config,onChange,onInvalid}:{kind:'schedule'|'webhook'|'filesystem';config:TriggerSourceConfig;onChange(config:TriggerSourceConfig):void;onInvalid(invalid:boolean):void}):JSX.Element {
 const draft=useTriggerSourceDraft(config),callbacks=useRef({onChange,onInvalid,config});callbacks.current={onChange,onInvalid,config};
 const configKey=JSON.stringify(config),adopted=useRef(configKey),loading=useRef(false);
 useEffect(()=>{if(adopted.current===configKey)return;adopted.current=configKey;loading.current=true;draft.load(config)},[configKey]);
 const values=JSON.stringify([kind,draft.scheduleKind,draft.onceAt,draft.intervalValue,draft.intervalUnit,draft.cronExpression,draft.timezone,draft.include,draft.exclude,draft.quietSeconds,draft.maxWindowSeconds]);
 // Local echoes keep the authored fields; Undo/Redo loads the existing draft hook.
 // Skip the old render's write while that external configuration is loading.
 useEffect(()=>{if(loading.current){loading.current=false;return;}try{if(kind==='filesystem'&&(draft.filesystemErrors.quiet||draft.filesystemErrors.max)||kind==='schedule'&&draft.scheduleKind==='interval'&&draft.intervalInvalid)throw new Error('Invalid trigger source');const next=draft.configuration(kind,callbacks.current.config);callbacks.current.onInvalid(false);const nextKey=JSON.stringify(next);if(nextKey!==configKey){adopted.current=nextKey;callbacks.current.onChange(next)}}catch{callbacks.current.onInvalid(true)}},[values,configKey]);
 useEffect(()=>()=>callbacks.current.onInvalid(false),[]);
 return <TriggerSourceFields sourceKind={kind} draft={draft}/>;
}
export function WorkflowEditor({definition,bindings,contexts,agents,engines,onDefinition,onBindings,onPendingEdits,branchId,chatId,validationIssues=[],availability,intake,triggerDirty=false,jsonOpen=false,onCloseJson,validationRequest=0,active=true,onInvalidStep,onSettingsIssue,onDraft,undoRedo,canvasViews,saveControl}:{saveControl:ReactNode;onDraft(value:{definition?:BranchDefinition;bindings?:BranchBindings}):void;undoRedo:WorkflowUndoRedo;canvasViews:Map<string,CanvasViewState>;branchId:string;validationIssues?:import("@ponderosa/core").BranchValidationIssue[];active?:boolean;onInvalidStep?():void;onSettingsIssue?():void;intake?:ReactNode;triggerDirty?:boolean;jsonOpen?:boolean;onCloseJson?():void;validationRequest?:number;availability?:ReactNode;onPendingEdits?(pending:boolean):void;definition:BranchDefinition;bindings:BranchBindings;chatId:string;contexts:ConversationDto[];agents:AgentDto[];engines:EngineDto[];existing:boolean;onDefinition(value:BranchDefinition):void;onBindings(value:BranchBindings):void;onChat(id:string):void}):JSX.Element{
 const retainedTemplates=useRef<NonNullable<BranchDefinition['templates']>>({});retainedTemplates.current={...retainedTemplates.current,...definition.templates,...Object.fromEntries(definition.steps.flatMap(step=>{const template=step.kind==='agent'&&'templateRef'in step.target?definition.templates?.[step.target.templateRef]:undefined;return template?[[step.id+'_'+template.kind+'_template',template]]:[]}))};
 const [setup,setSetup]=useState<AgentSetupRequest>(),[setupPending,setSetupPending]=useState(false),[setupNotice,setSetupNotice]=useState(''),[issueFocus,setIssueFocus]=useState(0),[chosenIssue,setChosenIssue]=useState<import('@ponderosa/core').BranchValidationIssue>();
 useBranchDraftGuard('workflow-agent-setup',setupPending);
 const owner=useRef({branchId,definition,bindings,onDefinition,onBindings,onDraft,active});owner.current={branchId,definition,bindings,onDefinition,onBindings,onDraft,active};
 const mounted=useRef(true);useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
 const finishSetup=(agent:AgentDto)=>{
  const current=owner.current;
  if(!mounted.current||!setup||current.branchId!==branchId)return;
  const node=current.definition.steps.find(step=>step.id===setup.nodeId);
  if(node?.kind==='agent'&&JSON.stringify(node.target)===JSON.stringify(setup.target)){
   current.onDraft({definition:changeAgentTarget(current.definition,node,{kind:setup.kind==='organization'?'persistent_organization':'persistent_agent',ref:node.id}),bindings:{...current.bindings,agents:{...current.bindings.agents,[node.id]:agent.id}}});
  }else setSetupNotice('The Agent Was Created. The Step Changed, So Choose It From The Agent Picker When Ready.');
  setSetup(undefined);setSetupPending(false);
 };
 const applyRequest=useRef(0),currentDefinition=useRef(definition);currentDefinition.current=definition;
 const [triggerInvalid,setTriggerInvalid]=useState(false),[triggerOpen,setTriggerOpen]=useState(false);
 const [selected,setSelected]=useState<string|undefined>(()=>canvasViews.get(branchId)?.selected),[editorOpen,setEditorOpen]=useState(false),[focusRequest,setFocusRequest]=useState(0),[addAnchor,setAddAnchor]=useState<HTMLElement|null>(null),[branching,setBranching]=useState(false),[advanced,setAdvanced]=useState<string>(),[jsonError,setJsonError]=useState('');
 // ponytail: side-by-side settings need 760px of workspace; lower this cutoff only with a denser shared editor.
 const addButton=useRef<HTMLButtonElement>(null),canvas=useRef<HTMLDivElement>(null),[wide,setWide]=useState(false);
 useLayoutEffect(()=>{const element=canvas.current;if(!element)return;const observer=new ResizeObserver(([entry])=>{if(entry&&entry.contentRect.width>0)setWide(entry.contentRect.width>=760)});observer.observe(element);return()=>observer.disconnect()},[]);
 useEffect(()=>{if(!validationIssues.length){setChosenIssue(undefined);return;}if(validationIssues.length){setChosenIssue(validationIssues[0]);if(validationIssues[0]?.nodeId){setSelected(validationIssues[0].nodeId);setEditorOpen(true);onInvalidStep?.()}}},[validationIssues]);
 const selectedNode=[...definition.steps,...definition.controls].find(node=>node.id===selected);
 const [insertionTarget,setInsertionTarget]=useState<GuidedInsertionTarget>({kind:'entry'}),[insertError,setInsertError]=useState(''),[sheetExpanded,setSheetExpanded]=useState(false),[sheetHeight,setSheetHeight]=useState(0);
 const sheet=useRef<HTMLDivElement>(null),sheetOpen=active&&!jsonOpen&&editorOpen&&!wide&&Boolean(selectedNode);
 useLayoutEffect(()=>{const element=sheet.current;if(!element||!sheetOpen){setSheetHeight(0);return;}const observer=new ResizeObserver(([entry])=>{if(entry)setSheetHeight(entry.borderBoxSize?.[0]?.blockSize??entry.contentRect.height)});observer.observe(element);return()=>observer.disconnect()},[sheetOpen]);
 const openAdd=(target:GuidedInsertionTarget,anchor:HTMLElement)=>{setInsertionTarget(target);setBranching(false);setAddAnchor(anchor);setInsertError('')};
 const add=(kind:GuidedStepKind)=>{if(!addAnchor)return;const result=insertGuidedStep(definition,kind,insertionTarget);if(!result.ok){setInsertError(result.reason);return;}onDraft({definition:result.definition});setSelected(result.selected);setEditorOpen(true);setFocusRequest(value=>value+1);setAddAnchor(null)};
 const removeSelected=(id:string)=>{const result=removeWorkflowNode(definition,id);if(!result.ok){setInsertError(result.reason);return;}onDefinition(result.definition);setSelected(result.nextSelected);setFocusRequest(value=>value+1)};
 const restricted=guidedInsertionRestriction(definition,insertionTarget);
 useEffect(()=>{if(!validationRequest||validationIssues.some(issue=>issue.nodeId))return;const missing=definition.steps.find(step=>advancedSettingsNeedAttention(step,bindings)||step.kind==='script'&&(!step.source.trim()||!bindings.directories[step.cwdRef]?.trim())||step.kind==='agent'&&'ref'in step.target&&!bindings.agents[step.target.ref]||step.kind==='human_gate'&&!step.prompt.trim()||step.kind==='branch_call'&&!bindings.branches?.[step.branchRef]);if(missing){setSelected(missing.id);setEditorOpen(true);onInvalidStep?.()}else if(!definition.steps.length){onInvalidStep?.();addButton.current?.focus()}},[validationRequest]);
 useEffect(()=>{onPendingEdits?.(setupPending||triggerInvalid||(advanced!==undefined&&advanced!==JSON.stringify(definition,null,2)))},[advanced,definition,onPendingEdits,triggerInvalid,setupPending]);
 useEffect(()=>()=>onPendingEdits?.(false),[onPendingEdits]);
 useEffect(()=>{if(!active){setAddAnchor(null);setTriggerOpen(false)}},[active]);
 const closeEditor=()=>{setEditorOpen(false);setFocusRequest(value=>value+1)};
 const source=definition.trigger.kind==='manual'?undefined:bindings.triggers?.[definition.trigger.configRef];
 const sourceConfig=source?.sourceConfig;
 const setSource=(sourceConfig:TriggerSourceConfig)=>{if(definition.trigger.kind!=='manual')onBindings({...bindings,triggers:{...bindings.triggers,[definition.trigger.configRef]:{enabled:source?.enabled??true,sourceConfig}}})};
 const setTrigger=(kind:BranchDefinition['trigger']['kind'])=>{
  const next={...bindings};
  if(kind==='manual')delete next.triggers;
  else next.triggers={source:{enabled:true,sourceConfig:kind==='schedule'?{scheduleKind:'interval',everyMs:3600000,startsAt:new Date(Date.now()+60000).toISOString()}:kind==='webhook'?{replayWindowSeconds:300}:{include:['**/*'],exclude:[],quietMs:1000,maxWindowMs:10000}}};
  onDraft({definition:{...definition,trigger:kind==='manual'?{kind}:{kind,configRef:'source'}},bindings:next});
 };
 return <Stack ref={canvas} sx={{minWidth:0,minHeight:0,height:'100%',width:'100%'}}>
  {setupNotice&&<Alert severity="info" onClose={()=>setSetupNotice('')}>{setupNotice}</Alert>}
  {setup&&<Suspense fallback={<Typography role="status">Loading Agent Setup…</Typography>}><WorkflowAgentSetup key={`${branchId}:${setup.nodeId}:${setup.kind}`} branchId={branchId} chatId={setup.chatId??chatId??''} request={setup} engines={engines} onComplete={finishSetup} onClose={()=>{setSetup(undefined);setSetupPending(false)}} onPendingChange={setSetupPending}/></Suspense>}
  {validationIssues.length>0&&<Stack component="section" aria-label="Publication Issues" spacing={.5} sx={{maxHeight:'40%',flexShrink:0,overflowY:'auto'}}><Typography fontWeight={600}>Publication Issues</Typography>{validationIssues.map((issue,index)=><Button key={index} sx={{justifyContent:'flex-start',textAlign:'left'}} onClick={()=>{if(issue.nodeId){setChosenIssue(issue);setIssueFocus(value=>value+1);setSelected(issue.nodeId);setEditorOpen(true);onInvalidStep?.()}else if(issue.section==='settings')onSettingsIssue?.();else addButton.current?.focus()}}>{issue.message}</Button>)}</Stack>}
  <Dialog open={triggerOpen} keepMounted onClose={()=>setTriggerOpen(false)} fullWidth maxWidth="sm"><DialogTitle>Workflow Setup</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
  <Stack component="section" aria-label="How It Starts" spacing={1.5}>
   <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap"><Typography fontWeight={600} sx={{flex:1}}>How It Starts</Typography>{triggerDirty&&<Typography variant="caption" color="warning.main">Unpublished Changes</Typography>}{availability}</Stack>
   <TextField select label="Starts" size="small" value={definition.trigger.kind} onChange={e=>setTrigger(e.target.value as BranchDefinition['trigger']['kind'])}><MenuItem value="manual">Manually</MenuItem><MenuItem value="schedule">On A Schedule</MenuItem><MenuItem value="webhook">When A Webhook Arrives</MenuItem><MenuItem value="filesystem">When Files Change</MenuItem></TextField>
   {definition.trigger.kind!=='manual'&&sourceConfig&&<BranchTriggerSource key={definition.trigger.kind} kind={definition.trigger.kind} config={sourceConfig} onChange={setSource} onInvalid={setTriggerInvalid}/>}
   {triggerInvalid&&<Alert severity="error">Correct the trigger fields before reviewing publication.</Alert>}
   {source&&definition.trigger.kind!=='manual'&&<FormControlLabel control={<Switch checked={source.enabled} onChange={(_,enabled)=>{if(definition.trigger.kind!=='manual')onBindings({...bindings,triggers:{...bindings.triggers,[definition.trigger.configRef]:{...source,enabled}}})}}/>} label="Automatic Intake After Publication"/>}
   {intake}
  </Stack>
   <Accordion disableGutters><AccordionSummary expandIcon={<ExpandMoreIcon/>}>Workflow Variables</AccordionSummary><AccordionDetails><ParameterDefinitions definition={definition} onChange={onDefinition}/></AccordionDetails></Accordion>
  </Stack></DialogContent><DialogActions><Button onClick={()=>setTriggerOpen(false)}>Close</Button></DialogActions></Dialog>
  {insertError&&<Alert severity="error" onClose={()=>setInsertError('')}>{insertError}</Alert>}
  <Menu transitionDuration={0} anchorEl={addAnchor} open={Boolean(addAnchor)} onClose={()=>setAddAnchor(null)}>
   {branching&&<MenuItem onClick={()=>setBranching(false)}>← All Steps</MenuItem>}
   <Box sx={{px:2,py:1,maxWidth:280}}><Typography variant="caption" color="text.secondary">{restricted??(insertionTarget.kind==='entry'?(definition.entry?'Before The First Step':'First Step'):insertionTarget.kind==='edge'?'On This Connection':'Before End This Path')}</Typography></Box>
   {(branching?[['condition','Condition'],['route','Named Routes'],['parallel','Parallel Paths'],['for_each','For Each']]:[['agent','Agent Task'],['human_gate','Approval'],['action','Notification'],['branch_call','Run Another Workflow'],['script','Script']]).map(([kind,label])=><MenuItem key={kind} disabled={Boolean(restricted)} onClick={()=>add(kind as GuidedStepKind)}>{label}</MenuItem>)}
   {!branching&&<MenuItem onClick={()=>setBranching(true)}>Branching…</MenuItem>}
  </Menu>
  <Box sx={{display:'grid',gridTemplateColumns:editorOpen&&selectedNode&&wide?'minmax(0,1fr) minmax(320px,380px)':'minmax(0,1fr)',flex:1,minHeight:0,alignItems:'stretch',minWidth:0}}><Suspense fallback={<Typography role="status">Loading Workflow Canvas…</Typography>}><WorkflowCanvas saveControl={saveControl} settingsDocked={Boolean(wide&&editorOpen&&selectedNode)} startControl={<Tooltip describeChild title="Trigger settings, Branch availability and workflow variables"><Button color={triggerInvalid?'error':'inherit'} variant="outlined" startIcon={<PlayArrowOutlinedIcon/>} endIcon={<ExpandMoreIcon/>} onClick={()=>setTriggerOpen(true)} sx={{minHeight:44,maxWidth:'100%',bgcolor:'background.paper',borderRadius:3,whiteSpace:'normal',textAlign:'left','& .MuiButton-startIcon, & .MuiButton-endIcon':{flexShrink:0}}}>{({manual:'Start Manually',schedule:'Start On Schedule',webhook:'Start From Webhook',filesystem:'Start On File Change'})[definition.trigger.kind]}{triggerDirty?' · Edited':''}</Button></Tooltip>} entryButtonRef={addButton} branchId={branchId} canvasViews={canvasViews} undoRedo={undoRedo} active={active} bottomSheetHeight={sheetHeight} revealRequest={validationRequest+issueFocus} bindings={bindings} agents={agents} issues={validationIssues} definition={definition} selected={selected} onSelect={id=>{setSelected(id);setEditorOpen(true)}} onInsert={openAdd} onDelete={removeSelected} focusRequest={editorOpen&&!wide?0:focusRequest}/></Suspense>{wide&&editorOpen&&selectedNode&&<Box sx={{minHeight:0,borderLeft:'1px solid',borderColor:'divider',overflow:'hidden'}}><NodeEditor docked key={selectedNode.id} onDraft={onDraft} headerActions={!wide?<Tooltip title={sheetExpanded?'Collapse Settings':'Expand Settings'}><IconButton aria-label={sheetExpanded?'Collapse Settings':'Expand Settings'} onClick={()=>setSheetExpanded(value=>!value)}>{sheetExpanded?<CloseFullscreenIcon/>:<OpenInFullIcon/>}</IconButton></Tooltip>:undefined} onClose={closeEditor} validationRequest={active?validationRequest+issueFocus:0} retainedTemplates={retainedTemplates.current} branchId={branchId} onSetup={setSetup} validationIssue={chosenIssue?.nodeId===selectedNode.id?chosenIssue:validationIssues.find(issue=>issue.nodeId===selectedNode.id)} definition={definition} nodeId={selectedNode.id} onChange={onDefinition} onRemove={next=>{setSelected(next);setFocusRequest(value=>value+1)}} bindings={bindings} onBindings={onBindings} contexts={contexts} agents={agents} engines={engines}/></Box>}</Box>
  <Drawer variant="persistent" anchor="bottom" open={sheetOpen} slotProps={{paper:{ref:sheet,sx:{height:sheetExpanded?'var(--ponderosa-app-viewport-block-size, 100dvh)':'min(52dvh, calc(var(--ponderosa-app-viewport-block-size, 100dvh) / 2))',maxHeight:'var(--ponderosa-app-viewport-block-size, 100dvh)',borderRadius:sheetExpanded?0:'16px 16px 0 0',overflowY:'auto',pb:'env(safe-area-inset-bottom, 0px)'}}}}>{!wide&&editorOpen&&selectedNode&&<FocusTrap open={sheetOpen&&sheetExpanded} disableRestoreFocus disableEnforceFocus><Box tabIndex={-1} role={sheetExpanded?'dialog':undefined} aria-label="Step Settings" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();closeEditor()}}}><NodeEditor key={selectedNode.id} onDraft={onDraft} headerActions={!wide?<Tooltip title={sheetExpanded?'Collapse Settings':'Expand Settings'}><IconButton aria-label={sheetExpanded?'Collapse Settings':'Expand Settings'} onClick={()=>setSheetExpanded(value=>!value)}>{sheetExpanded?<CloseFullscreenIcon/>:<OpenInFullIcon/>}</IconButton></Tooltip>:undefined} onClose={closeEditor} validationRequest={active?validationRequest+issueFocus:0} retainedTemplates={retainedTemplates.current} branchId={branchId} onSetup={setSetup} validationIssue={chosenIssue?.nodeId===selectedNode.id?chosenIssue:validationIssues.find(issue=>issue.nodeId===selectedNode.id)} definition={definition} nodeId={selectedNode.id} onChange={onDefinition} onRemove={next=>{setSelected(next);setFocusRequest(value=>value+1)}} bindings={bindings} onBindings={onBindings} contexts={contexts} agents={agents} engines={engines}/></Box></FocusTrap>}</Drawer>
  <Dialog open={jsonOpen} onClose={onCloseJson} fullWidth maxWidth="md"><DialogTitle>Edit Workflow JSON</DialogTitle><DialogContent><Stack spacing={1} sx={{pt:1}}>{jsonError&&<Alert severity="error">{jsonError}</Alert>}<TextField label="Definition JSON" multiline minRows={10} maxRows={24} value={advanced??JSON.stringify(definition,null,2)} onChange={e=>{applyRequest.current++;setAdvanced(e.target.value)}} slotProps={{input:{sx:{fontFamily:'monospace',fontSize:12}}}}/><Button onClick={async()=>{const requestId=++applyRequest.current,startedDefinition=definition;try{const parsed=await requestJson<{definition:BranchDefinition}>('/api/branches/import-preview',{method:'POST',body:JSON.stringify({schema:'ponderosa.branch-package.v1',exportedAt:new Date().toISOString(),definition:JSON.parse(advanced??JSON.stringify(definition))})});if(requestId!==applyRequest.current)return;if(startedDefinition!==currentDefinition.current){setJsonError('The workflow changed while validating. Your JSON is retained; review it before applying again.');return;}onDefinition(parsed.definition);setAdvanced(undefined);setJsonError('')}catch(error){setJsonError(error instanceof Error?error.message:'Invalid JSON')}}}>Apply Definition</Button><Button onClick={()=>{applyRequest.current++;setAdvanced(undefined);setJsonError('')}}>Discard Advanced Edits</Button></Stack></DialogContent><DialogActions><Button onClick={onCloseJson}>Close</Button></DialogActions></Dialog>
 </Stack>;
}

/** Definition policy edits use the same draft owner as the canvas. */
export function WorkflowExecutionSettings({definition,onDefinition,bindings,onBindings,agents,contexts}:Pick<Parameters<typeof WorkflowEditor>[0],'definition'|'onDefinition'|'bindings'|'onBindings'|'agents'|'contexts'>):JSX.Element {
 return <Stack component="section" aria-label="Execution Settings" spacing={2}><Typography variant="h6">Execution Settings</Typography>
  {([['maxConcurrentExecutions','Concurrent Executions',2],['maxEphemeralAgents','Temporary Agents Per Execution',100],['maxPathInstances','Maximum Paths',1000],['maxStepInvocations','Maximum Step Invocations',1000]] as const).map(([field,label,fallback])=><TextField key={field} label={label} type="number" size="small" inputProps={{min:1,max:field==='maxConcurrentExecutions'?1000:100000,step:1}} error={!Number.isSafeInteger(definition.policy[field]??fallback)||(definition.policy[field]??fallback)<1||(definition.policy[field]??fallback)>(field==='maxConcurrentExecutions'?1000:100000)} value={definition.policy[field]??fallback} onChange={e=>onDefinition({...definition,policy:{...definition.policy,[field]:Number(e.target.value)}})}/>)}
  <FailureEditor value={definition.policy.failure} onChange={failure=>onDefinition({...definition,policy:{...definition.policy,failure:failure??{action:'stop'}}})} bindings={bindings} onBindings={onBindings} agents={agents} contexts={contexts}/>
 </Stack>;
}
