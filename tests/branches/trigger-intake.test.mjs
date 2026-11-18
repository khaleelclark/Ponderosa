import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';

function fixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'branch-trigger-current-')),store=new AgentStore(root);
 let passed=false;t.after(()=>{store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)});
 const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite)),owner=branches.create('Intake','create');
 const config={scheduleKind:'once',at:'2026-01-01T00:00:00.000Z'};
 const branch=branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition:{
  schema:'ponderosa.branch.v1',name:'Intake',entry:'gate',trigger:{kind:'schedule',configRef:'clock'},controls:[],edges:[],
  steps:[{id:'gate',kind:'human_gate',prompt:'Review',editable:false}],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}
 },bindings:{agents:{},directories:{},triggers:{clock:{enabled:true,sourceConfig:config}}}},config.at,{sourceConfig:config,nextFireAt:config.at});
 return {store,branches,branch,at:config.at,done(){passed=true},input(key='event'){return {triggerId:branch.triggerId,occurrenceKey:key,payload:{hello:'world'},provenance:{source:'test'},now:config.at}}};
}

test('scheduled occurrence and cursor commit once with the Branch execution, without creating a provider Run',t=>{
 const f=fixture(t),triggers=f.branches.triggers;
 assert.equal(triggers.listDueScheduleTriggers(f.at)[0].id,f.branch.triggerId);
 const scheduled={...f.input(),expectedNextFireAt:f.at,lastFiredAt:f.at};
 const receipt=triggers.recordScheduledTriggerOccurrence(scheduled),occurrence=triggers.getTriggerOccurrence(receipt.occurrenceId);
 assert.equal(receipt.state,'activated');assert.ok(occurrence.branchExecutionId);
 assert.equal(f.branches.execution(occurrence.branchExecutionId).admissionSource,'automatic');
 assert.equal(triggers.getTriggerDefinition(f.branch.triggerId).enabled,false);
 assert.throws(()=>triggers.recordScheduledTriggerOccurrence(scheduled),/unavailable|cursor/);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,1);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM trigger_occurrences').get().n,1);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
 f.done();
});

test('failed workflow admission rolls back both occurrence and schedule cursor; retry keeps exact input identity',t=>{
 const f=fixture(t),triggers=f.branches.triggers,db=f.store.sqlite;
 db.exec("CREATE TEMP TRIGGER fail_intake BEFORE INSERT ON branch_executions BEGIN SELECT RAISE(ABORT,'injected admission failure'); END");
 const scheduled={...f.input(),expectedNextFireAt:f.at,lastFiredAt:f.at};
 assert.throws(()=>triggers.recordScheduledTriggerOccurrence(scheduled),/injected admission failure/);
 assert.equal(db.prepare('SELECT count(*) n FROM trigger_occurrences').get().n,0);
 assert.equal(triggers.getTriggerDefinition(f.branch.triggerId).nextFireAt,f.at);
 db.exec('DROP TRIGGER fail_intake');
 const result=triggers.recordTriggerOccurrence(f.input());
 assert.equal(triggers.recordTriggerOccurrence(f.input()).occurrenceId,result.occurrenceId);
 assert.equal(triggers.recordTriggerOccurrence(f.input()).replayed,true);
 assert.throws(()=>triggers.recordTriggerOccurrence({...f.input(),payload:{changed:true}}),/idempotency conflict/);
 assert.equal(db.prepare('SELECT count(*) n FROM branch_executions').get().n,1);
 f.done();
});

test('payload cannot grant manual admission or direct Agent authority, and a deleting Branch rejects new intake',t=>{
 const f=fixture(t),triggers=f.branches.triggers;
 const result=triggers.recordTriggerOccurrence({...f.input(),payload:{branchOperatorManual:true},provenance:{source:'test',branchOperatorManual:true}});
 const execution=triggers.getTriggerOccurrence(result.occurrenceId).branchExecutionId;
 assert.equal(f.branches.execution(execution).admissionSource,'automatic');
 assert.throws(()=>triggers.updateTriggerDefinition(f.branch.triggerId,{targetAgentId:'invented'}),/cannot target Agents/);
 assert.throws(()=>triggers.updateTriggerDefinition(f.branch.triggerId,{runBudget:{limit:1,period:'day'}}),/provider Run budgets/);
 f.branches.beginDeletion(f.branch.id);
 assert.throws(()=>triggers.recordTriggerOccurrence(f.input('later')),/disabled|unavailable/);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
 f.done();
});
