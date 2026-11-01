import type {BranchDefinition,BranchResult,BranchSharedStateDto,BranchStateValue} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
type Row=Record<string,any>;
const object=(v:unknown):v is Record<string,BranchStateValue>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** State is a projection of immutable successful seals, never a second mutable store. */
export function branchSharedState(definition:BranchDefinition,steps:Row[],seals:Row[]):BranchSharedStateDto {
 const values=Object.fromEntries(Object.entries(definition.state??{}).map(([key,c])=>[key,structuredClone(c.initial)]));
 const updates:{stepId:string;result:BranchResult}[]=[];
 for(const seal of seals){
  if(payloadHash(JSON.parse(seal.result_json))!==seal.content_hash)throw Error('State result hash differs');
  const result=JSON.parse(seal.result_json) as BranchResult,step=steps.find(s=>s.id===seal.step_execution_id),node=definition.steps.find(s=>s.id===step?.step_id);
  if(!step||!node)throw Error('State result Step unavailable');
  if(!result.failed&&node.stateWrites?.length){
   if(!result.stateUpdate)throw Error('Declared state write is missing its immutable revision');
   updates.push({stepId:step.step_id,result});
  }else if(result.stateUpdate!==undefined)throw Error('Undeclared state update');
 }
 updates.sort((a,b)=>a.result.stateUpdate!.revision-b.result.stateUpdate!.revision);
 let revision=0;
 for(const item of updates){
  const update=item.result.stateUpdate!,node=definition.steps.find(s=>s.id===item.stepId)!;
  if(update.revision!==++revision||stableJson(Object.keys(update).sort())!==stableJson(['revision','updates']))throw Error('State revision is missing or aliased');
  const parsed=JSON.parse(item.result.output??'');
  if(!object(parsed)||stableJson(parsed)!==stableJson(update.updates)||Object.keys(parsed).some(key=>!node.stateWrites!.includes(key)))throw Error('State writes differ from declared result');
  for(const [key,value] of Object.entries(parsed)){
   const channel=definition.state?.[key];if(!channel||!Object.hasOwn(values,key))throw Error('Unknown state channel');
   if(channel.reducer==='append'){
    if(!Array.isArray(value)||!Array.isArray(values[key]))throw Error('Append state requires arrays');
    values[key]=[...values[key] as BranchStateValue[],...value];
   }else if(channel.reducer==='sum'){
    if(typeof value!=='number'||typeof values[key]!=='number'||!Number.isFinite(value+values[key]))throw Error('Sum state requires finite numbers');
    values[key]=value+values[key];
   }else values[key]=structuredClone(value);
  }
 }
 // Same portable definition bound; fixed JSON guards protect synchronous snapshot memory.
 const content={revision,values};stableJson(content,{maxDepth:32,maxNodes:100_000});
 if(Buffer.byteLength(stableJson(content))>1024*1024)throw Error('Shared state exceeds 1 MiB retained bound');
 return {...content,evidenceHash:payloadHash({channels:definition.state??{},updates:updates.map(item=>item.result.stateUpdate),...content})};
}
export function branchStateResult(definition:BranchDefinition,steps:Row[],seals:Row[],stepId:string,result:BranchResult):BranchResult {
 if(result.stateUpdate!==undefined)throw Error('Caller cannot supply a state revision');
 const node=definition.steps.find(s=>s.id===stepId);
 if(result.failed||!node?.stateWrites?.length)return result;
 const state=branchSharedState(definition,steps,seals),updates=JSON.parse(result.output??'');
 if(!object(updates))throw Error('State output must be a JSON object');
 const next={...result,stateUpdate:{revision:state.revision+1,updates}};
 // Validate the proposed write using the same projection used by reads and replay.
 branchSharedState(definition,[...steps,{id:'proposed-state-write',step_id:stepId}],[...seals,{step_execution_id:'proposed-state-write',result_json:stableJson(next),content_hash:payloadHash(next)}]);
 return next;
}
export function validateBranchStateSeal(definition:BranchDefinition,steps:Row[],prior:Row[],seal:Row):void {
 const result=JSON.parse(seal.result_json),step=steps.find(s=>s.id===seal.step_execution_id);
 if(!step)throw Error('State seal Step missing');
 const {stateUpdate,...plain}=result;
 if(stableJson(branchStateResult(definition,steps,prior,step.step_id,plain))!==seal.result_json)throw Error('State seal revision differs from canonical settlement order');
}
export function branchResultWithoutState(result:BranchResult):BranchResult {const {stateUpdate,...plain}=result;return plain;}
