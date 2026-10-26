import {TriggerSourceFields,useTriggerSourceDraft} from '../TriggerSourceFields';
import {ParameterDefinitions} from './ParameterDefinitions';
import type {ReactNode} from 'react';
import { requestJson } from "../../api/real";
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Accordion,AccordionDetails,AccordionSummary,Alert,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,Drawer,FormControlLabel,Menu,MenuItem,Stack,Switch,TextField,Typography} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type {AgentDto,BranchBindings,BranchDefinition,ConversationDto,EngineDto,TriggerSourceConfig} from '@ponderosa/core';
import {BranchGraph} from './BranchGraph';
import {advancedSettingsNeedAttention,FailureEditor,NodeEditor} from './NodeEditor';
import {addNode,conditionBefore,nodeName,routeBefore} from './model';
function BranchTriggerSource({kind,config,onChange,onInvalid}:{kind:'schedule'|'webhook'|'filesystem';config:TriggerSourceConfig;onChange(config:TriggerSourceConfig):void;onInvalid(invalid:boolean):void}):JSX.Element {
 const draft=useTriggerSourceDraft(config),callbacks=useRef({onChange,onInvalid,config});callbacks.current={onChange,onInvalid,config};
 const values=JSON.stringify([kind,draft.scheduleKind,draft.onceAt,draft.intervalValue,draft.intervalUnit,draft.cronExpression,draft.timezone,draft.include,draft.exclude,draft.quietSeconds,draft.maxWindowSeconds]);
 useEffect(()=>{try{if(kind==='filesystem'&&(draft.filesystemErrors.quiet||draft.filesystemErrors.max)||kind==='schedule'&&draft.scheduleKind==='interval'&&draft.intervalInvalid)throw new Error('Invalid trigger source');const next=draft.configuration(kind,callbacks.current.config);callbacks.current.onInvalid(false);if(JSON.stringify(next)!==JSON.stringify(callbacks.current.config))callbacks.current.onChange(next)}catch{callbacks.current.onInvalid(true)}},[values]);
 useEffect(()=>()=>callbacks.current.onInvalid(false),[]);
 return <TriggerSourceFields sourceKind={kind} draft={draft}/>;
}
export function WorkflowEditor({definition,bindings,contexts,agents,engines,onDefinition,onBindings,onPendingEdits,agentFilter,availability,intake,triggerDirty=false,jsonOpen=false,onCloseJson,validationRequest=0,active=true,onInvalidStep}:{active?:boolean;onInvalidStep?():void;intake?:ReactNode;triggerDirty?:boolean;jsonOpen?:boolean;onCloseJson?():void;validationRequest?:number;availability?:ReactNode;agentFilter?:ReactNode;onPendingEdits?(pending:boolean):void;definition:BranchDefinition;bindings:BranchBindings;chatId:string;contexts:ConversationDto[];agents:AgentDto[];engines:EngineDto[];existing:boolean;onDefinition(value:BranchDefinition):void;onBindings(value:BranchBindings):void;onChat(id:string):void}):JSX.Element{
 const applyRequest=useRef(0),currentDefinition=useRef(definition);currentDefinition.current=definition;
 const [triggerInvalid,setTriggerInvalid]=useState(false);
 const [selected,setSelected]=useState<string>(),[editorOpen,setEditorOpen]=useState(false),[focusRequest,setFocusRequest]=useState(0),[addAnchor,setAddAnchor]=useState<HTMLElement|null>(null),[branching,setBranching]=useState(false),[advanced,setAdvanced]=useState<string>(),[jsonError,setJsonError]=useState('');
 // ponytail: side-by-side settings need 880px of workspace; lower this cutoff only with a denser shared editor.
 const addButton=useRef<HTMLButtonElement>(null),canvas=useRef<HTMLDivElement>(null),[wide,setWide]=useState(false);
 useLayoutEffect(()=>{const element=canvas.current;if(!element)return;const observer=new ResizeObserver(([entry])=>{if(entry&&entry.contentRect.width>0)setWide(entry.contentRect.width>=880)});observer.observe(element);return()=>observer.disconnect()},[]);
 const selectedNode=[...definition.steps,...definition.controls].find(node=>node.id===selected);
 const insertion=selectedNode?.id??definition.entry;
 const insertionNode=[...definition.steps,...definition.controls].find(node=>node.id===insertion);
 const restricted=definition.controls.some(control=>control.kind==='map'&&control.workerId===insertion)||Boolean(insertionNode&&['fork','condition','route','map'].includes(insertionNode.kind));
 const add=(kind:Parameters<typeof addNode>[1]|'condition'|'route')=>{const result=kind==='condition'?conditionBefore(definition,insertion):kind==='route'?routeBefore(definition,insertion):addNode(definition,kind,insertion);onDefinition(result.definition);setSelected(result.selected);setEditorOpen(true);setFocusRequest(value=>value+1);setAddAnchor(null)};
 useEffect(()=>{if(!validationRequest)return;const missing=definition.steps.find(step=>advancedSettingsNeedAttention(step,bindings)||step.kind==='script'&&(!step.source.trim()||!bindings.directories[step.cwdRef]?.trim())||step.kind==='agent'&&(!step.instructions.trim()||'ref'in step.target&&!bindings.agents[step.target.ref])||step.kind==='human_gate'&&!step.prompt.trim()||step.kind==='branch_call'&&!bindings.branches?.[step.branchRef]);if(missing){setSelected(missing.id);setEditorOpen(true);onInvalidStep?.()}else if(!definition.steps.length){onInvalidStep?.();addButton.current?.focus()}},[validationRequest]);
 useEffect(()=>{onPendingEdits?.(triggerInvalid||(advanced!==undefined&&advanced!==JSON.stringify(definition,null,2)))},[advanced,definition,onPendingEdits,triggerInvalid]);
 useEffect(()=>()=>onPendingEdits?.(false),[onPendingEdits]);
 useEffect(()=>{if(!active)setAddAnchor(null)},[active]);
 const closeEditor=()=>{setEditorOpen(false);setFocusRequest(value=>value+1)};
 const source=definition.trigger.kind==='manual'?undefined:bindings.triggers?.[definition.trigger.configRef];
 const sourceConfig=source?.sourceConfig;
 const setSource=(sourceConfig:TriggerSourceConfig)=>{if(definition.trigger.kind!=='manual')onBindings({...bindings,triggers:{...bindings.triggers,[definition.trigger.configRef]:{enabled:source?.enabled??true,sourceConfig}}})};
 const setTrigger=(kind:BranchDefinition['trigger']['kind'])=>{
  onDefinition({...definition,trigger:kind==='manual'?{kind}:{kind,configRef:'source'}});
  if(kind==='manual'){
   const next={...bindings};delete next.triggers;onBindings(next);
  }else onBindings({...bindings,triggers:{source:{enabled:true,sourceConfig:kind==='schedule'?{scheduleKind:'interval',everyMs:3600000,startsAt:new Date(Date.now()+60000).toISOString()}:kind==='webhook'?{replayWindowSeconds:300}:{include:['**/*'],exclude:[],quietMs:1000,maxWindowMs:10000}}}});
 };
 return <Stack ref={canvas} spacing={2.5} sx={{minWidth:0}}>
  <Stack component="section" aria-label="How it starts" spacing={1.5}>
   <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap"><Typography fontWeight={600} sx={{flex:1}}>How it starts</Typography>{triggerDirty&&<Typography variant="caption" color="warning.main">Unpublished changes</Typography>}{availability}</Stack>
   <TextField select label="Starts" size="small" value={definition.trigger.kind} onChange={e=>setTrigger(e.target.value as BranchDefinition['trigger']['kind'])}><MenuItem value="manual">Manually</MenuItem><MenuItem value="schedule">On a schedule</MenuItem><MenuItem value="webhook">When a webhook arrives</MenuItem><MenuItem value="filesystem">When files change</MenuItem></TextField>
   {definition.trigger.kind!=='manual'&&sourceConfig&&<BranchTriggerSource key={definition.trigger.kind} kind={definition.trigger.kind} config={sourceConfig} onChange={setSource} onInvalid={setTriggerInvalid}/>}
   {triggerInvalid&&<Alert severity="error">Correct the trigger fields before reviewing publication.</Alert>}
   {source&&definition.trigger.kind!=='manual'&&<FormControlLabel control={<Switch checked={source.enabled} onChange={(_,enabled)=>{if(definition.trigger.kind!=='manual')onBindings({...bindings,triggers:{...bindings.triggers,[definition.trigger.configRef]:{...source,enabled}}})}}/>} label="Automatic intake after publication"/>}
   {intake}
  </Stack>
  <Stack direction="row" spacing={1} alignItems="center"><Typography variant="h6" sx={{flex:1}}>Workflow</Typography><Button ref={addButton} variant="outlined" aria-haspopup="menu" aria-expanded={Boolean(addAnchor)} onClick={event=>{setBranching(false);setAddAnchor(event.currentTarget)}}>{definition.steps.length+definition.controls.length?'Add step':'Add your first step'}</Button></Stack>
  <Menu anchorEl={addAnchor} open={Boolean(addAnchor)} onClose={()=>setAddAnchor(null)}>
   {branching?<MenuItem onClick={()=>setBranching(false)}>← All steps</MenuItem>:null}
   <Box sx={{px:2,py:1,maxWidth:280}}><Typography variant="caption" color="text.secondary">{restricted?'Select an ordinary step or a Join to add follow-up work.':insertionNode?`After ${nodeName(insertionNode)}`:'First step'}</Typography></Box>
   {branching&&!definition.steps.some(node=>node.id===insertion)&&<Box sx={{px:2,maxWidth:280}}><Typography variant="caption">Conditions and named routes need an ordinary step selected as their destination.</Typography></Box>}
   {(branching?[['condition','Condition · before selected step'],['route','Named routes · before selected step'],['parallel','Parallel paths · after selected step'],['for_each','For Each · after selected step']]:[['agent','Agent task'],['human_gate','Approval'],['action','Notification'],['branch_call','Run another workflow'],['script','Script']]).map(([kind,label])=><MenuItem key={kind} disabled={restricted||((kind==='condition'||kind==='route')&&!definition.steps.some(node=>node.id===insertion))} onClick={()=>add(kind as Parameters<typeof add>[0])}>{label}</MenuItem>)}
   {!branching&&<MenuItem onClick={()=>setBranching(true)}>Branching…</MenuItem>}
  </Menu>
  <Box sx={{display:'grid',gridTemplateColumns:editorOpen&&selectedNode&&wide?'minmax(0,1fr) minmax(300px,360px)':'minmax(0,1fr)',gap:2,alignItems:'start',minWidth:0}}><BranchGraph definition={definition} selected={selected} onSelect={id=>{setSelected(id);setEditorOpen(true)}} focusRequest={editorOpen&&!wide?0:focusRequest}/>{wide&&editorOpen&&selectedNode&&<NodeEditor key={selectedNode.id} onClose={closeEditor} validationRequest={active?validationRequest:0} agentFilter={agentFilter} definition={definition} nodeId={selectedNode.id} onChange={onDefinition} onRemove={next=>{setSelected(next);setFocusRequest(value=>value+1)}} bindings={bindings} onBindings={onBindings} contexts={contexts} agents={agents} engines={engines}/>}</Box>
  <Drawer anchor="right" open={active&&!jsonOpen&&editorOpen&&!wide&&Boolean(selectedNode)} onClose={closeEditor} slotProps={{paper:{sx:{width:{xs:'100%',sm:420},maxWidth:'100%'}}}}>{!wide&&editorOpen&&selectedNode&&<NodeEditor key={selectedNode.id} onClose={closeEditor} validationRequest={active?validationRequest:0} agentFilter={agentFilter} definition={definition} nodeId={selectedNode.id} onChange={onDefinition} onRemove={next=>{setSelected(next);setFocusRequest(value=>value+1)}} bindings={bindings} onBindings={onBindings} contexts={contexts} agents={agents} engines={engines}/>}</Drawer>
  <Accordion disableGutters><AccordionSummary expandIcon={<ExpandMoreIcon/>}>Workflow variables</AccordionSummary><AccordionDetails><ParameterDefinitions definition={definition} onChange={onDefinition}/></AccordionDetails></Accordion>
  <Dialog open={jsonOpen} onClose={onCloseJson} fullWidth maxWidth="md"><DialogTitle>Edit workflow JSON</DialogTitle><DialogContent><Stack spacing={1} sx={{pt:1}}>{jsonError&&<Alert severity="error">{jsonError}</Alert>}<TextField label="Definition JSON" multiline minRows={10} maxRows={24} value={advanced??JSON.stringify(definition,null,2)} onChange={e=>{applyRequest.current++;setAdvanced(e.target.value)}} slotProps={{input:{sx:{fontFamily:'monospace',fontSize:12}}}}/><Button onClick={async()=>{const requestId=++applyRequest.current,startedDefinition=definition;try{const parsed=await requestJson<{definition:BranchDefinition}>('/api/branches/import-preview',{method:'POST',body:JSON.stringify({schema:'ponderosa.branch-package.v1',exportedAt:new Date().toISOString(),definition:JSON.parse(advanced??JSON.stringify(definition))})});if(requestId!==applyRequest.current)return;if(startedDefinition!==currentDefinition.current){setJsonError('The workflow changed while validating. Your JSON is retained; review it before applying again.');return;}onDefinition(parsed.definition);setAdvanced(undefined);setJsonError('')}catch(error){setJsonError(error instanceof Error?error.message:'Invalid JSON')}}}>Apply definition</Button><Button onClick={()=>{applyRequest.current++;setAdvanced(undefined);setJsonError('')}}>Discard advanced edits</Button></Stack></DialogContent><DialogActions><Button onClick={onCloseJson}>Close</Button></DialogActions></Dialog>
 </Stack>;
}

/** Definition policy edits use the same draft owner as the canvas. */
export function WorkflowExecutionSettings({definition,onDefinition,bindings,onBindings,agents,contexts}:Pick<Parameters<typeof WorkflowEditor>[0],'definition'|'onDefinition'|'bindings'|'onBindings'|'agents'|'contexts'>):JSX.Element {
 return <Stack component="section" aria-label="Execution settings" spacing={2}><Typography variant="h6">Execution settings</Typography>
  {([['maxConcurrentExecutions','Concurrent executions',2],['maxEphemeralAgents','Temporary Agents per execution',100],['maxPathInstances','Maximum paths',1000],['maxStepInvocations','Maximum step invocations',1000]] as const).map(([field,label,fallback])=><TextField key={field} label={label} type="number" size="small" inputProps={{min:1,max:field==='maxConcurrentExecutions'?1000:100000,step:1}} error={!Number.isSafeInteger(definition.policy[field]??fallback)||(definition.policy[field]??fallback)<1||(definition.policy[field]??fallback)>(field==='maxConcurrentExecutions'?1000:100000)} value={definition.policy[field]??fallback} onChange={e=>onDefinition({...definition,policy:{...definition.policy,[field]:Number(e.target.value)}})}/>)}
  <FailureEditor value={definition.policy.failure} onChange={failure=>onDefinition({...definition,policy:{...definition.policy,failure:failure??{action:'stop'}}})} bindings={bindings} onBindings={onBindings} agents={agents} contexts={contexts}/>
 </Stack>;
}
