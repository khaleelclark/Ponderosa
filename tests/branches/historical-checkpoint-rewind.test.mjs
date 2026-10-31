import assert from 'node:assert/strict';
import test from 'node:test';
import {CAPABILITY_IDS} from '../../packages/core/dist/index.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store,CapabilityPolicyStore} from '../../packages/agents/dist/index.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(t,mode='async',loop=false,secret=false){
 const dir=mkdtempSync(join(tmpdir(),'historical-rewind-'));let store,branches;
 const open=()=>{store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));};open();
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'History',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'History'});
 const definition={schema:'ponderosa.branch.v1',name:'Historical',trigger:{kind:'manual'},entry:'a',steps:['a','b'].map(id=>({id,kind:'script',runtime:'node',source:`// ${id} never executed`,cwdRef:'root',timeoutMs:5000})),controls:[{id:'c',kind:'condition',predicate:{source:'input',equals:'prefix'},otherwise:'b'}],edges:[{id:'a-c',from:'a',to:'c',on:'success'},{id:'yes',from:'c',to:loop?'a':'b',on:'selected',...(loop?{loop:true}:{})},{id:'no',from:'c',to:'b',on:'failure'}],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}},...(secret?{parameters:{private:{type:'secret'}}}:{})};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{},directories:{root:dir}}});
 branches.configure(branch.id,{...branches.configuration(branch.id),checkpointMode:mode,...(secret?{secretBindings:{private:'opaque-never-embed'}}:{})},0);
 const source=branches.accept(branch.id,'source','input');
 const claim=async()=>{let lease;for(let n=0;n<16&&!lease;n++){await branches.unitSaver.drain();branches.advance();lease=branches.claimScript('inert');}assert.ok(lease);await branches.unitSaver.drain();assert.equal(branches.checkpointDispatch(lease),'ready');return lease;};
 return {get store(){return store},get branches(){return branches},branch,source,definition,dir,claim,
  async prefix(){const lease=await claim();branches.settleScript(lease,{failed:false,output:'prefix'});await branches.unitSaver.drain();return branches.historicalCheckpoints(branch.id,source.id).find(cp=>{const s=JSON.parse(store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);return cp.restoreSupported&&s.selected.paths[0]?.node_id==='c'&&s.selected.steps.length===1;});},
  async finish(){if(loop){const second=await claim();branches.settleScript(second,{failed:false,output:'stop'});}const last=await claim();branches.settleScript(last,{failed:false,output:'later suffix'});await branches.unitSaver.drain();assert.equal(branches.execution(source.id).state,'completed');},
  async reopen(){await branches.unitSaver.drain();store.close();open();}};
}
for(const mode of ['async','sync'])test(`noninitial ${mode} capture -> later progress -> historical selection -> fresh continuation`,async t=>{
 const f=fixture(t,mode),cp=await f.prefix();assert.ok(cp);const prefix=JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);
 await f.finish();const before=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots WHERE execution_id=?').get(f.source.id).n;
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'selected');
 assert.equal(next.state,'queued');assert.notEqual(next.id,f.source.id);
 const lineage=f.store.sqlite.prepare("SELECT * FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1'").get(next.id);assert.ok(lineage);
 const origin=JSON.parse(lineage.snapshot_json);assert.equal(origin.checkpointId,cp.id);assert.equal(origin.checkpointHash,cp.contentHash);assert.equal(hash(lineage.snapshot_json),lineage.content_hash);
 const restored=f.branches.detail(next.id);assert.equal(restored.steps.length,1);assert.equal(restored.steps[0].state,'completed');assert.equal(restored.steps[0].result.output,'prefix');
 assert.notEqual(restored.steps[0].id,prefix.selected.steps[0].id);assert.notEqual(restored.attempts[0].id,prefix.selected.attempts[0].id);assert.equal(restored.attempts[0].fence,0);
 assert.equal(f.store.sqlite.prepare('SELECT node_id FROM branch_paths WHERE execution_id=?').get(next.id).node_id,'c');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind=?').get(next.id,'restored_prefix').n,prefix.continuation.audit.length);
 assert.equal(f.branches.claimScript('too-early'),undefined,'lineage commits before scheduler admission or fresh dispatch');
 assert.equal(f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'selected').id,next.id);
 const suffix=await f.claim();assert.equal(suffix.executionId,next.id);assert.ok(suffix.source.includes('// b'));
 f.branches.settleScript(suffix,{failed:false,output:'new suffix'});await f.branches.unitSaver.drain();assert.equal(f.branches.execution(next.id).state,'completed');
 assert.equal(f.branches.detail(next.id).steps.length,2);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots WHERE execution_id=?').get(f.source.id).n,before);
 assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});

test('looped Script/control frontier retains counters, invocation numbering and exact sealed prefix',async t=>{
 const f=fixture(t,'async',true);await f.prefix();f.branches.advance();await f.branches.unitSaver.drain();
 const cp=f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(cp=>{const s=JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);return cp.restoreSupported&&s.selected.execution[0].loop_iterations===1;});assert.ok(cp);
 await f.finish();const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'loop');
 assert.equal(f.store.sqlite.prepare('SELECT loop_iterations FROM branch_executions WHERE id=?').get(next.id).loop_iterations,1);
 assert.equal(f.store.sqlite.prepare('SELECT iterations FROM branch_loop_counts WHERE execution_id=?').get(next.id).iterations,1);
 const a=await f.claim();assert.ok(a.source.includes('// a'));assert.equal(f.branches.detail(next.id).steps.find(s=>s.state==='leased').invocation,2);
 f.branches.settleScript(a,{failed:false,output:'stop'});const b=await f.claim();f.branches.settleScript(b,{failed:false,output:'done'});
 assert.equal(f.branches.execution(next.id).state,'completed');assert.equal(f.branches.detail(next.id).sealedResults.length,3);
});

test('idempotent immutable historical lineage survives reopen and conflicts cannot create another execution',async t=>{
 const f=fixture(t),cp=await f.prefix();await f.finish();const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'once');await f.reopen();
 assert.equal(f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'once').id,next.id);
 const other=f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(c=>c.restoreSupported&&c.id!==cp.id);assert.ok(other);
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,other.id,other.contentHash,'once'),/idempotency conflict/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,2);
 assert.throws(()=>f.store.sqlite.prepare("UPDATE branch_unit_snapshots SET content_hash='changed'").run(),/immutable/);
});

test('invalid hash, foreign owner and live-source uncertainty refuse before new execution or receipt',async t=>{
 const f=fixture(t),cp=await f.prefix();assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'live'),/settled standalone/);
 await f.finish();assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,'0'.repeat(64),'hash'),/hash/);
 assert.throws(()=>f.branches.rewindHistorical('foreign',f.source.id,cp.id,cp.contentHash,'owner'),/unavailable/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,1);
});
for(const corrupt of ['runtime','pin','frontier','audit'])test(`rehashed but incompatible ${corrupt} capture is refused`,async t=>{
 const f=fixture(t),cp=await f.prefix();await f.finish();const s=JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);
 if(corrupt==='runtime')s.continuation.compatibility.format='different-runtime';else if(corrupt==='pin')s.continuation.versionHash='0'.repeat(64);else if(corrupt==='frontier')s.selected.paths[0].last_result_id='missing';else s.continuation.audit=[];
 // Deliberate new corrupt private row, never weakening immutable production triggers.
 const {stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');const bytes=stableJson(s);
 const bad=f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,bytes,hash(bytes));
 assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(cp=>cp.id===Number(bad.lastInsertRowid)).restoreSupported,false);
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,Number(bad.lastInsertRowid),hash(bytes),'bad'),/unsupported|failed verification/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,1);
});

test('changed current configuration, Script policy and owner deletion fence historical continuation',async t=>{
 const f=fixture(t),cp=await f.prefix();await f.finish();
 const policies=new CapabilityPolicyStore(f.store.sqlite);policies.put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.scripts]});
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'restricted'),/authority is restricted/);
 policies.put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:1,restrictedCapabilityIds:[]});
 f.branches.configure(f.branch.id,{...f.branches.configuration(f.branch.id),checkpointMode:'sync'},1);
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'changed'),/pins changed/);
 f.branches.beginDeletion(f.branch.id);assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'deleted'),/unavailable/);
});

test('lineage insert failure rolls back new prefix, receipt and saver candidates before dispatch; deletion is FK-safe',async t=>{
 const f=fixture(t),cp=await f.prefix();await f.finish();const rows=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n;
 f.store.sqlite.exec("CREATE TEMP TRIGGER fail_lineage BEFORE INSERT ON branch_unit_snapshots WHEN json_extract(NEW.snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1' BEGIN SELECT RAISE(ABORT,'lineage failed'); END");
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'atomic'),/lineage failed/);await f.branches.unitSaver.drain();
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,1);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_commands').get().n,0);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n,rows);
 f.store.sqlite.exec('DROP TRIGGER fail_lineage');const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'atomic');f.branches.cancel(next.id);await f.branches.unitSaver.drain();
 assert.throws(()=>f.branches.deleteBranch(f.branch.id),/audit publication/);f.branches.publishAudit(()=>{});f.branches.deleteBranch(f.branch.id);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n,0);assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});

test('secret-dependent and leased points remain unsupported; exit does not invent intermediate durable snapshots',async t=>{
 const f=fixture(t,'async',false,true);const lease=await f.claim();await f.branches.unitSaver.drain();
 assert.ok(f.branches.historicalCheckpoints(f.branch.id,f.source.id).every(c=>!c.restoreSupported));
 assert.ok(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots').all().every(r=>!r.snapshot_json.includes('opaque-never-embed')));
 f.branches.settleScript(lease,{failed:false,output:'known'});
 const x=fixture(t,'exit');await x.prefix();assert.equal(x.branches.historicalCheckpoints(x.branch.id,x.source.id).length,0);await x.finish();assert.ok(x.branches.historicalCheckpoints(x.branch.id,x.source.id).every(c=>!c.restoreSupported));
});

test('historical HTTP list/rewind enforce exact shape and commit a queued lineage before notify',async t=>{
 const f=fixture(t),cp=await f.prefix();await f.finish();const {createRequire}=await import('node:module');const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
 const {registerBranchRoutes}=await import('../../apps/server/dist/routes/branches.js');const app=require('fastify')();t.after(()=>app.close());let notified=0;
 registerBranchRoutes(app,{branches:f.branches,store:f.store,installations:{setPublisher(){}},notify(){notified++;assert.ok(f.store.sqlite.prepare("SELECT 1 FROM branch_unit_snapshots WHERE json_extract(snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1'").get());}});
 const base=`/api/branches/${f.branch.id}/executions/${f.source.id}`;
 const list=await app.inject({method:'GET',url:`${base}/historical-checkpoints`});assert.equal(list.statusCode,200);assert.ok(list.json().some(c=>c.id===cp.id&&c.restoreSupported));
 assert.equal((await app.inject({method:'GET',url:`${base}/historical-checkpoints?before=bad`})).statusCode,409);
 const command={checkpointId:cp.id,expectedHash:cp.contentHash,commandKey:'http'};
 assert.equal((await app.inject({method:'POST',url:`${base}/rewind-historical`,payload:{...command,extra:true}})).statusCode,409);
 const result=await app.inject({method:'POST',url:`${base}/rewind-historical`,payload:command});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().state,'queued');assert.equal(notified,1);
 assert.equal((await app.inject({method:'POST',url:`${base}/rewind-historical`,payload:command})).json().id,result.json().id);
});

test('nonempty audit with a missing sealed-result event must refuse',async t=>{
 const f=fixture(t),cp=await f.prefix();await f.finish();
 const snapshot=JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);
 const original=snapshot.continuation.audit;
 const sealed=original.find(r=>r.kind==='result_sealed');assert.ok(sealed);
 snapshot.continuation.audit=original.filter(r=>r.id!==sealed.id);
 const {stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');const bytes=stableJson(snapshot);
 const bad=f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,bytes,hash(bytes));
 const id=Number(bad.lastInsertRowid);
 const before={owners:f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,snapshots:f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n};
 let next,error;try{next=f.branches.rewindHistorical(f.branch.id,f.source.id,id,hash(bytes),'missing-one-audit');}catch(e){error=e.message;}
 assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(r=>r.id===id).restoreSupported,false);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_commands WHERE execution_id=?').get(f.source.id).n,0);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,before.owners);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n,before.snapshots);
 assert.ok(error,'rewind accepted a nonempty but incomplete exact audit prefix');
});

test('rehash must not redirect a sealed-prefix frontier back to its completed Script',async t=>{
 const f=fixture(t),cp=await f.prefix();await f.finish();
 const s=JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);
 assert.equal(s.selected.paths[0].node_id,'c');s.selected.paths[0].node_id='a';
 const {stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');const bytes=stableJson(s);
 const bad=f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,bytes,hash(bytes));const id=Number(bad.lastInsertRowid);
 const before={owners:f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,snapshots:f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n};
 let next,error;try{next=f.branches.rewindHistorical(f.branch.id,f.source.id,id,hash(bytes),'redirect-prefix');}catch(e){error=e.message;}
 let claim;if(next)claim=await f.claim();
 assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(r=>r.id===id).restoreSupported,false);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_commands WHERE execution_id=?').get(f.source.id).n,0);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,before.owners);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n,before.snapshots);
 assert.ok(error,'rewind accepted redirected frontier and issued a fresh lease for already sealed Script a');
});

for(const [name,mutate] of [
 ['missing interior lease',s=>{s.continuation.audit=s.continuation.audit.filter(r=>r.kind!=='script_leased');}],
 ['changed audit evidence',s=>{s.continuation.audit[0].evidence_json='{}';}],
 ['selected owner',s=>{s.selected.execution[0].branch_id='foreign';}],
 ['selected path input',s=>{s.selected.paths[0].input_text='corrupt';}],
 ['selected original input',s=>{s.selected.execution[0].input_text='corrupt';}],
 ['selected last result',s=>{s.selected.paths[0].last_result_id=null;}],
 ['selected invocation',s=>{s.selected.steps[0].invocation++;}],
 ['selected traversal total',s=>{s.selected.paths[0].traversals++;s.selected.execution[0].traversals++;}],
 ['selected prepared input',s=>{const step=s.selected.steps[0];step.input_text='corrupt';s.selected.attempts[0].input_hash=hash('corrupt');}],
])test(`audit/frontier semantic mismatch refuses ${name} without allocating`,async t=>{
 const f=fixture(t),cp=await f.prefix();await f.finish();
 const snapshot=JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);
 mutate(snapshot);
 const {stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');const bytes=stableJson(snapshot);
 const inserted=f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,bytes,hash(bytes));
 const id=Number(inserted.lastInsertRowid),owners=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n;
 assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(r=>r.id===id).restoreSupported,false);
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,id,hash(bytes),`bad-${name}`));
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,owners);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_commands WHERE execution_id=?').get(f.source.id).n,0);
});
