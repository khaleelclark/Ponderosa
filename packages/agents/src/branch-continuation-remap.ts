import {createHash} from 'node:crypto';
import {stableJson} from './coordination-v3-canonical-json.js';
import type {Selected} from './branch-script-continuation.js';
type Row=Record<string,any>;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const identityTables=['paths','steps','attempts','sealedResults','gates','forks','items','bundles'] as const;

/** A Map and its Fork intentionally share one identity; no other aliases are valid. */
export function branchContinuationIds(selected:Selected):string[] {
 const ids=identityTables.flatMap(key=>selected[key]!.map(row=>row.id));
 if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw Error('Duplicate continuation identity');
 const forks=new Set(selected.forks!.map(row=>row.id)),maps=new Set<string>();
 for(const row of selected.maps!){if(!forks.has(row.id)||maps.has(row.id))throw Error('Map requires one owned Fork identity');maps.add(row.id);}
 return ids;
}

/** Remap only typed ownership links. Authored text and graph node/edge keys stay intact. */
export function remapBranchFrontier(selected:Selected,ids:Record<string,string>,source:string,target:string,requestMap?:Record<string,string>):Selected {
 const keys=branchContinuationIds(selected);
 if(source===target||!target||keys.includes(target)||Object.keys(ids).some(key=>!keys.includes(key))
   ||keys.some(key=>typeof ids[key]!=='string'||!ids[key]||ids[key]===target||ids[key]===source||keys.includes(ids[key]!))
   ||new Set(Object.values(ids)).size!==keys.length)throw Error('Incomplete or aliased continuation ID map');
 const out=structuredClone(Object.fromEntries(['paths','steps','attempts','sealedResults','gates','forks','joins','loops','maps','items','bundles'].map(key=>[key,selected[key]!]))),members=(key:string)=>new Set(selected[key]!.map(row=>row.id));
 const paths=members('paths'),steps=members('steps'),attempts=members('attempts'),results=members('sealedResults'),forks=members('forks'),maps=members('maps'),bundles=members('bundles');
 const link=(id:string|null,owned:Set<string>):string|null=>{
  if(id===null)return null;
  if(!owned.has(id)||!ids[id])throw Error('Continuation link escapes its owner');
  return ids[id]!;
 };
 const execution=(row:Row)=>{if(row.execution_id!==source)throw Error('Continuation execution ownership mismatch');row.execution_id=target;};
 const text=(value:string):string=>{
  const match=/^branch-result-bundle:([0-9a-f-]{36}):([0-9a-f-]{36})$/u.exec(value);
  if(!match)return value;
  if(match[1]!==source||!bundles.has(match[2]!))throw Error('Result bundle requires captured local ownership');
  return `branch-result-bundle:${target}:${ids[match[2]!]}`;
 };
 const result=(value:string|null):string|null=>{
  if(value===null)return null;
  const parsed=JSON.parse(value);if(stableJson(parsed)!==value)throw Error('Noncanonical continuation result');
  if(typeof parsed.output==='string')parsed.output=text(parsed.output);
  return stableJson(parsed);
 };
 for(const row of out.paths!){
  if(row.step_execution_id!==null&&!selected.steps!.some(step=>step.id===row.step_execution_id&&step.path_id===row.id)||row.last_result_id!==null&&!selected.sealedResults!.some(result=>result.id===row.last_result_id&&result.path_id===row.id))throw Error('Path Step or result ownership mismatch');
  if(row.fork_invocation_id!==null&&!selected.forks!.some(fork=>fork.id===row.fork_invocation_id&&fork.parent_path_id===row.parent_path_id))throw Error('Nested path escapes its Fork parent');
  execution(row);row.id=ids[row.id];row.parent_path_id=link(row.parent_path_id,paths);row.fork_invocation_id=link(row.fork_invocation_id,forks);
  row.step_execution_id=link(row.step_execution_id,steps);row.last_result_id=link(row.last_result_id,results);row.input_text=text(row.input_text);row.result_json=result(row.result_json);
 }
 // Parent insertion order cannot be inferred from UUID sorting, including nested Forks.
 const pending=[...out.paths!],ordered:Row[]=[];
 while(pending.length){const index=pending.findIndex(row=>row.parent_path_id===null||ordered.some(parent=>parent.id===row.parent_path_id));if(index<0)throw Error('Cyclic continuation path ancestry');ordered.push(pending.splice(index,1)[0]!);}
 out.paths=ordered;
 for(const row of out.steps!){execution(row);row.id=ids[row.id];row.path_id=link(row.path_id,paths);row.input_text=text(row.input_text);row.result_json=result(row.result_json);}
 for(const row of out.attempts!){
  if(Object.keys(row).some(key=>!['id','step_execution_id','number','state','request_id','fence','input_hash','result_json','available_at','purpose','recovery_of_request_id','cancel_requested','runtime_outcome_json','error','created_at','updated_at'].includes(key)))throw Error('Attempt contains unselected runtime state');
  if(row.request_id&&(!requestMap?.[row.request_id]||requestMap[row.request_id]===row.request_id||Object.hasOwn(requestMap,requestMap[row.request_id]!))||row.recovery_of_request_id||row.runtime_outcome_json||row.cancel_requested&&row.state!=='canceled'||!['prepared','waiting','completed','failed','canceled'].includes(row.state))throw Error('Runtime authority or uncertain effect cannot be remapped');
  if(row.request_id)row.request_id=requestMap![row.request_id];
  const step=selected.steps!.find(step=>step.id===row.step_execution_id);if(!step||row.input_hash!==hash(step.input_text))throw Error('Attempt input integrity failure');
  row.id=ids[row.id];row.step_execution_id=link(row.step_execution_id,steps);row.input_hash=hash(text(step.input_text));row.result_json=result(row.result_json);row.fence=0;row.cancel_requested=0;
 }
 for(const row of out.sealedResults!){
  execution(row);if(hash(row.result_json)!==row.content_hash)throw Error('Sealed result integrity failure');
  row.id=ids[row.id];row.path_id=link(row.path_id,paths);row.step_execution_id=link(row.step_execution_id,steps);row.terminal_attempt_id=link(row.terminal_attempt_id,attempts);row.result_json=result(row.result_json);row.content_hash=hash(row.result_json);
 }
 for(const row of out.forks!){
  execution(row);const sourceFork=row.id;row.id=ids[sourceFork];row.parent_path_id=link(row.parent_path_id,paths);row.result_json=result(row.result_json);
  if(row.selected_paths_json!==null){
   const selectedPaths=JSON.parse(row.selected_paths_json);
   if(!Array.isArray(selectedPaths)||new Set(selectedPaths).size!==selectedPaths.length||stableJson(selectedPaths)!==row.selected_paths_json)throw Error('Invalid ordered Join selection');
   row.selected_paths_json=stableJson(selectedPaths.map(id=>{if(!selected.paths!.some(path=>path.id===id&&path.fork_invocation_id===sourceFork))throw Error('Join selection escapes its Fork');return link(id,paths);}));
  }
 }
 for(const row of out.joins!){execution(row);if(!selected.forks!.some(fork=>fork.id===row.fork_invocation_id&&fork.join_id===row.join_id))throw Error('Join identity differs from its Fork');if(!selected.paths!.some(path=>path.id===row.path_id&&path.fork_invocation_id===row.fork_invocation_id))throw Error('Join arrival escapes its Fork');row.fork_invocation_id=link(row.fork_invocation_id,forks);row.path_id=link(row.path_id,paths);row.output_text=text(row.output_text);}
 for(const row of out.maps!){if(!selected.forks!.some(fork=>fork.id===row.id&&fork.parent_path_id===row.parent_path_id&&fork.join_id===row.join_id&&fork.fork_id===row.map_id))throw Error('Map metadata differs from its Fork');execution(row);row.id=link(row.id,maps);row.parent_path_id=link(row.parent_path_id,paths);row.source_result_id=link(row.source_result_id,results);}
 for(const map of selected.maps!){
  const items=selected.items!.filter(item=>item.map_invocation_id===map.id).sort((a,b)=>a.item_index-b.item_index);
  if(items.length!==map.item_count||items.some((item,index)=>item.item_index!==index)||hash(stableJson(items.map(item=>item.input_text)))!==map.items_hash)throw Error('Sealed Map item order or inventory differs');
 }
 for(const row of out.items!){
  if(!Number.isSafeInteger(row.item_index)||row.item_index<0||row.id!==`${row.map_invocation_id}:${row.item_index}`||hash(row.input_text)!==row.input_hash)throw Error('Map item identity or content integrity failure');
  if(!selected.paths!.some(path=>path.id===row.path_id&&path.fork_invocation_id===row.map_invocation_id))throw Error('Map item escapes its Fork');
  const mapped=link(row.map_invocation_id,maps)!;
  if(ids[row.id]!==`${mapped}:${row.item_index}`)throw Error('Map item must retain its captured index');
  row.id=ids[row.id];row.map_invocation_id=mapped;row.path_id=link(row.path_id,paths);row.input_text=text(row.input_text);row.input_hash=hash(row.input_text);
 }
 for(const map of out.maps!)map.items_hash=hash(stableJson(out.items!.filter(item=>item.map_invocation_id===map.id).sort((a,b)=>a.item_index-b.item_index).map(item=>item.input_text)));
 for(const row of out.bundles!){execution(row);if(hash(row.content_text)!==row.content_hash)throw Error('Result bundle integrity failure');row.id=ids[row.id];row.fork_invocation_id=link(row.fork_invocation_id,forks);}
 for(const row of out.loops!){execution(row);row.path_id=link(row.path_id,paths);}
 for(const row of out.gates!){row.id=ids[row.id];row.step_execution_id=link(row.step_execution_id,steps);row.attempt_id=link(row.attempt_id,attempts);row.proposal_text=text(row.proposal_text);if(row.response_json!==null){const response=JSON.parse(row.response_json);if(typeof response.output==='string')response.output=text(response.output);row.response_json=stableJson(response);}}
 // No execution admission, Resources, Actions, leases or provider state is returned.
 return out;
}
