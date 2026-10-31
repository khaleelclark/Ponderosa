import {encodeScriptContinuation} from '../../packages/agents/dist/branch-script-continuation.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {CAPABILITY_IDS} from '../../packages/core/dist/index.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store,CapabilityPolicyStore} from '../../packages/agents/dist/index.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(t,mode='async',loop=false,secret=false,exitHistory=false,chainHistory=false){
 const dir=mkdtempSync(join(tmpdir(),'historical-rewind-'));let store,branches;
 const open=()=>{store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));};open();
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'History',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'History'});
 const definition={schema:'ponderosa.branch.v1',name:'Historical',trigger:{kind:'manual'},entry:'a',steps:['a','b'].map(id=>({id,kind:'script',runtime:'node',source:`// ${id} never executed`,cwdRef:'root',timeoutMs:5000})),controls:[{id:'c',kind:'condition',predicate:{source:'input',equals:'prefix'},otherwise:'b'}],edges:[{id:'a-c',from:'a',to:'c',on:'success'},{id:'yes',from:'c',to:loop?'a':'b',on:'selected',...(loop?{loop:true}:{})},{id:'no',from:'c',to:'b',on:'failure'}],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}},...(secret?{parameters:{private:{type:'secret'}}}:{})};
 if(exitHistory){definition.steps.push({id:'d',kind:'script',runtime:'node',source:'// d never executed',cwdRef:'root',timeoutMs:5000});definition.edges.push({id:'b-d',from:'b',to:'d',on:'success'});}
 if(chainHistory){definition.steps.push(...['e','f'].map(id=>({id,kind:'script',runtime:'node',source:`// ${id} never executed`,cwdRef:'root',timeoutMs:5000})));definition.edges.push({id:'d-e',from:'d',to:'e',on:'success'},{id:'e-f',from:'e',to:'f',on:'success'});}
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
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind=?').get(next.id,'restored_prefix').n,1);
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


const inertIdentity={pid:2147483647,pgid:2147483647,birthMarker:'controlled-no-process'};
const captureBytes=(f,id)=>JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(id).snapshot_json);
async function exitCut(t,loop=false,settle=true,chain=false){
 const f=fixture(t,'exit',loop,false,true,chain);
 await f.prefix();assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).length,0,'earlier exit progress is coalesced, never SAVED');
 const lease=await f.claim();f.branches.authorizeScript(lease,inertIdentity);
 const before=f.branches.execution(f.source.id).checkpointInvocation;
 const interrupt=()=>f.branches.checkpointInterruption(f.branch.id,f.source.id,'interrupt',before.id,'pause');
 const waiting=interrupt().checkpointInvocation;assert.equal(waiting.state,'interrupting');assert.ok(waiting.interruptionId);
 await f.branches.unitSaver.drain();assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).length,0);
 assert.equal(f.branches.claimScript('held'),undefined);
 assert.throws(()=>f.branches.checkpointInterruption(f.branch.id,f.source.id,'resume',waiting.interruptionId,'early-resume'),/saved quiescence/);
 const observe=(output='stopped')=>f.branches.recordScriptEvidence(lease,inertIdentity,{stdout:output,stderr:'',cwd:f.dir,runtime:'Node.js',finishedAt:new Date().toISOString(),outputHash:hash(output),code:0});
 const settleKnown=async()=>{observe();f.branches.settleScript(lease,{failed:false,output:'stopped'});await f.branches.unitSaver.completeExits();};
 if(settle)await settleKnown();
 const current=()=>f.branches.execution(f.source.id).checkpointInvocation;
 const point=()=>f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(c=>c.restoreSupported);
 const resume=()=>f.branches.checkpointInterruption(f.branch.id,f.source.id,'resume',waiting.interruptionId,'resume');
 const finish=async()=>{for(let n=0;n<4&&f.branches.execution(f.source.id).state!=='completed';n++){const suffix=await f.claim();f.branches.settleScript(suffix,{failed:false,output:'source later suffix'});}await f.branches.unitSaver.completeExits();assert.equal(f.branches.execution(f.source.id).state,'completed');};
 return Object.assign(f,{lease,waiting,before,interrupt,observe,settleKnown,current,point,resume,finish});
}

for(const loop of [false,true])test(`exit interrupted noninitial cut -> source completion -> fresh historical suffix, loop=${loop}`,async t=>{
 const f=await exitCut(t,loop),cp=f.point();assert.ok(cp,'quiescent closing exit cut must be executable');
 const cut=captureBytes(f,cp.id);assert.equal(cut.closing,true);assert.equal(cut.mode,'exit');assert.equal(cut.continuation.checkpoint.invocation.state,'interrupted');
 assert.equal(cut.continuation.checkpoint.invocation.interruptionId,f.waiting.interruptionId);assert.equal(cut.invocationId,f.before.id);
 assert.equal(f.current().durability,'saved');assert.equal(f.current().state,'interrupted');assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).length,1);
 for(let n=0;n<3;n++)f.branches.advance();assert.equal(f.current().id,f.before.id,'manual interruption cannot auto-resume');assert.equal(f.branches.claimScript('held'),undefined);
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'live'),/settled standalone/);
 const freshSource=f.resume().checkpointInvocation;assert.equal(freshSource.state,'active');assert.notEqual(freshSource.id,f.before.id);assert.equal(freshSource.durability,'coalesced');
 await f.finish();const oldCount=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots WHERE execution_id=?').get(f.source.id).n;
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'earlier-exit');
 assert.equal(next.state,'queued');assert.notEqual(next.checkpointInvocation.id,f.before.id);assert.equal(next.checkpointInvocation.interruptionId,undefined);
 const origin=JSON.parse(f.store.sqlite.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1'").get(next.id).snapshot_json);
 assert.equal(origin.checkpointHash,cp.contentHash);assert.equal(origin.sourceCheckpointInvocation.interruptionId,f.waiting.interruptionId);
 assert.equal(f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'earlier-exit').id,next.id);
 const prefix=f.branches.detail(next.id);assert.equal(prefix.steps.length,2);assert.ok(prefix.steps.every(s=>s.state==='completed'));
 assert.ok(prefix.steps.every(s=>!cut.selected.steps.some(old=>old.id===s.id)));
 if(loop){assert.equal(prefix.steps.filter(s=>s.stepId==='a').length,2);assert.equal(f.store.sqlite.prepare('SELECT loop_iterations FROM branch_executions WHERE id=?').get(next.id).loop_iterations,1);}
 const suffix=await f.claim();assert.equal(suffix.executionId,next.id);assert.ok(suffix.source.includes(loop?'// b':'// d'),'sealed prefix is not reissued');
 assert.equal(f.branches.checkpointDispatch(suffix),'ready','exit continuation has no INITIAL snapshot wait');
 f.branches.settleScript(suffix,{failed:false,output:'new suffix'});
 if(loop){const d=await f.claim();assert.ok(d.source.includes('// d'));f.branches.settleScript(d,{failed:false,output:'new final'});}
 await f.branches.unitSaver.completeExits();assert.equal(f.branches.execution(next.id).state,'completed');
 assert.equal(f.branches.detail(next.id).steps.length,loop?4:3);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots WHERE execution_id=?').get(f.source.id).n,oldCount);
 assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});

test('actual closed exit frontier encodes executable continuation through the used encoder',async t=>{
 const f=await exitCut(t),cp=f.point();assert.ok(cp);
 const snapshot=captureBytes(f,cp.id),encoded=encodeScriptContinuation(f.store.sqlite,f.source.id,snapshot.selected);
 assert.ok(encoded,'actual coherent noninitial exit interrupted frontier must encode');assert.equal(encoded.checkpoint.invocation.id,f.before.id);
});

test('coalesced, live and unknown exit cuts never become executable historical identities',async t=>{
 const f=await exitCut(t,false,false);assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).length,0);
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,99999,'0'.repeat(64),'coalesced'),/not found/);
 f.branches.markScriptUnknown(f.lease,'controlled uncertain effect');await f.branches.unitSaver.drain();
 assert.equal(f.current().state,'interrupting');assert.equal(f.current().durability,'coalesced');assert.equal(f.point(),undefined);
 assert.throws(()=>f.resume(),/saved quiescence/);assert.equal(f.branches.claimScript('unreleased'),undefined);
 assert.equal(f.branches.detail(f.source.id).attempts.find(a=>a.id===f.lease.attemptId).state,'outcome_unknown');
});

test('known settlement without process-exit observation retains interruption until actual observation',async t=>{
 const f=await exitCut(t,false,false);f.branches.settleScript(f.lease,{failed:false,output:'stopped'});await f.branches.unitSaver.drain();
 assert.equal(f.current().state,'interrupting');assert.equal(f.point(),undefined);assert.throws(()=>f.resume(),/saved quiescence/);
 f.observe();await f.branches.unitSaver.completeExits();assert.equal(f.current().state,'interrupted');assert.ok(f.point());
});

test('exit interruption command is idempotent, reopens at saved coverage and refuses stale identity',async t=>{
 const f=await exitCut(t),cp=f.point();assert.ok(cp);const count=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n;
 f.interrupt();await f.branches.unitSaver.drain();assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n,count);
 assert.throws(()=>f.branches.checkpointInterruption(f.branch.id,f.source.id,'interrupt','wrong','pause'),/idempotency conflict/);
 assert.throws(()=>f.branches.checkpointInterruption(f.branch.id,f.source.id,'resume','wrong','wrong'),/saved quiescence/);
 const policies=new CapabilityPolicyStore(f.store.sqlite);policies.put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.scripts]});
 assert.throws(()=>f.resume(),/authority/);policies.put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:1,restrictedCapabilityIds:[]});
 await f.reopen();assert.equal(f.branches.execution(f.source.id).checkpointInvocation.state,'interrupted');
 // Reopened authority comes from canonical saved closing bytes, not an in-memory ticket.
 const resumed=f.branches.checkpointInterruption(f.branch.id,f.source.id,'resume',f.waiting.interruptionId,'resume-after-reopen');assert.notEqual(resumed.checkpointInvocation.id,f.before.id);
 const same=f.branches.checkpointInterruption(f.branch.id,f.source.id,'resume',f.waiting.interruptionId,'resume-after-reopen');assert.equal(same.checkpointInvocation.id,resumed.checkpointInvocation.id);
 assert.throws(()=>f.branches.checkpointInterruption(f.branch.id,f.source.id,'interrupt',f.before.id,'stale'),/changed/);
});

for(const corrupt of ['closing','invocation','interruption','ordinal','missing invocation','missing pause audit','sealed result','pin'])test(`exit closing cut refuses rehashed ${corrupt} corruption before allocation`,async t=>{
 const f=await exitCut(t),cp=f.point();assert.ok(cp);f.resume();await f.finish();const s=captureBytes(f,cp.id);
 if(corrupt==='closing')s.closing=false;
 if(corrupt==='invocation')s.continuation.checkpoint.invocation.id='foreign';
 if(corrupt==='interruption')s.continuation.checkpoint.invocation.interruptionId='foreign';
 if(corrupt==='ordinal')s.continuation.checkpoint.invocation.ordinal++;
 if(corrupt==='missing invocation')delete s.continuation.checkpoint;
 if(corrupt==='missing pause audit')s.continuation.audit=s.continuation.audit.filter(e=>e.kind!=='checkpoint_interrupt_requested');
 if(corrupt==='sealed result')s.selected.sealedResults[0].content_hash='0'.repeat(64);
 if(corrupt==='pin')s.continuation.versionHash='0'.repeat(64);
 const {stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');const bytes=stableJson(s),id=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,bytes,hash(bytes)).lastInsertRowid);
 const counts=()=>[f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_commands').get().n,f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n];const before=counts();
 assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(c=>c.id===id).restoreSupported,false);
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,id,hash(bytes),'corrupt'),/unsupported|failed verification/);assert.deepEqual(counts(),before);
});

test('exit cut current Script policy/hash refusal and lineage rollback remain atomic',async t=>{
 const f=await exitCut(t),cp=f.point();assert.ok(cp);f.resume();await f.finish();
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,'0'.repeat(64),'wrong-hash'),/hash/);
 const policy=new CapabilityPolicyStore(f.store.sqlite);policy.put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.scripts]});
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'restricted'),/restricted/);policy.put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:1,restrictedCapabilityIds:[]});
 const count=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_commands').get().n;
 f.store.sqlite.exec("CREATE TEMP TRIGGER fail_exit_lineage BEFORE INSERT ON branch_unit_snapshots WHEN json_extract(NEW.snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1' BEGIN SELECT RAISE(ABORT,'exit lineage failed'); END");
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'atomic-exit'),/exit lineage failed/);await f.branches.unitSaver.drain();
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,1);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_commands').get().n,count);
 f.store.sqlite.exec('DROP TRIGGER fail_exit_lineage');const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'atomic-exit');await f.branches.unitSaver.drain();
 await f.reopen();assert.equal(f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'atomic-exit').id,next.id);
});

test('failed exit closing save preserves known result, prevents resume and publishes no historical point',async t=>{
 const f=await exitCut(t,false,false);
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_exit_close BEFORE INSERT ON branch_unit_snapshots WHEN NEW.execution_id='${f.source.id}' BEGIN SELECT RAISE(ABORT,'exit closing save failed'); END`);
 f.observe();f.branches.settleScript(f.lease,{failed:false,output:'stopped'});await assert.rejects(f.branches.unitSaver.completeExits(),/durability failed/);
 assert.equal(f.current().durability,'failed');assert.equal(f.point(),undefined);assert.throws(()=>f.resume(),/saved quiescence/);
 assert.equal(f.branches.detail(f.source.id).sealedResults.length,2);assert.ok(f.branches.detail(f.source.id).attempts.every(a=>a.state==='completed'));
 f.branches.cancel(f.source.id);assert.equal(f.branches.execution(f.source.id).state,'canceled');
});

test('a second exit interruption replays the preceding resume and binds the new closing invocation',async t=>{
 const f=await exitCut(t,true),first=f.point();assert.ok(first);const active=f.resume().checkpointInvocation;
 const b=await f.claim();assert.ok(b.source.includes('// b'));f.branches.authorizeScript(b,inertIdentity);
 const waiting=f.branches.checkpointInterruption(f.branch.id,f.source.id,'interrupt',active.id,'pause2').checkpointInvocation;
 f.branches.recordScriptEvidence(b,inertIdentity,{stdout:'second close',outputHash:hash('second close'),code:0});f.branches.settleScript(b,{failed:false,output:'second close'});
 await f.branches.unitSaver.completeExits();const second=f.point();assert.ok(second);assert.notEqual(second.id,first.id);
 assert.equal(captureBytes(f,second.id).continuation.checkpoint.invocation.ordinal,2);
 assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(c=>c.id===first.id).restoreSupported,true);
 f.branches.checkpointInterruption(f.branch.id,f.source.id,'resume',waiting.interruptionId,'resume2');await f.finish();
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,second.id,second.contentHash,'second-exit');const d=await f.claim();assert.equal(d.executionId,next.id);assert.ok(d.source.includes('// d'));
 f.branches.settleScript(d,{failed:false,output:'only remaining suffix'});assert.equal(f.branches.detail(next.id).steps.length,4);
});

for(const [mode,secret] of [['async',false],['exit',true]])test(`explicit interruption refuses unsupported slice mode=${mode}, secret=${secret}`,async t=>{
 const f=fixture(t,mode,false,secret);await f.claim();const invocation=f.branches.execution(f.source.id).checkpointInvocation;
 assert.throws(()=>f.branches.checkpointInterruption(f.branch.id,f.source.id,'interrupt',invocation.id,'unsupported'),/supports only/);
 assert.equal(f.branches.execution(f.source.id).checkpointInvocation.state,'active');assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_commands').get().n,0);
});

test('pending latest exit closing coverage cannot resume or masquerade as a SAVED historical point',async t=>{
 const f=await exitCut(t,false,false);let release;const held=new Promise(resolve=>{release=resolve;});
 f.branches.unitSaver.lanes.set(f.source.id,held);
 try{
  f.observe();f.branches.settleScript(f.lease,{failed:false,output:'stopped'});
  assert.equal(f.current().state,'interrupted');assert.equal(f.current().durability,'pending');assert.equal(f.point(),undefined);
  assert.throws(()=>f.resume(),/saved quiescence/);assert.equal(f.branches.claimScript('held'),undefined);
 }finally{release();await f.branches.unitSaver.completeExits();}
 assert.ok(f.point());assert.notEqual(f.resume().checkpointInvocation.id,f.before.id);
});

test('exit interruption and historical continuation are usable through exact-shape HTTP commands',async t=>{
 const f=fixture(t,'exit',false,false,true);await f.prefix();const live=await f.claim();f.branches.authorizeScript(live,inertIdentity);
 const {createRequire}=await import('node:module'),require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
 const {registerBranchRoutes}=await import('../../apps/server/dist/routes/branches.js'),app=require('fastify')();t.after(()=>app.close());let notifications=0;
 registerBranchRoutes(app,{branches:f.branches,store:f.store,installations:{setPublisher(){}},notify(){notifications++;assert.equal(f.store.sqlite.inTransaction,false);}});
 const base=`/api/branches/${f.branch.id}/executions/${f.source.id}`,inv=f.branches.execution(f.source.id).checkpointInvocation;
 const interrupt={action:'interrupt',expectedId:inv.id,commandKey:'http-pause'};
 assert.equal((await app.inject({method:'POST',url:`${base}/checkpoint-interruption`,payload:{...interrupt,extra:true}})).statusCode,409);
 const accepted=await app.inject({method:'POST',url:`${base}/checkpoint-interruption`,payload:interrupt});assert.equal(accepted.statusCode,200,accepted.body);
 const wait=accepted.json().checkpointInvocation;assert.equal(wait.state,'interrupting');const resume={action:'resume',expectedId:wait.interruptionId,commandKey:'http-resume'};
 assert.equal((await app.inject({method:'POST',url:`${base}/checkpoint-interruption`,payload:resume})).statusCode,409);
 f.branches.recordScriptEvidence(live,inertIdentity,{stdout:'http known',outputHash:hash('http known'),code:0});f.branches.settleScript(live,{failed:false,output:'http known'});await f.branches.unitSaver.completeExits();
 const list=await app.inject({method:'GET',url:`${base}/historical-checkpoints`}),cp=list.json().find(c=>c.restoreSupported);assert.ok(cp);
 const resumed=await app.inject({method:'POST',url:`${base}/checkpoint-interruption`,payload:resume});assert.equal(resumed.statusCode,200,resumed.body);assert.notEqual(resumed.json().checkpointInvocation.id,inv.id);
 const d=await f.claim();f.branches.settleScript(d,{failed:false,output:'http later'});await f.branches.unitSaver.completeExits();
 const next=await app.inject({method:'POST',url:`${base}/rewind-historical`,payload:{checkpointId:cp.id,expectedHash:cp.contentHash,commandKey:'http-exit-rewind'}});assert.equal(next.statusCode,200,next.body);assert.equal(next.json().state,'queued');assert.equal(notifications,3);
});

for(const boundary of ['list','rewind'])test(`historical exit proof must match the selected current attempt fence (${boundary})`,async t=>{
 const f=await exitCut(t,false,false);
 const wrong={...f.lease,fence:f.lease.fence+1};
 f.branches.recordScriptEvidence(wrong,inertIdentity,{stdout:'stopped',outputHash:hash('stopped'),code:0});
 f.branches.settleScript(f.lease,{failed:false,output:'stopped'});
 await f.branches.unitSaver.drain();
 assert.equal(f.current().state,'interrupting','wrong-fence proof cannot close actual runtime');
 f.observe();await f.branches.unitSaver.completeExits();const cp=f.point();assert.ok(cp);
 const s=captureBytes(f,cp.id);
 const correct=s.continuation.audit.findIndex(e=>e.kind==='script_process_exit'&&e.transition_key===`process-exit:${f.lease.attemptId}:${f.lease.fence}`);
 assert.ok(correct>0);s.continuation.audit=s.continuation.audit.slice(0,correct);
 const {stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');const bytes=stableJson(s),id=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,bytes,hash(bytes)).lastInsertRowid);
 f.branches.cancel(f.source.id);await f.branches.unitSaver.drain();
 const listed=f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(c=>c.id===id);
 const counts=()=>['branch_executions','branch_commands','branch_unit_snapshots'].map(table=>f.store.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);const before=counts();
 let accepted=false;try{f.branches.rewindHistorical(f.branch.id,f.source.id,id,hash(bytes),'wrong-fence-cut');accepted=true;}catch{}
 assert.deepEqual(counts(),before,'refusal allocates no execution, receipt or lineage');
 console.log(JSON.stringify({actualFence:f.lease.fence,wrongProofFence:wrong.fence,auditKinds:s.continuation.audit.map(e=>[e.kind,e.transition_key]),listed,accepted}));
 if(boundary==='list')assert.equal(listed.restoreSupported,false,'historical eligibility accepted stale/wrong-fence process proof');
 else assert.equal(accepted,false,'historical allocation accepted stale/wrong-fence process proof');
});

 test('late exact exit generation closes despite earlier wrong-generation evidence',async t=>{
 const f=await exitCut(t,false,false);
 f.branches.recordScriptEvidence({...f.lease,fence:f.lease.fence+1},inertIdentity,{stdout:'stopped',outputHash:hash('stopped'),code:0});
 f.branches.settleScript(f.lease,{failed:false,output:'stopped'});await f.branches.unitSaver.drain();
 assert.equal(f.current().state,'interrupting');f.observe();await f.branches.unitSaver.completeExits();
 const cp=f.point();assert.ok(cp);f.branches.cancel(f.source.id);await f.branches.unitSaver.drain();
 assert.ok(f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'exact-generation'));
 });

async function finishOwned(f,id){
 for(let n=0;n<10&&f.branches.execution(id).state!=='completed';n++){
  const lease=await f.claim();assert.equal(lease.executionId,id);f.branches.settleScript(lease,{failed:false,output:'stop'});
 }
 await f.branches.unitSaver.drain();assert.equal(f.branches.execution(id).state,'completed');
}
async function restoredCut(t,mode='async',loop=false){
 const f=fixture(t,mode,loop,false,true,true),a=await f.prefix();assert.ok(a);await finishOwned(f,f.source.id);
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'chain-A');
 const lease=await f.claim();assert.equal(lease.executionId,next.id);assert.ok(lease.source.includes(loop?'// a':'// b'));
 f.branches.settleScript(lease,{failed:false,output:'stop'});await f.branches.unitSaver.drain();
 const b=f.branches.historicalCheckpoints(f.branch.id,next.id).find(cp=>{const s=captureBytes(f,cp.id);return cp.restoreSupported&&s.selected.steps.length===2&&s.selected.steps.every(row=>row.state==='completed');});
 assert.ok(b,'continued restored execution must capture an executable checkpoint');
 return {f,a,next,b};
}
for(const mode of ['async','sync'])for(const loop of [false,true])test(`chained ${mode} history: capture A -> rewind A -> capture B -> rewind B, loop=${loop}`,async t=>{
 const {f,a,next,b}=await restoredCut(t,mode,loop),snapshot=captureBytes(f,b.id);
 assert.equal(snapshot.continuation.provenance.length,1);assert.equal(snapshot.continuation.provenance[0].checkpointId,a.id);
 assert.equal(snapshot.continuation.audit.filter(row=>row.kind==='restored_prefix').length,1);
 assert.ok(snapshot.continuation.audit.filter(row=>row.kind==='restored_prefix').every(row=>!JSON.parse(row.evidence_json).sourceAudit),'no recursively nested audit prose');
 await finishOwned(f,next.id);await f.reopen();
 assert.equal(f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'chain-A').id,next.id);
 const second=f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'chain-B');assert.equal(second.state,'queued');
 assert.equal(f.branches.claimScript('before-admission'),undefined);
 assert.equal(f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'chain-B').id,second.id);
 const suffix=await f.claim();assert.equal(suffix.executionId,second.id);assert.ok(suffix.source.includes(loop?'// b':'// d'),'both committed prefix effects stay sealed');assert.equal(suffix.fence,1);
 f.branches.settleScript(suffix,{failed:false,output:'stop'});await f.branches.unitSaver.drain();
 const c=f.branches.historicalCheckpoints(f.branch.id,second.id).find(cp=>{const s=captureBytes(f,cp.id);return cp.restoreSupported&&s.selected.steps.length===3&&s.selected.steps.every(row=>row.state==='completed');});assert.ok(c);
 assert.equal(captureBytes(f,c.id).continuation.provenance.length,2,'canonical provenance is a flat vector');
 await finishOwned(f,second.id);await f.reopen();assert.equal(f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'chain-B').id,second.id);const third=f.branches.rewindHistorical(f.branch.id,second.id,c.id,c.contentHash,'chain-C');
 await finishOwned(f,third.id);assert.equal(f.branches.detail(third.id).sealedResults.length,loop?6:5);
 assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});
for(const loop of [false,true])test(`chained exit interruption history uses fresh invocation and exact owned proof, loop=${loop}`,async t=>{
 const f=await exitCut(t,loop,true,true),a=f.point();assert.ok(a);f.resume();await finishOwned(f,f.source.id);
 const first=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'exit-chain-A');
 const lease=await f.claim();assert.equal(lease.executionId,first.id);assert.ok(lease.source.includes(loop?'// b':'// d'));f.branches.authorizeScript(lease,inertIdentity);
 const active=f.branches.execution(first.id).checkpointInvocation;assert.notEqual(active.id,f.before.id);
 const hold=f.branches.checkpointInterruption(f.branch.id,first.id,'interrupt',active.id,'exit-chain-hold').checkpointInvocation;
 f.branches.recordScriptEvidence(lease,inertIdentity,{stdout:'stop',outputHash:hash('stop'),code:0});f.branches.settleScript(lease,{failed:false,output:'stop'});await f.branches.unitSaver.completeExits();
 const b=f.branches.historicalCheckpoints(f.branch.id,first.id).find(cp=>cp.restoreSupported);assert.ok(b,'closing save on restored exit execution must be executable');
 assert.equal(captureBytes(f,b.id).continuation.provenance.length,1);assert.equal(f.branches.execution(first.id).checkpointInvocation.state,'interrupted');
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,first.id,b.id,b.contentHash,'live-chain'),/settled standalone/);
 f.branches.checkpointInterruption(f.branch.id,first.id,'resume',hold.interruptionId,'exit-chain-resume');await finishOwned(f,first.id);await f.reopen();
 const second=f.branches.rewindHistorical(f.branch.id,first.id,b.id,b.contentHash,'exit-chain-B');assert.notEqual(second.checkpointInvocation.id,active.id);assert.equal(second.checkpointInvocation.interruptionId,undefined);
 const suffix=await f.claim();assert.equal(suffix.executionId,second.id);assert.ok(suffix.source.includes(loop?'// d':'// e'));assert.equal(suffix.fence,1);f.branches.settleScript(suffix,{failed:false,output:'stop'});await finishOwned(f,second.id);
 assert.equal(f.branches.rewindHistorical(f.branch.id,first.id,b.id,b.contentHash,'exit-chain-B').id,second.id);
});
const allocationCounts=f=>['branch_executions','branch_commands','branch_unit_snapshots'].map(table=>f.store.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
for(const kind of ['provenance','audit','wrappedProse','counters','prefixResult','prefixFence','missingLineage','missingCheckpoint','receipt','idMap','mapAlias','foreignLineage','ancestorAudit','ancestorCounters','ancestorHash'])test(`chained historical ${kind} corruption refuses before allocation`,async t=>{
 const {f,next,b}=await restoredCut(t);await finishOwned(f,next.id);
 const snapshot=captureBytes(f,b.id),{stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 const ref=snapshot.continuation.provenance[0];
 if(kind==='provenance')snapshot.continuation.provenance=[];
 if(kind==='audit')snapshot.continuation.audit=snapshot.continuation.audit.filter(row=>row.kind!=='restored_prefix');
 if(kind==='wrappedProse'){const event=snapshot.continuation.audit.find(row=>row.kind==='restored_prefix');event.evidence_json=stableJson({sourceExecutionId:f.source.id,sourceAudit:{kind:'step_settled',evidence_json:'{}'}});f.store.sqlite.prepare('UPDATE branch_checkpoints SET evidence_json=? WHERE id=?').run(event.evidence_json,event.id);}
 if(kind==='counters'){snapshot.selected.execution[0].traversals++;snapshot.selected.paths[0].traversals++;}
 if(kind==='prefixResult'){
  const step=snapshot.selected.steps.find(row=>row.invocation===1&&row.step_id==='a'),attempt=snapshot.selected.attempts.find(row=>row.step_execution_id===step.id),result=snapshot.selected.sealedResults.find(row=>row.step_execution_id===step.id);
  step.result_json=stableJson({failed:false,output:'forged'});attempt.result_json=step.result_json;result.result_json=step.result_json;result.content_hash=hash(step.result_json);
 }
 if(kind==='prefixFence')snapshot.selected.attempts.find(row=>row.state==='completed'&&row.fence===0).fence=1;
 if(kind==='missingLineage')f.store.sqlite.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(ref.lineageId);
 if(kind==='missingCheckpoint')f.store.sqlite.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(ref.checkpointId);
 if(kind==='receipt')f.store.sqlite.prepare('UPDATE branch_commands SET input_hash=? WHERE execution_id=?').run('0'.repeat(64),f.source.id);
 if(['idMap','mapAlias','foreignLineage','ancestorAudit','ancestorCounters','ancestorHash'].includes(kind)){
  // New private canonical lineage and matching owned references, never weakening immutable UPDATE guards.
  const line=captureBytes(f,ref.lineageId);
  if(kind==='idMap')delete line.idMap[Object.keys(line.idMap)[0]];
  if(kind==='mapAlias'){const keys=Object.keys(line.idMap);line.idMap[keys[0]]=line.idMap[keys[1]];}
  if(kind==='foreignLineage')line.executionId='foreign-owner';
  if(kind.startsWith('ancestor')){
   const ancestor=captureBytes(f,line.checkpointId);
   if(kind==='ancestorAudit')ancestor.continuation.audit=ancestor.continuation.audit.filter(row=>row.kind!=='result_sealed');
   if(kind==='ancestorCounters'){ancestor.selected.execution[0].traversals++;ancestor.selected.paths[0].traversals++;}
   const content=stableJson(ancestor);line.checkpointId=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,content,hash(content)).lastInsertRowid);line.checkpointHash=kind==='ancestorHash'?'0'.repeat(64):hash(content);
   const {payloadHash}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');line.commandHash=payloadHash({executionId:line.sourceExecutionId,checkpointId:line.checkpointId,expectedHash:line.checkpointHash});
   ref.checkpointId=line.checkpointId;ref.checkpointHash=line.checkpointHash;
  }
  const bytes=stableJson(line),lineageId=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(next.id,bytes,hash(bytes)).lastInsertRowid);
  for(const event of snapshot.continuation.audit.filter(row=>['restored_prefix','historical_rewind'].includes(row.kind))){const v=JSON.parse(event.evidence_json);v.lineageId=lineageId;v.checkpointId=line.checkpointId;v.checkpointHash=line.checkpointHash;event.evidence_json=stableJson(v);f.store.sqlite.prepare('UPDATE branch_checkpoints SET evidence_json=? WHERE id=? AND execution_id=?').run(event.evidence_json,event.id,next.id);}
  f.store.sqlite.prepare('UPDATE branch_commands SET result_json=?,input_hash=? WHERE execution_id=?').run(stableJson({executionId:next.id,lineageId}),line.commandHash,f.source.id);ref.lineageId=lineageId;ref.lineageHash=hash(bytes);
 }
 const bytes=stableJson(snapshot),id=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(next.id,bytes,hash(bytes)).lastInsertRowid),before=allocationCounts(f);
 assert.equal(f.branches.historicalCheckpoints(f.branch.id,next.id).find(cp=>cp.id===id).restoreSupported,false);
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,next.id,id,hash(bytes),'bad-chain'),/unsupported|integrity/);assert.deepEqual(allocationCounts(f),before);
});

for(const mode of ['async','sync'])test(`chained ${mode} history resumes an inherited prepared Step exactly once`,async t=>{
 const f=fixture(t,mode,true,false,true,true);await f.prefix();let a;
 for(let n=0;n<4&&!a;n++){f.branches.advance();await f.branches.unitSaver.drain();a=f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(cp=>{const s=captureBytes(f,cp.id);return cp.restoreSupported&&s.selected.steps.length===2&&s.selected.steps.some(row=>row.state==='prepared');});}
 assert.ok(a);await finishOwned(f,f.source.id);const first=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'prepared-A');
 const lease=await f.claim();assert.ok(lease.source.includes('// a'));assert.equal(f.branches.detail(first.id).steps.length,2);assert.equal(f.branches.detail(first.id).steps.find(row=>row.state==='leased').invocation,2);
 f.branches.settleScript(lease,{failed:false,output:'stop'});await f.branches.unitSaver.drain();const b=f.branches.historicalCheckpoints(f.branch.id,first.id).find(cp=>{const s=captureBytes(f,cp.id);return cp.restoreSupported&&s.selected.steps.every(row=>row.state==='completed');});assert.ok(b);
 await finishOwned(f,first.id);const next=f.branches.rewindHistorical(f.branch.id,first.id,b.id,b.contentHash,'prepared-B');const suffix=await f.claim();assert.equal(suffix.executionId,next.id);assert.ok(suffix.source.includes('// b'));f.branches.settleScript(suffix,{failed:false,output:'stop'});await finishOwned(f,next.id);
});
test('chained current authority and pins refuse before lineage allocation, preserving immutable receipts',async t=>{
 const {f,next,b}=await restoredCut(t);await finishOwned(f,next.id);const before=allocationCounts(f),policies=new CapabilityPolicyStore(f.store.sqlite);
 policies.put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.scripts]});assert.throws(()=>f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'policy-chain'),/restricted/);assert.deepEqual(allocationCounts(f),before);
 policies.put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:1,restrictedCapabilityIds:[]});f.branches.configure(f.branch.id,{...f.branches.configuration(f.branch.id),checkpointMode:'sync'},1);
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'pins-chain'),/pins changed/);assert.deepEqual(allocationCounts(f),before);
 assert.throws(()=>f.store.sqlite.prepare("UPDATE branch_unit_snapshots SET snapshot_json='{}' WHERE id=?").run(captureBytes(f,b.id).continuation.provenance[0].lineageId),/immutable/);
});

test('chained idempotent command rechecks source ancestry after reopen without allocating',async t=>{
 const {f,next,b}=await restoredCut(t);await finishOwned(f,next.id);const second=f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'idempotent-chain');await finishOwned(f,second.id);await f.reopen();
 assert.equal(f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'idempotent-chain').id,second.id);
 const ref=captureBytes(f,b.id).continuation.provenance[0];f.store.sqlite.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(ref.lineageId);const before=allocationCounts(f);
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'idempotent-chain'),/integrity/);assert.deepEqual(allocationCounts(f),before);
});
test('chained lineage insertion failure rolls back all new prefix ownership before dispatch',async t=>{
 const {f,next,b}=await restoredCut(t);await finishOwned(f,next.id);const before=allocationCounts(f);
 f.store.sqlite.exec("CREATE TEMP TRIGGER fail_chain_lineage BEFORE INSERT ON branch_unit_snapshots WHEN json_extract(NEW.snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1' BEGIN SELECT RAISE(ABORT,'chain lineage failed'); END");
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'chain-atomic'),/chain lineage failed/);await f.branches.unitSaver.drain();assert.deepEqual(allocationCounts(f),before);assert.equal(f.branches.claimScript('no-candidate'),undefined);
 f.store.sqlite.exec('DROP TRIGGER fail_chain_lineage');const second=f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'chain-atomic');await finishOwned(f,second.id);assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});

function treeFixture(t,mode='async',nested=true,childMode='sync',futureCall=false,childLoop=false,longChild=false){
 const dir=mkdtempSync(join(tmpdir(),'tree-history-'));let store,branches;const open=()=>{store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));};open();
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Tree history',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Tree history'});
 const script=id=>({id,kind:'script',runtime:'node',source:`// tree ${id} never executed`,cwdRef:'root',timeoutMs:5000});
 const deploy=(name,steps,bindings={},edges=steps.slice(0,-1).map((step,i)=>({id:`edge-${i}`,from:step.id,to:steps[i+1].id,on:'success'})),controls=[])=>branches.deploy({chatId:chat.id,idempotencyKey:name,definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:steps[0].id,steps,controls,edges,policy:{maxConcurrentExecutions:10,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:dir},...bindings}});
 const leaf=childLoop?deploy('tree-leaf',[script('leaf1'),script('leaf2')],{},[{id:'to-check',from:'leaf1',to:'check',on:'success'},{id:'again',from:'check',to:'leaf1',on:'selected',loop:true},{id:'done',from:'check',to:'leaf2',on:'failure'}],[{id:'check',kind:'condition',predicate:{source:'input',equals:'again'},otherwise:'leaf2'}]):deploy('tree-leaf',[script('leaf1'),script('leaf2'),...(longChild?[script('leaf3'),script('leaf4')]:[])]);
 const middle=nested?deploy('tree-middle',[{id:'inner',kind:'branch_call',branchRef:'leaf'},script('middle')],{branches:{leaf:leaf.id}}):leaf;
 const root=deploy('tree-root',[script('prefix'),{id:'call',kind:'branch_call',branchRef:'child'},script('suffix1'),...(futureCall?[{id:'call-again',kind:'branch_call',branchRef:'child'}]:[]),script('suffix2'),script('suffix3')],{branches:{child:middle.id}});
 for(const [branch,m] of [[root,mode],[middle,childMode],...(nested?[[leaf,'exit']]:[])])if(m!=='async')branches.configure(branch.id,{...branches.configuration(branch.id),checkpointMode:m},0);
 const source=branches.accept(root.id,'tree-source','tree input');
 const settle=(lease,output='tree known')=>{if(childLoop&&lease.source.includes('leaf1'))output=branches.detail(lease.executionId).steps.find(s=>s.state==='leased').invocation===1?'again':'done';branches.authorizeScript(lease,inertIdentity);branches.recordScriptEvidence(lease,inertIdentity,{stdout:output,outputHash:hash(output),code:0});branches.settleScript(lease,{failed:false,output});};
 const claim=async()=>{for(let n=0;n<80;n++){await branches.unitSaver.drain();branches.advance();const lease=branches.claimScript('tree-inert');if(lease){await branches.unitSaver.drain();assert.equal(branches.checkpointDispatch(lease),'ready');return lease;}}assert.fail('expected fresh tree suffix lease');};
 const point=id=>branches.historicalCheckpoints(root.id,id).find(cp=>cp.restoreSupported&&captureBytes({store},cp.id).continuation?.schema==='ponderosa.branch.script-tree-continuation.v1'&&captureBytes({store},cp.id).continuation.owners.filter(o=>o.executionId!==id).every(o=>o.selected.execution[0].state==='completed'));
 return {get store(){return store},get branches(){return branches},dir,chat,root,middle,leaf,source,settle,claim,point,
  async prefix(){const first=await claim();assert.equal(first.executionId,source.id);settle(first);for(let n=0;n<100;n++){await branches.unitSaver.drain();branches.advance();await branches.unitSaver.drain();const cp=point(source.id);if(cp)return cp;const lease=branches.claimScript('tree-inert');if(lease){if(lease.executionId===source.id){assert.ok(lease.source.includes('suffix1'));return {pendingRoot:lease};}await branches.unitSaver.drain();settle(lease);}}assert.fail('expected completed-child tree frontier');},
  async finish(id){for(let n=0;n<20&&branches.execution(id).state!=='completed';n++){const lease=await claim();let owner=branches.execution(lease.executionId);while(owner.parentExecutionId)owner=branches.execution(owner.parentExecutionId);assert.equal(owner.id,id);settle(lease);}await branches.unitSaver.drain();assert.equal(branches.execution(id).state,'completed');},
  async reopen(){await branches.unitSaver.drain();store.close();open();}};
}
for(const mode of ['async','sync'])for(const nested of [false,true])test(`completed-child tree ${mode} captures/restores/remaps nested=${nested} and captures a second rewind`,async t=>{
 const f=treeFixture(t,mode,nested),a=await f.prefix();assert.ok(a.id,'actual completed children must produce executable parent history');
 const original=captureBytes(f,a.id),owners=original.continuation.owners;assert.equal(owners.length,nested?3:2);assert.ok(owners.filter(o=>o.executionId!==f.source.id).every(o=>o.selected.execution[0].state==='completed'));
 await f.finish(f.source.id);const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'tree-A');assert.equal(first.state,'queued');assert.equal(f.branches.claimScript('before-tree-admission'),undefined);
 const mappedOwners=f.store.sqlite.prepare('SELECT * FROM branch_executions WHERE parent_execution_id=?').all(first.id);assert.equal(mappedOwners.length,1);assert.equal(mappedOwners[0].state,'completed');
 const suffix=await f.claim();assert.equal(suffix.executionId,first.id);assert.ok(suffix.source.includes('suffix1'),'no sealed child or parent prefix effect replay');assert.equal(suffix.fence,1);f.settle(suffix);
 await f.branches.unitSaver.drain();const b=f.point(first.id);assert.ok(b,'restored tree must capture an executable second point');const nextCut=captureBytes(f,b.id);assert.equal(nextCut.continuation.provenance.length,1);
 assert.ok(nextCut.continuation.owners.filter(o=>o.executionId!==first.id).every(o=>o.selected.attempts.every(a=>a.fence===0)));
 await f.finish(first.id);await f.reopen();assert.equal(f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'tree-A').id,first.id);
 const second=f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'tree-B');const next=await f.claim();assert.equal(next.executionId,second.id);assert.ok(next.source.includes('suffix2'));f.settle(next);await f.finish(second.id);
 await f.reopen();assert.equal(f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'tree-B').id,second.id);
 const descendants=f.store.sqlite.prepare(`WITH RECURSIVE owned(id) AS (SELECT ? UNION SELECT e.id FROM branch_executions e JOIN owned o ON e.parent_execution_id=o.id) SELECT e.id FROM branch_executions e JOIN owned ON e.id=owned.id`).all(second.id);assert.equal(descendants.length,owners.length);
 assert.equal(f.branches.detail(second.id).steps.length,5);assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});
test('completed-child tree exit closing history uses actual interrupt and fresh root suffix',async t=>{
 const f=treeFixture(t,'exit',true,'async'),pending=await f.prefix();assert.ok(pending.pendingRoot);const lease=pending.pendingRoot;await f.branches.unitSaver.drain();assert.equal(f.branches.historicalCheckpoints(f.root.id,f.source.id).length,0,'exit progress remains coalesced');
 f.branches.authorizeScript(lease,inertIdentity);const active=f.branches.execution(f.source.id).checkpointInvocation,hold=f.branches.checkpointInterruption(f.root.id,f.source.id,'interrupt',active.id,'tree-exit-hold').checkpointInvocation;
 f.branches.recordScriptEvidence(lease,inertIdentity,{stdout:'known suffix',outputHash:hash('known suffix'),code:0});f.branches.settleScript(lease,{failed:false,output:'known suffix'});await f.branches.unitSaver.completeExits();const a=f.point(f.source.id);assert.ok(a);
 f.branches.checkpointInterruption(f.root.id,f.source.id,'resume',hold.interruptionId,'tree-exit-resume');await f.finish(f.source.id);const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'tree-exit-A');
 const next=await f.claim();assert.equal(next.executionId,first.id);assert.ok(next.source.includes('suffix2'));f.branches.authorizeScript(next,inertIdentity);const invocation=f.branches.execution(first.id).checkpointInvocation;assert.notEqual(invocation.id,active.id);
 const secondHold=f.branches.checkpointInterruption(f.root.id,first.id,'interrupt',invocation.id,'tree-exit-hold-B').checkpointInvocation;
 f.branches.recordScriptEvidence(next,inertIdentity,{stdout:'second known',outputHash:hash('second known'),code:0});f.branches.settleScript(next,{failed:false,output:'second known'});await f.branches.unitSaver.completeExits();const b=f.point(first.id);assert.ok(b);
 f.branches.checkpointInterruption(f.root.id,first.id,'resume',secondHold.interruptionId,'tree-exit-resume-B');await f.finish(first.id);await f.reopen();const second=f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'tree-exit-B');const suffix=await f.claim();assert.equal(suffix.executionId,second.id);assert.ok(suffix.source.includes('suffix3'));f.settle(suffix);await f.branches.unitSaver.completeExits();assert.equal(f.branches.execution(second.id).state,'completed');
});
async function capturedRestoredTree(t){
 const f=treeFixture(t),a=await f.prefix();assert.ok(a.id);await f.finish(f.source.id);const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'tree-corrupt-A');const lease=await f.claim();f.settle(lease);await f.branches.unitSaver.drain();const b=f.point(first.id);assert.ok(b);await f.finish(first.id);return {f,a,first,b};
}
for(const kind of ['missingOwner','foreignChild','parentAttempt','childAudit','parentAudit','sealedResult','counters','childInput','childGate','missingSource','missingRootLineage','missingChildLineage','receipt','provenance','mapMissing','mapAlias','foreignLineage'])test(`completed-child tree ${kind} corruption refuses all allocation`,async t=>{
 const {f,first,b}=await capturedRestoredTree(t),snapshot=captureBytes(f,b.id),c=snapshot.continuation,root=c.owners.find(o=>o.executionId===first.id),child=c.owners.find(o=>o.executionId!==first.id),{stableJson,payloadHash}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 const ref=c.provenance[0];
 if(kind==='missingOwner')c.owners=c.owners.filter(o=>o!==child);
 if(kind==='foreignChild')child.selected.execution[0].branch_id='foreign';
 if(kind==='parentAttempt')child.selected.execution[0].parent_attempt_id=root.selected.attempts.find(a=>a.fence===1).id;
 if(kind==='childAudit')child.audit=child.audit.filter(a=>a.kind!=='tree_restored_prefix');
 if(kind==='parentAudit')root.audit=root.audit.filter(a=>a.kind!=='tree_restored_prefix');
 if(kind==='sealedResult'){
  const s=child.selected.steps[0],a=child.selected.attempts.find(a=>a.step_execution_id===s.id),r=child.selected.sealedResults.find(r=>r.step_execution_id===s.id);s.result_json=stableJson({failed:false,output:'forged inherited result'});a.result_json=s.result_json;r.result_json=s.result_json;r.content_hash=hash(s.result_json);
 }
 if(kind==='counters'){child.selected.paths[0].traversals++;child.selected.execution[0].traversals++;let parent=child;while(parent.selected.execution[0].parent_execution_id){parent=c.owners.find(o=>o.executionId===parent.selected.execution[0].parent_execution_id);parent.selected.execution[0].traversals++;}}
 if(kind==='childInput')child.selected.execution[0].input_text='foreign input';
 if(kind==='childGate')child.selected.gates.push({id:'invented-gate',state:'waiting'});
 if(kind==='missingSource')f.store.sqlite.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(ref.checkpointId);
 if(kind==='missingRootLineage')f.store.sqlite.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(ref.lineageId);
 if(kind==='missingChildLineage'){const origin=JSON.parse(child.audit.find(a=>a.kind==='tree_historical_rewind').evidence_json);f.store.sqlite.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(origin.childLineageId);}
 if(kind==='receipt')f.store.sqlite.prepare('UPDATE branch_commands SET input_hash=? WHERE execution_id=?').run('0'.repeat(64),f.source.id);
 if(kind==='provenance')c.provenance=[];
 if(['mapMissing','mapAlias','foreignLineage'].includes(kind)){
  // New rehashed private lineage/child receipts and exact owned audit references; immutable guards stay enabled.
  const line=captureBytes(f,ref.lineageId),keys=Object.keys(line.idMap);
  if(kind==='mapMissing')delete line.idMap[keys[0]];
  if(kind==='mapAlias')line.idMap[keys[0]]=line.idMap[keys[1]];
  if(kind==='foreignLineage')line.executionId='foreign-owner';
  const bytes=stableJson(line),lineageId=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(first.id,bytes,hash(bytes)).lastInsertRowid);
  for(const o of c.owners){const origin=JSON.parse(o.audit.find(a=>a.kind==='tree_historical_rewind').evidence_json);origin.lineageId=lineageId;
   if(o!==root){const old=captureBytes(f,origin.childLineageId);old.rootLineageId=lineageId;old.idMap=line.idMap;const content=stableJson(old);origin.childLineageId=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(o.executionId,content,hash(content)).lastInsertRowid);}
   for(const event of o.audit.filter(a=>['tree_historical_rewind','tree_restored_prefix'].includes(a.kind))){event.evidence_json=stableJson(origin);f.store.sqlite.prepare('UPDATE branch_checkpoints SET evidence_json=? WHERE id=?').run(event.evidence_json,event.id);}
  }
  f.store.sqlite.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=?').run(stableJson({executionId:first.id,lineageId}),f.source.id);ref.lineageId=lineageId;ref.lineageHash=payloadHash(line);
 }
 snapshot.selected=root.selected;
 const bytes=stableJson(snapshot),id=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(first.id,bytes,hash(bytes)).lastInsertRowid),before=allocationCounts(f);
 assert.equal(f.branches.historicalCheckpoints(f.root.id,first.id).find(cp=>cp.id===id).restoreSupported,false);
 assert.throws(()=>f.branches.rewindHistorical(f.root.id,first.id,id,hash(bytes),'bad-tree'),/integrity|unsupported/);assert.deepEqual(allocationCounts(f),before);
});
test('completed-child tree child lineage failure rolls back root and every remapped owner',async t=>{
 const f=treeFixture(t),a=await f.prefix();await f.finish(f.source.id);const before=allocationCounts(f);
 f.store.sqlite.exec("CREATE TEMP TRIGGER fail_child_lineage BEFORE INSERT ON branch_unit_snapshots WHEN json_extract(NEW.snapshot_json,'$.schema')='ponderosa.branch.child-tree-lineage.v1' BEGIN SELECT RAISE(ABORT,'child lineage failed'); END");
 assert.throws(()=>f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'atomic-tree'),/child lineage failed/);await f.branches.unitSaver.drain();assert.deepEqual(allocationCounts(f),before);assert.equal(f.branches.claimScript('no-child-candidate'),undefined);
 f.store.sqlite.exec('DROP TRIGGER fail_child_lineage');const next=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'atomic-tree');await f.finish(next.id);assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});
test('completed-child tree current descendant policy/configuration and lineage replay require current owned proof',async t=>{
 const f=treeFixture(t),a=await f.prefix();await f.finish(f.source.id);const policies=new CapabilityPolicyStore(f.store.sqlite),before=allocationCounts(f);
 policies.put({scopeKind:'branch',scopeId:f.leaf.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.scripts]});assert.throws(()=>f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'tree-policy'),/restricted/);assert.deepEqual(allocationCounts(f),before);
 policies.put({scopeKind:'branch',scopeId:f.leaf.id,expectedRevision:1,restrictedCapabilityIds:[]});const next=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'tree-once');await f.finish(next.id);await f.reopen();assert.equal(f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'tree-once').id,next.id);
 const lineage=f.store.sqlite.prepare("SELECT id FROM branch_unit_snapshots WHERE execution_id IN (SELECT id FROM branch_executions WHERE parent_execution_id=?) AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.child-tree-lineage.v1'").get(next.id);assert.ok(lineage);assert.throws(()=>f.store.sqlite.prepare("UPDATE branch_unit_snapshots SET content_hash='bad' WHERE id=?").run(lineage.id),/immutable/);f.store.sqlite.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(lineage.id);const after=allocationCounts(f);assert.throws(()=>f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'tree-once'),/lineage/);assert.deepEqual(allocationCounts(f),after);
 f.branches.configure(f.leaf.id,{...f.branches.configuration(f.leaf.id),checkpointMode:'sync'},1);assert.throws(()=>f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'changed-child'),/pins changed/);assert.deepEqual(allocationCounts(f),after);
});
for(const unknown of [false,true])test(`completed-child tree live child remains unsupported and never invents completion, unknown=${unknown}`,async t=>{
 const f=treeFixture(t,'async',true,'async'),first=await f.claim();f.settle(first);const child=await f.claim();assert.notEqual(child.executionId,f.source.id);if(unknown){f.branches.authorizeScript(child,inertIdentity);f.branches.markScriptUnknown(child,'inert uncertain effect');}
 await f.branches.unitSaver.drain();assert.ok(f.branches.historicalCheckpoints(f.root.id,f.source.id).every(cp=>!cp.restoreSupported));assert.notEqual(f.branches.execution(child.executionId).state,'completed');assert.equal(f.branches.claimScript('cannot-repeat-child'),undefined);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_sealed_results WHERE execution_id=?').get(child.executionId).n,0);
});

for(const mode of ['async','sync'])test(`completed-child tree ${mode} fresh suffix admits a new tracked child without reopening inherited children`,async t=>{
 const f=treeFixture(t,mode,true,'async',true),a=await f.prefix();assert.ok(a.id);await f.finish(f.source.id);const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'fresh-child-A');
 const inherited=f.store.sqlite.prepare('SELECT id,parent_attempt_id FROM branch_executions WHERE parent_execution_id=?').all(first.id);assert.equal(inherited.length,1);
 let b;for(let n=0;n<10&&!b;n++){const lease=await f.claim();f.settle(lease);await f.branches.unitSaver.drain();b=f.branches.historicalCheckpoints(f.root.id,first.id).find(cp=>cp.restoreSupported&&captureBytes(f,cp.id).continuation.owners.length===5&&captureBytes(f,cp.id).continuation.owners.filter(o=>o.executionId!==first.id).every(o=>o.selected.execution[0].state==='completed'));}
 assert.ok(b,'second actual call and nested child must become part of the next coherent cut');
 assert.ok(f.branches.detail(first.id).steps.some(s=>s.stepId==='call-again'&&s.state==='completed'));
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind=?').get(inherited[0].id,'script_leased').n,0,'inherited child has no new effect lease');
 await f.finish(first.id);const next=f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'fresh-child-B');await f.finish(next.id);assert.equal(f.branches.detail(next.id).steps.length,6);
});
test('completed-child tree actual unresolved gate remains held without automatic approval',async t=>{
 const f=treeFixture(t,'exit',true,'async'),version=f.branches.version(f.leaf.id,f.leaf.versionId);
 f.branches.deploy({chatId:f.chat.id,branchId:f.leaf.id,expectedVersionId:version.id,idempotencyKey:'tree-real-gate',definition:{...version.definition,entry:'gate',steps:[{id:'gate',kind:'human_gate',prompt:'Explicit approval',editable:false}],edges:[]},bindings:{agents:{},directories:{root:f.dir}}});
 const prefix=await f.claim();f.settle(prefix);for(let n=0;n<15;n++){await f.branches.unitSaver.drain();f.branches.advance();}
 const child=f.branches.listExecutions(f.leaf.id)[0];assert.ok(child);const gate=f.branches.detail(child.id).gates[0];assert.equal(gate.state,'waiting');assert.equal(f.branches.claimScript('no-autoapproval'),undefined);
 const invocation=f.branches.execution(f.source.id).checkpointInvocation;assert.throws(()=>f.branches.checkpointInterruption(f.root.id,f.source.id,'interrupt',invocation.id,'live-tree-interrupt'),/supports only/);assert.equal(f.branches.detail(child.id).gates[0].state,'waiting');assert.ok(f.branches.historicalCheckpoints(f.root.id,f.source.id).every(cp=>!cp.restoreSupported));
});
test('completed-child tree failed child saver preserves known result and leaves independent owners usable',async t=>{
 const f=treeFixture(t,'async',false,'async'),prefix=await f.claim();f.settle(prefix);const child=await f.claim();assert.notEqual(child.executionId,f.source.id);
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_tree_child_save BEFORE INSERT ON branch_unit_snapshots WHEN NEW.execution_id='${child.executionId}' BEGIN SELECT RAISE(ABORT,'tree child save failed'); END`);
 f.settle(child);await assert.rejects(()=>f.branches.unitSaver.drain(),/durability failed/);assert.equal(f.branches.detail(child.executionId).sealedResults.length,1);assert.equal(f.branches.detail(child.executionId).steps[0].state,'completed');assert.ok(f.branches.historicalCheckpoints(f.root.id,f.source.id).every(cp=>!cp.restoreSupported));
 const other=f.branches.accept(f.root.id,'independent-tree','independent');let lease;for(let n=0;n<10&&!lease;n++){await f.branches.unitSaver.waitFor([other.id]);f.branches.advance();lease=f.branches.claimScript('independent-tree');}assert.ok(lease);assert.equal(lease.executionId,other.id);f.settle(lease);await f.branches.unitSaver.waitFor([other.id]);assert.equal(f.branches.detail(other.id).sealedResults.length,1);await assert.rejects(()=>f.branches.unitSaver.drain(),/durability failed/);
});
test('completed-child tree capture error stays a saver error after the primary known-result commit',async t=>{
 const f=treeFixture(t),a=await f.prefix();assert.ok(a.id);const lease=await f.claim();assert.equal(lease.executionId,f.source.id);f.branches.authorizeScript(lease,inertIdentity);f.branches.recordScriptEvidence(lease,inertIdentity,{stdout:'committed known',outputHash:hash('committed known'),code:0});await f.branches.unitSaver.drain();
 const db=f.store.sqlite,prepare=db.prepare;db.prepare=function(sql){if(sql.startsWith('WITH RECURSIVE tree(id)'))throw Error('inert tree capture read failure');return prepare.call(this,sql);};
 try{f.branches.settleScript(lease,{failed:false,output:'committed known'});}finally{db.prepare=prepare;}
 await assert.rejects(()=>f.branches.unitSaver.drain(),/durability failed/);assert.equal(f.branches.detail(f.source.id).steps.find(s=>s.stepId==='suffix1').result.output,'committed known');assert.equal(f.branches.execution(f.source.id).checkpointInvocation.durability,'failed');assert.equal(f.branches.claimScript('failed-tree-saver'),undefined);
});

for(const mode of ['async','sync'])test(`completed-child tree ${mode} nested control/loop counters survive two remappings`,async t=>{
 const f=treeFixture(t,mode,true,'async',false,true),a=await f.prefix();assert.ok(a.id);assert.equal(captureBytes(f,a.id).selected.execution[0].loop_iterations,1);await f.finish(f.source.id);
 const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'tree-loop-A'),lease=await f.claim();assert.ok(lease.source.includes('suffix1'));f.settle(lease);await f.branches.unitSaver.drain();const b=f.point(first.id);assert.ok(b);await f.finish(first.id);const second=f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'tree-loop-B');await f.finish(second.id);
 assert.equal(f.store.sqlite.prepare('SELECT loop_iterations FROM branch_executions WHERE id=?').get(second.id).loop_iterations,1);
 const leaf=f.store.sqlite.prepare(`WITH RECURSIVE owned(id) AS (SELECT ? UNION SELECT e.id FROM branch_executions e JOIN owned o ON e.parent_execution_id=o.id) SELECT e.id FROM branch_executions e JOIN owned ON e.id=owned.id WHERE e.branch_id=?`).get(second.id,f.leaf.id);assert.equal(f.branches.detail(leaf.id).steps.length,3);assert.equal(f.store.sqlite.prepare('SELECT iterations FROM branch_loop_counts WHERE execution_id=?').get(leaf.id).iterations,1);assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='script_leased'").get(leaf.id).n,0);
});
test('completed-child tree idempotent replay requires the actual target prefix receipt after reopen',async t=>{
 const f=treeFixture(t),a=await f.prefix();await f.finish(f.source.id);const next=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'target-prefix-tree');await f.finish(next.id);await f.reopen();
 assert.equal(f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'target-prefix-tree').id,next.id);f.store.sqlite.prepare("DELETE FROM branch_checkpoints WHERE execution_id=? AND kind='tree_restored_prefix'").run(next.id);const before=allocationCounts(f);
 assert.throws(()=>f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'target-prefix-tree'),/lineage/);assert.deepEqual(allocationCounts(f),before);
});

for(const mode of ['async','sync'])for(const kind of ['missing-step','alias','source-alias','empty','extra','wrong-root','foreign-step'])test(`maintained ${mode} ${kind} idempotent target requires complete lineage ID map`,async t=>{
 const f=treeFixture(t,mode),cp=await f.prefix();await f.finish(f.source.id);const target=f.branches.rewindHistorical(f.root.id,f.source.id,cp.id,cp.contentHash,'review-map');await f.finish(target.id);await f.reopen();
 const decoy=kind==='wrong-root'?f.branches.accept(f.root.id,'unrelated-review','unrelated input'):undefined;await f.branches.unitSaver.drain();
 const db=f.store.sqlite,{stableJson,payloadHash}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 const receipt=db.prepare('SELECT * FROM branch_commands WHERE execution_id=?').get(f.source.id),result=JSON.parse(receipt.result_json),line=captureBytes(f,result.lineageId),source=captureBytes(f,cp.id);
 const removed=source.selected.steps[0].id;assert.ok(line.idMap[removed]);if(kind==='missing-step')delete line.idMap[removed];
 else if(kind==='alias')line.idMap[removed]=line.idMap[source.selected.paths[0].id];
 else if(kind==='source-alias')line.idMap[removed]=removed;
 else if(kind==='empty')line.idMap[removed]='';
 else if(kind==='extra')line.idMap.extra='unused-destination';
 else if(kind==='foreign-step')line.idMap[removed]=removed;
 else line.executionId=decoy.id;
 if(kind==='foreign-step'){const foreign=f.branches.detail(f.source.id).steps.find(s=>!Object.hasOwn(line.idMap,s.id));assert.ok(foreign);line.idMap[removed]=foreign.id;}
 const insert=(id,value)=>Number(db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(id,stableJson(value),payloadHash(value)).lastInsertRowid);
 const newId=insert(decoy?.id??target.id,line);
 for(const old of source.continuation.owners){const id=line.idMap[old.executionId],events=db.prepare("SELECT * FROM branch_checkpoints WHERE execution_id=? AND kind IN ('tree_restored_prefix','tree_historical_rewind')").all(id);assert.equal(events.length,2);const evidence=JSON.parse(events[0].evidence_json);evidence.lineageId=newId;
  if(evidence.childLineageId){const child=captureBytes(f,evidence.childLineageId);child.rootLineageId=newId;child.idMap=line.idMap;evidence.childLineageId=insert(id,child);}
  for(const event of events)db.prepare('UPDATE branch_checkpoints SET evidence_json=? WHERE id=?').run(stableJson(evidence),event.id);
 }
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(stableJson({executionId:decoy?.id??target.id,lineageId:newId}),f.source.id,receipt.command_key);
 const before=allocationCounts(f);let accepted=false,error,returned;try{returned=f.branches.rewindHistorical(f.root.id,f.source.id,cp.id,cp.contentHash,'review-map');accepted=!!returned;}catch(e){error=e.message;}
 console.log(JSON.stringify({probe:'incomplete target map',mode,kind,removed,accepted,returnedId:returned?.id,expectedId:target.id,decoyId:decoy?.id,error,before,after:allocationCounts(f)}));assert.equal(accepted,false,'incomplete target ID map must not certify idempotent tree lineage');assert.deepEqual(allocationCounts(f),before);
});

for(const mode of ['async','sync'])test(`tree ${mode} idempotence preserves later progress and reopened target identity`,async t=>{
 const f=treeFixture(t,mode),cp=await f.prefix();await f.finish(f.source.id);
 const target=f.branches.rewindHistorical(f.root.id,f.source.id,cp.id,cp.contentHash,'target-progress');
 const lease=await f.claim();assert.equal(lease.executionId,target.id);f.settle(lease);await f.branches.unitSaver.drain();
 let before=allocationCounts(f);assert.equal(f.branches.rewindHistorical(f.root.id,f.source.id,cp.id,cp.contentHash,'target-progress').id,target.id);assert.deepEqual(allocationCounts(f),before);
 await f.finish(target.id);await f.reopen();before=allocationCounts(f);
 assert.equal(f.branches.rewindHistorical(f.root.id,f.source.id,cp.id,cp.contentHash,'target-progress').id,target.id);assert.deepEqual(allocationCounts(f),before);
});

const unfinishedPoint=(f,id)=>f.branches.historicalCheckpoints(f.root.id,id).find(cp=>cp.restoreSupported&&captureBytes(f,cp.id).continuation?.owners?.some(o=>o.executionId!==id&&o.selected.execution[0].state!=='completed'));
async function unfinishedFixture(t,mode='async',childMode='async',nested=false,loop=false,middleMode=childMode){
 const f=treeFixture(t,mode,nested,middleMode,false,loop,true);
 if(nested)f.branches.configure(f.leaf.id,{...f.branches.configuration(f.leaf.id),checkpointMode:childMode},1);
 const prefix=await f.claim();assert.equal(prefix.executionId,f.source.id);f.settle(prefix);
 const child=await f.claim();assert.notEqual(child.executionId,f.source.id);f.settle(child);await f.branches.unitSaver.drain();
 return {...f,get store(){return f.store},get branches(){return f.branches},childId:child.executionId};
}
for(const mode of ['async','sync'])for(const childMode of ['async','sync'])for(const nested of [false,true])test(`unfinished-child ${mode}/${childMode} nested=${nested} capture A and restored B continue only fresh child suffix`,async t=>{
 const f=await unfinishedFixture(t,mode,childMode,nested),a=unfinishedPoint(f,f.source.id);assert.ok(a,'actual unfinished child progress must yield executable root tree capture');
 const cut=captureBytes(f,a.id),oldChild=cut.continuation.owners.find(o=>o.executionId===f.childId);assert.equal(oldChild.selected.steps.length,1);assert.equal(oldChild.selected.execution[0].state,'running');
 await f.finish(f.source.id);const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'unfinished-A');assert.equal(first.state,'queued');assert.equal(f.branches.claimScript('before-new-admission'),undefined);
 const lease=await f.claim();assert.ok(lease.source.includes('leaf2'));assert.equal(lease.fence,1);assert.notEqual(lease.executionId,f.childId);f.settle(lease);await f.branches.unitSaver.drain();
 const b=unfinishedPoint(f,first.id);assert.ok(b,'restored unfinished child must yield executable second tree capture');assert.equal(captureBytes(f,b.id).continuation.provenance.length,1);
 const beforePrefix=f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='script_leased'").get(first.id).n;assert.equal(beforePrefix,0,'sealed parent prefix never leased');
 await f.finish(first.id);await f.reopen();const before=allocationCounts(f);assert.equal(f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'unfinished-A').id,first.id);assert.deepEqual(allocationCounts(f),before);
 const second=f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'unfinished-B'),suffix=await f.claim();assert.ok(suffix.source.includes('leaf3'));assert.equal(suffix.fence,1);f.settle(suffix);await f.finish(second.id);await f.reopen();
 assert.equal(f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'unfinished-B').id,second.id);
 const roots=[first.id,second.id];for(const id of roots){assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='child_completed'").get(id).n,1);assert.equal(f.branches.detail(id).steps.filter(s=>s.stepId==='call').length,1);}
 assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});

for(const mode of ['async','sync'])test(`unfinished-child ${mode} loop counters and waiting call survive two remappings`,async t=>{
 const f=await unfinishedFixture(t,mode,'async',true,true),a=unfinishedPoint(f,f.source.id);assert.ok(a);await f.finish(f.source.id);
 const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'unfinished-loop-A'),again=await f.claim();assert.ok(again.source.includes('leaf1'));f.settle(again);await f.branches.unitSaver.drain();
 // The loop edge is a distinct normal scheduler unit, not an immediate-next-lease promise.
 for(let n=0;n<8&&!f.store.sqlite.prepare('SELECT loop_iterations FROM branch_executions WHERE id=?').get(first.id).loop_iterations;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const b=unfinishedPoint(f,first.id);assert.ok(b);assert.equal(captureBytes(f,b.id).selected.execution[0].loop_iterations,1);await f.finish(first.id);
 const second=f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'unfinished-loop-B'),last=await f.claim();assert.ok(last.source.includes('leaf2'));f.settle(last);await f.finish(second.id);
 assert.equal(f.store.sqlite.prepare('SELECT loop_iterations FROM branch_executions WHERE id=?').get(second.id).loop_iterations,1);
});
test('unfinished-child exit root explicit interruption captures quiescent async child A and restored B without intermediate saves',async t=>{
 const f=await unfinishedFixture(t,'exit','async'),original=f.branches.execution(f.source.id).checkpointInvocation;
 assert.equal(f.branches.historicalCheckpoints(f.root.id,f.source.id).length,0);
 const hold=f.branches.checkpointInterruption(f.root.id,f.source.id,'interrupt',original.id,'unfinished-exit-A').checkpointInvocation;await f.branches.unitSaver.completeExits();const a=unfinishedPoint(f,f.source.id);assert.ok(a);assert.equal(f.branches.claimScript('held-child'),undefined);
 f.branches.checkpointInterruption(f.root.id,f.source.id,'resume',hold.interruptionId,'unfinished-exit-resume-A');await f.finish(f.source.id);
 const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'unfinished-exit-rewind-A'),leaf2=await f.claim();assert.ok(leaf2.source.includes('leaf2'));assert.equal(leaf2.fence,1);f.settle(leaf2);await f.branches.unitSaver.drain();
 assert.equal(f.branches.historicalCheckpoints(f.root.id,first.id).length,0,'fresh EXIT progress remains coalesced');const inv=f.branches.execution(first.id).checkpointInvocation;assert.notEqual(inv.id,original.id);
 const secondHold=f.branches.checkpointInterruption(f.root.id,first.id,'interrupt',inv.id,'unfinished-exit-B').checkpointInvocation;await f.branches.unitSaver.completeExits();const b=unfinishedPoint(f,first.id);assert.ok(b);
 f.branches.checkpointInterruption(f.root.id,first.id,'resume',secondHold.interruptionId,'unfinished-exit-resume-B');await f.finish(first.id);await f.reopen();
 const second=f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'unfinished-exit-rewind-B'),leaf3=await f.claim();assert.ok(leaf3.source.includes('leaf3'));f.settle(leaf3);await f.finish(second.id);await f.branches.unitSaver.completeExits();
});
test('unfinished-child exit root waits for exact known child process settlement before durable closing capture',async t=>{
 const f=await unfinishedFixture(t,'exit','sync'),lease=await f.claim();assert.ok(lease.source.includes('leaf2'));f.branches.authorizeScript(lease,inertIdentity);
 const inv=f.branches.execution(f.source.id).checkpointInvocation,hold=f.branches.checkpointInterruption(f.root.id,f.source.id,'interrupt',inv.id,'unfinished-running-hold').checkpointInvocation;assert.equal(hold.state,'interrupting');assert.equal(f.branches.claimScript('held-running'),undefined);
 f.branches.settleScript(lease,{failed:false,output:'known without exit proof'});await f.branches.unitSaver.drain();assert.equal(f.branches.execution(f.source.id).checkpointInvocation.state,'interrupting');assert.equal(unfinishedPoint(f,f.source.id),undefined);
 f.branches.recordScriptEvidence(lease,inertIdentity,{stdout:'known without exit proof',outputHash:hash('known without exit proof'),code:0});await f.branches.unitSaver.completeExits();assert.equal(f.branches.execution(f.source.id).checkpointInvocation.state,'interrupted');assert.ok(unfinishedPoint(f,f.source.id));
});
test('unfinished-child EXIT child remains explicit unsupported until actual completion',async t=>{
 const f=await unfinishedFixture(t,'async','exit');assert.equal(unfinishedPoint(f,f.source.id),undefined);await f.finish(f.source.id);
});
async function restoredUnfinished(t){
 const f=await unfinishedFixture(t),a=unfinishedPoint(f,f.source.id);assert.ok(a);await f.finish(f.source.id);const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'unfinished-corrupt-A'),lease=await f.claim();f.settle(lease);await f.branches.unitSaver.drain();const b=unfinishedPoint(f,first.id);assert.ok(b);await f.finish(first.id);return {f,a,first,b};
}
for(const kind of ['missingChild','foreignParent','waitingAttempt','parentAudit','childAudit','childCounter','sealedPrefix','sourceReceipt','missingChildLineage','mapAlias','missingMap','provenance'])test(`unfinished-child ${kind} corrupt cut refuses before allocation`,async t=>{
 const {f,first,b}=await restoredUnfinished(t),snapshot=captureBytes(f,b.id),c=snapshot.continuation,root=c.owners.find(o=>o.executionId===first.id),child=c.owners.find(o=>o.executionId!==first.id),{stableJson,payloadHash}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 if(kind==='missingChild')c.owners=c.owners.filter(o=>o!==child);
 if(kind==='foreignParent')child.selected.execution[0].parent_execution_id=f.source.id;
 if(kind==='waitingAttempt')root.selected.attempts.find(a=>a.state==='waiting').id='foreign-attempt';
 if(kind==='parentAudit')root.audit.splice(1,1);
 if(kind==='childAudit')child.audit.splice(1,1);
 if(kind==='childCounter')child.selected.execution[0].traversals++;
 if(kind==='sealedPrefix')child.selected.sealedResults[0].content_hash='bad';
 if(kind==='sourceReceipt')f.store.sqlite.prepare('DELETE FROM branch_commands WHERE execution_id=?').run(f.source.id);
 if(kind==='missingChildLineage'){const ev=JSON.parse(child.audit.find(a=>a.kind==='tree_restored_prefix').evidence_json);f.store.sqlite.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(ev.childLineageId);}
 if(kind==='mapAlias'||kind==='missingMap'){const ref=c.provenance[0],old=captureBytes(f,ref.checkpointId),line=captureBytes(f,ref.lineageId);if(kind==='mapAlias')line.idMap[old.selected.steps[0].id]=line.idMap[old.selected.paths[0].id];else delete line.idMap[old.selected.steps[0].id];const id=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(first.id,stableJson(line),payloadHash(line)).lastInsertRowid);for(const ev of root.audit.filter(a=>a.kind==='tree_restored_prefix'||a.kind==='tree_historical_rewind')){const value=JSON.parse(ev.evidence_json);value.lineageId=id;ev.evidence_json=stableJson(value);f.store.sqlite.prepare('UPDATE branch_checkpoints SET evidence_json=? WHERE id=?').run(ev.evidence_json,ev.id);}}
 if(kind==='provenance')c.provenance=[];
 snapshot.selected=root.selected;const bytes=stableJson(snapshot),id=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(first.id,bytes,hash(bytes)).lastInsertRowid),before=allocationCounts(f);
 assert.equal(f.branches.historicalCheckpoints(f.root.id,first.id).find(cp=>cp.id===id).restoreSupported,false);assert.throws(()=>f.branches.rewindHistorical(f.root.id,first.id,id,hash(bytes),'unfinished-corrupt-B'),/integrity|unsupported/);assert.deepEqual(allocationCounts(f),before);
});
test('unfinished-child allocation rolls back the whole owner tree on required child lineage failure',async t=>{
 const f=await unfinishedFixture(t),a=unfinishedPoint(f,f.source.id);await f.finish(f.source.id);const before=allocationCounts(f);
 f.store.sqlite.exec("CREATE TEMP TRIGGER unfinished_lineage_fail BEFORE INSERT ON branch_unit_snapshots WHEN json_extract(NEW.snapshot_json,'$.schema')='ponderosa.branch.child-tree-lineage.v1' BEGIN SELECT RAISE(ABORT,'unfinished lineage insert failure'); END");
 assert.throws(()=>f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'unfinished-atomic'),/unfinished lineage insert failure/);await f.branches.unitSaver.drain();assert.deepEqual(allocationCounts(f),before);assert.equal(f.branches.claimScript('no-rollback-child'),undefined);
});
for(const kind of ['policy','pins','cancel','unknown','gate'])test(`unfinished-child current ${kind} holds fresh work without prefix replay`,async t=>{
 const f=await unfinishedFixture(t,'sync','sync'),a=unfinishedPoint(f,f.source.id);assert.ok(a);await f.finish(f.source.id);
 if(kind==='policy'){new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'branch',scopeId:f.leaf.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.scripts]});const before=allocationCounts(f);assert.throws(()=>f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'unfinished-authority'),/restricted/);assert.deepEqual(allocationCounts(f),before);return;}
 if(kind==='pins'){f.branches.configure(f.leaf.id,{...f.branches.configuration(f.leaf.id),limits:{...f.branches.configuration(f.leaf.id).limits,maxTraversals:99}},1);const before=allocationCounts(f);assert.throws(()=>f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'unfinished-authority'),/pins changed/);assert.deepEqual(allocationCounts(f),before);return;}
 const next=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'unfinished-authority');
 if(kind==='cancel'){f.branches.cancel(next.id);await f.branches.unitSaver.drain();assert.equal(f.branches.claimScript('canceled-tree'),undefined);return;}
 const lease=await f.claim();assert.ok(lease.source.includes('leaf2'));const currentCut=unfinishedPoint(f,next.id);assert.ok(currentCut);
 if(kind==='unknown'){f.branches.authorizeScript(lease,inertIdentity);f.branches.markScriptUnknown(lease,'inert unknown suffix');await f.branches.unitSaver.drain();assert.equal(f.branches.claimScript('no-unknown-replay'),undefined);const before=allocationCounts(f);assert.throws(()=>f.branches.rewindHistorical(f.root.id,next.id,currentCut.id,currentCut.contentHash,'no-unknown-transfer'),/checkpoint|owner|settled|live|uncertain|integrity/i);assert.deepEqual(allocationCounts(f),before);return;}
 // Use the actual gate authority, preserving the unstarted lease as a held frontier.
 f.branches.unitTransaction(()=>{const attempt=f.store.sqlite.prepare('SELECT * FROM branch_attempts WHERE id=?').get(lease.attemptId);f.branches.openGate(attempt,lease.executionId,'Explicit test gate','held',undefined,'approval',new Date().toISOString());})();await f.branches.unitSaver.drain();assert.notEqual(f.branches.checkpointDispatch(lease),'ready');assert.equal(f.branches.claimScript('no-autoapproval'),undefined);assert.equal(f.branches.detail(lease.executionId).gates[0].state,'waiting');
});


async function interruptExitChild(f,id,key){
 const e=f.branches.execution(id),inv=e.checkpointInvocation;
 let hold;assert.doesNotThrow(()=>{hold=f.branches.checkpointInterruption(e.branchId,id,'interrupt',inv.id,key).checkpointInvocation;},'actual tracked EXIT child interruption must be supported');
 await f.branches.unitSaver.completeExits();return hold;
}
function resumeExitChild(f,id,hold,key){const e=f.branches.execution(id);return f.branches.checkpointInterruption(e.branchId,id,'resume',hold.interruptionId,key);}
for(const mode of ['async','sync'])for(const nested of [false,true])test(`exit-child ${mode} nested=${nested} actual closing A and restored B execute only fresh suffix`,async t=>{
 const f=await unfinishedFixture(t,mode,'exit',nested,false,nested?'async':'exit'),original=f.branches.execution(f.childId).checkpointInvocation;
 assert.equal(f.branches.historicalCheckpoints(f.leaf.id,f.childId).length,0,'EXIT has no intermediate saved identity');
 assert.equal(unfinishedPoint(f,f.source.id),undefined,'active EXIT child cannot be relabeled async');
 const hold=await interruptExitChild(f,f.childId,'child-close-A');
 const a=unfinishedPoint(f,f.source.id);assert.ok(a,'actual interrupted EXIT child must yield executable ancestor tree capture');
 assert.equal(f.branches.claimScript('held-exit-child'),undefined);assert.equal(hold.state,'interrupted');
 resumeExitChild(f,f.childId,hold,'child-resume-A');await f.finish(f.source.id);
 const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'exit-child-rewind-A');
 const restored=f.store.sqlite.prepare("SELECT id FROM branch_executions WHERE json_extract(checkpoint_invocation_json,'$.interruptionId') IS NOT NULL AND state='queued'").all();assert.equal(restored.length,1);
 const newHold=f.branches.execution(restored[0].id).checkpointInvocation;assert.notEqual(newHold.interruptionId,hold.interruptionId);
 const inherited=f.store.sqlite.prepare('SELECT a.* FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=?').all(restored[0].id);assert.ok(inherited.length);assert.ok(inherited.every(a=>a.fence===0&&a.lease_owner===null&&a.process_identity_json===null));
 await f.branches.unitSaver.drain();f.branches.advance();assert.equal(f.branches.claimScript('no-automatic-child-resume'),undefined);resumeExitChild(f,restored[0].id,newHold,'fresh-resume-A');
 const lease=await f.claim();assert.ok(lease.source.includes('leaf2'));assert.notEqual(lease.executionId,f.childId);assert.equal(lease.fence,1);
 const fresh=f.branches.execution(lease.executionId).checkpointInvocation;assert.notEqual(fresh.id,original.id);assert.equal(fresh.interruptionId,undefined);
 f.settle(lease);await f.branches.unitSaver.drain();
 const secondHold=await interruptExitChild(f,lease.executionId,'child-close-B'),b=unfinishedPoint(f,first.id);assert.ok(b,'restored EXIT child must yield executable second ancestor capture');
 assert.equal(captureBytes(f,b.id).continuation.provenance.length,1);
 resumeExitChild(f,lease.executionId,secondHold,'child-resume-B');await f.finish(first.id);await f.reopen();
 const before=allocationCounts(f);assert.equal(f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'exit-child-rewind-A').id,first.id);assert.deepEqual(allocationCounts(f),before);
 const second=f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'exit-child-rewind-B');await f.branches.unitSaver.drain();
 const held=f.store.sqlite.prepare("SELECT id FROM branch_executions WHERE state='queued' AND json_extract(checkpoint_invocation_json,'$.interruptionId') IS NOT NULL").get();assert.ok(held);resumeExitChild(f,held.id,f.branches.execution(held.id).checkpointInvocation,'fresh-resume-B');const last=await f.claim();assert.ok(last.source.includes('leaf3'));assert.equal(last.fence,1);f.settle(last);await f.finish(second.id);await f.reopen();
 assert.equal(f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'exit-child-rewind-B').id,second.id);
 for(const root of [first.id,second.id]){assert.equal(f.branches.detail(root).steps.filter(s=>s.stepId==='call').length,1);assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='child_completed'").get(root).n,1);assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='script_leased' AND json_extract(evidence_json,'$.attemptId') IN (SELECT a.id FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? AND s.step_id='prefix')").get(root,root).n,0);}
 assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});

test('exit-child exact late process proof closes child and ancestor without INITIAL or unknown release',async t=>{
 const f=await unfinishedFixture(t,'sync','exit'),lease=await f.claim();assert.ok(lease.source.includes('leaf2'));f.branches.authorizeScript(lease,inertIdentity);
 const inv=f.branches.execution(f.childId).checkpointInvocation,hold=f.branches.checkpointInterruption(f.leaf.id,f.childId,'interrupt',inv.id,'late-child-hold').checkpointInvocation;
 assert.equal(hold.state,'interrupting');await f.branches.unitSaver.drain();assert.equal(f.branches.historicalCheckpoints(f.leaf.id,f.childId).length,0);assert.equal(unfinishedPoint(f,f.source.id),undefined);
 assert.equal(f.branches.claimScript('late-child-held'),undefined);assert.throws(()=>resumeExitChild(f,f.childId,hold,'too-early'),/saved quiescence/);
 f.branches.settleScript(lease,{failed:false,output:'exact late child'});await f.branches.unitSaver.drain();assert.equal(f.branches.execution(f.childId).checkpointInvocation.state,'interrupting');assert.equal(unfinishedPoint(f,f.source.id),undefined);
 f.branches.recordScriptEvidence({...lease,fence:lease.fence+1},inertIdentity,{stdout:'exact late child',outputHash:hash('exact late child'),code:0});await f.branches.unitSaver.drain();assert.equal(f.branches.execution(f.childId).checkpointInvocation.state,'interrupting');
 f.branches.recordScriptEvidence(lease,inertIdentity,{stdout:'exact late child',outputHash:hash('exact late child'),code:0});await f.branches.unitSaver.completeExits();assert.equal(f.branches.execution(f.childId).checkpointInvocation.state,'interrupted');assert.ok(unfinishedPoint(f,f.source.id));
 assert.ok(f.branches.historicalCheckpoints(f.leaf.id,f.childId).every(cp=>captureBytes(f,cp.id).closing));resumeExitChild(f,f.childId,hold,'late-child-resume');await f.finish(f.source.id);
});
test('exit-child parent EXIT and nested EXIT holds stay independent through restore',async t=>{
 const f=await unfinishedFixture(t,'exit','exit',true),leafHold=await interruptExitChild(f,f.childId,'nested-leaf-close');
 const middle=f.store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(f.source.id);
 const middleHold=await interruptExitChild(f,middle.id,'nested-middle-close'),rootHold=await interruptExitChild(f,f.source.id,'nested-root-close');
 const a=unfinishedPoint(f,f.source.id);assert.ok(a);resumeExitChild(f,f.childId,leafHold,'nested-leaf-resume');assert.equal(f.branches.claimScript('parent-still-held'),undefined);
 await f.branches.unitSaver.completeExits();resumeExitChild(f,middle.id,middleHold,'nested-middle-resume');assert.equal(f.branches.claimScript('root-still-held'),undefined);await f.branches.unitSaver.completeExits();resumeExitChild(f,f.source.id,rootHold,'nested-root-resume');await f.finish(f.source.id);
 const next=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'nested-all-exit');await f.branches.unitSaver.drain();
 const children=f.store.sqlite.prepare("SELECT id FROM branch_executions WHERE state='queued' AND json_extract(checkpoint_invocation_json,'$.interruptionId') IS NOT NULL ORDER BY call_depth").all();assert.equal(children.length,2);
 for(const child of children){await f.branches.unitSaver.drain();resumeExitChild(f,child.id,f.branches.execution(child.id).checkpointInvocation,`nested-fresh-${child.id}`);}
 const suffix=await f.claim();assert.ok(suffix.source.includes('leaf2'));f.settle(suffix);await f.finish(next.id);await f.branches.unitSaver.completeExits();
});
async function closedExitChild(t,mode='async'){
 const f=await unfinishedFixture(t,mode,'exit'),hold=await interruptExitChild(f,f.childId,'close-corruption'),a=unfinishedPoint(f,f.source.id);assert.ok(a);
 resumeExitChild(f,f.childId,hold,'resume-corruption');await f.finish(f.source.id);return {f,a,hold};
}
for(const kind of ['invocation','ordinal','interruption','primaryOutcome','missingPause','childAudit','counter','coverageMissing','coverageForeign','coverageTampered','proofMissing','proofWrongFence','mapMissing','receiptMissing'])test(`exit-child ${kind} refuses before restore allocation`,async t=>{
 const {f,a}=await closedExitChild(t),snapshot=captureBytes(f,a.id),child=snapshot.continuation.owners.find(o=>o.executionId===f.childId),inv=child.invocation;
 const {stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js');
 if(kind==='invocation')inv.id='foreign-invocation';if(kind==='ordinal')inv.ordinal++;if(kind==='interruption')inv.interruptionId='foreign-interruption';if(kind==='primaryOutcome')inv.primaryOutcome='completed';
 if(kind==='missingPause')child.audit=child.audit.filter(a=>a.kind!=='checkpoint_interrupt_requested');if(kind==='childAudit')child.audit=child.audit.filter(a=>a.kind!=='script_authorized');if(kind==='counter')child.selected.execution[0].traversals++;
 if(kind.startsWith('coverage')){
  const rows=f.store.sqlite.prepare("SELECT id,snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.invocationId')=? AND json_extract(snapshot_json,'$.closing')=1").all(f.childId,inv.id);assert.ok(rows.length);
  for(const row of rows){const cp=JSON.parse(row.snapshot_json);f.store.sqlite.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(row.id);if(kind==='coverageForeign')f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,row.snapshot_json,hash(row.snapshot_json));if(kind==='coverageTampered'){cp.selected.execution[0].traversals++;const bytes=stableJson(cp);f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.childId,bytes,hash(bytes));}}
 }
 if(kind.startsWith('proof')){
  const proof=child.audit.find(a=>a.kind==='script_process_exit');assert.ok(proof);if(kind==='proofMissing'){f.store.sqlite.prepare('DELETE FROM branch_checkpoints WHERE id=?').run(proof.id);}else{proof.transition_key=proof.transition_key.replace(/:(\d+)$/,(_,n)=>`:${Number(n)+1}`);f.store.sqlite.prepare('UPDATE branch_checkpoints SET transition_key=? WHERE id=?').run(proof.transition_key,proof.id);}
 }
 if(kind==='mapMissing'||kind==='receiptMissing'){
  const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'exit-corrupt-map');await f.branches.unitSaver.drain();
  if(kind==='receiptMissing')f.store.sqlite.prepare("DELETE FROM branch_commands WHERE execution_id=? AND command_key LIKE 'tree-historical-rewind:%'").run(f.source.id);
  else{const lineRow=f.store.sqlite.prepare("SELECT id,snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.tree-rewind-lineage.v1'").get(first.id),line=JSON.parse(lineRow.snapshot_json);delete line.idMap[f.childId];const bytes=stableJson(line),id=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(first.id,bytes,hash(bytes)).lastInsertRowid);f.store.sqlite.prepare("UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key LIKE 'tree-historical-rewind:%'").run(stableJson({executionId:first.id,lineageId:id}),f.source.id);}
  const childId=f.store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(first.id).id,held=f.branches.execution(childId).checkpointInvocation,before=allocationCounts(f);assert.throws(()=>resumeExitChild(f,childId,held,'corrupt-resume'),/saved quiescence and authority/);assert.deepEqual(allocationCounts(f),before);assert.equal(f.branches.claimScript('corrupt-held'),undefined);return;
 }
 const bytes=stableJson(snapshot),id=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,bytes,hash(bytes)).lastInsertRowid),before=allocationCounts(f);
 assert.equal(f.branches.historicalCheckpoints(f.root.id,f.source.id).find(cp=>cp.id===id).restoreSupported,false);assert.throws(()=>f.branches.rewindHistorical(f.root.id,f.source.id,id,hash(bytes),'exit-child-corrupt'),/integrity|unsupported/);assert.deepEqual(allocationCounts(f),before);
});
test('exit-child closing saver failure stays visible and cannot become ancestor coverage',async t=>{
 const f=await unfinishedFixture(t,'async','exit');f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_child_close BEFORE INSERT ON branch_unit_snapshots WHEN NEW.execution_id='${f.childId}' BEGIN SELECT RAISE(ABORT,'child closing failure'); END`);
 const inv=f.branches.execution(f.childId).checkpointInvocation,hold=f.branches.checkpointInterruption(f.leaf.id,f.childId,'interrupt',inv.id,'failed-child-close').checkpointInvocation;
 await assert.rejects(f.branches.unitSaver.completeExits(),/durability failed/);assert.equal(f.branches.execution(f.childId).checkpointInvocation.durability,'failed');assert.equal(unfinishedPoint(f,f.source.id),undefined);assert.equal(f.branches.detail(f.childId).steps[0].result.failed,false);assert.throws(()=>resumeExitChild(f,f.childId,hold,'failed-close-resume'),/supports only|saved quiescence/);assert.equal(f.branches.claimScript('failed-child-held'),undefined);
});
for(const kind of ['policy','parentPolicy','pins','cancel','parentCancel','gate','missingCoverage'])test(`exit-child restored ${kind} blocks explicit resume and fresh effects`,async t=>{
 const {f,a}=await closedExitChild(t),next=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'held-authority');await f.branches.unitSaver.drain();
 const child=f.store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(next.id),hold=f.branches.execution(child.id).checkpointInvocation;
 if(kind==='policy'||kind==='parentPolicy')new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'branch',scopeId:kind==='policy'?f.leaf.id:f.root.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.scripts]});
 if(kind==='pins')f.branches.configure(f.leaf.id,{...f.branches.configuration(f.leaf.id),limits:{...f.branches.configuration(f.leaf.id).limits,maxTraversals:99}},1);
 if(kind==='cancel'||kind==='parentCancel')f.branches.cancel(kind==='cancel'?child.id:next.id);
 if(kind==='gate'){const attempt=f.store.sqlite.prepare('SELECT a.*,s.path_id FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=?').get(child.id);f.branches.unitTransaction(()=>f.branches.openGate(attempt,child.id,'still requires human','',[],'approval',new Date().toISOString()))();}
 if(kind==='missingCoverage'){const saved=f.branches.execution(child.id).checkpointInvocation.savedSnapshotId;assert.ok(saved);f.store.sqlite.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(saved);await f.reopen();}
 const before=allocationCounts(f);assert.throws(()=>resumeExitChild(f,child.id,hold,`blocked-${kind}`),/supports only|saved quiescence/);assert.deepEqual(allocationCounts(f),before);assert.equal(f.branches.claimScript('held-authority'),undefined);
});
test('exit-child required fresh hold insertion failure atomically rolls back all owners and lineage',async t=>{
 const {f,a}=await closedExitChild(t),before=allocationCounts(f);f.store.sqlite.exec("CREATE TEMP TRIGGER fail_fresh_hold BEFORE INSERT ON branch_checkpoints WHEN NEW.kind='checkpoint_restore_held' BEGIN SELECT RAISE(ABORT,'fresh child hold failure'); END");
 assert.throws(()=>f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'atomic-fresh-hold'),/fresh child hold failure/);await f.branches.unitSaver.drain();assert.deepEqual(allocationCounts(f),before);assert.equal(f.branches.claimScript('rollback-hold'),undefined);
});

test('exit-child reopened fresh hold requires explicit resume with saved current bytes',async t=>{
 const {f,a}=await closedExitChild(t),next=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'reopen-fresh-hold');await f.branches.unitSaver.drain();
 const child=f.store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(next.id),hold=f.branches.execution(child.id).checkpointInvocation;await f.reopen();
 assert.equal(f.branches.claimScript('reopened-held-child'),undefined);const resumed=resumeExitChild(f,child.id,hold,'reopened-explicit-resume');assert.notEqual(resumed.checkpointInvocation.id,hold.id);
 const same=resumeExitChild(f,child.id,hold,'reopened-explicit-resume');assert.equal(same.checkpointInvocation.id,resumed.checkpointInvocation.id);
 const suffix=await f.claim();assert.ok(suffix.source.includes('leaf2'));assert.equal(suffix.fence,1);f.settle(suffix);await f.finish(next.id);
 assert.throws(()=>f.store.sqlite.prepare("UPDATE branch_unit_snapshots SET snapshot_json='{}' WHERE execution_id=?").run(child.id),/immutable/);
});
test('exit-child unknown running effect remains held without completion or replay',async t=>{
 const f=await unfinishedFixture(t,'async','exit'),lease=await f.claim();f.branches.authorizeScript(lease,inertIdentity);f.branches.markScriptUnknown(lease,'inert unknown');
 const inv=f.branches.execution(f.childId).checkpointInvocation,hold=f.branches.checkpointInterruption(f.leaf.id,f.childId,'interrupt',inv.id,'unknown-exit-child').checkpointInvocation;await f.branches.unitSaver.drain();
 assert.equal(hold.state,'interrupting');assert.equal(unfinishedPoint(f,f.source.id),undefined);assert.throws(()=>resumeExitChild(f,f.childId,hold,'unknown-resume'),/saved quiescence/);assert.equal(f.branches.claimScript('unknown-no-release'),undefined);
 assert.equal(f.store.sqlite.prepare('SELECT state FROM branch_attempts WHERE id=?').get(lease.attemptId).state,'outcome_unknown');assert.equal(f.branches.execution(f.source.id).state,'waiting');
});
test('exit-child pending closing save cannot count as ancestor coverage',async t=>{
 const f=await unfinishedFixture(t,'async','exit');let release;const barrier=new Promise(resolve=>{release=resolve;});f.branches.unitSaver.lanes.set(f.childId,barrier);
 const inv=f.branches.execution(f.childId).checkpointInvocation,hold=f.branches.checkpointInterruption(f.leaf.id,f.childId,'interrupt',inv.id,'pending-child-close').checkpointInvocation;
 await f.branches.unitSaver.waitFor([f.source.id]);assert.equal(unfinishedPoint(f,f.source.id),undefined);assert.throws(()=>resumeExitChild(f,f.childId,hold,'pending-resume'),/saved quiescence/);
 release();await f.branches.unitSaver.completeExits();assert.ok(unfinishedPoint(f,f.source.id));resumeExitChild(f,f.childId,hold,'pending-now-saved');await f.finish(f.source.id);
});
test('exit-child EXIT parent keeps independent A and B closing boundaries across second rewind',async t=>{
 const f=await unfinishedFixture(t,'exit','exit'),childA=await interruptExitChild(f,f.childId,'both-child-A'),rootA=await interruptExitChild(f,f.source.id,'both-root-A'),a=unfinishedPoint(f,f.source.id);assert.ok(a);
 resumeExitChild(f,f.childId,childA,'both-child-resume-A');assert.equal(f.branches.claimScript('root-A-held'),undefined);await f.branches.unitSaver.completeExits();resumeExitChild(f,f.source.id,rootA,'both-root-resume-A');await f.finish(f.source.id);
 const first=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'both-rewind-A');await f.branches.unitSaver.drain();const child=f.store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(first.id);resumeExitChild(f,child.id,f.branches.execution(child.id).checkpointInvocation,'both-fresh-A');
 const suffix=await f.claim();assert.ok(suffix.source.includes('leaf2'));f.settle(suffix);await f.branches.unitSaver.drain();assert.equal(f.branches.historicalCheckpoints(f.root.id,first.id).length,0);
 const childB=await interruptExitChild(f,child.id,'both-child-B'),rootB=await interruptExitChild(f,first.id,'both-root-B'),b=unfinishedPoint(f,first.id);assert.ok(b);
 resumeExitChild(f,child.id,childB,'both-child-resume-B');await f.branches.unitSaver.completeExits();resumeExitChild(f,first.id,rootB,'both-root-resume-B');await f.finish(first.id);
 const second=f.branches.rewindHistorical(f.root.id,first.id,b.id,b.contentHash,'both-rewind-B');await f.branches.unitSaver.drain();const lastChild=f.store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(second.id);resumeExitChild(f,lastChild.id,f.branches.execution(lastChild.id).checkpointInvocation,'both-fresh-B');
 const last=await f.claim();assert.ok(last.source.includes('leaf3'));assert.equal(last.fence,1);f.settle(last);await f.finish(second.id);await f.branches.unitSaver.completeExits();
});

for(const mode of ['async','sync'])for(const kind of ['forged-interruption','forged-ordinal','foreign-saved-hold','foreign-receipt','wrong-human-id'])test(`maintained hold identity ${mode} ${kind} held child refusal`,async t=>{
 const {f,a}=await closedExitChild(t,mode),root=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'independent-A');await f.branches.unitSaver.drain();
 let db=f.store.sqlite;const child=db.prepare('SELECT * FROM branch_executions WHERE parent_execution_id=?').get(root.id),old=JSON.parse(child.checkpoint_invocation_json);
 let expected=old.interruptionId;
 if(kind==='forged-interruption'){
  expected='never-issued-human-hold';db.prepare("UPDATE branch_executions SET checkpoint_invocation_json=json_set(checkpoint_invocation_json,'$.interruptionId',?) WHERE id=?").run(expected,child.id);
 }
 if(kind==='forged-ordinal')db.prepare("UPDATE branch_executions SET checkpoint_invocation_json=json_set(checkpoint_invocation_json,'$.ordinal',99) WHERE id=?").run(child.id);
 if(kind==='foreign-saved-hold'||kind==='foreign-receipt'){
  const second=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'independent-B');await f.branches.unitSaver.drain();const foreign=db.prepare('SELECT * FROM branch_executions WHERE parent_execution_id=?').get(second.id);
  if(kind==='foreign-saved-hold'){db.prepare('UPDATE branch_executions SET checkpoint_invocation_json=? WHERE id=?').run(foreign.checkpoint_invocation_json,child.id);expected=JSON.parse(foreign.checkpoint_invocation_json).interruptionId;}
  else{const ev=db.prepare("SELECT evidence_json FROM branch_checkpoints WHERE execution_id=? AND kind='tree_historical_rewind'").get(second.id);db.prepare("UPDATE branch_checkpoints SET evidence_json=? WHERE execution_id=? AND kind='tree_historical_rewind'").run(ev.evidence_json,root.id);}
 }
 if(kind==='wrong-human-id')expected='never-issued-human-hold';
 await f.reopen();db=f.store.sqlite;const savedBytes=db.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(old.saved_snapshot_id).snapshot_json;const holdEvent=db.prepare("SELECT evidence_json FROM branch_checkpoints WHERE execution_id=? AND kind='checkpoint_restore_held'").get(child.id);const before=allocationCounts(f),invBefore=f.branches.execution(child.id).checkpointInvocation;let accepted=false,error;
 try{f.branches.checkpointInterruption(f.leaf.id,child.id,'resume',expected,'independent-resume');accepted=true;}catch(e){error=e.message;}
 let suffix;if(accepted){suffix=await f.claim();assert.equal(suffix.executionId,child.id);assert.ok(suffix.source.includes('leaf2'));assert.equal(suffix.fence,1);}
 console.log(JSON.stringify({mode,kind,accepted,error,before,after:allocationCounts(f),invBefore,invAfter:f.branches.execution(child.id).checkpointInvocation,ownedHold:JSON.parse(holdEvent.evidence_json),savedBytesUnchanged:savedBytes===db.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(old.saved_snapshot_id).snapshot_json,suffix:suffix&&{executionId:suffix.executionId,fence:suffix.fence,source:suffix.source}}));
 assert.equal(accepted,false,'foreign or never issued fresh child hold must not authorize resume');assert.deepEqual(allocationCounts(f),before);assert.equal(f.branches.claimScript('held-independent'),undefined);
});
for(const mode of ['async','sync'])for(const kind of ['invocation','missingHold','mismatchedHold','missingResume','changedResume','laterOrdinal'])test(`current EXIT hold ${mode} ${kind} refuses unchanged`,async t=>{
 const {f,a}=await closedExitChild(t,mode),root=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'hold-chain');await f.branches.unitSaver.drain();
 const child=f.store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(root.id);let hold=f.branches.execution(child.id).checkpointInvocation;
 if(['missingResume','changedResume','laterOrdinal'].includes(kind)){
  resumeExitChild(f,child.id,hold,'chain-first-resume');const lease=await f.claim();assert.equal(lease.executionId,child.id);f.settle(lease);await f.branches.unitSaver.completeExits();
  hold=await interruptExitChild(f,child.id,'chain-second-hold');
 }
 const db=f.store.sqlite;
 if(kind==='invocation')db.prepare("UPDATE branch_executions SET checkpoint_invocation_json=json_set(checkpoint_invocation_json,'$.id','forged-current-invocation') WHERE id=?").run(child.id);
 if(kind==='missingHold')db.prepare("DELETE FROM branch_checkpoints WHERE execution_id=? AND kind='checkpoint_restore_held'").run(child.id);
 if(kind==='mismatchedHold')db.prepare("UPDATE branch_checkpoints SET evidence_json=json_set(evidence_json,'$.ordinal',99) WHERE execution_id=? AND kind='checkpoint_restore_held'").run(child.id);
 if(kind==='missingResume')db.prepare("DELETE FROM branch_checkpoints WHERE execution_id=? AND kind='checkpoint_interrupt_resumed'").run(child.id);
 if(kind==='changedResume')db.prepare("UPDATE branch_checkpoints SET evidence_json=json_set(evidence_json,'$.nextInvocationId','foreign-next') WHERE execution_id=? AND kind='checkpoint_interrupt_resumed'").run(child.id);
 if(kind==='laterOrdinal')db.prepare("UPDATE branch_executions SET checkpoint_invocation_json=json_set(checkpoint_invocation_json,'$.ordinal',99) WHERE id=?").run(child.id);
 await f.reopen();const before=allocationCounts(f),bytes=f.store.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(child.id).checkpoint_invocation_json;
 assert.throws(()=>resumeExitChild(f,child.id,hold,'chain-invalid-resume'),/saved quiescence and authority|supports only live/);assert.deepEqual(allocationCounts(f),before);assert.equal(f.store.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(child.id).checkpoint_invocation_json,bytes);assert.equal(f.branches.claimScript('invalid-chain'),undefined);
});
for(const mode of ['async','sync'])test(`current EXIT hold ${mode} repeated genuine interruption survives reopen`,async t=>{
 const {f,a}=await closedExitChild(t,mode),root=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'legal-chain');await f.branches.unitSaver.drain();
 const child=f.store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(root.id);let hold=f.branches.execution(child.id).checkpointInvocation;
 await f.reopen();resumeExitChild(f,child.id,hold,'legal-first');const lease=await f.claim();assert.equal(lease.executionId,child.id);assert.ok(lease.source.includes('leaf2'));assert.equal(lease.fence,1);f.settle(lease);await f.branches.unitSaver.completeExits();
 hold=await interruptExitChild(f,child.id,'legal-second');await f.reopen();resumeExitChild(f,child.id,hold,'legal-second-resume');await f.finish(root.id);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='child_completed'").get(root.id).n,1);
});

for(const mode of ['async','sync'])test(`current EXIT hold ${mode} missing mutable interruption cannot auto resume`,async t=>{
 const {f,a}=await closedExitChild(t,mode),root=f.branches.rewindHistorical(f.root.id,f.source.id,a.id,a.contentHash,'no-auto-resume');await f.branches.unitSaver.drain();
 const child=f.store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(root.id);
 for(let n=0;n<4;n++){f.branches.advance();assert.equal(f.branches.claimScript('genuine-held'),undefined);await f.branches.unitSaver.drain();}
 f.store.sqlite.prepare("UPDATE branch_executions SET checkpoint_invocation_json=json_remove(checkpoint_invocation_json,'$.interruptionId') WHERE id=?").run(child.id);
 await f.reopen();const before=allocationCounts(f),bytes=f.store.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(child.id).checkpoint_invocation_json;
 for(let n=0;n<4;n++){f.branches.advance();assert.equal(f.branches.claimScript('no-auto-held'),undefined);await f.branches.unitSaver.drain();}
 assert.deepEqual(allocationCounts(f),before);assert.equal(f.store.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(child.id).checkpoint_invocation_json,bytes);
});
