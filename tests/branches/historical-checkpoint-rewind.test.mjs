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
function fixture(t,mode='async',loop=false,secret=false,exitHistory=false){
 const dir=mkdtempSync(join(tmpdir(),'historical-rewind-'));let store,branches;
 const open=()=>{store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));};open();
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'History',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'History'});
 const definition={schema:'ponderosa.branch.v1',name:'Historical',trigger:{kind:'manual'},entry:'a',steps:['a','b'].map(id=>({id,kind:'script',runtime:'node',source:`// ${id} never executed`,cwdRef:'root',timeoutMs:5000})),controls:[{id:'c',kind:'condition',predicate:{source:'input',equals:'prefix'},otherwise:'b'}],edges:[{id:'a-c',from:'a',to:'c',on:'success'},{id:'yes',from:'c',to:loop?'a':'b',on:'selected',...(loop?{loop:true}:{})},{id:'no',from:'c',to:'b',on:'failure'}],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}},...(secret?{parameters:{private:{type:'secret'}}}:{})};
 if(exitHistory){definition.steps.push({id:'d',kind:'script',runtime:'node',source:'// d never executed',cwdRef:'root',timeoutMs:5000});definition.edges.push({id:'b-d',from:'b',to:'d',on:'success'});}
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


const inertIdentity={pid:2147483647,pgid:2147483647,birthMarker:'controlled-no-process'};
const captureBytes=(f,id)=>JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(id).snapshot_json);
async function exitCut(t,loop=false,settle=true){
 const f=fixture(t,'exit',loop,false,true);
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
