import {createPortal} from 'react-dom';
import {WorkflowOutline} from './WorkflowOutline';
import {WorkflowCanvasFooter} from './WorkflowCanvasFooter';
import {WorkflowInspectorPage} from './WorkflowInspectorPage';
import {workflowTriggerSummary} from './trigger-summary';
import {useBranchDraftGuard} from './BranchNavigation';
import type {AgentSetupRequest} from './AgentStepFields';
import {TriggerSourceFields,useTriggerSourceDraft} from '../TriggerSourceFields';
import {ParameterDefinitions} from './ParameterDefinitions';
import {lazy,Suspense,type ReactNode} from 'react';
const WorkflowAgentSetup=lazy(()=>import('./WorkflowAgentSetup').then(module=>({default:module.WorkflowAgentSetup})));

import { requestJson } from "../../api/real";
import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Alert,Box,Button,FormControl,FormControlLabel,FormLabel,IconButton,Menu,MenuItem,Radio,RadioGroup,Stack,Switch,TextField,ToggleButton,ToggleButtonGroup,Tooltip,Typography} from '@mui/material';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import type {AgentDto,BranchBindings,BranchDefinition,ConversationDto,EngineDto,TriggerSourceConfig} from '@ponderosa/core';
import type {CanvasNavigation,CanvasPhase,CanvasViewState,WorkflowUndoRedo} from './WorkflowCanvas';
const WorkflowCanvas=lazy(()=>import('./WorkflowCanvas').then(module=>({default:module.WorkflowCanvas})));
import {guidedInsertionRestriction,insertGuidedStep,type GuidedInsertionTarget,type GuidedStepKind} from './guided-operations';
import {removeWorkflowNode} from './model';
import {advancedSettingsNeedAttention,FailureEditor,NodeEditor} from './NodeEditor';
import {changeAgentTarget} from './model';
function workflowInsertionAnchor(control:HTMLElement,returnTo?:HTMLElement){
 const rectangle=control.getBoundingClientRect(),document=control.ownerDocument,identity=control.dataset.workflowInsertion;
 // React Flow may replace a toolbar during measurement. MUI keeps this clicked
 // client rectangle and applies its normal viewport-edge positioning to it.
 return {nodeType:1 as const,ownerDocument:document,getBoundingClientRect:()=>rectangle,restoreFocus(){
  const replacement=identity?Array.from(document.querySelectorAll<HTMLElement>('[data-workflow-insertion]')).find(element=>element.dataset.workflowInsertion===identity&&element.isConnected&&element.getBoundingClientRect().width>0):undefined;
  const target=[control,replacement,returnTo].find(element=>element?.isConnected&&element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0);
  target?.focus({preventScroll:true});
 }};
}
function BranchTriggerSource({kind,config,onChange,onInvalid}:{kind:'schedule'|'webhook'|'filesystem';config:TriggerSourceConfig;onChange(config:TriggerSourceConfig):void;onInvalid(invalid:boolean):void}):JSX.Element {
 const draft=useTriggerSourceDraft(config),callbacks=useRef({onChange,onInvalid,config});callbacks.current={onChange,onInvalid,config};
 const configKey=JSON.stringify(config),adopted=useRef(configKey),loading=useRef(false);
 useEffect(()=>{if(adopted.current===configKey)return;adopted.current=configKey;loading.current=true;draft.load(config)},[configKey]);
 const values=JSON.stringify([kind,draft.scheduleKind,draft.whenRunning,draft.onceAt,draft.intervalValue,draft.intervalUnit,draft.cronExpression,draft.timezone,draft.include,draft.exclude,draft.quietSeconds,draft.maxWindowSeconds]);
 // Local echoes keep the authored fields; Undo/Redo loads the existing draft hook.
 // Skip the old render's write while that external configuration is loading.
 useEffect(()=>{if(loading.current){loading.current=false;return;}try{if(kind==='filesystem'&&(draft.filesystemErrors.quiet||draft.filesystemErrors.max)||kind==='schedule'&&(draft.scheduleKind==='interval'&&draft.intervalInvalid||draft.scheduleKind==='cron'&&(draft.cronFormatError||draft.timezoneError)))throw new Error('Invalid trigger source');const next=draft.configuration(kind,callbacks.current.config);callbacks.current.onInvalid(false);const nextKey=JSON.stringify(next);if(nextKey!==configKey){adopted.current=nextKey;callbacks.current.onChange(next)}}catch{callbacks.current.onInvalid(true)}},[values,configKey]);
 useEffect(()=>()=>callbacks.current.onInvalid(false),[]);
 return <TriggerSourceFields sourceKind={kind} draft={draft}/>;
}
export function WorkflowEditor({definition,bindings,contexts,agents,engines,onDefinition,onBindings,onPendingEdits,branchId,chatId,validationIssues=[],intake,triggerDirty=false,inspectorTarget,inspectorPane,onInspectorPane,inspectorActive,validationRequest=0,firstStepRequest=0,onProviderSetup,active=true,onInvalidStep,onSettingsIssue,onDraft,undoRedo,canvasViews,saveControl}:{editing?:boolean;saveControl:ReactNode;onDraft(value:{definition?:BranchDefinition;bindings?:BranchBindings}):void;undoRedo:WorkflowUndoRedo;canvasViews:Map<string,CanvasViewState>;branchId:string;validationIssues?:import("@ponderosa/core").BranchValidationIssue[];active?:boolean;firstStepRequest?:number;onProviderSetup?():void;onInvalidStep?():void;onSettingsIssue?(field?:string):void;intake?:ReactNode;triggerDirty?:boolean;inspectorTarget:HTMLElement|null;inspectorPane?:'trigger'|'step'|'json'|'variables';onInspectorPane(pane?:'trigger'|'step'|'json'|'variables'):void;inspectorActive:boolean;validationRequest?:number;onPendingEdits?(pending:boolean):void;definition:BranchDefinition;bindings:BranchBindings;chatId:string;contexts:ConversationDto[];agents:AgentDto[];engines:EngineDto[];existing:boolean;onDefinition(value:BranchDefinition):void;onBindings(value:BranchBindings):void;onChat(id:string):void}):JSX.Element{
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
  setSetup(undefined);setSetupPending(false);restoreSetupFocus();
 };
 const applyRequest=useRef(0),currentDefinition=useRef(definition);currentDefinition.current=definition;
 const [triggerInvalid,setTriggerInvalid]=useState(false),[retainTrigger,setRetainTrigger]=useState(false);
 const startsLabel=useId();
 const [selected,setSelected]=useState<string|undefined>(()=>canvasViews.get(branchId)?.selected),[expanded,setExpanded]=useState(false),[editorReveal,setEditorReveal]=useState(0),[focusRequest,setFocusRequest]=useState(0),[addAnchor,setAddAnchor]=useState<ReturnType<typeof workflowInsertionAnchor>|null>(null),[branching,setBranching]=useState(false),[advanced,setAdvanced]=useState<string>(),[jsonError,setJsonError]=useState('');
 const [view,setView]=useState(()=>canvasViews.get(branchId)?.view??'canvas');
 const canvasRegion=useRef<HTMLDivElement>(null),canvasNavigation=useRef<CanvasNavigation>(null);
 const [canvasPhase,setCanvasPhase]=useState<CanvasPhase>('loading');
 const [canvasOpened,setCanvasOpened]=useState(view==='canvas'),[outlineOpened,setOutlineOpened]=useState(view==='outline');
 const outlineScroll=useRef(canvasViews.get(branchId)?.outlineScroll??0),outlineTrigger=useRef<HTMLButtonElement>(null),outlineEntry=useRef<HTMLButtonElement>(null);
 const [insertionLabel,setInsertionLabel]=useState<string>();
 useLayoutEffect(()=>{
  const previous=canvasViews.get(branchId);
  canvasViews.delete(branchId);
  canvasViews.set(branchId,{...previous,view,selected});
  while(canvasViews.size>100)canvasViews.delete(canvasViews.keys().next().value!);
 },[branchId,canvasViews,selected,view]);
 useLayoutEffect(()=>()=>{const saved=canvasViews.get(branchId);if(saved)saved.outlineScroll=outlineScroll.current},[branchId,canvasViews]);
 const dismissedInsertion=useRef<ReturnType<typeof workflowInsertionAnchor>|null>(null);
 const addButton=useRef<HTMLButtonElement>(null),triggerButton=useRef<HTMLButtonElement>(null),canvas=useRef<HTMLDivElement>(null);
 const expandedPane=useRef<typeof inspectorPane>(),stepPanel=useRef<HTMLDivElement>(null),stepScroll=useRef(0);
 const variablesButton=useRef<HTMLButtonElement>(null),setupButton=useRef<HTMLElement>(),variablesFromTrigger=useRef(false);
 const restoreSetupFocus=()=>requestAnimationFrame(()=>setupButton.current?.focus({preventScroll:true}));
 useEffect(()=>{if(inspectorPane==='trigger')setRetainTrigger(true);if(inspectorPane!=='variables')variablesFromTrigger.current=false},[inspectorPane]);
 useEffect(()=>{if(!validationIssues.length){setChosenIssue(undefined);return;}setChosenIssue(validationIssues[0]);if(validationIssues[0]?.nodeId){openEditor(validationIssues[0].nodeId);onInvalidStep?.()}},[validationIssues]);
 const selectedNode=[...definition.steps,...definition.controls].find(node=>node.id===selected);
 const [insertionTarget,setInsertionTarget]=useState<GuidedInsertionTarget>({kind:'entry'}),[insertError,setInsertError]=useState('');
 const editorVisible=active&&inspectorActive&&inspectorPane==='step'&&!setup&&Boolean(selectedNode);
 const editorAuthority=useRef({visible:editorVisible,branchId,nodeId:selectedNode?.id});editorAuthority.current={visible:editorVisible,branchId,nodeId:selectedNode?.id};
 const openEditor=(id:string)=>{if(setupPending)return;if(setup&&id!==selected)setSetup(undefined);setSelected(id);onInspectorPane('step');setExpanded(false);setEditorReveal(value=>value+1)};
 const toggleExpanded=()=>{
  const next=!expanded;setExpanded(next);
  if(next){
   expandedPane.current=inspectorPane;
   stepScroll.current=stepPanel.current?.querySelector('[data-inspector-scroll]')?.scrollTop??0;
   onInspectorPane();
  }else if(expandedPane.current)onInspectorPane(expandedPane.current);
  requestAnimationFrame(()=>{
   if(!mounted.current||owner.current.branchId!==branchId)return;
   if(!next&&expandedPane.current){
    if(expandedPane.current==='step'){
     const scroll=stepPanel.current?.querySelector('[data-inspector-scroll]');
     if(scroll)scroll.scrollTop=stepScroll.current;
    }
    return;
   }
   canvas.current?.querySelector<HTMLElement>(`[aria-label="${next?'Collapse Workflow':'Expand Workflow'}"]:not([hidden] *)`)?.focus({preventScroll:true})
  })
 };
 const openAdd=(target:GuidedInsertionTarget,anchor:HTMLElement,returnTo?:HTMLElement,label?:string)=>{setInsertionTarget(target);setInsertionLabel(label);setBranching(false);dismissedInsertion.current=null;setAddAnchor(workflowInsertionAnchor(anchor,returnTo));setInsertError('')};
 const servedFirstStep=useRef(0);
 useEffect(()=>{
  if(!active||!firstStepRequest||firstStepRequest===servedFirstStep.current||definition.steps.length||definition.controls.length)return;
  const workspace=canvas.current;
  if(!workspace)return;
  const focusFirstStep=()=>{
   const button=(view==='outline'?outlineEntry:addButton).current;
   if(!button?.getClientRects().length||button.closest('[aria-busy="true"]'))return;
   servedFirstStep.current=firstStepRequest;
   button.focus({preventScroll:true});
   openAdd({kind:'entry'},button);
   observer.disconnect();
  };
  const observer=new MutationObserver(focusFirstStep);
  observer.observe(workspace,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','aria-busy']});
  focusFirstStep();
  return()=>observer.disconnect();
 },[active,firstStepRequest,view,definition.steps.length,definition.controls.length]);
 const closeAdd=()=>{dismissedInsertion.current=addAnchor;setAddAnchor(null)};
 const add=(kind:GuidedStepKind)=>{if(!addAnchor)return;const result=insertGuidedStep(definition,kind,insertionTarget);if(!result.ok){setInsertError(result.reason);return;}onDraft({definition:result.definition});openEditor(result.selected);setFocusRequest(value=>value+1);dismissedInsertion.current=null;setAddAnchor(null)};
 const removeSelected=(id:string)=>{const result=removeWorkflowNode(definition,id);if(!result.ok){setInsertError(result.reason);return;}onDefinition(result.definition);setSelected(result.nextSelected);setFocusRequest(value=>value+1)};
 const restricted=guidedInsertionRestriction(definition,insertionTarget);
 useEffect(()=>{if(!validationRequest||validationIssues.some(issue=>issue.nodeId))return;const missing=definition.steps.find(step=>advancedSettingsNeedAttention(step,bindings)||step.kind==='script'&&(!step.source.trim()||!bindings.directories[step.cwdRef]?.trim())||step.kind==='agent'&&'ref'in step.target&&!bindings.agents[step.target.ref]||step.kind==='human_gate'&&!step.prompt.trim()||step.kind==='branch_call'&&!bindings.branches?.[step.branchRef]);if(missing){openEditor(missing.id);onInvalidStep?.()}else if(!definition.steps.length){onInvalidStep?.();(view==='outline'?outlineEntry:addButton).current?.focus()}},[validationRequest]);
 useEffect(()=>{onPendingEdits?.(setupPending||triggerInvalid||(advanced!==undefined&&advanced!==JSON.stringify(definition,null,2)))},[advanced,definition,onPendingEdits,triggerInvalid,setupPending]);
 useEffect(()=>()=>onPendingEdits?.(false),[onPendingEdits]);
 useEffect(()=>{if(!active)setAddAnchor(null)},[active]);
 const closeEditor=()=>{onInspectorPane();setFocusRequest(value=>value+1)};
 const source=definition.trigger.kind==='manual'?undefined:bindings.triggers?.[definition.trigger.configRef];
 const sourceConfig=source?.sourceConfig;
 const setSource=(sourceConfig:TriggerSourceConfig)=>{if(definition.trigger.kind!=='manual')onBindings({...bindings,triggers:{...bindings.triggers,[definition.trigger.configRef]:{enabled:source?.enabled??true,sourceConfig}}})};
 const setTrigger=(kind:BranchDefinition['trigger']['kind'])=>{
  const next={...bindings};
  if(kind==='manual')delete next.triggers;
  else next.triggers={source:{enabled:true,sourceConfig:kind==='schedule'?{scheduleKind:'interval',everyMs:3600000,startsAt:new Date(Date.now()+60000).toISOString(),whenRunning:'run_latest'}:kind==='webhook'?{}:{include:['**/*'],exclude:[],quietMs:1000,maxWindowMs:10000}}};
  onDraft({definition:{...definition,trigger:kind==='manual'?{kind}:{kind,configRef:'source'}},bindings:next});
 };
 const triggerControl=(ref:React.RefObject<HTMLButtonElement>)=><Tooltip describeChild title="Edit trigger settings"><Button ref={ref} color={triggerInvalid?'error':'inherit'} variant="outlined" startIcon={<PlayArrowOutlinedIcon/>} endIcon={<ExpandMoreIcon/>} onClick={()=>{setExpanded(false);onInspectorPane('trigger')}} sx={{minHeight:44,maxWidth:'100%',bgcolor:'background.paper',borderRadius:'12px',whiteSpace:'normal',textAlign:'left','& .MuiButton-startIcon, & .MuiButton-endIcon':{flexShrink:0}}}>{workflowTriggerSummary(definition.trigger.kind,sourceConfig)}{triggerDirty?' · Draft':''}</Button></Tooltip>;
 const focusViewSelector=useRef(false);
 const restoreViewFocus=useCallback((group:HTMLDivElement|null)=>{
  if(!group||!focusViewSelector.current)return;
  focusViewSelector.current=false;
  group.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({preventScroll:true});
 },[]);
 const viewSelector=<ToggleButtonGroup ref={restoreViewFocus} exclusive value={view} aria-label="Workflow view" size="small" onChange={(_,next:'canvas'|'outline'|null)=>{
  if(!next)return;
  focusViewSelector.current=true;
  setView(next);
  if(next==='canvas')setCanvasOpened(true);else setOutlineOpened(true);
 }} sx={{flexShrink:0,'& .MuiToggleButton-root':{minHeight:44,px:{xs:1,sm:2},textTransform:'none'}}}>
  <ToggleButton value="canvas">Canvas</ToggleButton>
  <ToggleButton value="outline">Outline</ToggleButton>
 </ToggleButtonGroup>;
 const canEditInspector=()=>mounted.current&&editorAuthority.current.visible&&editorAuthority.current.branchId===branchId&&editorAuthority.current.nodeId===selectedNode?.id&&owner.current.definition===definition&&owner.current.bindings===bindings;
 return <Stack ref={canvas} onKeyDown={event=>{if(canvas.current?.contains(event.target as Node)&&event.key==='Escape'&&!event.defaultPrevented&&expanded){event.preventDefault();toggleExpanded()}}} sx={{minWidth:0,minHeight:0,height:'100%',width:'100%'}}>
  {setupNotice&&<Alert severity="info" onClose={()=>setSetupNotice('')}>{setupNotice}</Alert>}
  {validationIssues.length>0&&<Stack component="section" aria-label="Publication Issues" spacing={.5} sx={{maxHeight:'40%',flexShrink:0,overflowY:'auto'}}><Typography fontWeight={600}>Publication Issues</Typography>{validationIssues.map((issue,index)=><Button key={index} sx={{justifyContent:'flex-start',textAlign:'left'}} onClick={()=>{if(issue.nodeId){setChosenIssue(issue);setIssueFocus(value=>value+1);openEditor(issue.nodeId);onInvalidStep?.()}else if(issue.section==='settings')onSettingsIssue?.(issue.field);else (view==='outline'?outlineEntry:addButton).current?.focus()}}>{issue.message}</Button>)}</Stack>}
  {insertError&&<Alert severity="error" onClose={()=>setInsertError('')}>{insertError}</Alert>}
  <Menu anchorEl={addAnchor} anchorOrigin={{vertical:'bottom',horizontal:'center'}} transformOrigin={{vertical:'top',horizontal:'center'}} marginThreshold={16} open={Boolean(addAnchor)} onClose={closeAdd} disableRestoreFocus slotProps={{transition:{onExited:()=>{const anchor=dismissedInsertion.current;dismissedInsertion.current=null;if(mounted.current&&owner.current.active)anchor?.restoreFocus()}}}}>
   {branching&&<MenuItem onClick={()=>setBranching(false)}>← All Steps</MenuItem>}
   <Box sx={{px:2,py:1,maxWidth:280}}><Typography variant="caption" color="text.secondary">{restricted??insertionLabel??(insertionTarget.kind==='entry'?(definition.entry?'Before The First Step':'First Step'):insertionTarget.kind==='edge'?'On This Connection':'Before End This Path')}</Typography></Box>
   {(branching?[['condition','Condition'],['route','Named Routes'],['parallel','Parallel Paths'],['for_each','For Each']]:[['agent','Agent Task'],['human_gate','Approval'],['action','Notification'],['branch_call','Run Another Workflow'],['script','Script']]).map(([kind,label])=><MenuItem key={kind} disabled={Boolean(restricted)} onClick={()=>add(kind as GuidedStepKind)}>{label}</MenuItem>)}
   {!branching&&<MenuItem onClick={()=>setBranching(true)}>Branching…</MenuItem>}
  </Menu>
  {canvasOpened&&<Stack ref={canvasRegion} hidden={view!=='canvas'} role="region" aria-label="Workflow Canvas"
   aria-busy={canvasPhase==='loading'||canvasPhase==='arranging'} sx={{display:view==='canvas'?'flex':'none',flex:1,minHeight:0,minWidth:0}}>
   <Suspense fallback={<Typography role="status" sx={{flex:1,minHeight:0}}>Loading Workflow Canvas…</Typography>}>
    <WorkflowCanvas region={canvasRegion} navigationRef={canvasNavigation} onPhase={setCanvasPhase} startControl={triggerControl(triggerButton)} entryButtonRef={addButton} branchId={branchId} canvasViews={canvasViews} undoRedo={undoRedo} active={active&&view==='canvas'} revealRequest={validationRequest+issueFocus+editorReveal} bindings={bindings} agents={agents} issues={validationIssues} definition={definition} selected={selected} onSelect={openEditor} onInsert={openAdd} onDelete={removeSelected} focusRequest={editorVisible?0:focusRequest}/>
   </Suspense>
   <WorkflowCanvasFooter viewSelector={view==='canvas'?viewSelector:null} saveControl={saveControl} undoRedo={undoRedo} expanded={expanded} onToggleExpanded={toggleExpanded}
    zoomIn={canvasPhase==='loading'?undefined:()=>canvasNavigation.current?.zoomBy(1.2)}
    zoomOut={canvasPhase==='loading'?undefined:()=>canvasNavigation.current?.zoomBy(1/1.2)}
    fit={canvasPhase==='ready'?()=>canvasNavigation.current?.fit():undefined}/>
  </Stack>}
  {outlineOpened&&<Box hidden={view!=='outline'} sx={{flex:1,minHeight:0,minWidth:0}}>
   <WorkflowOutline definition={definition} bindings={bindings} agents={agents} issues={validationIssues} active={active&&view==='outline'} selected={selected}
    onSelect={openEditor} onInsert={openAdd} onDelete={removeSelected} startControl={triggerControl(outlineTrigger)} entryButtonRef={outlineEntry}
    viewSelector={view==='outline'?viewSelector:null} saveControl={saveControl} undoRedo={undoRedo} expanded={expanded} onToggleExpanded={toggleExpanded}
    focusRequest={editorVisible?0:focusRequest} revealRequest={validationRequest+issueFocus+editorReveal} scrollPosition={outlineScroll}/>
  </Box>}
  {inspectorTarget&&createPortal(<>
   {retainTrigger||inspectorPane==='trigger'?<Box hidden={!inspectorActive||inspectorPane!=='trigger'} sx={{height:'100%'}}>
    <WorkflowInspectorPage title="Trigger settings" onBack={()=>{onInspectorPane();requestAnimationFrame(()=>(view==='outline'?outlineTrigger:triggerButton).current?.focus({preventScroll:true}))}} actions={<Button ref={variablesButton} onClick={()=>{variablesFromTrigger.current=true;onInspectorPane('variables')}}>Workflow variables</Button>}>
  <Stack component="section" aria-label="How It Starts" spacing={1.5}>
   {intake}
   {triggerDirty&&<Typography fontWeight={600}>Draft · {workflowTriggerSummary(definition.trigger.kind,sourceConfig)}</Typography>}
   <FormControl>
    <FormLabel id={startsLabel}>How it starts</FormLabel>
    <RadioGroup row aria-labelledby={startsLabel} value={definition.trigger.kind} onChange={(_,value)=>setTrigger(value as BranchDefinition['trigger']['kind'])}>
     <FormControlLabel value="manual" control={<Radio size="small"/>} label="Manually with Run once"/>
     <FormControlLabel value="schedule" control={<Radio size="small"/>} label="On a schedule"/>
     <FormControlLabel value="webhook" control={<Radio size="small"/>} label="When a webhook arrives"/>
     <FormControlLabel value="filesystem" control={<Radio size="small"/>} label="When files change"/>
    </RadioGroup>
   </FormControl>
   {definition.trigger.kind!=='manual'&&sourceConfig&&<BranchTriggerSource key={definition.trigger.kind} kind={definition.trigger.kind} config={sourceConfig} onChange={setSource} onInvalid={setTriggerInvalid}/>}
   {triggerInvalid&&<Alert severity="error">Correct the trigger fields before reviewing publication.</Alert>}
   {source&&definition.trigger.kind!=='manual'&&<Box>
    <FormControlLabel control={<Switch checked={source.enabled} inputProps={{'aria-describedby':startsLabel+'-publish'}} onChange={(_,enabled)=>{if(definition.trigger.kind!=='manual')onBindings({...bindings,triggers:{...bindings.triggers,[definition.trigger.configRef]:{...source,enabled}}})}}/>} label="Allow automatic runs in this draft"/>
    <Typography id={startsLabel+'-publish'} variant="body2" color="text.secondary">Review changes shows whether automatic runs will be on or paused after publishing.</Typography>
   </Box>}
  </Stack>
    </WorkflowInspectorPage>
   </Box>:null}
   {inspectorActive&&inspectorPane==='variables'&&<WorkflowInspectorPage title="Workflow variables" backLabel={variablesFromTrigger.current?"Back to trigger settings":"Back to workflow"} onBack={()=>{if(!variablesFromTrigger.current){onInspectorPane();return}variablesFromTrigger.current=false;onInspectorPane('trigger');requestAnimationFrame(()=>variablesButton.current?.focus({preventScroll:true}))}}>
    <ParameterDefinitions definition={definition} onChange={onDefinition}/>
   </WorkflowInspectorPage>}
   {selectedNode&&<Box ref={stepPanel} hidden={!editorVisible} {...(!editorVisible?{inert:''}:{})} sx={{height:'100%'}}>
    <WorkflowInspectorPage title="Step Settings" onBack={closeEditor} headerAction={<IconButton aria-label="Expand Workflow" onClick={toggleExpanded} sx={{width:44,height:44}}><OpenInFullIcon/></IconButton>}>
     <NodeEditor active={editorVisible} key={selectedNode.id} onProviderSetup={onProviderSetup} onDraft={value=>{if(canEditInspector())owner.current.onDraft(value)}} validationRequest={active?validationRequest+issueFocus:0} retainedTemplates={retainedTemplates.current} branchId={branchId} onSetup={value=>{if(canEditInspector()){setupButton.current=document.activeElement instanceof HTMLElement?document.activeElement:undefined;setSetup(value)}}} validationIssue={chosenIssue?.nodeId===selectedNode.id?chosenIssue:validationIssues.find(issue=>issue.nodeId===selectedNode.id)} definition={definition} nodeId={selectedNode.id} onChange={value=>{if(canEditInspector())owner.current.onDefinition(value)}} onRemove={next=>{if(canEditInspector()){setSelected(next);setFocusRequest(value=>value+1)}}} bindings={bindings} onBindings={value=>{if(canEditInspector())owner.current.onBindings(value)}} contexts={contexts} agents={agents} engines={engines}/>
    </WorkflowInspectorPage>
   </Box>}
   {setup&&<Box hidden={!inspectorActive||inspectorPane!=='step'} sx={{height:'100%'}}><Suspense fallback={<Typography role="status">Loading Agent Setup…</Typography>}><WorkflowAgentSetup key={`${branchId}:${setup.nodeId}:${setup.kind}`} branchId={branchId} chatId={setup.chatId??chatId??''} request={setup} engines={engines} onComplete={finishSetup} onClose={()=>{setSetup(undefined);setSetupPending(false);restoreSetupFocus()}} onPendingChange={setSetupPending}/></Suspense></Box>}
   {inspectorActive&&inspectorPane==='json'&&<WorkflowInspectorPage title="Edit Workflow JSON" onBack={()=>onInspectorPane()}>
    <Stack spacing={1} sx={{pt:1}}>{jsonError&&<Alert severity="error">{jsonError}</Alert>}<TextField label="Definition JSON" multiline minRows={10} maxRows={24} value={advanced??JSON.stringify(definition,null,2)} onChange={e=>{applyRequest.current++;setAdvanced(e.target.value)}} slotProps={{htmlInput:{spellCheck:false},input:{sx:{fontFamily:'monospace',fontSize:12}}}}/><Button onClick={async()=>{const requestId=++applyRequest.current,startedDefinition=definition;try{const parsed=await requestJson<{definition:BranchDefinition}>('/api/branches/import-preview',{method:'POST',body:JSON.stringify({schema:'ponderosa.branch-package.v1',exportedAt:new Date().toISOString(),definition:JSON.parse(advanced??JSON.stringify(definition))})});if(requestId!==applyRequest.current)return;if(startedDefinition!==currentDefinition.current){setJsonError('The workflow changed while validating. Your JSON is retained; review it before applying again.');return;}onDefinition(parsed.definition);setAdvanced(undefined);setJsonError('')}catch(error){setJsonError(error instanceof Error?error.message:'Invalid JSON')}}}>Apply Definition</Button><Button onClick={()=>{applyRequest.current++;setAdvanced(undefined);setJsonError('')}}>Discard Advanced Edits</Button></Stack>
   </WorkflowInspectorPage>}
  </>,inspectorTarget)}

 </Stack>;
}

/** Definition policy edits use the same draft owner as the canvas. */
export function WorkflowExecutionSettings({definition,onDefinition,bindings,onBindings,agents,contexts,validationIssue}:Pick<Parameters<typeof WorkflowEditor>[0],'definition'|'onDefinition'|'bindings'|'onBindings'|'agents'|'contexts'>&{validationIssue?:import('@ponderosa/core').BranchValidationIssue}):JSX.Element {
 const section=useRef<HTMLElement>(null);
 useEffect(()=>{
  if(!validationIssue)return;
  const root=section.current;
  const name=validationIssue.field;
  const field=name?root?.querySelector(`[data-branch-field="${CSS.escape(name)}"]`)?.querySelector<HTMLElement>('[role="combobox"], input:not([aria-hidden])'):undefined;
  const target=field??root;
  target?.focus({preventScroll:true});
  target?.scrollIntoView({block:'center'});
 },[validationIssue]);
 return <Stack component="section" ref={section} tabIndex={-1} aria-label="Draft execution policy" spacing={2}>
  <Box><Typography fontWeight={650}>Execution policy</Typography><Typography variant="body2" color="text.secondary">Publish the workflow to apply these changes.</Typography></Box>
  {([['maxConcurrentExecutions','Concurrent Executions',2],['maxEphemeralAgents','Temporary Agents Per Execution',100],['maxPathInstances','Maximum Paths',1000],['maxStepInvocations','Maximum Step Invocations',1000]] as const).map(([field,label,fallback])=>{
    const value=definition.policy[field]??fallback,maximum=field==='maxConcurrentExecutions'?1000:100000;
    const invalid=!Number.isSafeInteger(value)||value<1||value>maximum;
    return <TextField data-branch-field={field} key={field} label={label} type="number" size="small" inputProps={{min:1,max:maximum,step:1}} error={invalid} helperText={invalid?`Enter a whole number from 1 to ${maximum.toLocaleString()}.`:undefined} value={value} onChange={e=>onDefinition({...definition,policy:{...definition.policy,[field]:Number(e.target.value)}})}/>;
   })}
  <FormControlLabel data-branch-field="pauseOnSpeakerRemoval" label="Pause Automatic Runs When Speaker Role Is Removed" control={<Switch checked={definition.policy.pauseOnSpeakerRemoval===true} onChange={(_,pauseOnSpeakerRemoval)=>onDefinition({...definition,policy:{...definition.policy,pauseOnSpeakerRemoval}})}/>}/>
  <FailureEditor value={definition.policy.failure} onChange={failure=>onDefinition({...definition,policy:{...definition.policy,failure:failure??{action:'stop'}}})} bindings={bindings} onBindings={onBindings} agents={agents} contexts={contexts}/>
 </Stack>;
}
