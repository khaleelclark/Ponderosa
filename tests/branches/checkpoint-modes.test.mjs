import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {AgentStore,CoordinationV3Store,BranchStore} from '../../packages/agents/dist/index.js';
const script=id=>({id,kind:'script',runtime:'node',source:'// never executed',cwdRef:'root',timeoutMs:5000});
const edge=(id,from,to,on='success',extra={})=>({id,from,to,on,...extra});
const graph={entry:'c',steps:[script('work')],controls:[{id:'c',kind:'condition',predicate:{source:'input',equals:'input'},otherwise:'work'}],edges:[edge('yes','c','work','selected'),edge('no','c','work','failure')]};
function fixture(t,mode,extra=graph){
 const dir=mkdtempSync(join(tmpdir(),'checkpoint-modes-')),store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Modes',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Modes'});
 const definition={schema:'ponderosa.branch.v1',name:'Modes',trigger:{kind:'manual'},controls:[],edges:[],policy:{maxConcurrentExecutions:20,failure:{action:'stop'}},...extra};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{},directories:{root:dir}}});
 const configure=mode=>branches.configure(branch.id,{...branches.configuration(branch.id),checkpointMode:mode},store.sqlite.prepare('SELECT configuration_revision n FROM branches WHERE id=?').get(branch.id).n);
 if(mode!==undefined)configure(mode);
 const execution=branches.accept(branch.id,'first','input');
 return {store,branches,branch,execution,configure};
}
const rows=f=>f.store.sqlite.prepare('SELECT * FROM branch_unit_snapshots ORDER BY id').all();
const path=f=>f.store.sqlite.prepare('SELECT node_id FROM branch_paths WHERE execution_id=?').get(f.execution.id)?.node_id;
const invocation=f=>f.branches.execution(f.execution.id).checkpointInvocation;
const one=f=>f.branches.unitTransaction(()=>f.branches.advance())();

test('effective mode defaults async, rejects invalid input, and remains pinned after Branch reconfiguration',async t=>{
 const f=fixture(t,undefined);assert.equal(f.branches.configuration(f.branch.id).checkpointMode,undefined);assert.equal(invocation(f).mode,'async');assert.equal(invocation(f).durability,'pending');
 assert.throws(()=>f.configure('sometimes'),/checkpoint mode/);
 f.configure('sync');const next=f.branches.accept(f.branch.id,'next','input');
 assert.equal(f.branches.execution(next.id).checkpointInvocation.mode,'sync');assert.equal(invocation(f).mode,'async');
 f.branches.advance();assert.equal(path(f),'work'); // Async still overlaps pending.
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_paths WHERE execution_id=?').get(next.id).n,0);
 await f.branches.unitSaver.drain();assert.equal(invocation(f).durability,'saved');
 assert.equal(JSON.parse(rows(f)[0].snapshot_json).mode,'async');
});

test('sync waits INITIAL and each committed frontier before next control/preparation/claim',async t=>{
 const f=fixture(t,'sync');f.branches.advance();assert.equal(path(f),undefined);
 await f.branches.unitSaver.drain();f.branches.advance();assert.equal(path(f),'c');
 assert.equal(f.branches.claimScript('inert'),undefined);
 await f.branches.unitSaver.drain();f.branches.advance();assert.equal(path(f),'work');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_step_executions').get().n,0);
 await f.branches.unitSaver.drain();f.branches.advance();assert.equal(f.branches.claimScript('inert'),undefined);
 await f.branches.unitSaver.drain();const lease=f.branches.claimScript('inert');assert.ok(lease);
 assert.equal(invocation(f).durability,'pending');assert.equal(invocation(f).savedSnapshotId,undefined);
 assert.equal(f.branches.checkpointDispatch(lease),'waiting');await f.branches.unitSaver.drain();assert.equal(f.branches.checkpointDispatch(lease),'ready');assert.equal(invocation(f).durability,'saved');
 f.branches.settleScript(lease,{failed:false,output:'known'});assert.equal(f.branches.execution(f.execution.id).state,'completed');
 assert.equal(invocation(f).state,'terminal');assert.equal(invocation(f).durability,'pending');
 await f.branches.unitSaver.completeExits();assert.equal(invocation(f).durability,'saved');
});

test('mixed C/P/G written group waits only sync ancestor watermark, invalidates sibling readiness, leaves X independent',async t=>{
 const f=fixture(t,'async'),ids={C:f.execution.id};
 for(const [name,mode] of [['P','sync'],['G','exit'],['D','async'],['X','async']]){f.configure(mode);ids[name]=f.branches.accept(f.branch.id,name,'input').id;}
 await f.branches.unitSaver.drain();
 f.store.sqlite.prepare('UPDATE branch_executions SET parent_execution_id=? WHERE id=?').run(ids.G,ids.P);
 for(const name of ['C','D'])f.store.sqlite.prepare('UPDATE branch_executions SET parent_execution_id=? WHERE id=?').run(ids.P,ids[name]);
 assert.equal(f.branches.functionalReady(ids.D),true);
 let release;const held=new Promise(resolve=>{release=resolve});f.branches.unitSaver.lanes.set(ids.P,held);
 const before=rows(f).length;
 f.branches.unitTransaction(()=>f.branches.chargeTraversal(ids.C))();
 assert.equal(f.branches.unitSaver.status(ids.P).state,'pending');assert.equal(f.branches.unitSaver.status(ids.G).state,'coalesced');
 assert.equal(f.branches.functionalReady(ids.D),false);assert.equal(f.branches.functionalReady(ids.C),false);assert.equal(f.branches.functionalReady(ids.X),true);
 // Already-observed mandatory cancellation must not await the held ancestor lane.
 assert.doesNotThrow(()=>f.branches.cancel(ids.C));assert.equal(f.branches.execution(ids.C).state,'canceled');
 release();await f.branches.unitSaver.drain();assert.equal(f.branches.functionalReady(ids.D),true);
 assert.equal(rows(f).slice(before).filter(row=>row.execution_id===ids.G).length,0);
 assert.equal(f.branches.unitSaver.status(ids.G).state,'coalesced');
});

test('exit coalesces INITIAL and functional progress; terminal saves only final known result and completion is awaited',async t=>{
 const f=fixture(t,'exit');const segment=invocation(f).id;
 assert.equal(invocation(f).durability,'coalesced');await f.branches.unitSaver.drain();assert.equal(rows(f).length,0);
 f.branches.advance();const lease=f.branches.claimScript('inert');assert.ok(lease);await f.branches.unitSaver.drain();assert.equal(rows(f).length,0);
 assert.equal(invocation(f).id,segment);assert.equal(invocation(f).state,'active');
 f.branches.settleScript(lease,{failed:false,output:'known'});
 assert.equal(invocation(f).state,'terminal');assert.equal(invocation(f).durability,'pending');assert.equal(rows(f).length,0);
 await f.branches.unitSaver.completeExits();assert.equal(rows(f).length,1);assert.equal(invocation(f).durability,'saved');
 const snapshot=JSON.parse(rows(f)[0].snapshot_json);assert.equal(snapshot.mode,'exit');assert.equal(snapshot.invocationId,segment);assert.equal(snapshot.restore_supported,false);
 assert.equal(snapshot.selected.sealedResults[0].result_json,JSON.stringify({failed:false,output:'known'}));
});

test('exit human interrupt saves complete frontier; explicit resolution resumes with a fresh invocation before suffix',async t=>{
 const f=fixture(t,'exit',{entry:'gate',steps:[{id:'gate',kind:'human_gate',prompt:'Approve?',editable:false},script('work')],edges:[edge('next','gate','work','approved')]});
 const first=invocation(f).id;f.branches.advance();assert.equal(invocation(f).state,'interrupted');
 assert.equal(invocation(f).durability,'pending');await f.branches.unitSaver.completeExits();assert.equal(rows(f).length,1);
 assert.equal(f.branches.claimScript('inert'),undefined);
 const gate=f.branches.detail(f.execution.id).gates[0];const resolution=f.branches.resolveGate(gate.id,{commandKey:'approve',expectedRevision:gate.revision,decision:'approve'});
 assert.equal(resolution.execution.checkpointInvocation.durability,'pending');assert.equal(resolution.execution.checkpointInvocation.savedSnapshotId,undefined);
 f.branches.advance();assert.equal(invocation(f).id,first); // No resume through pending interrupt save.
 await f.branches.unitSaver.completeExits();f.branches.advance();assert.notEqual(invocation(f).id,first);assert.equal(invocation(f).state,'active');
 assert.equal(invocation(f).mode,'exit');assert.equal(invocation(f).durability,'coalesced');
 const lease=f.branches.claimScript('inert');assert.ok(lease);f.branches.settleScript(lease,{failed:false,output:'suffix'});await f.branches.unitSaver.completeExits();
 assert.equal(rows(f).length,3);assert.equal(f.store.sqlite.prepare("SELECT json_extract(checkpoint_invocation_json,'$.ordinal') n FROM branch_executions WHERE id=?").get(f.execution.id).n,2);
});

test('exit interruption stops new arms but lets an already leased sibling settle before final capture',async t=>{
 const f=fixture(t,'exit',{entry:'fork',steps:[script('work'),{id:'gate',kind:'human_gate',prompt:'Approve?',editable:false}],controls:[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['left','right']}],edges:[edge('left','fork','work','selected'),edge('right','fork','gate','selected'),edge('work-done','work','join'),edge('gate-done','gate','join','approved')]});
 let lease;
 for(let n=0;n<8&&!lease;n++){one(f);lease=f.branches.claimScript('inert');}
 assert.ok(lease);f.branches.advance();assert.equal(invocation(f).state,'interrupting');await f.branches.unitSaver.drain();assert.equal(rows(f).length,0);
 f.branches.settleScript(lease,{failed:false,output:'observed'});assert.equal(invocation(f).state,'interrupted');
 await f.branches.unitSaver.completeExits();assert.equal(rows(f).length,1);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_sealed_results').get().n,1);
});

for(const mode of ['sync','exit'])test(`${mode} failed final saver preserves known result, cancellation and unrelated work`,async t=>{
 const f=fixture(t,mode);for(let n=0;n<5;n++){await f.branches.unitSaver.drain();f.branches.advance();}
 await f.branches.unitSaver.drain();const lease=f.branches.claimScript('inert');assert.ok(lease);await f.branches.unitSaver.drain();
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_save BEFORE INSERT ON branch_unit_snapshots WHEN NEW.execution_id='${f.execution.id}' BEGIN SELECT RAISE(ABORT,'save failed'); END`);
 f.branches.settleScript(lease,{failed:false,output:'known'});await assert.rejects(f.branches.unitSaver.completeExits(),/durability failed/);
 assert.equal(f.branches.execution(f.execution.id).state,'completed');assert.equal(invocation(f).durability,'failed');assert.equal(invocation(f).savedSnapshotId,undefined);
 assert.equal(f.store.sqlite.prepare('SELECT state FROM branch_attempts WHERE id=?').get(lease.attemptId).state,'completed');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_attempts WHERE state='outcome_unknown'").get().n,0);
 assert.doesNotThrow(()=>f.branches.cancel(f.execution.id));f.configure('async');const x=f.branches.accept(f.branch.id,'X','input');f.branches.advance();assert.ok(f.branches.claimScript('independent'));
 assert.equal(f.branches.execution(x.id).state,'running');
});

test('exit rollback preserves prior coalesced frontier and invocation; nested discard emits no snapshot',async t=>{
 const f=fixture(t,'exit'),before={...invocation(f)};
 assert.throws(()=>f.branches.unitTransaction(()=>{f.branches.advance();f.branches.cancel(f.execution.id);throw new Error('rollback');})(),/rollback/);
 assert.deepEqual(invocation(f),before);assert.equal(f.branches.execution(f.execution.id).state,'queued');
 await f.branches.unitSaver.drain();assert.equal(rows(f).length,0);
 f.branches.cancel(f.execution.id);await f.branches.unitSaver.completeExits();assert.equal(rows(f).length,1);
});

test('service exit notification failure is separate from effect catch and still runs cleanup',async t=>{
 const {BranchScriptService}=await import('../../apps/server/dist/branch-script-service.js');
 const f=fixture(t,'exit',{entry:'notify',steps:[{id:'notify',kind:'action',action:'notify',configRefs:[]}]});
 f.branches.advance();f.store.sqlite.exec("CREATE TEMP TRIGGER fail_exit BEFORE INSERT ON branch_unit_snapshots BEGIN SELECT RAISE(ABORT,'exit failed'); END");
 let notified=0,cleanup=0;const service=new BranchScriptService(f.branches,f.store,'inert',{notifyAction:()=>{notified++;return 'known-notification'},resources:{tick:async admit=>{if(!admit)cleanup++}}});
 await service.tick(true);await assert.rejects(f.branches.unitSaver.drain(),/durability failed/);assert.equal(notified,1);
 assert.deepEqual(f.store.sqlite.prepare('SELECT state,notification_id FROM branch_actions').get(),{state:'delivered',notification_id:'known-notification'});
 await assert.rejects(service.tick(false),/durability failed/);assert.equal(cleanup,1);assert.equal(notified,1);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE kind='action_delivery_failed'").get().n,0);
});

test('pending sync result capture cannot block known settlement or cleanup; latest generation wins after awaited ancestor writes',async t=>{
 const f=fixture(t,'sync');for(let n=0;n<4;n++){await f.branches.unitSaver.drain();f.branches.advance();}await f.branches.unitSaver.drain();
 const lease=f.branches.claimScript('inert');await f.branches.unitSaver.drain();
 let release;f.branches.unitSaver.lanes.set(f.execution.id,new Promise(resolve=>{release=resolve}));
 f.branches.unitTransaction(()=>f.branches.chargeTraversal(f.execution.id))();const first=invocation(f).requiredWatermark;
 f.branches.settleScript(lease,{failed:false,output:'observed during pending save'});assert.equal(f.branches.execution(f.execution.id).state,'completed');
 assert.ok(invocation(f).requiredWatermark>first);assert.equal(invocation(f).durability,'pending');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_attempts WHERE state='outcome_unknown'").get().n,0);
 release();await f.branches.unitSaver.completeExits();assert.equal(invocation(f).durability,'saved');
});

test('an older saved interrupt cannot impersonate a newer pending resolved frontier after lifecycle reopen',async t=>{
 const f=fixture(t,'exit',{entry:'gate',steps:[{id:'gate',kind:'human_gate',prompt:'Approve?',editable:false},script('work')],edges:[edge('next','gate','work','approved')]});
 f.branches.advance();await f.branches.unitSaver.completeExits();const gate=f.branches.detail(f.execution.id).gates[0];
 let release;f.branches.unitSaver.lanes.set(f.execution.id,new Promise(resolve=>{release=resolve}));
 f.branches.resolveGate(gate.id,{commandKey:'approve',expectedRevision:gate.revision,decision:'approve'});
 const reopened=new BranchStore(f.store.sqlite,new CoordinationV3Store(f.store.sqlite));
 assert.equal(reopened.execution(f.execution.id).checkpointInvocation.durability,'coverage_unknown');
 const first=invocation(f).id;reopened.advance();assert.equal(reopened.execution(f.execution.id).checkpointInvocation.id,first);
 let completed=false;const completing=f.branches.unitSaver.completeExits().then(()=>{completed=true});await Promise.resolve();await Promise.resolve();assert.equal(completed,false);
 release();await completing;assert.equal(reopened.execution(f.execution.id).checkpointInvocation.durability,'saved');
 reopened.advance();assert.notEqual(reopened.execution(f.execution.id).checkpointInvocation.id,first);await reopened.unitSaver.drain();
});


test('actual sync service saves the claimed notification boundary before invoking the effect',async t=>{
 const {BranchScriptService}=await import('../../apps/server/dist/branch-script-service.js');
 const f=fixture(t,'sync',{entry:'notify',steps:[{id:'notify',kind:'action',action:'notify',configRefs:[]}]});
 let notified=0;const service=new BranchScriptService(f.branches,f.store,'inert',{notifyAction:()=>{assert.equal(f.branches.unitSaver.status(f.execution.id).state,'saved');notified++;return 'known';}});
 for(let n=0;n<6;n++)await service.tick(true);
 assert.equal(notified,1);assert.equal(f.branches.execution(f.execution.id).state,'completed');assert.equal(invocation(f).durability,'saved');
 assert.equal(invocation(f).savedContentHash,rows(f).at(-1).content_hash);
});


test('actual service never awaits a held sync owner: unrelated notification and cleanup continue; canceled queued lease cannot fire',async t=>{
 const {BranchScriptService}=await import('../../apps/server/dist/branch-script-service.js');
 const f=fixture(t,'sync',{entry:'notify',steps:[{id:'notify',kind:'action',action:'notify',configRefs:[]}]});
 for(let n=0;n<4;n++){await f.branches.unitSaver.drain();f.branches.advance();}await f.branches.unitSaver.drain();
 let release;f.branches.unitSaver.lanes.set(f.execution.id,new Promise(resolve=>{release=resolve}));
 f.configure('async');const x=f.branches.accept(f.branch.id,'X','input');const delivered=[],cleanups=[];
 const service=new BranchScriptService(f.branches,f.store,'inert',{notifyAction:input=>{delivered.push(input.branchExecutionId);return 'known-'+input.branchExecutionId},resources:{tick:async admit=>{if(!admit)cleanups.push('cleanup')}}});
 await service.tick(true);assert.deepEqual(delivered,[x.id]);assert.equal(invocation(f).durability,'pending');
 assert.equal(f.store.sqlite.prepare('SELECT a.state FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=?').get(f.execution.id).state,'leased');
 f.branches.cancel(f.execution.id);await service.tick(false);assert.deepEqual(cleanups,['cleanup']);
 release();await f.branches.unitSaver.drain();await service.tick(true);assert.deepEqual(delivered,[x.id]);assert.equal(f.branches.execution(f.execution.id).state,'canceled');
});

test('a pending notification lease revalidates current capability policy before any effect',async t=>{
 const {BranchScriptService}=await import('../../apps/server/dist/branch-script-service.js'),{CapabilityPolicyStore}=await import('../../packages/agents/dist/index.js'),{CAPABILITY_IDS}=await import('../../packages/core/dist/index.js');
 const f=fixture(t,'sync',{entry:'notify',steps:[{id:'notify',kind:'action',action:'notify',configRefs:[]}]});
 for(let n=0;n<4;n++){await f.branches.unitSaver.drain();f.branches.advance();}await f.branches.unitSaver.drain();
 let release;f.branches.unitSaver.lanes.set(f.execution.id,new Promise(resolve=>{release=resolve}));let notified=0;
 const service=new BranchScriptService(f.branches,f.store,'inert',{notifyAction:()=>{notified++;return 'forbidden'}});await service.tick(true);
 new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.notifications]});
 release();await f.branches.unitSaver.drain();await service.tick(true);assert.equal(notified,0);f.branches.cancel(f.execution.id);
});

test('pending sync Script lease consumes no process slot and is fenced before late release; no process launched',async t=>{
 const {BranchScriptService}=await import('../../apps/server/dist/branch-script-service.js');
 const f=fixture(t,'sync');for(let n=0;n<4;n++){await f.branches.unitSaver.drain();f.branches.advance();}await f.branches.unitSaver.drain();
 let release;f.branches.unitSaver.lanes.set(f.execution.id,new Promise(resolve=>{release=resolve}));
 f.configure('async');const x=f.branches.accept(f.branch.id,'X','input'),launched=[];
 const service=new BranchScriptService(f.branches,f.store,'inert',{maxConcurrentScripts:1});
 // Exercise actual claim/retention/readiness logic with an inert effect boundary.
 service.launch=async lease=>{assert.equal(f.branches.checkpointDispatch(lease),'ready');launched.push(lease.executionId);f.branches.settleScript(lease,{failed:false,output:'controlled'});};
 await service.tick(true);assert.deepEqual(launched,[]);await service.tick(true);assert.deepEqual(launched,[x.id]);
 f.branches.cancel(f.execution.id);release();await f.branches.unitSaver.drain();await service.tick(true);assert.deepEqual(launched,[x.id]);assert.equal(f.branches.execution(f.execution.id).state,'canceled');
});

test('persisted saver failure stays visible after lifecycle reopen and only blocks its related owners',async t=>{
 const f=fixture(t,'async');f.branches.advance();await f.branches.unitSaver.drain();
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_active BEFORE INSERT ON branch_unit_snapshots WHEN NEW.execution_id='${f.execution.id}' BEGIN SELECT RAISE(ABORT,'active save failed'); END`);
 f.branches.unitTransaction(()=>f.branches.chargeTraversal(f.execution.id))();await assert.rejects(f.branches.unitSaver.drain());
 const reopened=new BranchStore(f.store.sqlite,new CoordinationV3Store(f.store.sqlite));assert.equal(reopened.unitSaver.errors().length,1);assert.equal(reopened.functionalReady(f.execution.id),false);assert.equal(reopened.execution(f.execution.id).checkpointInvocation.durability,'failed');
 const x=reopened.accept(f.branch.id,'X','input');reopened.advance();assert.equal(reopened.claimScript('inert').executionId,x.id);await assert.rejects(reopened.unitSaver.drain());
});
