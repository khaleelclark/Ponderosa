import type {BranchDefinition, BranchStep} from '@ponderosa/core';
import {createClientId} from '../../clientId.js';
import {addNode, conditionBefore, newDefinition, routeBefore, type WorkflowNode} from './model.js';

type Edge = BranchDefinition['edges'][number];
export type GuidedStepKind = BranchStep['kind'] | 'parallel' | 'for_each' | 'condition' | 'route';
export type GuidedInsertionTarget =
 | {kind:'entry'}
 | {kind:'edge';edgeId:string}
 | {kind:'terminal';nodeId:string;on:Edge['on']};
export type GuidedInsertionResult = {ok:true;definition:BranchDefinition;selected:string} | {ok:false;reason:string};

const outcomes=(node:WorkflowNode):Edge['on'][]=>node.kind==='condition'||node.kind==='route'?['selected','failure']:node.kind==='fork'||node.kind==='map'?['selected']:node.kind==='human_gate'?['approved','rejected']:node.kind==='branch_call'?['success','failure','canceled']:['success','failure'];
const mapBoundary='For Each has one worker connected directly to its Join. Edit that worker, or add a Step before For Each or after its Join.';

/** Explain fixed relationships before opening the shared insertion menu. */
export function guidedInsertionRestriction(definition:BranchDefinition,target:GuidedInsertionTarget):string|undefined {
 const nodes=[...definition.steps,...definition.controls];
 if(target.kind==='entry')return nodes.length&&!nodes.some(node=>node.id===definition.entry)?'Choose a valid workflow entry before adding a Step.':undefined;
 const edge=target.kind==='edge'?definition.edges.find(item=>item.id===target.edgeId):undefined;
 if(target.kind==='edge'&&!edge)return 'This connection no longer exists.';
 const node=nodes.find(item=>item.id===(target.kind==='terminal'?target.nodeId:edge!.from));
 if(!node||edge&&!nodes.some(item=>item.id===edge.to))return 'This Step or its connection no longer exists.';
 if(node.kind==='map'||definition.controls.some(control=>control.kind==='map'&&control.workerId===node.id))return mapBoundary;
 if(target.kind==='terminal') {
  if(node.kind==='fork'||node.kind==='condition'||node.kind==='route')return 'Add a Step on one of this control’s existing connections.';
  if(!outcomes(node).includes(target.on))return 'This outcome does not belong to the selected Step.';
  if(definition.edges.some(item=>item.from===node.id&&item.on===target.on))return 'This outcome already has a connection. Add the Step on that connection instead.';
 }
 return undefined;
}

/** A topology guard for one draft edit, not a substitute for server publication validation. */
function structuralDraftError(definition:BranchDefinition):string|undefined {
 const nodes=[...definition.steps,...definition.controls],byId=new Map(nodes.map(node=>[node.id,node]));
 if(byId.size!==nodes.length||!byId.has(definition.entry)||new Set(definition.edges.map(edge=>edge.id)).size!==definition.edges.length)return 'The draft contains a duplicate identity or invalid entry.';
 if(definition.steps.length>100||definition.controls.length>100||definition.edges.length>500)return 'This insertion would exceed the existing workflow size limit.';
 const outgoing=new Map(nodes.map(node=>[node.id,definition.edges.filter(edge=>edge.from===node.id)]));
 if(definition.edges.some(edge=>!byId.has(edge.from)||!byId.has(edge.to)))return 'The draft contains a connection to a missing Step.';
 for(const node of nodes) {
  const edges=outgoing.get(node.id)!;
  if(edges.some(edge=>!outcomes(node).includes(edge.on))||!['fork','map','route'].includes(node.kind)&&new Set(edges.map(edge=>edge.on)).size!==edges.length)return 'The draft contains an invalid or ambiguous outcome connection.';
  if(node.kind==='condition'||node.kind==='route') {
   if(!byId.has(node.otherwise)||!edges.some(edge=>edge.on==='failure'&&edge.to===node.otherwise)||!edges.some(edge=>edge.on==='selected')||node.kind==='condition'&&edges.length!==2)return 'The draft’s condition or route connections need correction first.';
  } else if(node.kind==='fork'||node.kind==='map') {
   const join=byId.get(node.joinId);
   if(join?.kind!=='join'||join.forkId!==node.id)return 'The draft’s parallel or For Each Join needs correction first.';
   if(node.kind==='fork'&&(edges.length<2||join.inputOrder.length!==edges.length||new Set(join.inputOrder).size!==edges.length||edges.some(edge=>!join.inputOrder.includes(edge.id))))return 'The draft’s parallel paths and Join order need correction first.';
   if(node.kind==='map') {
    const worker=definition.steps.find(step=>step.id===node.workerId),workerEdges=outgoing.get(node.workerId);
    if(!worker||edges.length!==1||edges[0]?.to!==node.workerId||edges[0]?.on!=='selected'||workerEdges?.length!==1||workerEdges[0]?.to!==node.joinId||workerEdges[0]?.on!=='success'||join.inputOrder.length)return mapBoundary;
   }
  } else if(node.kind==='join') {
   const owner=byId.get(node.forkId);
   if((owner?.kind!=='fork'&&owner?.kind!=='map')||owner.joinId!==node.id)return 'The draft contains an unpaired Join.';
  }
 }
 const visited=new Set<string>(),visiting=new Set<string>();
 const visit=(id:string):boolean=>{
  if(visiting.has(id))return false;
  if(visited.has(id))return true;
  visiting.add(id);
  for(const edge of outgoing.get(id)!)if(!edge.loop&&!visit(edge.to))return false;
  visiting.delete(id);visited.add(id);return true;
 };
 if(!visit(definition.entry)||visited.size!==nodes.length)return 'The draft contains an undeclared loop or an unreachable Step.';
 const contexts=new Map<string,string>();
 const inContext=(id:string,stack:string[]):boolean=>{
  const key=JSON.stringify(stack),previous=contexts.get(id);
  if(previous!==undefined)return previous===key;
  contexts.set(id,key);
  const node=byId.get(id)!;
  let next=stack;
  if(node.kind==='fork'||node.kind==='map')next=[...stack,node.id];
  if(node.kind==='join') {
   if(stack.at(-1)!==node.forkId)return false;
   next=stack.slice(0,-1);
  }
  const edges=outgoing.get(id)!;
  return !(!edges.length&&next.length)&&edges.every(edge=>inContext(edge.to,next));
 };
 return inContext(definition.entry,[])?undefined:'This insertion would leave a parallel path outside its paired Join.';
}

/** Build only the new subgraph with established factories; never let addNode rewire an authored edge. */
function insertionGraph(kind:GuidedStepKind):{definition:BranchDefinition;selected:string} {
 if(kind==='condition'||kind==='route') {
  const first=addNode(newDefinition(),'script');
  return kind==='condition'?conditionBefore(first.definition,first.selected):routeBefore(first.definition,first.selected);
 }
 return addNode(newDefinition(),kind);
}

/** Retain the exact incoming edge identity/outcome/input; only its destination changes. */
export function insertGuidedStep(definition:BranchDefinition,kind:GuidedStepKind,target:GuidedInsertionTarget):GuidedInsertionResult {
 const restriction=guidedInsertionRestriction(definition,target);
 if(restriction)return {ok:false,reason:restriction};
 const next=structuredClone(definition),added=insertionGraph(kind),entry=added.definition.entry;
 const edge=target.kind==='edge'?next.edges.find(item=>item.id===target.edgeId):undefined;
 const destination=target.kind==='entry'?next.entry||undefined:edge?.to;
 next.steps.push(...added.definition.steps);next.controls.push(...added.definition.controls);next.edges.push(...added.definition.edges);
 if(target.kind==='entry')next.entry=entry;
 else if(target.kind==='terminal')next.edges.push({id:createClientId('edge_'),from:target.nodeId,to:entry,on:target.on});
 else {
  edge!.to=entry;
  // A new Step must be reachable without a loop. Move the return marker onto the
  // continuation, retaining the original edge ID, routing outcome and input.
  if(edge!.loop)delete edge!.loop;
  for(const control of next.controls)if((control.kind==='condition'||control.kind==='route')&&control.id===edge!.from&&edge!.on==='failure')control.otherwise=entry;
 }
 if(destination) {
  const terminals=[...added.definition.steps,...added.definition.controls].filter(node=>!added.definition.edges.some(item=>item.from===node.id));
  for(const node of terminals)next.edges.push({id:createClientId('edge_'),from:node.id,to:destination,on:node.kind==='human_gate'?'approved':'success',...(target.kind==='edge'&&definition.edges.find(item=>item.id===target.edgeId)?.loop?{loop:true}:{})});
 }
 const error=structuralDraftError(next);
 return error?{ok:false,reason:error}:{ok:true,definition:next,selected:added.selected};
}
