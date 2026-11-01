import type Database from 'better-sqlite3';
import type {Selected} from './branch-script-continuation.js';
import {selectBranchUnit} from './branch-unit-selection.js';
import {stableJson} from './coordination-v3-canonical-json.js';

// Column lists are owned here, never supplied by a portable checkpoint.
const tables=[
 ['paths','branch_paths','id,execution_id,parent_path_id,fork_invocation_id,edge_id,state,node_id,step_execution_id,input_text,result_json,traversals,handling_limit,last_result_id'],
 ['steps','branch_step_executions','id,execution_id,step_id,path_id,invocation,state,input_text,result_json'],
 ['attempts','branch_attempts','id,step_execution_id,number,state,fence,input_hash,result_json,error,available_at,purpose,request_id'],
 ['sealedResults','branch_sealed_results','id,execution_id,path_id,step_execution_id,terminal_attempt_id,result_json,content_hash'],
 ['forks','branch_forks','id,execution_id,parent_path_id,fork_id,join_id,state,selected_paths_json,result_json'],
 ['joins','branch_join_arrivals','execution_id,fork_invocation_id,join_id,path_id,outcome,output_text'],
 ['maps','branch_map_invocations','id,execution_id,map_id,parent_path_id,join_id,source_result_id,item_count,items_hash,state'],
 ['items','branch_map_items','id,map_invocation_id,item_index,path_id,input_text,input_hash,dispatched'],
 ['bundles','branch_result_bundles','id,execution_id,fork_invocation_id,content_text,content_hash'],
 ['loops','branch_loop_counts','execution_id,path_id,edge_id,iterations'],
 ['gates','branch_gates','id,step_execution_id,state,proposal_text,choices_json,revision,response_json,purpose,attempt_id,prompt_text'],
] as const;

/** Caller must own the acceptance/lineage transaction; no admission or lease is copied. */
export function insertBranchFrontier(db:Database.Database,executionId:string,restored:Selected,now:string,requestIds?:ReadonlySet<string>):void {
 if(!db.inTransaction)throw Error('Continuation insertion requires the owner transaction');
 for(const [key,table,fields] of tables){
  const columns=fields.split(','),timestamps=key==='attempts'?['created_at','updated_at']:['sealedResults','maps','bundles'].includes(key)?['created_at']:[];
  const all=[...columns,...timestamps],insert=db.prepare(`INSERT INTO ${table}(${all.join(',')}) VALUES(${all.map(()=>'?').join(',')})`);
  for(const row of restored[key]??[]){
   if(columns.includes('execution_id')&&row.execution_id!==executionId)throw Error('Restored row escapes its execution');
   if(key==='attempts'&&(row.fence!==0||row.request_id&&!requestIds?.has(row.request_id)||row.recovery_of_request_id||row.runtime_outcome_json||row.cancel_requested))throw Error('Restored attempt retains runtime authority');
   insert.run(...columns.map(column=>row[column]),...timestamps.map(()=>now));
  }
 }
 // Read back within the same transaction. A missing control row or changed derived
 // hash must abort acceptance, not leave a runnable partial continuation.
 const actual=selectBranchUnit(db,executionId);
 for(const [key,,fields] of tables){
  const columns=fields.split(','),project=(rows:Record<string,any>[])=>rows.map(row=>stableJson(Object.fromEntries(columns.map(column=>[column,row[column]])))).sort();
  if(stableJson(project(actual[key]!))!==stableJson(project(restored[key]??[])))throw Error(`Restored ${key} inventory differs`);
 }
}
