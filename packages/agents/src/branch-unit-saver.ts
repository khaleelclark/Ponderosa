import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {stableJson} from './coordination-v3-canonical-json.js';

export type BranchUnitTransaction = <T>(operation:()=>T)=>{():T;deferred:()=>T;immediate:()=>T;exclusive:()=>T};
export interface BranchUnitContext {written: Set<string>}
type Candidate = {executionId:string; content?:string; hash?:string; error?:unknown};
type Status = {state:'pending'|'saved'|'failed'|'coverage_unknown'|'suppressed'; savedId?:number; contentHash?:string; error?:unknown};
const selections: Record<string,string> = {
  "execution": "SELECT id,branch_id,version_id,binding_revision_id,occurrence_key,input_text,input_hash,state,wait_reason,cancel_requested,output_text,merged_into,requested_outcome,parent_execution_id,parent_attempt_id,call_depth,depth_ceiling,traversals,budget_exhausted,recovery_traversals,loop_iterations FROM branch_executions WHERE id=? ORDER BY id",
  "paths": "SELECT id,execution_id,parent_path_id,fork_invocation_id,edge_id,state,node_id,step_execution_id,input_text,result_json,traversals,handling_limit,last_result_id FROM branch_paths WHERE execution_id=? ORDER BY id",
  "steps": "SELECT id,execution_id,step_id,path_id,invocation,state,input_text,result_json FROM branch_step_executions WHERE execution_id=? ORDER BY id",
  "attempts": "SELECT id,step_execution_id,number,state,request_id,fence,input_hash,result_json,available_at,purpose,recovery_of_request_id,cancel_requested,runtime_outcome_json FROM branch_attempts WHERE step_execution_id IN (SELECT id FROM branch_step_executions WHERE execution_id=?) ORDER BY id",
  "forks": "SELECT id,execution_id,parent_path_id,fork_id,join_id,state,selected_paths_json,result_json FROM branch_forks WHERE execution_id=? ORDER BY id",
  "joins": "SELECT execution_id,fork_invocation_id,join_id,path_id,outcome,output_text FROM branch_join_arrivals WHERE execution_id=? ORDER BY fork_invocation_id,join_id,path_id",
  "loops": "SELECT execution_id,path_id,edge_id,iterations FROM branch_loop_counts WHERE execution_id=? ORDER BY path_id,edge_id",
  "maps": "SELECT id,execution_id,map_id,parent_path_id,join_id,source_result_id,item_count,items_hash,state FROM branch_map_invocations WHERE execution_id=? ORDER BY id",
  "items": "SELECT id,map_invocation_id,item_index,path_id,input_text,input_hash,dispatched FROM branch_map_items WHERE map_invocation_id IN (SELECT id FROM branch_map_invocations WHERE execution_id=?) ORDER BY id",
  "sealedResults": "SELECT id,execution_id,path_id,step_execution_id,terminal_attempt_id,result_json,content_hash FROM branch_sealed_results WHERE execution_id=? ORDER BY id",
  "bundles": "SELECT id,execution_id,fork_invocation_id,content_text,content_hash FROM branch_result_bundles WHERE execution_id=? ORDER BY id",
  "gates": "SELECT id,step_execution_id,state,proposal_text,choices_json,revision,response_json,purpose,attempt_id,prompt_text FROM branch_gates WHERE step_execution_id IN (SELECT id FROM branch_step_executions WHERE execution_id=?) ORDER BY id",
  "actions": "SELECT attempt_id,state,notification_id FROM branch_actions WHERE attempt_id IN (SELECT a.id FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=?) ORDER BY attempt_id",
  "resources": "SELECT step_execution_id,execution_id,template_ref,state,requested_count,root_agent_id,chat_id,generation,retry_draining FROM branch_resources WHERE execution_id=? ORDER BY step_execution_id"
};

/** Async default only. Intermediate snapshots are not executable rewind checkpoints. */
export class BranchUnitSaver {
  private readonly lanes = new Map<string,Promise<void>>();
  private readonly failures = new Map<string,unknown>();
  private readonly statuses = new Map<string,Status>();
  constructor(private readonly sqlite:Database.Database) {}
  freeze(context:BranchUnitContext):Candidate[] {
    return [...context.written].sort().map(executionId => {
      try {
        const selected=Object.fromEntries(Object.entries(selections).map(([key,sql])=>[key,this.sqlite.prepare(sql).all(executionId)]));
        // Fixed SQL/column inventory excludes secretBindings and operational authority.
        const content=stableJson({schema:'branch-unit-selected.v1',restore_supported:false,selected});
        return {executionId,content,hash:createHash('sha256').update(content).digest('hex')};
      } catch(error) { return {executionId,error}; }
    });
  }
  unowned(context:BranchUnitContext):void {
    for(const id of context.written){const error=new Error('Raw ambient transaction has no owned checkpoint commit handoff; use unitTransaction');this.failures.set(id,error);this.statuses.set(id,{state:'coverage_unknown',error});}
  }
  publish(candidates:Candidate[]):void {
    if(this.sqlite.inTransaction)throw new Error('Cannot publish before actual root COMMIT');
    for(const candidate of candidates){
      const id=candidate.executionId;
      const ticket:Status={state:'pending'};
      this.statuses.set(id,ticket);
      const previous=this.lanes.get(id)??Promise.resolve();
      const save=previous.then(()=>{
        if(this.sqlite.inTransaction)throw new Error('Checkpoint saver cannot join a primary transaction');
        if(Object.hasOwn(candidate,'error'))throw candidate.error;
        // Deletion can run between commit and the async saver. Never recreate ownership.
        this.sqlite.transaction(()=>{
          const owner=this.sqlite.prepare('SELECT b.deleting FROM branch_executions e JOIN branches b ON b.id=e.branch_id WHERE e.id=?').get(id) as {deleting:number}|undefined;
          if(!owner||owner.deleting){Object.assign(ticket,{state:'suppressed'});return;}
          const result=this.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(id,candidate.content!,candidate.hash!);
          Object.assign(ticket,{state:'saved',savedId:Number(result.lastInsertRowid),contentHash:candidate.hash});
        }).immediate();
      });
      // Keep the rejecting lane: later saves cannot bypass a failed predecessor.
      this.lanes.set(id,save);
      void save.catch(error=>{this.failures.set(id,error);Object.assign(ticket,{state:'failed',error});});
    }
  }
  status(id:string):Readonly<Status>|undefined {return this.statuses.get(id);}
  failed(id:string):boolean {return this.failures.has(id);}
  errors():unknown[] {return [...this.failures.values()];}
  async drain():Promise<void> {
    await Promise.allSettled([...this.lanes.values()]);
    const errors=this.errors();
    if(errors.length)throw new AggregateError(errors,'Branch checkpoint durability failed');
  }
}
