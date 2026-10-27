import {branchScriptFailureSummary} from "@ponderosa/core";
import {createClientId} from '../../clientId.js';
import type { AgentPortablePackageDto, BranchBindings, BranchExecutionDetailDto, BranchControl, BranchDefinition, BranchStep } from '@ponderosa/core';
export type WorkflowNode=BranchStep|BranchControl;
export const nodeName=(node:WorkflowNode)=>node.label||node.id;
export const nodeKind=(node:WorkflowNode)=>node.kind==='agent'?({persistent_agent:'Agent',persistent_organization:'Organization',ephemeral_agent:'Temporary Agent',ephemeral_organization:'Temporary organization'}[node.target.kind]):({script:'Script',human_gate:'Human approval',condition:'Condition',route:'Choose route',fork:'Parallel paths',map:'For Each',join:'Join',action:'Notify me',branch_call:'Run Branch'}[node.kind]);
export const makeScript=(id:string):BranchStep=>({id,label:'Transform input',kind:'script',runtime:'node',source:"let input = '';\nfor await (const chunk of process.stdin) input += chunk;\nprocess.stdout.write(input);\n",cwdRef:'workspace',timeoutMs:30000});
export function makeTemplate(organization:boolean):AgentPortablePackageDto{
 const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
 return {schema:'ponderosa.agent-package.v1',mode:'template',kind:organization?'organization':'agent',exportedAt:new Date().toISOString(),sourceLabel:'Workflow team',rootRef:'lead',agents:[{ref:'lead',title:organization?'Team Lead':'Agent',engine:'default',managementPermissions:permissions},...(organization?[{ref:'worker',title:'Specialist',engine:'default',managerRef:'lead',managementPermissions:permissions}]:[])]};
}
export function newDefinition():BranchDefinition{return {schema:'ponderosa.branch.v1',name:'Untitled workflow',trigger:{kind:'manual'},entry:'',steps:[],controls:[],edges:[],policy:{maxConcurrentExecutions:2,maxPathInstances:1000,maxStepInvocations:1000,maxEphemeralAgents:100,failure:{action:'stop'}}}}
export function addNode(definition:BranchDefinition,kind:BranchStep['kind']|'parallel'|'for_each',after?:string):{definition:BranchDefinition;selected:string}{
 const d=structuredClone(definition),id='step_'+createClientId(),previous=after?[...d.steps,...d.controls].find(n=>n.id===after):undefined;
 if(!d.steps.length&&!d.controls.length)d.entry=id;
 const outcome=previous?.kind==='human_gate'?'approved':'success';
 const forward=previous&&!['fork','map','condition','route'].includes(previous.kind)?d.edges.find(e=>e.from===after&&e.on===outcome):undefined;
 if(forward)d.edges=d.edges.filter(e=>e.id!==forward.id);
 const link=(from:string,to:string,on:BranchDefinition['edges'][number]['on']='success')=>d.edges.push({id:'edge_'+createClientId(),from,to,on});
 if(kind==='parallel'){
  const join=id+'_join',a=id+'_a',b=id+'_b';d.controls.push({id,kind:'fork',label:'Parallel work',joinId:join},{id:join,kind:'join',label:'Combine results',forkId:id,mode:'all',remainder:'finish',inputOrder:[id+'_left',id+'_right']});
  d.steps.push({...makeScript(a),label:'First path'},{...makeScript(b),label:'Second path'});d.edges.push({id:id+'_left',from:id,to:a,on:'selected'},{id:id+'_right',from:id,to:b,on:'selected'});link(a,join);link(b,join);if(forward)link(join,forward.to);
 }else if(kind==='for_each'){
  const join=id+'_join',worker=id+'_worker';
  d.controls.push({id,kind:'map',label:'For Each item',joinId:join,workerId:worker,source:'interpret',maxItems:100,maxConcurrentItems:4},{id:join,kind:'join',label:'Wait for items',forkId:id,mode:'all',remainder:'finish',inputOrder:[]});
  d.steps.push({id:worker,label:'Review item',kind:'agent',target:{kind:'persistent_agent',ref:worker},instructions:''});
  d.edges.push({id:id+'_item',from:id,to:worker,on:'selected'});link(worker,join);if(forward)link(join,forward.to);
 }else{
  const node:BranchStep=kind==='branch_call'?{id,label:'Run Branch',kind,branchRef:id}:kind==='script'?makeScript(id):kind==='human_gate'?{id,label:'Review result',kind,prompt:'Review the proposed result.',editable:true}:kind==='action'?{id,label:'Notify me',kind,action:'notify',configRefs:[]}:{id,label:'Agent work',kind:'agent',target:{kind:'persistent_agent',ref:id},instructions:''};
  d.steps.push(node);if(forward)link(id,forward.to,kind==='human_gate'?'approved':'success');
 }
 if(previous&&!['fork','map','condition','route'].includes(previous.kind))link(previous.id,id,outcome);
 return {definition:d,selected:id};
}
export function conditionBefore(definition:BranchDefinition,nodeId:string):{definition:BranchDefinition;selected:string}{
 const d=structuredClone(definition),id='condition_'+createClientId(),skip='skip_'+createClientId();
 // Both explicit routes remain authorable. The fallback is a separate identity with a valid terminal result.
 d.steps.push({...makeScript(skip),label:'Otherwise'});d.controls.push({id,label:'Choose a path',kind:'condition',predicate:{source:'input',equals:'yes'},otherwise:skip});
 for(const edge of d.edges)if(edge.to===nodeId)edge.to=id;
 if(d.entry===nodeId)d.entry=id;
 const next=d.edges.find(e=>e.from===nodeId&&(e.on==='success'||e.on==='approved'));if(next)d.edges.push({id:skip+'_next',from:skip,to:next.to,on:'success'});
 d.edges.push({id:id+'_yes',from:id,to:nodeId,on:'selected'},{id:id+'_no',from:id,to:skip,on:'failure'});
 return {definition:d,selected:id};
}
export function routeBefore(definition:BranchDefinition,nodeId:string):{definition:BranchDefinition;selected:string}{
 const d=structuredClone(definition),id='route_'+createClientId(),fallback='fallback_'+createClientId();
 d.steps.push({...makeScript(fallback),label:'Otherwise'});
 d.controls.push({id,label:'Ask which route to take',kind:'route',otherwise:fallback});
 for(const edge of d.edges)if(edge.to===nodeId)edge.to=id;
 if(d.entry===nodeId)d.entry=id;
 const next=d.edges.find(e=>e.from===nodeId&&(e.on==='success'||e.on==='approved'));
 if(next)d.edges.push({id:fallback+'_next',from:fallback,to:next.to,on:'success'});
 d.edges.push({id:id+'_choice',from:id,to:nodeId,on:'selected',choice:'First route'},{id:id+'_otherwise',from:id,to:fallback,on:'failure'});
 return {definition:d,selected:id};
}

export type WorkflowNodeRemoval =
 | {ok:true;definition:BranchDefinition;nextSelected:string}
 | {ok:false;reason:string};

/** Remove a Step while preserving the graph invariants required by deployment. */
export function removeWorkflowNode(definition:BranchDefinition,nodeId:string):WorkflowNodeRemoval{
 const nodes=[...definition.steps,...definition.controls],node=nodes.find(item=>item.id===nodeId);
 if(!node)return {ok:false,reason:'This Step no longer exists.'};
 if(node.kind==='fork'||node.kind==='join'||node.kind==='map'||definition.controls.some(c=>c.kind==='map'&&c.workerId===nodeId))return {ok:false,reason:'Edit the complete parallel or For Each group in the advanced definition before removing one of its required parts.'};
 if(nodes.length<=1)return {ok:false,reason:'Every workflow needs at least one Step. Add another Step before removing this one.'};
 const successorEdge=definition.edges.find(edge=>edge.from===nodeId&&(edge.on==='success'||edge.on==='approved'));
 const successor=successorEdge?.to!==nodeId&&nodes.some(item=>item.id===successorEdge?.to)?successorEdge?.to:undefined;
 const fallbackOwners=definition.controls.filter(control=>(control.kind==='condition'||control.kind==='route')&&control.otherwise===nodeId);
 if(fallbackOwners.length&&!successor)return {ok:false,reason:'This Step is a Condition fallback with no next Step. Route it onward or choose another fallback before removing it.'};
 const remainingNodes=nodes.filter(item=>item.id!==nodeId),remainingIds=new Set(remainingNodes.map(item=>item.id));
 const edges=definition.edges
  .filter(edge=>edge.from!==nodeId&&(edge.to!==nodeId||Boolean(successor)))
  .map(edge=>edge.to===nodeId?{...edge,to:successor!}:edge);
 const controls=definition.controls.filter(control=>control.id!==nodeId).map(control=>(control.kind==='condition'||control.kind==='route')&&control.otherwise===nodeId?{...control,otherwise:successor!}:control);
 const next={...definition,entry:definition.entry===nodeId?(successor??remainingNodes[0]!.id):definition.entry,steps:definition.steps.filter(step=>step.id!==nodeId),controls,edges};
 const invalidEdge=edges.some(edge=>!remainingIds.has(edge.from)||!remainingIds.has(edge.to));
 const invalidControl=controls.some(control=>{
  if(control.kind==='condition'){
   const outgoing=edges.filter(edge=>edge.from===control.id);
   return !remainingIds.has(control.otherwise)||outgoing.length!==2||!outgoing.some(edge=>edge.on==='selected')||!outgoing.some(edge=>edge.on==='failure'&&edge.to===control.otherwise);
  }
  if(control.kind==='route')return !remainingIds.has(control.otherwise)||!edges.some(edge=>edge.from===control.id&&edge.on==='failure'&&edge.to===control.otherwise)||!edges.some(edge=>edge.from===control.id&&edge.on==='selected');
  if(control.kind==='fork'){
   const join=controls.find(candidate=>candidate.id===control.joinId);
   const outgoing=edges.filter(edge=>edge.from===control.id);
   return join?.kind!=='join'||join.forkId!==control.id||outgoing.length<2||join.inputOrder.length!==outgoing.length||outgoing.some(edge=>!join.inputOrder.includes(edge.id));
  }
  if(control.kind==='map')return !remainingIds.has(control.workerId)||!remainingIds.has(control.joinId)||!edges.some(edge=>edge.from===control.id&&edge.to===control.workerId);
  const fork=controls.find(candidate=>candidate.id===control.forkId);
  return (fork?.kind!=='fork'&&fork?.kind!=='map')||fork.joinId!==control.id;
 });
 if(invalidEdge||invalidControl)return {ok:false,reason:'Removing this Step would break a Condition or Parallel path. Re-route that path before removing it.'};
 return {ok:true,definition:next,nextSelected:successor??remainingNodes[0]!.id};
}

/** Stable graph layers ignore declared loop-back edges while retaining them for rendering. */
export function workflowGraphLevels(definition:BranchDefinition):Map<string,number>{
 const nodes=[...definition.steps,...definition.controls],forwardEdges=definition.edges.filter(edge=>!edge.loop),levels=new Map<string,number>();
 const indegree=new Map(nodes.map(node=>[node.id,forwardEdges.filter(edge=>edge.to===node.id).length])),queue=nodes.filter(node=>indegree.get(node.id)===0).map(node=>node.id);
 for(const id of queue)levels.set(id,0);
 for(let index=0;index<queue.length;index++){
  const id=queue[index]!;
  for(const edge of forwardEdges.filter(item=>item.from===id)){
   levels.set(edge.to,Math.max(levels.get(edge.to)??0,(levels.get(id)??0)+1));
   indegree.set(edge.to,(indegree.get(edge.to)??1)-1);
   if(indegree.get(edge.to)===0)queue.push(edge.to);
  }
 }
 for(const node of nodes)if(!levels.has(node.id))levels.set(node.id,0);
 return levels;
}

/** Initialize new Script bindings from the selected Chat without rewriting explicit folders. */
export function bindDefinitionDirectories(definition:BranchDefinition,bindings:import('@ponderosa/core').BranchBindings,folder?:string):import('@ponderosa/core').BranchBindings{
 return {...bindings,directories:Object.fromEntries(definition.steps.filter(s=>s.kind==='script').map(s=>[s.cwdRef,bindings.directories[s.cwdRef]??folder??'']))};
}

type BranchDraftRevisionInput={definition:BranchDefinition;bindings:BranchBindings;chatId:string;branchId?:string;expectedVersionId?:string};
function sortJson(value:unknown):unknown{
 if(Array.isArray(value))return value.map(sortJson);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sortJson(item)]));
 return value;
}
/** Compare the effective deployable draft, excluding stale bindings that its definition cannot use. */
export function branchDraftRevision(draft:BranchDraftRevisionInput):string{
 const bindings=structuredClone(draft.bindings);
 if(draft.definition.trigger.kind==='manual')delete bindings.triggers;
 else if(bindings.triggers){
  const source=bindings.triggers[draft.definition.trigger.configRef];
  bindings.triggers=source?{[draft.definition.trigger.configRef]:source}:{};
 }
 for(const field of ['branches','engines','triggers'] as const)if(bindings[field]&&Object.keys(bindings[field]!).length===0)delete bindings[field];
 return JSON.stringify(sortJson({...draft,bindings}));
}
/** A response belongs to the selection that initiated it, even if a user switches away and back. */
export function isCurrentWorkflowResponse(started:{branchId?:string;selection:number},current:{branchId?:string;selection:number}):boolean{return started.branchId===current.branchId&&started.selection===current.selection}

/** Only current failed invocations need attention; historical failed retry attempts do not. */
export function currentFailedInvocations(detail:BranchExecutionDetailDto):BranchExecutionDetailDto['steps']{
 return detail.steps.filter(step=>(step.state==='failed'||step.state==='outcome_unknown')&&detail.paths.some(path=>path.id===step.pathId&&path.stepExecutionId===step.id&&!['arrived','canceled','completed','skipped'].includes(path.state)));
}
export function executionFailures(detail:BranchExecutionDetailDto):{stepId:string;invocationId:string;reason:string}[]{
 return currentFailedInvocations(detail).map(step=>{
  const attempt=detail.attempts.filter(a=>a.stepExecutionId===step.id).sort((a,b)=>b.number-a.number)[0];
  const reason=attempt?.error||(attempt?.scriptEvidence?branchScriptFailureSummary(attempt.scriptEvidence.code,attempt.scriptEvidence.error):undefined)||attempt?.result?.output||step.result?.output||(step.state==='outcome_unknown'?'The previous attempt’s outcome is unknown. Review its effects before retrying.':'The Engine did not record a failure explanation. Open the Step for available evidence.');
  return {stepId:step.stepId,invocationId:step.id,reason};
 });
}

/** The explicit failure edge is the runtime's first choice; inactive policies are retained. */
export function effectiveStepFailure(definition:BranchDefinition,node:BranchStep):string {
 return definition.edges.some(edge=>edge.from===node.id&&edge.on==='failure')?'goto':node.failure?.action??'inherit';
}
export function setStepFailure(definition:BranchDefinition,nodeId:string,failure:BranchStep['failure']):BranchDefinition {
 return {...definition,steps:definition.steps.map(step=>step.id===nodeId?{...step,failure}:step),edges:definition.edges.filter(edge=>edge.from!==nodeId||edge.on!=='failure')};
}
export function workflowIncoming(definition:BranchDefinition,nodeId:string):Array<{id:string;label:string;custom:boolean}> {
 const nodes=[...definition.steps,...definition.controls];
 return [...(definition.entry===nodeId?[{id:'workflow-input',label:'Workflow Input',custom:false}]:[]),...definition.edges.filter(edge=>edge.to===nodeId).map(edge=>({id:edge.id,label:nodeName(nodes.find(node=>node.id===edge.from)??{id:edge.from} as WorkflowNode),custom:edge.input?.kind==='literal'}))];
}
/** Remove a displaced template only when no other step uses it; the editor retains its unpublished form values. */
export function changeAgentTarget(definition:BranchDefinition,node:Extract<BranchStep,{kind:'agent'}>,target:Extract<BranchStep,{kind:'agent'}>['target']):BranchDefinition {
 const steps=definition.steps.map(step=>step.id===node.id?{...node,target}:step),templates={...definition.templates};
 if('templateRef'in node.target&&!steps.some(step=>step.kind==='agent'&&'templateRef'in step.target&&step.target.templateRef===('templateRef'in node.target?node.target.templateRef:'')))delete templates[node.target.templateRef];
 return {...definition,steps,...(definition.templates?{templates}:{})};
}
export function selectTemporaryAgent(definition:BranchDefinition,node:Extract<BranchStep,{kind:'agent'}>,organization:boolean,retained:NonNullable<BranchDefinition['templates']>={}):BranchDefinition {
 const kind=organization?'organization':'agent',current='templateRef'in node.target?definition.templates?.[node.target.templateRef]:undefined;
 const templateRef=current?.kind===kind&&'templateRef'in node.target?node.target.templateRef:node.id+'_'+kind+'_template';
 const legacy=definition.templates?.[node.id+'_template']??retained[node.id+'_template'];
 const template=definition.templates?.[templateRef]??retained[templateRef]??(legacy?.kind===kind?legacy:makeTemplate(organization));
 const next=changeAgentTarget(definition,node,{kind:organization?'ephemeral_organization':'ephemeral_agent',templateRef});
 return {...next,templates:{...next.templates,[templateRef]:template}};
}
