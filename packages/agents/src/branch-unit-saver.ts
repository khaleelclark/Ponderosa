import {captureBranchHostCut,verifyBranchHostCut} from './branch-host-cut.js';
import {selectBranchUnit} from './branch-unit-selection.js';
import {encodeScriptTreeContinuation} from './branch-tree-continuation.js';
import {encodeScriptContinuation,type Selected} from './branch-script-continuation.js';
import {createHash} from 'node:crypto';
import type {BranchCheckpointMode} from '@ponderosa/core';
import type Database from 'better-sqlite3';
import {stableJson} from './coordination-v3-canonical-json.js';

export type BranchUnitTransaction = <T>(operation:()=>T)=>{():T;deferred:()=>T;immediate:()=>T;exclusive:()=>T};
export interface BranchUnitContext {written: Set<string>}
type Candidate = {executionId:string; invocationId?:string; mode?:BranchCheckpointMode; closing?:boolean; content?:string; hash?:string; error?:unknown};
type Status = {state:'pending'|'coalesced'|'saved'|'failed'|'coverage_unknown'|'suppressed'; mode?:BranchCheckpointMode; invocationId?:string; requiredWatermark?:number; savedId?:number; contentHash?:string; error?:unknown};


/** Mode-aware after-commit saver; only explicitly encoded supported frontiers are executable. */
export class BranchUnitSaver {
  // Exact async cuts cannot be coalesced. Pause fresh work until their bytes drain.
  private pendingBytes = 0;
  private readonly maxPendingBytes = 32 * 1024 * 1024;
  private readonly lanes = new Map<string,Promise<void>>();
  private readonly failures = new Map<string,unknown>();
  private readonly statuses = new Map<string,Status>();
  private readonly watermarks = new Map<string,number>();
  private readonly coalesced = new Map<string,Candidate>();
  constructor(private readonly sqlite:Database.Database) {
    const rows=sqlite.prepare("SELECT id,checkpoint_invocation_json FROM branch_executions WHERE json_extract(checkpoint_invocation_json,'$.durability')='failed'").all() as {id:string;checkpoint_invocation_json:string}[];
    for(const row of rows){
      const invocation=JSON.parse(row.checkpoint_invocation_json),error=new Error('Retained Branch checkpoint durability failed; explicit reconciliation required');
      this.failures.set(row.id,error);this.statuses.set(row.id,{state:'failed',mode:invocation.mode,invocationId:invocation.id,error});
    }
  }
  freeze(context:BranchUnitContext):Candidate[] {
    if(!this.sqlite.inTransaction)return this.sqlite.transaction(()=>this.freeze(context)).deferred();
    return [...context.written].sort().map(executionId => {
      const row=this.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(executionId) as {checkpoint_invocation_json:string|null}|undefined;
      const invocation=row?.checkpoint_invocation_json?JSON.parse(row.checkpoint_invocation_json) as {id:string;mode:BranchCheckpointMode;state:string}:undefined;
      const metadata={invocationId:invocation?.id,mode:invocation?.mode??'async' as BranchCheckpointMode,closing:invocation?.state==='interrupted'||invocation?.state==='terminal'};
      try {
        const selected=selectBranchUnit(this.sqlite,executionId);
        // Fixed SQL/column inventory excludes secretBindings and operational authority.
        const hostDependencies=captureBranchHostCut(this.sqlite,executionId,selected);
        const continuation=encodeScriptContinuation(this.sqlite,executionId,selected as Selected,hostDependencies)??encodeScriptTreeContinuation(this.sqlite,executionId,selected as Selected);
        const content=stableJson({schema:'branch-unit-selected.v2',restore_supported:!!continuation,...metadata,selected,...(continuation?{continuation}:{}),...(hostDependencies?{hostDependencies}:{})});
        return {executionId,...metadata,content,hash:createHash('sha256').update(content).digest('hex')};
      } catch(error) { return {executionId,...metadata,error}; }
    });
  }
  unowned(context:BranchUnitContext):void {
    for(const id of context.written){const error=new Error('Raw ambient transaction has no owned checkpoint commit handoff; use unitTransaction');this.failures.set(id,error);this.statuses.set(id,{state:'coverage_unknown',error});}
  }
  publish(candidates:Candidate[]):void {
    if(this.sqlite.inTransaction)throw new Error('Cannot publish before actual root COMMIT');
    for(const candidate of candidates){
      const id=candidate.executionId;
      const requiredWatermark=(this.watermarks.get(id)??0)+1;
      this.watermarks.set(id,requiredWatermark);
      const ticket:Status={state:'pending',mode:candidate.mode??'async',invocationId:candidate.invocationId,requiredWatermark};
      this.statuses.set(id,ticket);
      if(candidate.mode==='exit'&&!candidate.closing&&!Object.hasOwn(candidate,'error')&&!this.failed(id)){
        // Keep only the final immutable bytes, never an intermediate saved identity.
        this.coalesced.set(id,candidate);ticket.state='coalesced';continue;
      }
      this.coalesced.delete(id);
      const previous=this.lanes.get(id)??Promise.resolve();
      const bytes=(candidate.content?.length??0)*2;
      this.pendingBytes+=bytes;
      const save=previous.then(()=>{
        if(this.sqlite.inTransaction)throw new Error('Checkpoint saver cannot join a primary transaction');
        if(Object.hasOwn(candidate,'error'))throw candidate.error;
        // Deletion can run between commit and the async saver. Never recreate ownership.
        const savedId=this.sqlite.transaction(()=>{
          const owner=this.sqlite.prepare('SELECT b.deleting FROM branch_executions e JOIN branches b ON b.id=e.branch_id WHERE e.id=?').get(id) as {deleting:number}|undefined;
          if(!owner||owner.deleting)return;
          const result=this.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(id,candidate.content!,candidate.hash!);
          const savedId=Number(result.lastInsertRowid);
          if(candidate.invocationId)this.sqlite.prepare("UPDATE branch_executions SET checkpoint_invocation_json=json_set(checkpoint_invocation_json,'$.saved_snapshot_id',?,'$.durability',?) WHERE id=? AND json_extract(checkpoint_invocation_json,'$.id')=?").run(savedId,candidate.closing?'saved':'pending',id,candidate.invocationId);
          return savedId;
        }).immediate();
        if(savedId===undefined)Object.assign(ticket,{state:'suppressed'});
        else Object.assign(ticket,{state:'saved',savedId,contentHash:candidate.hash});
      });
      // Keep the rejecting lane: later saves cannot bypass a failed predecessor.
      this.lanes.set(id,save);
      // Release the accounting on either outcome; a failed predecessor stays rejecting.
      void save.then(()=>{this.pendingBytes-=bytes;},()=>{this.pendingBytes-=bytes;});
      void save.catch(error=>{
        this.failures.set(id,error);Object.assign(ticket,{state:'failed',error});
        // Reporting failure must itself remain outside the primary effect channel.
        try {if(candidate.invocationId)this.sqlite.prepare("UPDATE branch_executions SET checkpoint_invocation_json=json_set(checkpoint_invocation_json,'$.durability','failed') WHERE id=? AND json_extract(checkpoint_invocation_json,'$.id')=?").run(id,candidate.invocationId);}
        catch(reportError){this.failures.set(id,new AggregateError([error,reportError],'Checkpoint save and failure reporting failed'));}
      });
    }
  }
  currentSavedMatches(executionId:string,invocationId:string,savedId:number|undefined):boolean {
    if(!savedId)return false;
    try {
      const row=this.sqlite.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE execution_id=? AND id=?').get(executionId,savedId) as {snapshot_json:string;content_hash:string}|undefined;
      const current=this.freeze({written:new Set([executionId])})[0];
      if(!row||current?.invocationId!==invocationId||!current.content||createHash('sha256').update(row.snapshot_json).digest('hex')!==row.content_hash)return false;
      const saved=JSON.parse(row.snapshot_json),candidate=JSON.parse(current.content);
      if(saved.hostDependencies&&!verifyBranchHostCut(saved.hostDependencies,executionId))return false;
      // Host dependency evidence is observational at capture. Only the selected
      // executable frontier participates in fresh dispatch coverage.
      delete saved.hostDependencies;delete candidate.hostDependencies;
      return stableJson(saved)===stableJson(candidate);
    } catch { return false; } // A failed verification is unknown coverage, never a saved acknowledgement.
  }
  ready(id:string,mode:BranchCheckpointMode):boolean {
    if(this.failed(id)||this.pendingBytes>=this.maxPendingBytes)return false;
    const ticket=this.statuses.get(id);
    if(mode!=='sync')return true;
    // A process-local ticket cannot attest rows changed by a different connection.
    if(ticket&&ticket.state!=='saved')return false;
    const row=this.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(id) as {checkpoint_invocation_json:string}|undefined;
    if(!row?.checkpoint_invocation_json)return false;
    try {
      const invocation=JSON.parse(row.checkpoint_invocation_json);
      if(ticket&&ticket.invocationId!==invocation.id)return false;
      return this.currentSavedMatches(id,invocation.id,ticket?.savedId??invocation.saved_snapshot_id);
    } catch {return false;}
  }
  status(id:string):Readonly<Status>|undefined {return this.statuses.get(id);}
  failed(id:string):boolean {return this.failures.has(id);}
  errors():unknown[] {return [...this.failures.values()];}
  async waitFor(ids:string[]):Promise<void> {
    await Promise.allSettled(ids.map(id=>this.lanes.get(id)??Promise.resolve()));
    const errors=ids.filter(id=>this.failed(id)).map(id=>this.failures.get(id));
    if(errors.length)throw new AggregateError(errors,'Branch checkpoint durability failed');
  }
  async completeExits():Promise<void> {
    for(;;){
      const read=()=>this.sqlite.prepare("SELECT id execution_id,checkpoint_invocation_json FROM branch_executions WHERE json_extract(checkpoint_invocation_json,'$.state') IN ('interrupted','terminal')").all() as {execution_id:string;checkpoint_invocation_json:string}[];
      await this.waitFor(read().map(row=>row.execution_id));
      const rows=read();
      if(rows.some(row=>this.statuses.get(row.execution_id)?.state==='pending'))continue;
      for(const row of rows){
        const invocation=JSON.parse(row.checkpoint_invocation_json),ticket=this.statuses.get(row.execution_id);
        if(ticket&&ticket.invocationId===invocation.id&&ticket.state==='saved')continue;
        if(!ticket&&invocation.durability==='saved'&&this.currentSavedMatches(row.execution_id,invocation.id,invocation.saved_snapshot_id))continue;
        throw new Error('Branch checkpoint coverage unknown at orderly completion');
      }
      return;
    }
  }
  async drain():Promise<void> {
    await Promise.allSettled([...this.lanes.values()]);
    const errors=this.errors();
    if(errors.length)throw new AggregateError(errors,'Branch checkpoint durability failed');
  }
}
