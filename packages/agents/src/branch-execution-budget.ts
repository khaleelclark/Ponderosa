import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BranchExecutionBudgetDto, BranchExecutionBudgetUpdate, BranchExecutionBudgetGrant, BranchExecutionBudgetPolicy } from '@ponderosa/core';
import { triggerBudgetEndsAt } from './coordination-v3-trigger-budget.js';
import { payloadHash, stableJson } from './coordination-v3-canonical-json.js';
import { branchKey } from './branch-definition.js';

type Row = {branch_id:string;revision:number;limit_count:number|null;period:BranchExecutionBudgetPolicy['period']|null;used:number;allowance:number;period_id:string|null;period_started_at:string|null};
const maximum = 1_000_000_000;
/** Only called inside the existing Branch authority's SQLite transaction. */
export class BranchExecutionBudgetAuthority {
  constructor(private readonly db:Database.Database) {}
  private event(branchId:string,kind:string,evidence:unknown,now:string):void {
    this.db.prepare('INSERT INTO branch_execution_budget_events(branch_id,kind,evidence_json,created_at) VALUES(?,?,?,?)').run(branchId,kind,stableJson(evidence),now);
  }
  private row(branchId:string,now:string):Row {
    if(!this.db.prepare('SELECT 1 FROM branches WHERE id=? AND deleting=0').get(branchId))throw new Error('Branch not found or deleting');
    this.db.prepare('INSERT OR IGNORE INTO branch_execution_budgets(branch_id,updated_at) VALUES(?,?)').run(branchId,now);
    return this.db.prepare('SELECT * FROM branch_execution_budgets WHERE branch_id=?').get(branchId) as Row;
  }
  private rotate(row:Row,now:string):Row {
    const end=row.period&&row.period_started_at?triggerBudgetEndsAt(row.period,row.period_started_at):undefined;
    if(end&&end<=now){
      const periodId=randomUUID();
      this.db.prepare('UPDATE branch_execution_budgets SET used=0,allowance=0,period_id=?,period_started_at=?,revision=revision+1,updated_at=? WHERE branch_id=?').run(periodId,now,now,row.branch_id);
      this.event(row.branch_id,'period_started',{priorPeriodId:row.period_id,periodId,startedAt:now},now);
      return {...row,used:0,allowance:0,period_id:periodId,period_started_at:now,revision:row.revision+1};
    }
    return row;
  }
  read(branchId:string,now:string):BranchExecutionBudgetDto {
    const row=this.rotate(this.row(branchId,now),now);
    const resetsAt=row.period&&row.period_started_at?triggerBudgetEndsAt(row.period,row.period_started_at):undefined;
    // Held count comes from durable scheduler decisions, never from UI quota arithmetic.
    const held=(this.db.prepare("SELECT COUNT(*) n FROM branch_executions WHERE branch_id=? AND state='queued' AND cancel_requested=0 AND budget_wait=1").get(branchId) as {n:number}).n;
    return {branchId,revision:row.revision,policy:row.limit_count!==null?{limit:row.limit_count,period:row.period!}:null,used:row.used,allowance:row.allowance,periodId:row.period_id,periodStartedAt:row.period_started_at,...(resetsAt?{resetsAt}:{}),heldCount:held,observedAt:now};
  }
  command(branchId:string,kind:'policy'|'grant',input:BranchExecutionBudgetUpdate|BranchExecutionBudgetGrant,now:string):BranchExecutionBudgetDto {
    if(!input||typeof input!=='object'||typeof input.commandKey!=='string'||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||(input.expectedPeriodId!==null&&typeof input.expectedPeriodId!=='string'))throw new Error('Invalid execution budget command');
    branchKey(input.commandKey);
    const hash=payloadHash({kind,input});
    const prior=this.db.prepare('SELECT input_hash,result_json FROM branch_execution_budget_commands WHERE branch_id=? AND command_key=?').get(branchId,input.commandKey) as {input_hash:string;result_json:string}|undefined;
    if(prior){if(prior.input_hash!==hash)throw new Error('Budget command idempotency conflict');return JSON.parse(prior.result_json) as BranchExecutionBudgetDto;}
    if(this.db.prepare("SELECT 1 FROM branch_installation_plans WHERE branch_id=? AND state IN ('applying','canceling')").get(branchId))throw new Error('An installation update is applying; wait for it to finish');
    const current=this.read(branchId,now);
    if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision!==current.revision||input.expectedPeriodId!==current.periodId)throw new Error('Budget revision or period conflict; refresh before trying again');
    if(kind==='grant'){
      const grant=input as BranchExecutionBudgetGrant;
      if(!current.policy)throw new Error('An automatic execution budget is required');
      if(!Number.isSafeInteger(grant.additional)||grant.additional<1||current.policy.limit+current.allowance+grant.additional>maximum)throw new Error(`Additional executions must be a positive whole number; total allowance cannot exceed ${maximum}`);
      this.db.prepare('UPDATE branch_execution_budgets SET allowance=allowance+?,revision=revision+1,updated_at=? WHERE branch_id=?').run(grant.additional,now,branchId);
    }else{
      const update=input as BranchExecutionBudgetUpdate,policy=update.policy;
      if(policy!==null&&(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).some(key=>!['limit','period'].includes(key))||!Number.isSafeInteger(policy.limit)||policy.limit<1||policy.limit>maximum||!['day','week','month','lifetime'].includes(policy.period)))throw new Error('Invalid automatic execution budget policy');
      const newEpoch=policy!==null&&(!current.policy||current.policy.period!==policy.period);
      if(newEpoch&&update.acknowledgeNewPeriod!==true)throw new Error('Confirm starting a new budget period');
      if(policy&&!newEpoch&&policy.limit+current.allowance>maximum)throw new Error('Budget plus extra allowance is too large');
      this.db.prepare('UPDATE branch_execution_budgets SET limit_count=?,period=?,used=?,allowance=?,period_id=?,period_started_at=?,revision=revision+1,updated_at=? WHERE branch_id=?')
        .run(policy?.limit??null,policy?.period??null,policy&&!newEpoch?current.used:0,policy&&!newEpoch?current.allowance:0,policy?(newEpoch?randomUUID():current.periodId):null,policy?(newEpoch?now:current.periodStartedAt):null,now,branchId);
    }
    const result=this.read(branchId,now);
    this.db.prepare('INSERT INTO branch_execution_budget_commands VALUES(?,?,?,?,?)').run(branchId,input.commandKey,hash,stableJson(result),now);
    this.event(branchId,kind==='grant'?'allowance_granted':'policy_saved',{commandKey:input.commandKey,...result},now);
    return result;
  }
  /** Debit and receipt must commit with queued→running and the entry path. */
  admit(executionId:string,now:string):boolean {
    const execution=this.db.prepare('SELECT branch_id,admission_source,admitted_at FROM branch_executions WHERE id=?').get(executionId) as {branch_id:string;admission_source:string;admitted_at:string|null};
    if(execution.admitted_at)return true;
    const row=this.rotate(this.row(execution.branch_id,now),now);
    const charged=execution.admission_source!=='manual'&&row.limit_count!==null;
    if(charged){
      const debit=this.db.prepare('UPDATE branch_execution_budgets SET used=used+1,updated_at=? WHERE branch_id=? AND used<limit_count+allowance').run(now,execution.branch_id);
      if(!debit.changes)return false;
    }
    this.db.prepare('UPDATE branch_executions SET admitted_at=?,admission_json=?,budget_wait=0 WHERE id=?').run(now,stableJson({kind:charged?'charged':execution.admission_source==='manual'?'manual':'unlimited',periodId:row.period_id,revision:row.revision}),executionId);
    return true;
  }
}
