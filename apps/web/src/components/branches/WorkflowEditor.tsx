import {createPortal} from 'react-dom';
import {readBrowserStorage,writeBrowserStorage} from '../../browserStorage';
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
import {Alert,Box,Button,FormControl,FormControlLabel,FormLabel,IconButton,ListSubheader,Menu,MenuItem,Radio,RadioGroup,Stack,Switch,TextField,ToggleButton,ToggleButtonGroup,Tooltip,Typography} from '@mui/material';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import type {AgentDto,BranchBindings,BranchDefinition,ConversationDto,EngineDto,TriggerSourceConfig} from '@ponderosa/core';
import type {CanvasNavigation,CanvasPhase,CanvasViewState,WorkflowUndoRedo} from './WorkflowCanvas';
const WorkflowCanvas=lazy(()=>import('./WorkflowCanvas').then(module=>({default:module.WorkflowCanvas})));
import {guidedInsertionRestriction,insertGuidedStep,type GuidedInsertionTarget,type GuidedStepKind} from './guided-operations';
import {nodeName,removeWorkflowNode} from './model';
import {workflowPaths} from './workflow-outline';
import {advancedSettingsNeedAttention,FailureEditor,NodeEditor} from './NodeEditor';
import {ExecutionControlHelp} from './ExecutionControlHelp';
import {changeAgentTarget} from './model';
const standardSteps=[
 ['agent','Agent Task','Give an Agent instructions to work on the step’s input.'],
 ['human_gate','Approval','Pause for someone to review and decide how to proceed.'],
 ['action','Notification','Sends the step’s input to Ponderosa Notifications and subscribed devices.'],
 ['branch_call','Run Another Workflow','Pass the input to a published workflow and use its result.'],
 ['script','Script','Run code to process the input.'],
] as const;
const branchingSteps=[
 ['condition','Condition','Choose a path based on a rule.'],
 ['route','Named Routes','Choose a named path that matches the input.'],
 ['parallel','Parallel Paths','Run paths in parallel and join their results.'],
 ['for_each','For Each','Run the same work for every item in a list.'],
] as const;

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
export function WorkflowEditor({definition,bindings,contexts,agents,engines,onDefinition,onBindings,onPendingEdits,branchId,chatId,validationIssues=[],intake,triggerDirty=false,inspectorTarget,inspectorPane,onInspectorPane,inspectorActive,validationRequest=0,firstStepRequest=0,onProviderSetup,variablesSettingsHref,onVariablesSettings,active=true,onInvalidStep,onSettingsIssue,onDraft,undoRedo,canvasViews,saveControl}:{editing?:boolean;saveControl:ReactNode;variablesSettingsHref:string;onVariablesSettings():void;onDraft(value:{definition?:BranchDefinition;bindings?:BranchBindings}):void;undoRedo:WorkflowUndoRedo;canvasViews:Map<string,CanvasViewState>;branchId:string;validationIssues?:import("@ponderosa/core").BranchValidationIssue[];active?:boolean;firstStepRequest?:number;onProviderSetup?():void;onInvalidStep?():void;onSettingsIssue?(field?:string):void;intake?:ReactNode;triggerDirty?:boolean;inspectorTarget:HTMLElement|null;inspectorPane?:'trigger'|'step'|'json'|'variables';onInspectorPane(pane?:'trigger'|'step'|'json'|'variables'):void;inspectorActive:boolean;validationRequest?:number;onPendingEdits?(pending:boolean):void;definition:BranchDefinition;bindings:BranchBindings;chatId:string;contexts:ConversationDto[];agents:AgentDto[];engines:EngineDto[];existing:boolean;onDefinition(value:BranchDefinition):void;onBindings(value:BranchBindings):void;onChat(id:string):void}):JSX.Element{
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
 const startsLabel=useId(),pickerLabel=useId();
 const [selected,setSelected]=useState<string|undefined>(()=>canvasViews.get(branchId)?.selected),[expanded,setExpanded]=useState(false),[editorReveal,setEditorReveal]=useState(0),[focusRequest,setFocusRequest]=useState(0),[addAnchor,setAddAnchor]=useState<ReturnType<typeof workflowInsertionAnchor>|null>(null),[branching,setBranching]=useState(false),[advanced,setAdvanced]=useState<string>(),[jsonError,setJsonError]=useState('');
 const viewStorageKey=`ponderosa:workflow-view:${branchId}`;
 const [view,setView]=useState(()=>canvasViews.get(branchId)?.view??(branchId&&readBrowserStorage('sessionStorage',viewStorageKey)==='outline'?'outline':'canvas'));
 const triggerView=useRef<typeof view>();
 const canvasRegion=useRef<HTMLDivElement>(null),canvasNavigation=useRef<CanvasNavigation>(null);
 const [canvasPhase,setCanvasPhase]=useState<CanvasPhase>('loading');
 const [canvasOpened,setCanvasOpened]=useState(view==='canvas'),[outlineOpened,setOutlineOpened]=useState(view==='outline');
 const outlineScroll=useRef(canvasViews.get(branchId)?.outlineScroll??0),outlineTrigger=useRef<HTMLButtonElement>(null),outlineEntry=useRef<HTMLButtonElement>(null);
 const [stepMenu,setStepMenu]=useState<{id:string;anchor:HTMLElement}>();
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
 const setupButton=useRef<HTMLElement>();
 const restoreSetupFocus=()=>requestAnimationFrame(()=>setupButton.current?.focus({preventScroll:true}));
 useEffect(()=>{
  if(inspectorPane==='trigger')setRetainTrigger(true);
  else triggerView.current=undefined;
 },[inspectorPane]);
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
 const removeSelected=(id:string)=>{
  const result=removeWorkflowNode(definition,id);
  if(!result.ok){setInsertError(result.reason);return;}
  onDefinition(result.definition);
  setSelected(result.nextSelected);
  if(!result.nextSelected){
   if(inspectorPane==='step')onInspectorPane();
   if(expandedPane.current==='step')expandedPane.current=undefined;
  }
  setFocusRequest(value=>value+1);
 };
 const restricted=guidedInsertionRestriction(definition,insertionTarget);
 useEffect(()=>{if(!validationRequest||validationIssues.some(issue=>issue.nodeId))return;const missing=definition.steps.find(step=>advancedSettingsNeedAttention(step,bindings)||step.kind==='script'&&(!step.source.trim()||!bindings.directories[step.cwdRef]?.trim())||step.kind==='agent'&&'ref'in step.target&&!bindings.agents[step.target.ref]||step.kind==='human_gate'&&!step.prompt.trim()||step.kind==='branch_call'&&!bindings.branches?.[step.branchRef]);if(missing){openEditor(missing.id);onInvalidStep?.()}else if(!definition.steps.length){onInvalidStep?.();(view==='outline'?outlineEntry:addButton).current?.focus()}},[validationRequest]);
 useEffect(()=>{onPendingEdits?.(setupPending||triggerInvalid||(advanced!==undefined&&advanced!==JSON.stringify(definition,null,2)))},[advanced,definition,onPendingEdits,triggerInvalid,setupPending]);
 useEffect(()=>()=>onPendingEdits?.(false),[onPendingEdits]);
 useEffect(()=>{if(!active){setAddAnchor(null);setStepMenu(undefined)}},[active]);
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
 const changeView=(next:typeof view)=>{
  setView(next);
  if(branchId)writeBrowserStorage('sessionStorage',viewStorageKey,next);
  if(next==='canvas')setCanvasOpened(true);else setOutlineOpened(true);
 };
 const closeTrigger=()=>{
  const origin=triggerView.current??view;
  triggerView.current=undefined;
  if(origin!==view)changeView(origin);
  onInspectorPane();
  requestAnimationFrame(()=>{
   if(mounted.current&&owner.current.active)(origin==='outline'?outlineTrigger:triggerButton).current?.focus({preventScroll:true});
  });
 };
 const triggerControl=(ref:React.RefObject<HTMLButtonElement>)=><Tooltip describeChild title="Edit trigger settings"><Button ref={ref} color={triggerInvalid?'error':'inherit'} variant="outlined" startIcon={<PlayArrowOutlinedIcon/>} endIcon={<ExpandMoreIcon/>} onClick={()=>{triggerView.current=view;setExpanded(false);onInspectorPane('trigger')}} sx={{minHeight:44,maxWidth:'100%',bgcolor:'background.paper',borderRadius:'12px',whiteSpace:'normal',textAlign:'left','& .MuiButton-startIcon, & .MuiButton-endIcon':{flexShrink:0}}}>{workflowTriggerSummary(definition.trigger.kind,sourceConfig)}{triggerDirty?' · Draft':''}</Button></Tooltip>;
 const focusViewSelector=useRef(false);
 const restoreViewFocus=useCallback((group:HTMLDivElement|null)=>{
  if(!group||!focusViewSelector.current)return;
  focusViewSelector.current=false;
  group.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({preventScroll:true});
 },[]);
 const viewSelector=<ToggleButtonGroup ref={restoreViewFocus} exclusive value={view} aria-label="Workflow view" size="small" onChange={(_,next:'canvas'|'outline'|null)=>{
  if(!next)return;
  focusViewSelector.current=true;
  changeView(next);
 }} sx={{flexShrink:0,'& .MuiToggleButton-root':{minHeight:44,px:{xs:1,sm:2},textTransform:'none'}}}>
  <ToggleButton value="canvas">Canvas</ToggleButton>
  <ToggleButton value="outline">Outline</ToggleButton>
 </ToggleButtonGroup>;
 const menuNodes=[...definition.steps,...definition.controls];
 const menuNode=stepMenu&&menuNodes.find(node=>node.id===stepMenu.id);
 const menuPaths=menuNode?workflowPaths(definition).get(menuNode.id)??[]:[];
 const openStepMenu=(id:string,anchor:HTMLElement)=>{if(active&&!setupPending)setStepMenu({id,anchor})};
 const closeStepMenu=()=>{
  setStepMenu(undefined);
  const anchor=stepMenu?.anchor;
  requestAnimationFrame(()=>{if(owner.current.active&&anchor?.isConnected&&anchor.getClientRects().length)anchor.focus({preventScroll:true})});
 };
 const canEditInspector=()=>mounted.current&&editorAuthority.current.visible&&editorAuthority.current.branchId===branchId&&editorAuthority.current.nodeId===selectedNode?.id&&owner.current.definition===definition&&owner.current.bindings===bindings;
 return <Stack ref={canvas} onKeyDown={event=>{if(canvas.current?.contains(event.target as Node)&&event.key==='Escape'&&!event.defaultPrevented&&expanded){event.preventDefault();toggleExpanded()}}} sx={{minWidth:0,minHeight:0,height:'100%',width:'100%'}}>
  {setupNotice&&<Alert severity="info" onClose={()=>setSetupNotice('')}>{setupNotice}</Alert>}
  {validationIssues.length>0&&<Stack component="section" aria-label="Publication Issues" spacing={.5} sx={{maxHeight:'40%',flexShrink:0,overflowY:'auto'}}><Typography fontWeight={600}>Publication Issues</Typography>{validationIssues.map((issue,index)=><Button key={index} sx={{justifyContent:'flex-start',textAlign:'left'}} onClick={()=>{if(issue.nodeId){setChosenIssue(issue);setIssueFocus(value=>value+1);openEditor(issue.nodeId);onInvalidStep?.()}else if(issue.section==='settings')onSettingsIssue?.(issue.field);else (view==='outline'?outlineEntry:addButton).current?.focus()}}>{issue.message}</Button>)}</Stack>}
  {insertError&&<Alert severity="error" onClose={()=>setInsertError('')}>{insertError}</Alert>}
  <Menu open={Boolean(menuNode&&stepMenu)} anchorEl={stepMenu?.anchor} onClose={closeStepMenu} disableRestoreFocus
   slotProps={{list:{'aria-label':menuNode?`Actions for ${nodeName(menuNode)}`:undefined},paper:{sx:{maxWidth:'calc(100vw - 32px)','& .MuiMenuItem-root':{minHeight:44,whiteSpace:'normal',overflowWrap:'anywhere'}}}}}>
   {menuNode&&stepMenu&&[
    <MenuItem key="edit" onClick={()=>{setStepMenu(undefined);openEditor(menuNode.id)}}>Edit step</MenuItem>,
    ...menuPaths.filter(path=>!guidedInsertionRestriction(definition,path.target)).map(path=>{
     const linear=menuPaths.length===1&&!path.loop&&['On success','If approved'].includes(path.label);
     const destination=menuNodes.find(node=>node.id===path.to);
     const route=destination?`${path.label} → ${path.loop?'loop to ':''}${nodeName(destination)}`:path.label;
     const label=linear?'Add after this step':/^(On |If |Otherwise$)/.test(path.label)?`Add ${route[0]!.toLowerCase()}${route.slice(1)}`:`Add on ${route}`;
     return <MenuItem key={path.key} onClick={()=>{setStepMenu(undefined);openAdd(path.target,stepMenu.anchor,undefined,linear?`After ${nodeName(menuNode)}`:route)}}>{label}</MenuItem>;
    }),
    ...(removeWorkflowNode(definition,menuNode.id).ok?[<MenuItem key="remove" onClick={()=>{setStepMenu(undefined);removeSelected(menuNode.id)}}>Remove step</MenuItem>]:[]),
   ]}
  </Menu>
  <Menu anchorEl={addAnchor} anchorOrigin={{vertical:'bottom',horizontal:'center'}} transformOrigin={{vertical:'top',horizontal:'center'}} marginThreshold={16} open={Boolean(addAnchor)} onClose={closeAdd} disableRestoreFocus slotProps={{transition:{onExited:()=>{const anchor=dismissedInsertion.current;dismissedInsertion.current=null;if(mounted.current&&owner.current.active)anchor?.restoreFocus()}}}}>
   {branching&&<MenuItem onClick={()=>setBranching(false)}>← All Steps</MenuItem>}
   <ListSubheader disableSticky sx={{px:2,py:1,maxWidth:280,typography:'caption'}}>{restricted??insertionLabel??(insertionTarget.kind==='entry'?(definition.entry?'Before The First Step':'First Step'):insertionTarget.kind==='edge'?'On This Connection':'Before End This Path')}</ListSubheader>
   {(branching?branchingSteps:standardSteps).map(([kind,label,help])=><MenuItem key={kind} aria-label={label} aria-describedby={pickerLabel+kind} disabled={Boolean(restricted)} onClick={()=>add(kind)}
    sx={{display:'block',py:1,minHeight:44,maxWidth:360,whiteSpace:'normal'}}>
    <Typography>{label}</Typography>
    <Typography id={pickerLabel+kind} variant="body2" color="text.secondary">{help}</Typography>
   </MenuItem>)}
   {!branching&&<MenuItem onClick={()=>setBranching(true)}>Branching…</MenuItem>}
  </Menu>
  {canvasOpened&&<Stack ref={canvasRegion} hidden={view!=='canvas'} role="region" aria-label="Workflow Canvas"
   aria-busy={canvasPhase==='loading'||canvasPhase==='arranging'} sx={{display:view==='canvas'?'flex':'none',flex:1,minHeight:0,minWidth:0}}>
   <Suspense fallback={<Typography role="status" sx={{flex:1,minHeight:0}}>Loading Workflow Canvas…</Typography>}>
    <WorkflowCanvas region={canvasRegion} navigationRef={canvasNavigation} onPhase={setCanvasPhase} startControl={triggerControl(triggerButton)} entryButtonRef={addButton} branchId={branchId} canvasViews={canvasViews} undoRedo={undoRedo} active={active&&view==='canvas'} revealRequest={validationRequest+issueFocus+editorReveal} bindings={bindings} agents={agents} issues={validationIssues} definition={definition} selected={selected} onSelect={openEditor} onInsert={openAdd} onDelete={removeSelected} onStepMenu={openStepMenu} stepMenuId={stepMenu?.id} focusRequest={editorVisible?0:focusRequest}/>
   </Suspense>
   <WorkflowCanvasFooter viewSelector={view==='canvas'?viewSelector:null} saveControl={saveControl} undoRedo={undoRedo} expanded={expanded} onToggleExpanded={toggleExpanded}
    zoomIn={canvasPhase==='loading'?undefined:()=>canvasNavigation.current?.zoomBy(1.2)}
    zoomOut={canvasPhase==='loading'?undefined:()=>canvasNavigation.current?.zoomBy(1/1.2)}
    fit={canvasPhase==='ready'?()=>canvasNavigation.current?.fit():undefined}/>
  </Stack>}
  {outlineOpened&&<Box hidden={view!=='outline'} sx={{flex:1,minHeight:0,minWidth:0}}>
   <WorkflowOutline definition={definition} bindings={bindings} agents={agents} issues={validationIssues} active={active&&view==='outline'} selected={selected}
    onSelect={openEditor} onInsert={openAdd} onStepMenu={openStepMenu} stepMenuId={stepMenu?.id} startControl={triggerControl(outlineTrigger)} entryButtonRef={outlineEntry}
    viewSelector={view==='outline'?viewSelector:null} saveControl={saveControl} undoRedo={undoRedo} expanded={expanded} onToggleExpanded={toggleExpanded}
    focusRequest={editorVisible?0:focusRequest} revealRequest={validationRequest+issueFocus+editorReveal} scrollPosition={outlineScroll}/>
  </Box>}
  {inspectorTarget&&createPortal(<>
   {retainTrigger||inspectorPane==='trigger'?<Box hidden={!inspectorActive||inspectorPane!=='trigger'} sx={{height:'100%'}}>
    <WorkflowInspectorPage title="Trigger settings" onBack={closeTrigger}>
  <Stack component="section" aria-label="How It Starts" spacing={1.5}>
   <FormControl>
    <FormLabel id={startsLabel}>How it starts</FormLabel>
    <RadioGroup aria-labelledby={startsLabel} value={definition.trigger.kind} onChange={(_,value)=>setTrigger(value as BranchDefinition['trigger']['kind'])}
     sx={{'& .MuiFormControlLabel-root':{m:0,width:'100%',minHeight:44},'& .MuiRadio-root':{flexShrink:0}}}>
     <FormControlLabel value="manual" control={<Radio size="small"/>} label="Manually with Run once"/>
     <FormControlLabel value="schedule" control={<Radio size="small"/>} label="On a schedule"/>
     <FormControlLabel value="webhook" control={<Radio size="small"/>} label="When a webhook arrives"/>
     <FormControlLabel value="filesystem" control={<Radio size="small"/>} label="When files change"/>
    </RadioGroup>
   </FormControl>
   {intake}
   {triggerDirty&&<Typography fontWeight={600}>Draft · {workflowTriggerSummary(definition.trigger.kind,sourceConfig)}</Typography>}
   {definition.trigger.kind!=='manual'&&sourceConfig&&<BranchTriggerSource key={definition.trigger.kind} kind={definition.trigger.kind} config={sourceConfig} onChange={setSource} onInvalid={setTriggerInvalid}/>}
   {triggerInvalid&&<Alert severity="error">Correct the trigger fields before reviewing publication.</Alert>}
   {source&&definition.trigger.kind!=='manual'&&<Box>
    <FormControlLabel control={<Switch checked={source.enabled} inputProps={{'aria-describedby':startsLabel+'-publish'}} onChange={(_,enabled)=>{if(definition.trigger.kind!=='manual')onBindings({...bindings,triggers:{...bindings.triggers,[definition.trigger.configRef]:{...source,enabled}}})}}/>} label="Allow automatic runs in this draft"/>
    <Typography id={startsLabel+'-publish'} variant="body2" color="text.secondary">Review changes shows whether automatic runs will be on or paused after publishing.</Typography>
   </Box>}
  </Stack>
    </WorkflowInspectorPage>
   </Box>:null}
   {inspectorActive&&inspectorPane==='variables'&&<WorkflowInspectorPage title="Workflow variables" onBack={()=>onInspectorPane()}>
    <ParameterDefinitions definition={definition} onChange={onDefinition} settingsHref={variablesSettingsHref} onSettings={onVariablesSettings}/>
   </WorkflowInspectorPage>}
   {selectedNode&&<Box ref={stepPanel} hidden={!editorVisible} {...(!editorVisible?{inert:''}:{})} sx={{height:'100%'}}>
    <WorkflowInspectorPage title={selectedNode.kind==='condition'?'Condition':'Step Settings'} onBack={closeEditor} headerAction={<IconButton aria-label="Expand Workflow" onClick={toggleExpanded} sx={{width:44,height:44}}><OpenInFullIcon/></IconButton>}>
     <NodeEditor active={editorVisible} key={selectedNode.id} onProviderSetup={onProviderSetup} onDraft={value=>{if(canEditInspector())owner.current.onDraft(value)}} validationRequest={active?validationRequest+issueFocus:0} retainedTemplates={retainedTemplates.current} branchId={branchId} onSetup={value=>{if(canEditInspector()){setupButton.current=document.activeElement instanceof HTMLElement?document.activeElement:undefined;setSetup(value)}}} validationIssue={chosenIssue?.nodeId===selectedNode.id?chosenIssue:validationIssues.find(issue=>issue.nodeId===selectedNode.id)} definition={definition} nodeId={selectedNode.id} onChange={value=>{if(canEditInspector())owner.current.onDefinition(value)}} onRemove={id=>{if(canEditInspector())removeSelected(id)}} bindings={bindings} onBindings={value=>{if(canEditInspector())owner.current.onBindings(value)}} contexts={contexts} agents={agents} engines={engines}/>
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
  {([
   ['maxConcurrentExecutions','Concurrent Executions',2,'How many runs of this workflow can do work at the same time. Additional runs wait for room.'],
   ['maxEphemeralAgents','Temporary Agents Per Execution',100,'How many temporary Agents one run can create, including Agents created by a temporary team.'],
   ['maxPathInstances','Maximum Paths',1000,'How many paths one run can create in total, including its starting path, parallel paths, and For Each item paths.'],
   ['maxStepInvocations','Maximum Step Invocations',1000,'How many step visits one run can make across its paths. Visiting the same step again in a loop uses another visit.'],
  ] as const).map(([field,label,fallback,help])=>{
    const value=definition.policy[field]??fallback,maximum=field==='maxConcurrentExecutions'?1000:100000;
    const invalid=!Number.isSafeInteger(value)||value<1||value>maximum;
    return <ExecutionControlHelp key={field} label={label} help={help}><TextField data-branch-field={field} label={label} type="number" size="small" inputProps={{min:1,max:maximum,step:1}} error={invalid} helperText={invalid?`Enter a whole number from 1 to ${maximum.toLocaleString()}.`:undefined} value={value} onChange={e=>onDefinition({...definition,policy:{...definition.policy,[field]:Number(e.target.value)}})}/></ExecutionControlHelp>;
   })}
  <ExecutionControlHelp label="Pause Automatic Runs When Speaker Role Is Removed" help="If this workflow’s designated Speaker Agent loses that role, pause new automatic runs.">
   <FormControlLabel sx={{m:0}} data-branch-field="pauseOnSpeakerRemoval" label="Pause Automatic Runs When Speaker Role Is Removed" control={<Switch checked={definition.policy.pauseOnSpeakerRemoval===true} onChange={(_,pauseOnSpeakerRemoval)=>onDefinition({...definition,policy:{...definition.policy,pauseOnSpeakerRemoval}})}/>}/>
  </ExecutionControlHelp>
  <FailureEditor selectorHelp="Choose what to do when a step fails and hasn’t set its own behavior." value={definition.policy.failure} onChange={failure=>onDefinition({...definition,policy:{...definition.policy,failure:failure??{action:'stop'}}})} bindings={bindings} onBindings={onBindings} agents={agents} contexts={contexts}/>
 </Stack>;
}
