import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import test from 'node:test';
import {AgentStore,CoordinationV3Store,BranchStore} from '../../packages/agents/dist/index.js';
const require=createRequire(new URL('../../packages/agents/package.json',import.meta.url));
const Database=require('better-sqlite3');
const script=id=>({id,kind:'script',runtime:'node',source:'// never executed',cwdRef:'root',timeoutMs:5000});
const condition=(id,otherwise='work')=>({id,kind:'condition',predicate:{source:'input',equals:'input'},otherwise});
const edge=(id,from,to,on='success',extra={})=>({id,from,to,on,...extra});
function fixture(t,graph={}){
 const dir=mkdtempSync(join(tmpdir(),'branch-unit-handoff-')),store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const observer=new Database(store.sqlite.name,{readonly:true,fileMustExist:true});
 t.after(async()=>{if(branches.unitSaver)await branches.unitSaver.drain().catch(()=>{});observer.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Boundary',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Boundary'});
 const agent=store.createAgent(project.id,{title:'Controlled',engine:'codex',conversationId:chat.id});
 const definition={schema:'ponderosa.branch.v1',name:'Boundary',trigger:{kind:'manual'},entry:'work',steps:[script('work')],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}},...graph};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{worker:agent.id},directories:{root:dir}}});
 const execution=branches.accept(branch.id,'input','input');
 return {store,branches,coordination,agent,observer,branch,execution,dir};
}
const snapshots=f=>f.store.sqlite.prepare('SELECT * FROM branch_unit_snapshots ORDER BY id').all().map(r=>({...r,snapshot:JSON.parse(r.snapshot_json)}));
const settlementGraph={entry:'a',steps:[script('a'),script('b')],controls:[condition('c','b')],edges:[edge('a-c','a','c'),edge('yes','c','b','selected'),edge('no','c','b','failure')]};

test('B1 each control exposes a committed frontier before the following control or Script preparation',async t=>{
 const f=fixture(t,{entry:'c1',controls:[condition('c1'),condition('c2')],edges:[edge('yes1','c1','c2','selected'),edge('no1','c1','work','failure'),edge('yes2','c2','work','selected'),edge('no2','c2','work','failure')]});
 const observed=[];const read=f.observer.prepare('SELECT node_id,traversals FROM branch_paths WHERE execution_id=?');
 f.store.sqlite.function('observe_condition',id=>{observed.push(read.get(id));return 1;});
 f.store.sqlite.exec("CREATE TEMP TRIGGER observe_unit AFTER INSERT ON branch_checkpoints WHEN NEW.kind='condition_selected' BEGIN SELECT observe_condition(NEW.execution_id); END");
 f.branches.advance();
 assert.deepEqual(observed,[{node_id:'c1',traversals:0},{node_id:'c2',traversals:1}]);
 assert.equal(f.branches.unitSaver.status(f.execution.id).state,'pending'); // Async default overlaps pending work.
 await f.branches.unitSaver.drain();
 const frontiers=snapshots(f).map(r=>r.snapshot.selected.paths[0]?.node_id);
 assert.deepEqual(frontiers,[undefined,'c1','c2','work','work']);
 assert.ok(snapshots(f).every(r=>r.snapshot.restore_supported===false));
 for(const row of snapshots(f))assert.equal(createHash('sha256').update(row.snapshot_json).digest('hex'),row.content_hash);
 assert.equal(f.branches.unitSaver.status(f.execution.id).contentHash,snapshots(f).at(-1).content_hash);
});

test('B2 owned outer rollback and caught nested rollback publish no discarded owners',async t=>{
 const f=fixture(t);await f.branches.unitSaver.drain();const before=snapshots(f).length;
 assert.throws(()=>f.branches.unitTransaction(()=>{f.branches.advance();throw new Error('outer rollback');}).immediate(),/outer rollback/);
 await f.branches.unitSaver.drain();assert.equal(snapshots(f).length,before);assert.equal(f.branches.execution(f.execution.id).state,'queued');
 const other=f.branches.accept(f.branch.id,'other','input');await f.branches.unitSaver.drain();const beforeNested=snapshots(f).length;
 f.branches.unitTransaction(()=>{
  assert.throws(()=>f.branches.unitTransaction(()=>{f.branches.chargeTraversal(other.id);throw new Error('nested rollback');})(),/nested rollback/);
  f.branches.chargeTraversal(f.execution.id);
 })();
 await f.branches.unitSaver.drain();assert.deepEqual(snapshots(f).slice(beforeNested).map(r=>r.execution_id),[f.execution.id]);
 assert.equal(f.store.sqlite.prepare('SELECT traversals FROM branch_executions WHERE id=?').get(other.id).traversals,0);
});

test('B3 observed Script result and edge commit before any suffix transition',async t=>{
 const f=fixture(t,settlementGraph);f.branches.advance();const lease=f.branches.claimScript('controlled');assert.ok(lease);
 f.branches.settleScript(lease,{failed:false,output:'input'});
 assert.deepEqual(f.observer.prepare('SELECT step_id,state FROM branch_step_executions ORDER BY rowid').all(),[{step_id:'a',state:'completed'}]);
 assert.equal(f.observer.prepare('SELECT node_id FROM branch_paths WHERE execution_id=?').get(f.execution.id).node_id,'c');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_sealed_results').get().n,1);
 await f.branches.unitSaver.drain();
 assert.equal(snapshots(f).at(-1).snapshot.selected.paths[0].node_id,'c');
 f.branches.advance();assert.equal(f.branches.claimScript('controlled').executionId,f.execution.id);
});

for(const failure of ['freeze','insert'])test(`B4 ${failure} snapshot failure preserves known result and cancellation; independent failure channel`,async t=>{
 const f=fixture(t,settlementGraph);f.branches.advance();const lease=f.branches.claimScript('controlled');await f.branches.unitSaver.drain();
 if(failure==='freeze')f.branches.unitSaver.freeze=()=>{throw new Error('injected freeze failure');};
 else f.store.sqlite.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON branch_unit_snapshots BEGIN SELECT RAISE(ABORT,'injected insert failure'); END");
 assert.doesNotThrow(()=>f.branches.settleScript(lease,{failed:false,output:'known'}));
 await assert.rejects(f.branches.unitSaver.drain(),/durability failed/);
 const attempt=f.store.sqlite.prepare('SELECT state,result_json,fence FROM branch_attempts WHERE id=?').get(lease.attemptId);
 assert.deepEqual(attempt,{state:'completed',result_json:'{"failed":false,"output":"known"}',fence:lease.fence});
 f.branches.markScriptUnknown(lease,'must not change a known result');assert.equal(f.store.sqlite.prepare('SELECT state FROM branch_attempts WHERE id=?').get(lease.attemptId).state,'completed');
 assert.doesNotThrow(()=>f.branches.cancel(f.execution.id));assert.equal(f.branches.execution(f.execution.id).state,'canceled');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_sealed_results').get().n,1);
});

test('B5 final C/P/G counter closure is captured once each despite unchanged revisions; D/X excluded',async t=>{
 const f=fixture(t),ids={C:f.execution.id};for(const name of ['G','P','D','X'])ids[name]=f.branches.accept(f.branch.id,name,'input').id;
 await f.branches.unitSaver.drain();
 f.store.sqlite.prepare('UPDATE branch_executions SET parent_execution_id=? WHERE id=?').run(ids.G,ids.P);
 for(const name of ['C','D'])f.store.sqlite.prepare('UPDATE branch_executions SET parent_execution_id=? WHERE id=?').run(ids.P,ids[name]);
 f.store.sqlite.prepare("INSERT INTO branch_paths(id,execution_id,state,node_id,input_text) VALUES('controlled-path',?,'active','work','input')").run(ids.C);
 const before=snapshots(f).length;
 const revisions=Object.fromEntries(Object.entries(ids).map(([key,id])=>[key,f.store.sqlite.prepare('SELECT revision FROM branch_executions WHERE id=?').get(id).revision]));
 f.branches.unitTransaction(()=>{
  f.branches.chargeTraversal(ids.C);f.branches.chargeTraversal(ids.C,true);
  f.branches.followEdge('controlled-path',edge('loop','work','work','success',{loop:true}),'input',{failed:false,output:'input'},new Date().toISOString());
  f.branches.chargeTraversal(ids.C);
 })();
 assert.equal(snapshots(f).length,before);await f.branches.unitSaver.drain();
 const saved=snapshots(f).slice(before);assert.deepEqual(saved.map(r=>r.execution_id),[ids.C,ids.P,ids.G].sort());
 for(const r of saved){const e=r.snapshot.selected.execution[0];assert.equal(e.traversals,2);assert.equal(e.recovery_traversals,1);assert.equal(e.loop_iterations,1);}
 for(const [key,id] of Object.entries(ids))assert.equal(f.store.sqlite.prepare('SELECT revision FROM branch_executions WHERE id=?').get(id).revision,revisions[key]);
 assert.equal(saved.find(r=>r.execution_id===ids.C).snapshot.selected.loops.length,1);
 for(const r of saved.filter(r=>r.execution_id!==ids.C))assert.deepEqual(r.snapshot.selected.loops,[]);
});

test('failed ancestor saver stops related new work, while known sibling result, cancellation and unrelated X proceed',async t=>{
 const f=fixture(t,settlementGraph),p=f.branches.accept(f.branch.id,'P','input'),d=f.branches.accept(f.branch.id,'D','input'),x=f.branches.accept(f.branch.id,'X','input');
 f.branches.advance();const leases=[];for(let n=0;n<4;n++)leases.push(f.branches.claimScript('controlled'));
 const dLease=leases.find(l=>l.executionId===d.id);assert.ok(dLease);await f.branches.unitSaver.drain();
 f.store.sqlite.prepare('UPDATE branch_executions SET parent_execution_id=? WHERE id IN (?,?)').run(p.id,f.execution.id,d.id);
 f.store.sqlite.exec(`CREATE TRIGGER fail_ancestor BEFORE INSERT ON branch_unit_snapshots WHEN NEW.execution_id='${p.id}' BEGIN SELECT RAISE(ABORT,'ancestor saver failed'); END`);
 f.branches.unitTransaction(()=>f.branches.chargeTraversal(f.execution.id))();await assert.rejects(f.branches.unitSaver.drain());
 assert.equal(f.branches.functionalReady(d.id),false);assert.equal(f.branches.functionalReady(x.id),true);
 assert.doesNotThrow(()=>f.branches.settleScript(dLease,{failed:false,output:'known sibling result'}));
 assert.equal(f.store.sqlite.prepare('SELECT state FROM branch_attempts WHERE id=?').get(dLease.attemptId).state,'completed');
 const xLease=leases.find(l=>l.executionId===x.id);f.branches.settleScript(xLease,{failed:false,output:'input'});
 f.branches.advance();
 assert.equal(f.store.sqlite.prepare('SELECT node_id FROM branch_paths WHERE execution_id=?').get(d.id).node_id,'c');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_step_executions WHERE execution_id=? AND step_id='b'").get(d.id).n,0);
 assert.equal(f.branches.claimScript('unrelated').executionId,x.id);
 f.branches.cancel(f.execution.id);assert.equal(f.store.sqlite.prepare('SELECT cancel_requested FROM branch_executions WHERE id=?').get(f.execution.id).cancel_requested,1);
 const fresh=f.branches.accept(f.branch.id,'independent','input');f.branches.advance();
 assert.ok(f.branches.claimScript('independent'));assert.equal(f.branches.execution(fresh.id).state,'running');
});

test('unowned ambient savepoint never publishes; deletion suppresses queued candidates; saved rows immutable',async t=>{
 const f=fixture(t);await f.branches.unitSaver.drain();const before=snapshots(f).length;
 assert.throws(()=>f.store.sqlite.transaction(()=>{f.branches.advance();throw new Error('raw outer rollback');})(),/raw outer rollback/);
 await assert.rejects(f.branches.unitSaver.drain(),/durability failed/);assert.equal(snapshots(f).length,before);
 assert.equal(f.branches.execution(f.execution.id).state,'queued');
 const other=f.branches.accept(f.branch.id,'deletion','input');
 f.store.sqlite.prepare('UPDATE branches SET deleting=1 WHERE id=?').run(f.branch.id);
 await assert.rejects(f.branches.unitSaver.drain());assert.equal(f.branches.unitSaver.status(other.id).state,'suppressed');
 assert.throws(()=>f.store.sqlite.prepare('UPDATE branch_unit_snapshots SET content_hash=?').run('bad'),/immutable/);
});

test('actual service reports notification saver failure outside delivery catch, without retrying the known notification',async t=>{
 const {BranchScriptService}=await import('../../apps/server/dist/branch-script-service.js');
 const f=fixture(t,{entry:'notify',steps:[{id:'notify',kind:'action',action:'notify',configRefs:[]}]});
 f.branches.advance();await f.branches.unitSaver.drain();
 f.store.sqlite.exec("CREATE TRIGGER fail_notification_snapshot BEFORE INSERT ON branch_unit_snapshots BEGIN SELECT RAISE(ABORT,'notification saver failed'); END");
 let notified=0,cleanup=0;
 const service=new BranchScriptService(f.branches,f.store,'controlled',{notifyAction:()=>{notified++;return 'known-notification';},resources:{tick:async admit=>{if(!admit)cleanup++;}}});
 await service.tick(true);await assert.rejects(f.branches.unitSaver.drain());
 await assert.rejects(service.tick(false),/durability failed/);assert.equal(cleanup,1);
 await assert.rejects(service.tick(true),/durability failed/);assert.equal(notified,1);
 assert.deepEqual(f.store.sqlite.prepare('SELECT state,notification_id FROM branch_actions').get(),{state:'delivered',notification_id:'known-notification'});
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE kind='action_delivery_failed'").get().n,0);
 assert.equal(f.branches.execution(f.execution.id).state,'completed');
});

test('freeze follows command receipt and snapshot errors including thrown undefined never replace the primary channel',async t=>{
 const f=fixture(t,{entry:'gate',steps:[{id:'gate',kind:'human_gate',prompt:'Approve?',editable:false},script('work')],edges:[edge('approved','gate','work','approved')]});
 f.branches.advance();await f.branches.unitSaver.drain();const gate=f.branches.detail(f.execution.id).gates[0];
 const freeze=f.branches.unitSaver.freeze.bind(f.branches.unitSaver);let receipts;
 f.branches.unitSaver.freeze=context=>{receipts=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_commands WHERE execution_id=?').get(f.execution.id).n;return freeze(context);};
 f.branches.resolveGate(gate.id,{commandKey:'approve',expectedRevision:gate.revision,decision:'approve'});
 assert.equal(receipts,1);assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_step_executions WHERE step_id='work'").get().n,0);
 await f.branches.unitSaver.drain();const before=snapshots(f).length;
 let caught=false;try{f.branches.unitTransaction(()=>{f.branches.chargeTraversal(f.execution.id);throw undefined;})()}catch(error){caught=true;assert.equal(error,undefined)}
 assert.equal(caught,true);await f.branches.unitSaver.drain();assert.equal(snapshots(f).length,before);
 f.branches.unitSaver.freeze=()=>{throw undefined};f.branches.cancel(f.execution.id);
 await assert.rejects(f.branches.unitSaver.drain(),error=>error instanceof AggregateError&&error.errors.length===1&&error.errors[0]===undefined);
 assert.equal(f.branches.execution(f.execution.id).state,'canceled');
});

test('already-observed Agent result seals despite saver failure, before suffix dispatch',async t=>{
 const f=fixture(t,{entry:'agent',steps:[{id:'agent',kind:'agent',target:{kind:'persistent_organization',ref:'worker'},instructions:'Controlled only'},script('work')],edges:[edge('next','agent','work')]});
 f.branches.advance();const attempt=f.branches.detail(f.execution.id).attempts[0];assert.ok(attempt.requestId);await f.branches.unitSaver.drain();
 f.store.sqlite.exec("CREATE TRIGGER fail_agent_snapshot BEFORE INSERT ON branch_unit_snapshots BEGIN SELECT RAISE(ABORT,'agent saver failed'); END");
 f.branches.unitTransaction(()=>f.branches.chargeTraversal(f.execution.id))();await assert.rejects(f.branches.unitSaver.drain());
 f.coordination.updateRequest({requestId:attempt.requestId,updateId:'known-agent-result',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'known'}});
 assert.doesNotThrow(()=>f.branches.advance());
 const detail=f.branches.detail(f.execution.id);assert.equal(detail.attempts[0].state,'completed');assert.equal(detail.steps[0].result.output,'known');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_sealed_results').get().n,1);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_step_executions WHERE step_id='work'").get().n,0);
 assert.equal(f.coordination.getRequest(attempt.requestId).state,'completed');
});

test('completed called execution is observed through public admission despite failed parent saver',async t=>{
 const f=fixture(t);
 const parent=f.branches.deploy({chatId:f.agent.conversationId,idempotencyKey:'parent',definition:{schema:'ponderosa.branch.v1',name:'Parent',trigger:{kind:'manual'},entry:'call',steps:[{id:'call',kind:'branch_call',branchRef:'child'},script('after')],controls:[],edges:[edge('after-call','call','after')],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:f.dir},branches:{child:f.branch.id}}});
 const execution=f.branches.accept(parent.id,'parent','input');let child;
 for(let n=0;n<5&&!child;n++){f.branches.advance();child=f.branches.listExecutions(f.branch.id).find(e=>e.parentExecutionId===execution.id)}
 assert.ok(child);f.branches.advance();let lease,childLease;
 while((lease=f.branches.claimScript('controlled'))){if(lease.executionId===child.id)childLease=lease}
 assert.ok(childLease);await f.branches.unitSaver.drain();
 f.store.sqlite.exec(`CREATE TRIGGER fail_parent_snapshot BEFORE INSERT ON branch_unit_snapshots WHEN NEW.execution_id='${execution.id}' BEGIN SELECT RAISE(ABORT,'parent saver failed'); END`);
 f.branches.unitTransaction(()=>f.branches.chargeTraversal(execution.id))();await assert.rejects(f.branches.unitSaver.drain());
 f.branches.settleScript(childLease,{failed:false,output:'child known'});assert.equal(f.branches.execution(child.id).state,'completed');
 assert.doesNotThrow(()=>f.branches.advance());const detail=f.branches.detail(execution.id);
 assert.equal(detail.steps[0].state,'completed');assert.equal(detail.steps[0].result.output,'child known');
 assert.equal(detail.steps.length,1);assert.equal(f.branches.claimScript('parent suffix'),undefined);
});
