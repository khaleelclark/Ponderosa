import type Database from 'better-sqlite3';
import type {Selected} from './branch-script-continuation.js';
const selections: Record<string,string> = {
  "execution": "SELECT id,branch_id,version_id,binding_revision_id,occurrence_key,input_text,input_hash,state,wait_reason,cancel_requested,output_text,merged_into,requested_outcome,parent_execution_id,parent_attempt_id,call_depth,depth_ceiling,traversals,budget_exhausted,recovery_traversals,loop_iterations,admission_source FROM branch_executions WHERE id=? ORDER BY id",
  "paths": "SELECT id,execution_id,parent_path_id,fork_invocation_id,edge_id,state,node_id,step_execution_id,input_text,result_json,traversals,handling_limit,last_result_id FROM branch_paths WHERE execution_id=? ORDER BY id",
  "steps": "SELECT id,execution_id,step_id,path_id,invocation,state,input_text,result_json FROM branch_step_executions WHERE execution_id=? ORDER BY id",
  "attempts": "SELECT id,step_execution_id,number,state,request_id,fence,input_hash,result_json,available_at,purpose,recovery_of_request_id,cancel_requested,runtime_outcome_json,error,created_at,updated_at FROM branch_attempts WHERE step_execution_id IN (SELECT id FROM branch_step_executions WHERE execution_id=?) ORDER BY id",
  "forks": "SELECT id,execution_id,parent_path_id,fork_id,join_id,state,selected_paths_json,result_json FROM branch_forks WHERE execution_id=? ORDER BY id",
  "joins": "SELECT execution_id,fork_invocation_id,join_id,path_id,outcome,output_text FROM branch_join_arrivals WHERE execution_id=? ORDER BY fork_invocation_id,join_id,path_id",
  "loops": "SELECT execution_id,path_id,edge_id,iterations FROM branch_loop_counts WHERE execution_id=? ORDER BY path_id,edge_id",
  "maps": "SELECT id,execution_id,map_id,parent_path_id,join_id,source_result_id,item_count,items_hash,state FROM branch_map_invocations WHERE execution_id=? ORDER BY id",
  "items": "SELECT id,map_invocation_id,item_index,path_id,input_text,input_hash,dispatched FROM branch_map_items WHERE map_invocation_id IN (SELECT id FROM branch_map_invocations WHERE execution_id=?) ORDER BY id",
  "sealedResults": "SELECT id,execution_id,path_id,step_execution_id,terminal_attempt_id,result_json,content_hash FROM branch_sealed_results WHERE execution_id=? ORDER BY id",
  "bundles": "SELECT id,execution_id,fork_invocation_id,content_text,content_hash FROM branch_result_bundles WHERE execution_id=? ORDER BY id",
  "gates": "SELECT id,step_execution_id,state,proposal_text,choices_json,revision,response_json,purpose,attempt_id,prompt_text FROM branch_gates WHERE step_execution_id IN (SELECT id FROM branch_step_executions WHERE execution_id=?) ORDER BY id",
  "actions": "SELECT attempt_id,state,notification_id FROM branch_actions WHERE attempt_id IN (SELECT a.id FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=?) ORDER BY attempt_id",
  "resources": "SELECT step_execution_id,execution_id,template_ref,state,requested_count,root_agent_id,chat_id,generation,retry_draining,error,creation_key,(SELECT result_json FROM branch_commands c WHERE c.execution_id=r.execution_id AND c.command_key='resource-operation:'||r.creation_key||':chat') chat_operation_json,(SELECT result_json FROM branch_commands c WHERE c.execution_id=r.execution_id AND c.command_key='resource-operation:'||r.creation_key||':import') import_operation_json FROM branch_resources r WHERE execution_id=? ORDER BY step_execution_id"
};
export const selectBranchUnit=(db:Database.Database,id:string):Selected=>Object.fromEntries(Object.entries(selections).map(([key,sql])=>[key,db.prepare(sql).all(id)])) as Selected;
