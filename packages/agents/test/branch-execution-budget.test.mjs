import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import Database from 'better-sqlite3';
import {AgentStore,BranchStore,CoordinationV3Store} from '../dist/index.js';
const now='2026-01-01T00:00:00.000Z';
const gate={id:'gate',kind:'human_gate',prompt:'Review',editable:false};
const script={id:'script',kind:'script',runtime:'node',source:'console.log(1)',cwdRef:'root',timeoutMs:1000};
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'branch-budget-'));let store,branches,coordination;
 const open=()=>{store=new AgentStore(dir);coordination=new CoordinationV3Store(store.sqlite);branches=new BranchStore(store.sqlite,coordination)};open();
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
 return {dir,get db(){return store.sqlite},get branches(){return branches},get coordination(){return coordination},reopen(){store.close();open()},deploy(name,steps=[gate],bindings={},controls=[],edges=[]){
 const owner=branches.create(name,name);
 return branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:name,definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:controls[0]?.id??steps[0].id,steps,controls,edges,policy:{maxConcurrentExecutions:10,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:dir},...bindings}},now);
 },budget(id,policy={limit:1,period:'day'},at=now){const b=branches.executionBudget(id,at);return branches.updateExecutionBudget(id,{commandKey:crypto.randomUUID(),expectedRevision:b.revision,expectedPeriodId:b.periodId,policy,acknowledgeNewPeriod:true},at)}
 };
}
function call(f,child,key){const parent=f.deploy('parent-'+key,[{id:'call',kind:'branch_call',branchRef:'child'}],{branches:{child:child.id}});const e=f.branches.accept(parent.id,key,'input',now);f.branches.advance(now);return {parent:e,child:f.branches.listExecutions(child.id).find(x=>x.parentExecutionId===e.id)}}
function grant(f,id,additional=1,at=now){const b=f.branches.executionBudget(id,at);const input={commandKey:crypto.randomUUID(),expectedRevision:b.revision,expectedPeriodId:b.periodId,additional};return {input,result:f.branches.grantExecutions(id,input,at)}}
test('last unit starts once; held child is pinned, resource-free, restartable and not a traversal failure',t=>{
 const f=fixture(t),b=f.deploy('child');f.budget(b.id);
 const first=call(f,b,'one');f.branches.advance(now);assert.equal(f.branches.executionBudget(b.id,now).used,1);
 const second=call(f,b,'two');f.branches.advance(now);const held=f.branches.execution(second.child.id);
 assert.equal(held.state,'queued');assert.ok(held.budgetWait);assert.equal(held.budgetExhausted,false);
 for(const table of ['branch_paths','branch_step_executions','branch_resources'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE execution_id=?`).get(held.id).n,0);
 assert.equal(f.branches.detail(second.parent.id).waits[0].kind,'execution_budget');
 assert.equal(f.branches.detail(held.id).waits[0].kind,'execution_budget');
 const oldVersion=held.versionId;f.branches.deploy({chatId:'',branchId:b.id,expectedVersionId:b.versionId,idempotencyKey:'updated-child',definition:{...f.branches.version(b.id,b.versionId).definition,name:'Updated'},bindings:{agents:{},directories:{root:f.dir}}},now);
 f.reopen();f.branches.setEnabled(b.id,false);grant(f,b.id);f.branches.advance(now);
 assert.equal(f.branches.execution(held.id).versionId,oldVersion);assert.ok(f.branches.execution(held.id).admittedAt);
 assert.equal(f.branches.executionBudget(b.id,now).used,2);f.branches.advance(now);assert.equal(f.branches.executionBudget(b.id,now).used,2);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM branch_paths WHERE execution_id=?').get(held.id).n,1);
});
test('manual/unlimited admissions are durable; no retroactive charges or refunds and input replay conflicts',t=>{
 const f=fixture(t),b=f.deploy('manual');f.budget(b.id);
 const manual=f.branches.accept(b.id,'trigger:forged','input',now);assert.equal(f.branches.accept(b.id,'trigger:forged','input',now).id,manual.id);assert.throws(()=>f.branches.accept(b.id,'trigger:forged','changed',now),/conflict/);
 f.branches.advance(now);assert.ok(f.branches.execution(manual.id).admittedAt);assert.equal(f.branches.executionBudget(b.id,now).used,0);
 f.budget(b.id,null);const incoming=call(f,b,'unlimited');f.branches.advance(now);assert.ok(f.branches.execution(incoming.child.id).admittedAt);
 f.budget(b.id);f.reopen();f.branches.advance(now);assert.equal(f.branches.executionBudget(b.id,now).used,0);
 const counted=call(f,b,'counted');f.branches.advance(now);f.branches.cancel(counted.child.id,now);assert.equal(f.branches.executionBudget(b.id,now).used,1);
});
test('allowance replay/input conflict/stale period and same-period settings preserve counters',t=>{
 const f=fixture(t),b=f.deploy('grants');f.budget(b.id);call(f,b,'charge');f.branches.advance(now);
 const g=grant(f,b.id,2);assert.deepEqual(f.branches.grantExecutions(b.id,g.input,now),g.result);assert.throws(()=>f.branches.grantExecutions(b.id,{...g.input,additional:3},now),/idempotency conflict/);
 const updated=f.budget(b.id,{limit:3,period:'day'});assert.equal(updated.used,1);assert.equal(updated.allowance,2);
 const current=f.branches.executionBudget(b.id,now);assert.throws(()=>f.branches.updateExecutionBudget(b.id,{commandKey:'epoch',expectedRevision:current.revision,expectedPeriodId:current.periodId,policy:{limit:2,period:'week'}},now),/Confirm/);
 const next=f.budget(b.id,{limit:2,period:'week'});assert.equal(next.used,0);assert.equal(next.allowance,0);assert.notEqual(next.periodId,current.periodId);
 assert.throws(()=>f.branches.grantExecutions(b.id,{...g.input,commandKey:'stale'},now),/conflict/);
 for(const n of [0,-1,1.5,1_000_000_001])assert.throws(()=>grant(f,b.id,n),/positive/);
});
test('anchored UTC rollover, month-end overflow, lifetime and long downtime clear extra allowance',t=>{
 const f=fixture(t),b=f.deploy('periods');
 for(const [period,start,end]of [['day',now,'2026-01-02T00:00:00.000Z'],['week',now,'2026-01-08T00:00:00.000Z'],['month','2026-01-31T00:00:00.000Z','2026-03-03T00:00:00.000Z']]){
 f.budget(b.id,null,start);f.budget(b.id,{limit:1,period},start);grant(f,b.id,1,start);
 assert.equal(f.branches.executionBudget(b.id,start).resetsAt,end);const before=f.branches.executionBudget(b.id,new Date(Date.parse(end)-1).toISOString());assert.equal(before.allowance,1);
 const after=f.branches.executionBudget(b.id,end);assert.equal(after.allowance,0);assert.notEqual(after.periodId,before.periodId);
 }
 f.budget(b.id,null,now);f.budget(b.id,{limit:1,period:'lifetime'});grant(f,b.id,1);assert.equal(f.branches.executionBudget(b.id,'2040-01-01T00:00:00.000Z').allowance,1);
 f.budget(b.id,{limit:1,period:'day'});const after=f.branches.executionBudget(b.id,'2040-01-01T00:00:00.000Z');assert.equal(after.periodStartedAt,'2040-01-01T00:00:00.000Z');
});
test('queued cancel and parent cancel never revive on grant/removal; no ancestor debit',t=>{
 const f=fixture(t),b=f.deploy('cancel');f.budget(b.id);call(f,b,'first');f.branches.advance(now);const waiting=call(f,b,'waiting');f.branches.advance(now);
 f.branches.cancel(waiting.parent.id,now);grant(f,b.id);f.budget(b.id,null);f.branches.advance(now);
 assert.equal(f.branches.execution(waiting.child.id).state,'canceled');assert.equal(f.db.prepare('SELECT admitted_at FROM branch_executions WHERE id=?').get(waiting.child.id).admitted_at,null);
 assert.equal(f.branches.listExecutions(b.id).length,2);
});
test('separate processes race the exact last unit with atomic receipt/path/counter and recover on reopen',{timeout:15000},async t=>{
 const f=fixture(t),b=f.deploy('race');f.budget(b.id);
 const parents=['race-a','race-b'].map(key=>f.deploy(key,[{id:'call',kind:'branch_call',branchRef:'child'}],{branches:{child:b.id}}));
 parents.forEach(p=>f.branches.accept(p.id,p.id,'input',now));f.branches.advance(now);
 assert.equal(f.branches.listExecutions(b.id).length,2);
 assert.equal(f.branches.executionBudget(b.id,now).used,0);
 const workers=[0,1].map(()=>fork(new URL('./branch-execution-budget-worker.mjs',import.meta.url),[join(f.dir,'ponderosa.db')],{stdio:['ignore','ignore','pipe','ipc']}));t.after(()=>workers.forEach(w=>w.kill()));
 await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('message',m=>m==='ready'?resolve():reject(m));w.once('error',reject);w.once('exit',code=>reject(new Error('worker exited before ready '+code)))})));
 const done=workers.map(w=>new Promise((resolve,reject)=>{w.once('exit',code=>code===0?resolve():reject(new Error('worker exit '+code)))}));workers.forEach(w=>w.send('go'));await Promise.all(done);
 f.reopen();assert.equal(f.branches.executionBudget(b.id,now).used,1);
 const children=f.branches.listExecutions(b.id);assert.equal(children.filter(e=>e.admittedAt).length,1);assert.equal(children.filter(e=>e.budgetWait).length,1);
 for(const e of children)assert.equal(f.db.prepare('SELECT COUNT(*) n FROM branch_paths WHERE execution_id=?').get(e.id).n,e.admittedAt?1:0);
});
test('failure between debit and entry path rolls back all authority; committed admission survives restart',t=>{
 const f=fixture(t),b=f.deploy('rollback');f.budget(b.id);const c=call(f,b,'rollback');
 f.db.exec("CREATE TRIGGER fail_entry BEFORE INSERT ON branch_paths WHEN NEW.execution_id='"+c.child.id+"' BEGIN SELECT RAISE(ABORT,'injected entry failure'); END");
 assert.throws(()=>f.branches.advance(now),/injected/);assert.equal(f.branches.executionBudget(b.id,now).used,0);assert.equal(f.branches.execution(c.child.id).admittedAt,undefined);assert.equal(f.branches.execution(c.child.id).state,'queued');
 f.db.exec('DROP TRIGGER fail_entry');f.reopen();f.branches.advance(now);assert.equal(f.branches.executionBudget(b.id,now).used,1);f.reopen();f.branches.advance('2026-01-02T00:00:00.000Z');assert.equal(f.branches.executionBudget(b.id,'2026-01-02T00:00:00.000Z').used,0);assert.ok(f.branches.execution(c.child.id).admittedAt);
});
test('migration grandfathers only started work and fresh budgets default unlimited',()=>{
 const db=new Database(':memory:');try{db.exec('CREATE TABLE branches(id TEXT PRIMARY KEY); CREATE TABLE branch_executions(id TEXT PRIMARY KEY,state TEXT,created_at TEXT,parent_attempt_id TEXT); CREATE TABLE trigger_occurrences(branch_execution_id TEXT); CREATE TABLE branch_paths(execution_id TEXT);');
 db.exec("INSERT INTO branch_executions VALUES('queued','queued','time',NULL),('running','running','time',NULL),('canceled-before','canceled','time',NULL),('canceled-after','canceled','time','attempt'); INSERT INTO branch_paths VALUES('canceled-after');");
 db.exec(readFileSync(new URL('../src/schema/0031_branch_execution_budgets.sql',import.meta.url),'utf8'));
 assert.deepEqual(db.prepare('SELECT id FROM branch_executions WHERE admitted_at IS NOT NULL ORDER BY id').all().map(r=>r.id),['canceled-after','running']);assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_execution_budgets').get().n,0);assert.equal(db.prepare("SELECT admission_source FROM branch_executions WHERE id='queued'").get().admission_source,'manual');assert.equal(db.prepare("SELECT admission_source FROM branch_executions WHERE id='canceled-after'").get().admission_source,'call');
 }finally{db.close()}
});
test('process death before path commit rolls back debit; death after commit keeps receipt', {timeout:15000},async t=>{
 const f=fixture(t),b=f.deploy('death');f.budget(b.id);const c=call(f,b,'death');
 for(const mode of ['before-path','after-commit']){
 const worker=fork(new URL('./branch-execution-budget-worker.mjs',import.meta.url),[join(f.dir,'ponderosa.db'),mode],{stdio:['ignore','ignore','inherit','ipc']});t.after(()=>worker.kill());
 await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',()=>reject(new Error('exited before ready')))});
 const exit=new Promise(resolve=>worker.once('exit',(code,signal)=>resolve({code,signal})));worker.send('go');assert.equal((await exit).signal,'SIGKILL');
 f.reopen();const committed=mode==='after-commit';assert.equal(f.branches.executionBudget(b.id,now).used,committed?1:0);
 assert.equal(Boolean(f.branches.execution(c.child.id).admittedAt),committed);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM branch_paths WHERE execution_id=?').get(c.child.id).n,committed?1:0);
 }
 f.branches.advance(now);assert.equal(f.branches.executionBudget(b.id,now).used,1);
});
test('script-only retry and Map/Join work retain one execution charge',t=>{
 const f=fixture(t),b=f.deploy('script-retry',[script]);f.budget(b.id);const c=call(f,b,'script');f.branches.advance(now);
 const lease=f.branches.claimScript('worker',now);assert.equal(lease.executionId,c.child.id);f.branches.settleScript(lease,{failed:true,output:'failure'},now);
 const detail=f.branches.detail(c.child.id);f.branches.intervene(c.child.id,{commandKey:'retry',expectedRevision:detail.execution.revision,action:'retry',attemptId:detail.attempts[0].id,reason:'try again'},now);f.branches.advance(now);
 const retry=f.branches.claimScript('worker',now);f.branches.settleScript(retry,{failed:false,output:'okay'},now);assert.equal(f.branches.executionBudget(b.id,now).used,1);
 const map=f.deploy('map-budget',[script],{},[{id:'map',kind:'map',joinId:'join',workerId:'script',source:'list',maxItems:3,maxConcurrentItems:3},{id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}],[{id:'item',from:'map',to:'script',on:'selected'},{id:'return',from:'script',to:'join',on:'success'}]);f.budget(map.id);
 const parent=f.deploy('map-parent',[{id:'call',kind:'branch_call',branchRef:'child'}],{branches:{child:map.id}});const pe=f.branches.accept(parent.id,'map-input','["a","b","c"]',now);f.branches.advance(now);f.branches.advance(now);
 const child=f.branches.listExecutions(map.id).find(e=>e.parentExecutionId===pe.id);assert.ok(child);
 for(let i=0;i<3;i++){const item=f.branches.claimScript('worker',now);assert.equal(item.executionId,child.id);f.branches.settleScript(item,{failed:false,output:item.input},now)}
 f.branches.advance(now);assert.equal(f.branches.execution(child.id).state,'completed');assert.equal(f.branches.executionBudget(map.id,now).used,1);
});
test('budget receipts audit and drain-first deletion clean up local accounting',t=>{
 const f=fixture(t),b=f.deploy('delete');f.budget(b.id);const c=call(f,b,'delete');f.branches.advance(now);f.branches.cancel(c.parent.id,now);f.branches.advance(now);
 for(const gate of f.branches.gateNotificationEvents())f.branches.markGateNotification(gate.gateId,gate.revision,'resolved',now);
 const events=[];f.branches.publishAudit(e=>events.push(e));assert.ok(events.some(e=>e.type==='branch_execution_budget'&&e.kind==='policy_saved'));
 const count=events.length;f.branches.publishAudit(e=>events.push(e));assert.equal(events.length,count);
 f.branches.beginDeletion(c.parent.branchId);f.branches.publishAudit(()=>{});f.branches.deleteBranch(c.parent.branchId);
 f.branches.beginDeletion(b.id);f.branches.publishAudit(()=>{});f.branches.deleteBranch(b.id);
 for(const table of ['branch_execution_budgets','branch_execution_budget_commands','branch_execution_budget_events'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE branch_id=?`).get(b.id).n,0);
 assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
});
test('queue bound includes held work; scans past it to exempt manual work and keeps receipts on duplicates',t=>{
 const f=fixture(t),base=f.deploy('queue-budget'),definition={...f.branches.version(base.id,base.versionId).definition,trigger:{kind:'schedule',configRef:'source'}};
 const config={scheduleKind:'once',at:'2027-01-01T00:00:00.000Z'};
 const b=f.branches.deploy({chatId:'',branchId:base.id,expectedVersionId:base.versionId,idempotencyKey:'queue-trigger',definition,bindings:{agents:{},directories:{root:f.dir},triggers:{source:{enabled:true,sourceConfig:config}}}},now,{sourceConfig:config});f.budget(b.id,{limit:1,period:'lifetime'});
 const intake=key=>f.coordination.recordTriggerOccurrence({triggerId:b.triggerId,occurrenceKey:key,payload:{key},provenance:{source:'test'},now});
 const first=intake('first');f.branches.advance(now);
 for(let i=0;i<999;i++)intake('queued-'+i);
 const manual=f.branches.accept(b.id,'manual-last','input',now);
 assert.throws(()=>intake('overflow'),/pending execution limit/);
 const replay=intake('queued-0');assert.equal(replay.replayed,true);
 for(let i=0;i<11;i++)f.branches.advance(now);
 assert.ok(f.branches.execution(manual.id).admittedAt);assert.equal(f.branches.executionBudget(b.id,now).used,1);assert.equal(f.branches.executionBudget(b.id,now).heldCount,999);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM branch_executions WHERE branch_id=? AND state='queued'").get(b.id).n,999);
 assert.equal(f.coordination.listTriggerOccurrences(b.triggerId).some(o=>o.occurrenceKey==='overflow'),false);
});
test('replayed grant after rollover retains its original receipt without refilling the new period',t=>{
 const f=fixture(t),b=f.deploy('grant-rollover');f.budget(b.id);const g=grant(f,b.id,3);
 const at='2026-01-02T00:00:00.000Z';const rolled=f.branches.executionBudget(b.id,at);assert.equal(rolled.allowance,0);
 assert.deepEqual(f.branches.grantExecutions(b.id,g.input,at),g.result);assert.equal(f.branches.executionBudget(b.id,at).allowance,0);
 assert.throws(()=>f.branches.grantExecutions(b.id,{...g.input,commandKey:'late'},at),/conflict/);
});
test('real upgrade preserves old manual and bound Call intake and grandfathers only starts',t=>{
 const f=fixture(t),b=f.deploy('upgrade'),manual=f.branches.accept(b.id,'manual:legacy','input',now),c=call(f,b,'upgrade');f.branches.advance(now);
 const queued=f.branches.accept(b.id,'queued-legacy','queued',now);
 // Recreate the exact pre-extension schema from an otherwise-current database.
 f.db.exec('DROP TABLE branch_execution_budget_events; DROP TABLE branch_execution_budget_commands; DROP TABLE branch_execution_budgets; ALTER TABLE branch_executions DROP COLUMN budget_wait; ALTER TABLE branch_executions DROP COLUMN admission_json; ALTER TABLE branch_executions DROP COLUMN admitted_at; ALTER TABLE branch_executions DROP COLUMN admission_source;');
 f.db.prepare("DELETE FROM _schema_version WHERE name='0031_branch_execution_budgets.sql'").run();f.reopen();
 assert.equal(f.branches.execution(queued.id).admittedAt,undefined);assert.equal(f.branches.execution(queued.id).admissionSource,'manual');assert.ok(f.branches.execution(manual.id).admittedAt);assert.equal(f.branches.execution(c.child.id).admissionSource,'call');
 f.budget(b.id);f.branches.advance(now);assert.equal(f.branches.executionBudget(b.id,now).used,0);assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
});
test('retrying a failed Call creates a new counted child while its manual parent stays exempt',t=>{
 const f=fixture(t),b=f.deploy('call-retry-budget',[script]);f.budget(b.id,{limit:1,period:'lifetime'});const c=call(f,b,'call-retry');f.budget(c.parent.branchId,{limit:1,period:'lifetime'});f.branches.advance(now);
 const first=f.branches.claimScript('worker',now);assert.equal(first.executionId,c.child.id);f.branches.settleScript(first,{failed:true,output:'child failed'},now);f.branches.advance(now);
 const parent=f.branches.detail(c.parent.id);assert.equal(parent.execution.state,'failed');f.branches.intervene(c.parent.id,{commandKey:'retry-call',expectedRevision:parent.execution.revision,action:'retry',attemptId:parent.attempts[0].id,reason:'new child'},now);
 f.branches.advance(now);f.branches.advance(now);const children=f.branches.listExecutions(b.id);assert.equal(children.length,2);
 const second=children.find(e=>e.id!==c.child.id);assert.ok(second.budgetWait);assert.equal(second.state,'queued');assert.equal(f.branches.executionBudget(b.id,now).used,1);assert.equal(f.branches.executionBudget(c.parent.branchId,now).used,0);
 grant(f,b.id);f.branches.advance(now);const retry=f.branches.claimScript('worker',now);assert.equal(retry.executionId,second.id);f.branches.settleScript(retry,{failed:false,output:'second result'},now);f.branches.advance(now);
 assert.equal(f.branches.executionBudget(b.id,now).used,2);assert.equal(f.branches.execution(c.parent.id).output,'second result');
});
