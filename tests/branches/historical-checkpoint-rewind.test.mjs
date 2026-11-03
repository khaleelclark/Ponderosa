import {CoordinationV3DestinationAdmissionAuthority} from '../../packages/agents/dist/coordination-v3-destination-admission-authority.js';
import {commitDestinationHistoricalPartition,verifyDestinationHistoricalPartition} from '../../packages/agents/dist/coordination-v3-historical-partition.js';
import {generationExitHeld} from '../../packages/agents/dist/index.js';
import {encodeScriptContinuation} from '../../packages/agents/dist/branch-script-continuation.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {CAPABILITY_IDS} from '../../packages/core/dist/index.js';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store,CapabilityPolicyStore,stableJson,readIssuedResourceContinuation,reconstructIssuedResourceContinuation,issuedResourceContinuationSupported,readDestinationHistoricalPartition,destinationHistoricalFacts} from '../../packages/agents/dist/index.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
// Raw delete/reinsert models storage corruption while retaining the UPDATE immutability guard.
function corruptCheckpoint(db,id,bytes,digest){
 const row=db.prepare('SELECT * FROM branch_unit_snapshots WHERE id=?').get(id);assert.ok(row);
 assert.throws(()=>db.prepare('UPDATE branch_unit_snapshots SET content_hash=? WHERE id=?').run(digest,id),/immutable/);
 db.transaction(()=>{db.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(id);db.prepare('INSERT INTO branch_unit_snapshots(id,execution_id,snapshot_json,content_hash) VALUES(?,?,?,?)').run(id,row.execution_id,bytes,digest);})();
}

function fixture(t,mode='async',loop=false,secret=false,exitHistory=false,chainHistory=false,sharedState=false){
 const dir=mkdtempSync(join(tmpdir(),'historical-rewind-'));let store,branches;
 const open=()=>{store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));};open();
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'History',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'History'});
 const definition={schema:'ponderosa.branch.v1',name:'Historical',trigger:{kind:'manual'},entry:'a',steps:['a','b'].map(id=>({id,kind:'script',runtime:'node',source:`// ${id} never executed`,cwdRef:'root',timeoutMs:5000})),controls:[{id:'c',kind:'condition',predicate:{source:'input',equals:'prefix'},otherwise:'b'}],edges:[{id:'a-c',from:'a',to:'c',on:'success'},{id:'yes',from:'c',to:loop?'a':'b',on:'selected',...(loop?{loop:true}:{})},{id:'no',from:'c',to:'b',on:'failure'}],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}},...(secret?{parameters:{private:{type:'secret'}}}:{})};
 if(exitHistory){definition.steps.push({id:'d',kind:'script',runtime:'node',source:'// d never executed',cwdRef:'root',timeoutMs:5000});definition.edges.push({id:'b-d',from:'b',to:'d',on:'success'});}
 if(chainHistory){definition.steps.push(...['e','f'].map(id=>({id,kind:'script',runtime:'node',source:`// ${id} never executed`,cwdRef:'root',timeoutMs:5000})));definition.edges.push({id:'d-e',from:'d',to:'e',on:'success'},{id:'e-f',from:'e',to:'f',on:'success'});}
 if(sharedState){definition.state={total:{initial:0,reducer:'sum'},notes:{initial:[],reducer:'append'},phase:{initial:'new',reducer:'replace'}};for(const step of definition.steps)step.stateWrites=['total','notes','phase'];definition.controls[0].predicate.equals=JSON.stringify({total:2,notes:['prefix'],phase:'prefix'});}
 if(sharedState==='parallel'){
  definition.entry='fork';definition.steps.push({id:'reduce',kind:'script',runtime:'node',source:'// custom aggregate never executed',cwdRef:'root',timeoutMs:5000,stateWrites:['phase']});
  definition.controls=[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['a-arm','b-arm']}];
  definition.edges=[{id:'a-arm',from:'fork',to:'a',on:'selected'},{id:'b-arm',from:'fork',to:'b',on:'selected'},{id:'a-join',from:'a',to:'join',on:'success'},{id:'b-join',from:'b',to:'join',on:'success'},{id:'reduce-edge',from:'join',to:'reduce',on:'success'}];
 }

 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{},directories:{root:dir}}});
 branches.configure(branch.id,{...branches.configuration(branch.id),checkpointMode:mode,...(secret?{secretBindings:{private:'opaque-never-embed'}}:{})},0);
 const source=branches.accept(branch.id,'source','input');
 const claim=async()=>{let lease;for(let n=0;n<16&&!lease;n++){await branches.unitSaver.drain();branches.advance();lease=branches.claimScript('inert');}assert.ok(lease);await branches.unitSaver.drain();assert.equal(branches.checkpointDispatch(lease),'ready');if(sharedState)branches.authorizeScript(lease,{pid:818181,pgid:818181,birthMarker:'inert-shared-state'});return lease;};
 return {get store(){return store},get branches(){return branches},branch,source,definition,dir,claim,
  settleState(lease,result){branches.recordScriptEvidence(lease,{pid:818181,pgid:818181,birthMarker:'inert-shared-state'},{stdout:result.output??'',outputHash:hash(result.output??''),code:result.failed?1:0,...(result.failed?{error:result.output}:{})});branches.settleScript(lease,result);},
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
 registerBranchRoutes(app,{resources:{async verifyHistoricalCustody(){}},branches:f.branches,store:f.store,installations:{setPublisher(){}},notify(){notified++;assert.ok(f.store.sqlite.prepare("SELECT 1 FROM branch_unit_snapshots WHERE json_extract(snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1'").get());}});
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
 registerBranchRoutes(app,{resources:{async verifyHistoricalCustody(){}},branches:f.branches,store:f.store,installations:{setPublisher(){}},notify(){notifications++;assert.equal(f.store.sqlite.inTransaction,false);}});
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
 const point=id=>branches.historicalCheckpoints(root.id,id).find(cp=>cp.restoreSupported&&captureBytes({store},cp.id).continuation?.schema==='ponderosa.branch.script-tree-continuation.v1'&&captureBytes({store},cp.id).continuation.owners.length===(nested?3:2)&&captureBytes({store},cp.id).continuation.owners.filter(o=>o.executionId!==id).every(o=>o.selected.execution[0].state==='completed'));
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

// Resource replay stops before any external Chat/import release; suffix work uses fresh custody.
// Deferred real Branch/call/resource/import/Request source; custody and Script authority remain inert.
async function openCalledTreeResource(store,branches,dir,executionId,branchId){
 let r;for(let n=0;n<40;n++){branches.advance();await branches.unitSaver.drain();r=store.sqlite.prepare("SELECT * FROM branch_resources WHERE execution_id=? AND state='reserved'").get(executionId);if(r)break;}assert.ok(r);
 for(let n=0;n<6&&branches.resourceRelease(r.step_execution_id)!=='ready';n++){await branches.unitSaver.drain();branches.advance();}
 const chatToken=branches.beginResourceOperation(r.step_execution_id,r.creation_key,'chat');await branches.unitSaver.drain();assert.equal(branches.releaseResourceChat(r.step_execution_id,r.creation_key,chatToken),true);
 const p=store.createProject({label:'Called issued source',hostPath:dir,defaultEngine:'codex',chatOwned:true,branchId,executionId}),chat=store.getConversation(p.lastConversationId);
 branches.completeResourceOperation(r.step_execution_id,'chat',chatToken,{chatId:chat.id});await branches.unitSaver.drain();
 const token=branches.beginResourceOperation(r.step_execution_id,r.creation_key,'import');await branches.unitSaver.drain();
 const op=store.beginAgentCreationOperation({projectId:p.id,conversationId:chat.id,actorScope:'inert-called-source',kind:'import',idempotencyKey:r.creation_key,payloadHash:'inert'}).operation,id=randomUUID();
 store.addAgentCreationOperationMember(op.id,id,0);branches.observeResourceImportPlan(r.step_execution_id,token,op.id);await branches.unitSaver.drain();branches.planResource(r.step_execution_id,[id],token);
 store.createAgent(p.id,{title:'Called source',engine:'codex',conversationId:chat.id},undefined,id);
 const result={rootAgentId:id,agentIds:[id],agentRefs:{worker:id}};
 branches.unitTransaction(()=>{store.updateAgentCreationOperation(op.id,{status:'completed',result});branches.completeResourceOperation(r.step_execution_id,'import',token,result);})();await branches.unitSaver.drain();
 if(branches.resourceCaptureEligible(r.step_execution_id)){const source=branches.reserveResourceCapture(r.step_execution_id),receipt={...source,version:1,custodyId:hash(source.checkpointId),boundaryId:'inert-called-opening',sha256:hash('opening'),byteLength:1};branches.finishResourceCapture(source,receipt);await branches.unitSaver.drain();}
 branches.bindResource(r.step_execution_id,result);await branches.unitSaver.drain();
 return {requestId:store.sqlite.prepare('SELECT request_id FROM branch_attempts WHERE step_execution_id=? ORDER BY number DESC LIMIT 1').get(r.step_execution_id).request_id,agentId:id,chatId:chat.id,stepId:r.step_execution_id};
}
async function reservationHistoryFixture(t,mode='async',childOwner=false,parallel=false,freshRetry=false,twoResources=false,calledResources=false,stateful=false){
 const dir=mkdtempSync(join(tmpdir(),'resource-history-'));let store,branches,coordination;
 const open=()=>{store=new AgentStore(dir);coordination=new CoordinationV3Store(store.sqlite);branches=new BranchStore(store.sqlite,coordination);};open();
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Inert resource history',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Owner'}),permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
 const template={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Worker',rootRef:'worker',agents:[{ref:'worker',title:'Worker',engine:'codex',managementPermissions:permissions}]};
 const script=id=>({id,kind:'script',runtime:'node',source:`// resource ${id} never executed`,cwdRef:'root',timeoutMs:5000});
 const count=typeof twoResources==='number'?twoResources:twoResources?2:1;
 const teams=Array.from({length:parallel==='map'?1:count},(_,i)=>i?`team${i+1}`:'team');
 const resourceSteps=teams.map((id,i)=>({id,...(stateful?{stateWrites:['count']}:{}),kind:'agent',target:{kind:'ephemeral_organization',templateRef:'team'},instructions:i?'Additional inert local result':'Inert local result',...(freshRetry?{failure:{action:'retry',maxAttempts:typeof freshRetry==='number'?freshRetry:2,delayMs:0,freshContext:true}}:{})}));
 const arms=teams.map(id=>`${id}-arm`);
 const controls=parallel==='map'?[{id:'fork',kind:'map',joinId:'join',workerId:'team',source:'lines',maxItems:count,maxConcurrentItems:count},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:[]}]:parallel?[{id:'fork',kind:'fork',joinId:'join'},{id:'side',kind:'condition',predicate:{source:'input',equals:'known'},otherwise:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:[...arms,'side-arm']}]:[];
 const edges=parallel==='map'?[{id:'to-fork',from:'prefix',to:'fork',on:'success'},{id:'team-arm',from:'fork',to:'team',on:'selected'},{id:'team-join',from:'team',to:'join',on:'success'},{id:'join-suffix',from:'join',to:'suffix',on:'success'}]:parallel?[{id:'to-fork',from:'prefix',to:'fork',on:'success'},...teams.flatMap((id,i)=>[{id:arms[i],from:'fork',to:id,on:'selected'},{id:`${id}-join`,from:id,to:'join',on:'success'}]),{id:'side-arm',from:'fork',to:'side',on:'selected'},{id:'side-join',from:'side',to:'join',on:'selected'},{id:'side-fallback',from:'side',to:'join',on:'failure'},{id:'join-suffix',from:'join',to:'suffix',on:'success'}]:[{id:'to-team',from:'prefix',to:'team',on:'success'},...teams.map((id,i)=>({id:`${id}-next`,from:id,to:teams[i+1]??'suffix',on:'success'}))];
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'resource-history',definition:{...(stateful?{state:{count:{initial:0,reducer:'sum'}}}:{}),schema:'ponderosa.branch.v1',name:'Resource history',trigger:{kind:'manual'},entry:'prefix',templates:{team:template},steps:[script('prefix'),...resourceSteps,script('suffix')],controls,edges,policy:{maxConcurrentExecutions:8,maxEphemeralAgents:Math.max(2,count),failure:{action:'stop'}}},bindings:{agents:{},directories:{root:dir,workspace:dir},engines:{codex:'codex'}}});
 if(mode!=='async')branches.configure(branch.id,{...branches.configuration(branch.id),checkpointMode:mode},0);
 let parent,root,source;
 if(childOwner){
  parent=branches.deploy({chatId:chat.id,idempotencyKey:'resource-parent',definition:{schema:'ponderosa.branch.v1',name:'Resource parent',trigger:{kind:'manual'},entry:calledResources?'team':'call',...(calledResources?{templates:{team:template}}:{}),steps:[...(calledResources?[resourceSteps[0]]:[]),{id:'call',kind:'branch_call',branchRef:'resource'}],controls:[],edges:calledResources?[{id:'team-call',from:'team',to:'call',on:'success'}]:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:dir,...(calledResources?{workspace:dir}:{})},...(calledResources?{engines:{codex:'codex'}}:{}),branches:{resource:branch.id}}});
  if(calledResources&&mode!=='async')branches.configure(parent.id,{...branches.configuration(parent.id),checkpointMode:mode},0);
  root=branches.accept(parent.id,'resource-root','input');
  if(calledResources){const issued=await openCalledTreeResource(store,branches,dir,root.id,parent.id);coordination.updateRequest({requestId:issued.requestId,updateId:'called-root-result',kind:'completed',actor:{kind:'agent',id:issued.agentId},payload:{text:'known'}});}
  for(let n=0;n<30&&!source;n++){branches.advance();await branches.unitSaver.drain();const child=store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(root.id);if(child)source=branches.execution(child.id);}
  assert.ok(source,'canonical Branch call admits the resource owner');
 }else source=branches.accept(branch.id,'resource-source','input');
 const claim=async()=>{for(let n=0;n<60;n++){await branches.unitSaver.drain();branches.advance();const lease=branches.claimScript('resource-inert');if(lease){await branches.unitSaver.drain();assert.equal(branches.checkpointDispatch(lease),'ready');return lease;}}assert.fail('expected resource Script lease');};
 const settle=lease=>{const output=parallel==='map'&&lease.source.includes('prefix')?Array.from({length:count},()=> 'known').join('\n'):'known';branches.authorizeScript(lease,inertIdentity);branches.recordScriptEvidence(lease,inertIdentity,{stdout:output,outputHash:hash(output),code:0});branches.settleScript(lease,{failed:false,output});};
 const reservation=id=>store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(id);
 const advance=async id=>{for(let n=0;n<30;n++){await branches.unitSaver.drain();branches.advance();if(reservation(id)&&branches.execution(id).state==='waiting')break;}await branches.unitSaver.drain();assert.ok(reservation(id));};
 const capture=async id=>{if(mode==='exit'){const inv=branches.execution(id).checkpointInvocation;assert.doesNotThrow(()=>branches.checkpointInterruption(branch.id,id,'interrupt',inv.id,`close-${id}`),'actual resource EXIT interruption must be supported');await branches.unitSaver.completeExits();}return branches.historicalCheckpoints(branch.id,id).find(c=>c.restoreSupported&&captureBytes({store},c.id).selected.resources.length===1);};
 const resume=id=>{if(mode==='exit'){const inv=branches.execution(id).checkpointInvocation;branches.checkpointInterruption(branch.id,id,'resume',inv.interruptionId,`resume-${id}`);}};
 const finish=async(id,onCaptured,onIssued,onOpening)=>{
  await advance(id);for(let n=0;n<6&&branches.resourceRelease(reservation(id).step_execution_id)!=='ready';n++){await branches.unitSaver.drain();branches.advance();}
  const r=reservation(id),chatToken=branches.beginResourceOperation(r.step_execution_id,r.creation_key,'chat');assert.ok(chatToken);await branches.unitSaver.drain();assert.equal(branches.releaseResourceChat(r.step_execution_id,r.creation_key,chatToken),true);
  const p=store.createProject({label:'Inert owned resource',hostPath:dir,defaultEngine:'codex',chatOwned:true,branchId:branch.id,executionId:id}),temporary=store.getConversation(p.lastConversationId);
  branches.completeResourceOperation(r.step_execution_id,'chat',chatToken,{chatId:temporary.id});await branches.unitSaver.drain();
  const token=branches.beginResourceOperation(r.step_execution_id,r.creation_key,'import');assert.ok(token);await branches.unitSaver.drain();
  const operation=store.beginAgentCreationOperation({projectId:p.id,conversationId:temporary.id,actorScope:'resource-history-inert',kind:'import',idempotencyKey:r.creation_key,payloadHash:'inert'}).operation,agentId=randomUUID();store.addAgentCreationOperationMember(operation.id,agentId,0);
  branches.observeResourceImportPlan(r.step_execution_id,token,operation.id);await branches.unitSaver.drain();branches.planResource(r.step_execution_id,[agentId],token);
  const agent=store.createAgent(p.id,{title:'Inert fixture identity',engine:'codex',conversationId:temporary.id},undefined,agentId),result={rootAgentId:agent.id,agentIds:[agent.id]};
  branches.unitTransaction(()=>{branches.completeResourceOperation(r.step_execution_id,'import',token,result);store.updateAgentCreationOperation(operation.id,{status:'completed',result});})();await branches.unitSaver.drain();
  if(!parallel){
  const captureSource=branches.reserveResourceCapture(r.step_execution_id),captureReceipt={...captureSource,version:1,custodyId:hash(captureSource.checkpointId),boundaryId:'inert-capture-boundary',sha256:hash('inert-package'),byteLength:1};
  assert.throws(()=>branches.bindResource(r.step_execution_id,result),/retained|coverage/);
  branches.finishResourceCapture(captureSource,captureReceipt);await branches.unitSaver.drain();
  if(onCaptured)await onCaptured({source:captureSource,receipt:captureReceipt,result,stepId:r.step_execution_id});
  }
  branches.bindResource(r.step_execution_id,result);
  const request=store.sqlite.prepare('SELECT request_id FROM branch_attempts WHERE step_execution_id=?').get(r.step_execution_id).request_id;
  if(onOpening)await onOpening({stepId:r.step_execution_id,generation:r.generation,requestId:request});
  coordination.updateRequest({requestId:request,updateId:`result-${id}`,kind:'completed',actor:{kind:'agent',id:agent.id},payload:{text:'known resource result'}});
  const suffix=await claim();assert.equal(suffix.executionId,id);assert.ok(suffix.source.includes('suffix'));assert.equal(suffix.fence,1);settle(suffix);await branches.unitSaver.drain();
  if(onIssued)await onIssued({stepId:r.step_execution_id,generation:r.generation,agentId:agent.id,chatId:temporary.id});
  const preview=store.previewAgentDeletion([agent.id]);store.deleteAgentSubtrees([agent.id],preview.previewHash,x=>coordination.handleAgentDeletion(x));
  const receipt=store.commitConversationDeletion(temporary.id);store.finishConversationDeletionStorageCleanup(receipt);store.markConversationDeletionServerCleanupComplete(temporary.id);branches.resourceRetired(r.step_execution_id);await branches.unitSaver.drain();assert.equal(branches.execution(id).state,'completed');
  return {chatId:temporary.id,agentId,chatToken,token,deletionPreviewHash:preview.previewHash};
 };
 return {get store(){return store},get branches(){return branches},branch,parent,root,source,claim,settle,reservation,advance,capture,resume,finish,async reopen(){await branches.unitSaver.drain();store.close();open();}};
}
for(const mode of ['async','sync','exit'])test(`resource reservation ${mode} executable A and restored B with fresh custody`,async t=>{
 const f=await reservationHistoryFixture(t,mode),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);const a=await f.capture(f.source.id);assert.ok(a,'actual resource reservation unit must be executable');
 const snapshot=captureBytes(f,a.id);f.resume(f.source.id);const sourceEffects=await f.finish(f.source.id);
 const first=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'resource-A');await f.advance(first.id);const b=await f.capture(first.id);assert.ok(b,'restored reservation must yield second executable capture');
 const line=JSON.parse(f.store.sqlite.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.tree-rewind-lineage.v1'").get(first.id).snapshot_json),sourceIds=[f.source.id,...['paths','steps','attempts','sealedResults'].flatMap(k=>snapshot.selected[k].map(r=>r.id))];
 assert.deepEqual(Object.keys(line.idMap).sort(),sourceIds.sort());assert.equal(new Set(Object.values(line.idMap)).size,sourceIds.length);assert.equal(Object.values(line.idMap).every(id=>!sourceIds.includes(id)),true);assert.equal(line.idMap[f.source.id],first.id);
 for(const result of snapshot.selected.sealedResults){const current=f.store.sqlite.prepare('SELECT execution_id,result_json,content_hash FROM branch_sealed_results WHERE id=?').get(line.idMap[result.id]);assert.deepEqual(current,{execution_id:first.id,result_json:result.result_json,content_hash:result.content_hash});}
 assert.notEqual(f.reservation(first.id).step_execution_id,snapshot.selected.resources[0].step_execution_id);assert.notEqual(f.reservation(first.id).creation_key,snapshot.selected.resources[0].creation_key);
 for(const a of f.branches.detail(first.id).attempts){assert.equal(a.fence,0);const row=f.store.sqlite.prepare('SELECT lease_owner,lease_until,process_identity_json FROM branch_attempts WHERE id=?').get(a.id);assert.deepEqual(row,{lease_owner:null,lease_until:null,process_identity_json:null});}
 f.resume(first.id);const firstEffects=await f.finish(first.id);assert.notEqual(firstEffects.agentId,sourceEffects.agentId);assert.notEqual(firstEffects.chatId,sourceEffects.chatId);assert.notEqual(firstEffects.token,sourceEffects.token);
 const second=f.branches.rewindHistorical(f.branch.id,first.id,b.id,b.contentHash,'resource-B');await f.advance(second.id);const secondEffects=await f.finish(second.id);assert.notEqual(secondEffects.token,firstEffects.token);assert.notEqual(secondEffects.agentId,firstEffects.agentId);await f.reopen();const counts=allocationCounts(f);assert.equal(f.branches.rewindHistorical(f.branch.id,first.id,b.id,b.contentHash,'resource-B').id,second.id);assert.deepEqual(allocationCounts(f),counts);
 const db=f.store.sqlite,target=f.reservation(second.id),attempt=db.prepare('SELECT * FROM branch_attempts WHERE step_execution_id=?').get(target.step_execution_id),request=db.prepare('SELECT * FROM coordination_requests WHERE id=?').get(attempt.request_id);
 for(const corrupt of [
  ()=>db.prepare('UPDATE branch_attempts SET request_id=? WHERE id=?').run('foreign-opening',attempt.id),
  ()=>db.prepare('UPDATE coordination_requests SET payload_json=? WHERE id=?').run(stableJson({...JSON.parse(request.payload_json),input:'foreign restored input'}),request.id),
  ()=>db.prepare("DELETE FROM branch_checkpoints WHERE execution_id=? AND transition_key=?").run(second.id,`resource-bound:${target.step_execution_id}:${target.generation}`),
  ()=>db.prepare("UPDATE coordination_idempotency SET result_json=? WHERE project_id=? AND actor_scope=? AND operation='coordinate' AND idempotency_key=?").run(stableJson({requestIds:['foreign-opening']}),request.project_id,`branch:${second.id}`,attempt.id),
 ])assert.throws(()=>db.transaction(()=>{corrupt();assert.throws(()=>f.branches.rewindHistorical(f.branch.id,first.id,b.id,b.contentHash,'resource-B'),/Tree mapped attempt ownership failure/);assert.deepEqual(allocationCounts(f),counts);throw Error('restore opening proof');})(),/restore opening proof/);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_step_executions WHERE execution_id=? AND step_id='prefix'").get(second.id).n,1);assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});
async function completedReservationHistory(t,mode='async'){
 const f=await reservationHistoryFixture(t,mode),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);const a=await f.capture(f.source.id);assert.ok(a);f.resume(f.source.id);const effects=await f.finish(f.source.id);return {f,a,effects};
}
for(const mode of ['async','sync','exit'])for(const kind of ['policy','pins','cancel','gate','missingCoverage','missingLineage','wrongResourceKey'])test(`resource reservation ${mode} restored ${kind} refuses fresh authority`,async t=>{
 const {f,a}=await completedReservationHistory(t,mode),next=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'resource-authority');await f.advance(next.id);const r=f.reservation(next.id),db=f.store.sqlite;
 if(kind==='policy')new CapabilityPolicyStore(db).put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate]});
 if(kind==='pins')f.branches.configure(f.branch.id,{...f.branches.configuration(f.branch.id),limits:{...f.branches.configuration(f.branch.id).limits,maxTraversals:99}},mode==='async'?0:1);
 if(kind==='cancel')f.branches.cancel(next.id);
 if(kind==='missingCoverage')db.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(a.id);
 if(kind==='missingLineage')db.prepare("DELETE FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.tree-rewind-lineage.v1'").run(next.id);
 if(kind==='wrongResourceKey')db.prepare("UPDATE branch_resources SET creation_key='foreign-key' WHERE step_execution_id=?").run(r.step_execution_id);
 if(kind==='gate')f.branches.unitTransaction(()=>{const attempt=db.prepare('SELECT id FROM branch_attempts WHERE step_execution_id=?').get(r.step_execution_id);db.prepare("INSERT INTO branch_gates(id,step_execution_id,state,proposal_text,revision,purpose,attempt_id,prompt_text) VALUES(?,?,'waiting','',1,'approval',?,'Hold')").run(randomUUID(),r.step_execution_id,attempt.id);f.branches.selectedWrite(next.id);})();
 await f.branches.unitSaver.drain();const before=allocationCounts(f),inv=db.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(next.id).checkpoint_invocation_json;
 assert.notEqual(f.branches.resourceRelease(r.step_execution_id),'ready');assert.equal(f.branches.beginResourceOperation(r.step_execution_id,r.creation_key,'chat'),undefined);assert.deepEqual(allocationCounts(f),before);assert.equal(db.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(next.id).checkpoint_invocation_json,inv);assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_ephemeral_contexts WHERE step_execution_id=?').get(r.step_execution_id).n,0);
});
for(const kind of ['count','generation','foreignStep','resourceAudit','missingAudit','lease','result','counter'])test(`resource reservation ${kind} prefix corruption refuses without allocation`,async t=>{
 const {f,a}=await completedReservationHistory(t),cp=captureBytes(f,a.id),o=cp.continuation.owners[0],r=o.selected.resources[0];
 if(kind==='count')r.requested_count++;if(kind==='generation')r.generation++;if(kind==='foreignStep')r.step_execution_id='foreign-step';if(kind==='resourceAudit'){const audit=o.audit.find(a=>a.kind==='resource_reserved');audit.evidence_json=JSON.stringify({count:99,templateRef:r.template_ref});}if(kind==='missingAudit')o.audit=o.audit.filter(a=>a.kind!=='resource_reserved');if(kind==='lease')o.selected.attempts.find(a=>a.state==='prepared').fence=1;if(kind==='result')o.selected.sealedResults[0].content_hash='bad';if(kind==='counter')o.selected.execution[0].traversals++;
 cp.selected=o.selected;const {stableJson}=await import('../../packages/agents/dist/coordination-v3-canonical-json.js'),bytes=stableJson(cp),id=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,bytes,hash(bytes)).lastInsertRowid),before=allocationCounts(f);
 assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(c=>c.id===id).restoreSupported,false);assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,id,hash(bytes),'bad-resource-prefix'),/integrity unsupported/);assert.deepEqual(allocationCounts(f),before);
 if(kind==='generation'){
  r.creation_key=`branch-resource:${r.step_execution_id}:${r.generation}`;const forged=stableJson(cp),forgedId=Number(f.store.sqlite.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,forged,hash(forged)).lastInsertRowid),unchanged=allocationCounts(f);
  assert.equal(f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(c=>c.id===forgedId).restoreSupported,false);assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,forgedId,hash(forged),'bad-generation-and-key'),/integrity unsupported/);assert.deepEqual(allocationCounts(f),unchanged);
 }
});
for(const mode of ['async','sync','exit'])test(`resource reservation ${mode} unknown released Chat keeps custody and cannot rewind`,async t=>{
 const {f,a}=await completedReservationHistory(t,mode),next=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'resource-unknown');await f.advance(next.id);const b=await f.capture(next.id);assert.ok(b);f.resume(next.id);await f.branches.unitSaver.drain();const r=f.reservation(next.id),token=f.branches.beginResourceOperation(r.step_execution_id,r.creation_key,'chat');assert.ok(token);await f.branches.unitSaver.drain();assert.equal(f.branches.releaseResourceChat(r.step_execution_id,r.creation_key,token),true);
 f.branches.finishResourceOperation(r.step_execution_id,'chat',token,Error('inert uncertain Chat'));await f.branches.unitSaver.drain();const before=allocationCounts(f);assert.equal(f.branches.resourceOperation(r.step_execution_id,'chat').state,'unknown');assert.equal(f.branches.beginResourceOperation(r.step_execution_id,r.creation_key,'chat'),undefined);assert.equal(f.branches.resourceCanRetire(r.step_execution_id,[]),false);assert.throws(()=>f.branches.rewindHistorical(f.branch.id,next.id,b.id,b.contentHash,'unknown-resource'),/custody|settled/);assert.deepEqual(allocationCounts(f),before);assert.equal(f.branches.historicalCheckpoints(f.branch.id,next.id).filter(c=>c.restoreSupported).every(c=>captureBytes(f,c.id).selected.resources[0].chat_operation_json===null),true);
});
for(const kind of ['retirement','deletionReceipt','releasedUnknown'])test(`resource reservation source ${kind} custody refuses before restore`,async t=>{
 const {f,a,effects}=await completedReservationHistory(t),r=f.reservation(f.source.id),db=f.store.sqlite;
 if(kind==='retirement')db.prepare("UPDATE branch_resources SET state='active' WHERE step_execution_id=?").run(r.step_execution_id);
 if(kind==='deletionReceipt')db.prepare('UPDATE conversation_deletion_receipts SET server_cleanup_completed=0 WHERE conversation_id=?').run(effects.chatId);
 if(kind==='releasedUnknown')db.prepare("UPDATE branch_commands SET result_json=json_set(result_json,'$.state','unknown') WHERE execution_id=? AND command_key=?").run(f.source.id,`resource-operation:${r.creation_key}:chat`);
 const before=allocationCounts(f);assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'custody-refusal'),/custody/);assert.deepEqual(allocationCounts(f),before);
});
test('resource reservation allocation rollback preserves primary sealed result and no receipt',async t=>{
 const {f,a}=await completedReservationHistory(t),before=allocationCounts(f);f.store.sqlite.exec("CREATE TEMP TRIGGER fail_resource_restore BEFORE INSERT ON branch_resources BEGIN SELECT RAISE(ABORT,'resource restore failure'); END");
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'resource-rollback'),/resource restore failure/);await f.branches.unitSaver.drain();assert.deepEqual(allocationCounts(f),before);assert.equal(f.branches.detail(f.source.id).steps[0].result.failed,false);
});
for(const kind of ['resourceRow','chatReceipt','importReceipt','context'])test(`resource reservation source missing ${kind} refuses custody`,async t=>{
 const {f,a}=await completedReservationHistory(t),r=f.reservation(f.source.id),db=f.store.sqlite;
 if(kind==='resourceRow'){db.prepare('DELETE FROM branch_resource_members WHERE step_execution_id=?').run(r.step_execution_id);db.prepare('DELETE FROM branch_resources WHERE step_execution_id=?').run(r.step_execution_id);}
 else if(kind==='context')db.prepare('DELETE FROM branch_ephemeral_contexts WHERE step_execution_id=?').run(r.step_execution_id);
 else db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,`resource-operation:${r.creation_key}:${kind==='chatReceipt'?'chat':'import'}`);
 const before=allocationCounts(f);assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'missing-custody'),/custody/);assert.deepEqual(allocationCounts(f),before);
});
for(const kind of ['foreignChat','foreignAgent','changedReceipt'])test(`resource reservation restored ${kind} custody refuses current operation`,async t=>{
 const {f,a}=await completedReservationHistory(t),next=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'target-custody');await f.advance(next.id);const r=f.reservation(next.id),db=f.store.sqlite;
 if(kind==='foreignChat'){const p=f.store.createProject({label:'Foreign inert owner',hostPath:f.branches.localConfiguration(f.branch.id).directories.root,defaultEngine:'codex',chatOwned:true,branchId:f.branch.id,executionId:f.source.id});db.prepare('UPDATE branch_resources SET chat_id=? WHERE step_execution_id=?').run(p.lastConversationId,r.step_execution_id);}
 if(kind==='foreignAgent'){const agent=f.store.createAgent(f.store.getConversation(f.branch.chatId).projectId,{title:'Foreign inert fixture',engine:'codex',conversationId:f.branch.chatId});db.prepare("INSERT INTO branch_resource_members VALUES(?,?,'template')").run(agent.id,r.step_execution_id);}
 if(kind==='changedReceipt'){const token=f.branches.beginResourceOperation(r.step_execution_id,r.creation_key,'chat');assert.ok(token);await f.branches.unitSaver.drain();db.prepare("UPDATE branch_commands SET result_json=json_set(result_json,'$.token','foreign-token') WHERE execution_id=? AND command_key=?").run(next.id,`resource-operation:${r.creation_key}:chat`);}
 const before=allocationCounts(f);assert.equal(f.branches.resourceRelease(r.step_execution_id),'fenced');assert.equal(f.branches.beginResourceOperation(r.step_execution_id,r.creation_key,'chat'),undefined);assert.deepEqual(allocationCounts(f),before);
});

for(const mode of ['async','sync','exit'])for(const kind of ['empty-context-members','missing-source-member','incomplete-cleanup','missing-import-receipt'])test(`resource custody regression ${mode} ${kind} refuses before allocation`,async t=>{
 const {f,a,effects}=await completedReservationHistory(t,mode),db=f.store.sqlite,r=f.reservation(f.source.id);
 const immutableBytes=db.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(a.id).snapshot_json;
 const originalContext=db.prepare('SELECT * FROM branch_ephemeral_contexts WHERE step_execution_id=?').get(r.step_execution_id);
 const originalMembers=db.prepare('SELECT * FROM branch_resource_members WHERE step_execution_id=?').all(r.step_execution_id);
 if(kind==='empty-context-members')db.prepare("UPDATE branch_ephemeral_contexts SET agent_ids_json='[]' WHERE step_execution_id=? AND generation=?").run(r.step_execution_id,r.generation);
 if(kind==='missing-source-member')db.prepare('DELETE FROM branch_resource_members WHERE step_execution_id=?').run(r.step_execution_id);
 if(kind==='incomplete-cleanup')db.prepare('UPDATE conversation_deletion_receipts SET storage_cleanup_completed=0 WHERE conversation_id=?').run(effects.chatId);
 if(kind==='missing-import-receipt')db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,`resource-operation:${r.creation_key}:import`);
 await f.reopen();const current=f.store.sqlite,before=allocationCounts(f);let next,error,token,released;
 try{next=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'independent-custody');}catch(e){error=e.message;}
 const after=allocationCounts(f);
 if(next){await f.advance(next.id);const target=f.reservation(next.id);token=f.branches.beginResourceOperation(target.step_execution_id,target.creation_key,'chat');if(token){await f.branches.unitSaver.drain();released=f.branches.releaseResourceChat(target.step_execution_id,target.creation_key,token);}}
 console.log(JSON.stringify({mode,kind,accepted:!!next,error,before,after,originalContext,originalMembers,currentContext:current.prepare('SELECT * FROM branch_ephemeral_contexts WHERE step_execution_id=?').get(r.step_execution_id),currentMembers:current.prepare('SELECT * FROM branch_resource_members WHERE step_execution_id=?').all(r.step_execution_id),sourceImport:f.branches.resourceOperation(r.step_execution_id,'import'),nextId:next?.id,freshChatToken:token,actualChatRelease:released,immutableBytesUnchanged:immutableBytes===current.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(a.id).snapshot_json,knownSourcePrefix:f.branches.detail(f.source.id).steps[0].result}));
 assert.equal(!!next,false,'source custody identities must match actual owned phase result before rewind');assert.deepEqual(after,before);
});
for(const mode of ['async','sync','exit'])test(`resource custody regression ${mode} source context change after rewind fences next release`,async t=>{
 const {f,a}=await completedReservationHistory(t,mode),next=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'independent-postrewind');await f.advance(next.id);
 const source=f.reservation(f.source.id),target=f.reservation(next.id);assert.equal(f.branches.resourceRelease(target.step_execution_id),'ready','legitimate target ready before source corruption');f.store.sqlite.prepare("UPDATE branch_ephemeral_contexts SET agent_ids_json='[]' WHERE step_execution_id=?").run(source.step_execution_id);
 const before=allocationCounts(f),readiness=f.branches.resourceRelease(target.step_execution_id),token=f.branches.beginResourceOperation(target.step_execution_id,target.creation_key,'chat');let released;
 if(token){await f.branches.unitSaver.drain();released=f.branches.releaseResourceChat(target.step_execution_id,target.creation_key,token);}
 console.log(JSON.stringify({mode,kind:'postrewind-source-context',readiness,token,actualChatRelease:released,before,after:allocationCounts(f)}));
 assert.equal(token,undefined,'post-rewind source custody mismatch must fence fresh resource command');assert.deepEqual(allocationCounts(f),before);
});
for(const boundary of ['rewind','release'])for(const kind of ['duplicateContext','foreignContext','nonArrayContext','duplicateReceipt','foreignRoot','wrongCount','wrongGeneration','foreignChat','foreignCreation','missingMember','foreignMember','memberOrigin','liveAgent','runningCustody','leasedCustody'])test(`resource custody exact set ${boundary} ${kind}`,async t=>{
 const {f,a,effects}=await completedReservationHistory(t),db=f.store.sqlite,source=f.reservation(f.source.id);
 let target;
 if(boundary==='release'){const next=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'exact-set-target');await f.advance(next.id);target=f.reservation(next.id);assert.equal(f.branches.resourceRelease(target.step_execution_id),'ready');}
 const command=`resource-operation:${source.creation_key}:import`,mutateReceipt=change=>{const op=f.branches.resourceOperation(source.step_execution_id,'import');change(op);db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(JSON.stringify(op),f.source.id,command);};
 if(kind==='duplicateContext')db.prepare('UPDATE branch_ephemeral_contexts SET agent_ids_json=? WHERE step_execution_id=?').run(JSON.stringify([effects.agentId,effects.agentId]),source.step_execution_id);
 if(kind==='foreignContext'||kind==='nonArrayContext')db.prepare('UPDATE branch_ephemeral_contexts SET agent_ids_json=? WHERE step_execution_id=?').run(JSON.stringify(kind==='foreignContext'?[randomUUID()]:{}),source.step_execution_id);
 if(kind==='duplicateReceipt')mutateReceipt(op=>op.result.agentIds.push(effects.agentId));
 if(kind==='foreignRoot')db.prepare('UPDATE branch_resources SET root_agent_id=? WHERE step_execution_id=?').run(randomUUID(),source.step_execution_id);
 if(kind==='wrongCount')db.prepare('UPDATE branch_resources SET requested_count=requested_count+1 WHERE step_execution_id=?').run(source.step_execution_id);
 if(kind==='wrongGeneration')db.prepare('UPDATE branch_ephemeral_contexts SET generation=generation+1 WHERE step_execution_id=?').run(source.step_execution_id);
 if(kind==='foreignChat')db.prepare('UPDATE branch_ephemeral_contexts SET chat_id=? WHERE step_execution_id=?').run(f.branch.chatId,source.step_execution_id);
 if(kind==='foreignCreation')mutateReceipt(op=>op.creationOperationId=randomUUID());
 if(kind==='missingMember')db.prepare('DELETE FROM branch_resource_members WHERE step_execution_id=?').run(source.step_execution_id);
 if(kind==='foreignMember'){db.prepare('DELETE FROM branch_resource_members WHERE step_execution_id=?').run(source.step_execution_id);db.prepare("INSERT INTO branch_resource_members VALUES(?,?,'template')").run(randomUUID(),source.step_execution_id);}
 if(kind==='memberOrigin')db.prepare("UPDATE branch_resource_members SET origin='descendant' WHERE step_execution_id=?").run(source.step_execution_id);
 if(kind==='liveAgent')db.prepare('UPDATE agents SET deleted_at=NULL WHERE id=?').run(effects.agentId);
 if(kind==='runningCustody'||kind==='leasedCustody'){
  const now=new Date().toISOString();db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at) VALUES(?,?,?,?,'inert',?,1,'injected',?,?,?)").run(randomUUID(),f.store.getConversation(f.branch.chatId).projectId,effects.agentId,kind==='runningCustody'?'running':'leased',now,now,now,now);
 }
 const before=allocationCounts(f),invocation=f.store.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(f.source.id).checkpoint_invocation_json,checkpoint=db.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(a.id).snapshot_json;
 if(boundary==='rewind'){if(kind!=='liveAgent')await f.reopen();else assert.equal(f.store.sqlite.prepare('SELECT deleted_at FROM agents WHERE id=?').get(effects.agentId).deleted_at,null);assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'exact-set-refusal'),/custody/);}
 else{assert.equal(f.branches.resourceRelease(target.step_execution_id),'fenced');assert.equal(f.branches.beginResourceOperation(target.step_execution_id,target.creation_key,'chat'),undefined);}
 assert.deepEqual(allocationCounts(f),before);assert.equal(f.store.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(f.source.id).checkpoint_invocation_json,invocation);assert.equal(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(a.id).snapshot_json,checkpoint);assert.equal(f.branches.claimScript('must-not-dispatch'),undefined);
});
for(const mode of ['async','sync','exit'])test(`resource custody ${mode} settled reopen preserves A B and second rewind`,async t=>{
 const {f,a,effects}=await completedReservationHistory(t,mode);await f.reopen();
 const source=f.reservation(f.source.id),op=f.branches.resourceOperation(source.step_execution_id,'import');
 assert.deepEqual(op.result.agentIds,[effects.agentId]);assert.equal(op.result.rootAgentId,effects.agentId);
 const first=f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'custody-positive-A');await f.advance(first.id);const b=await f.capture(first.id);assert.ok(b);f.resume(first.id);const fresh=await f.finish(first.id);assert.notEqual(fresh.agentId,effects.agentId);await f.reopen();
 const second=f.branches.rewindHistorical(f.branch.id,first.id,b.id,b.contentHash,'custody-positive-B');await f.advance(second.id);const latest=await f.finish(second.id);assert.notEqual(latest.agentId,fresh.agentId);await f.reopen();const before=allocationCounts(f);assert.equal(f.branches.rewindHistorical(f.branch.id,first.id,b.id,b.contentHash,'custody-positive-B').id,second.id);assert.deepEqual(allocationCounts(f),before);
});
for(const kind of ['duplicateIds','emptyId','nonArrayIds','rootOutsideSet'])test(`resource custody malformed owned import ${kind} refuses before allocation`,async t=>{
 const {f,a}=await completedReservationHistory(t),db=f.store.sqlite,r=f.reservation(f.source.id),op=f.branches.resourceOperation(r.step_execution_id,'import');
 if(kind==='duplicateIds')op.result.agentIds.push(op.result.rootAgentId);
 if(kind==='emptyId')op.result.agentIds=[''];
 if(kind==='nonArrayIds')op.result.agentIds={};
 if(kind==='rootOutsideSet')op.result.rootAgentId=randomUUID();
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v,bytes=JSON.stringify(stable(op)),key=`resource-operation:${r.creation_key}:import`;
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(bytes,f.source.id,key);
 const event=db.prepare("SELECT id FROM branch_checkpoints WHERE execution_id=? AND kind='resource_operation' AND substr(transition_key,1,?)=? ORDER BY id DESC LIMIT 1").get(f.source.id,key.length+1,key+':');assert.ok(event);db.prepare('UPDATE branch_checkpoints SET evidence_json=? WHERE id=?').run(bytes,event.id);
 const before=allocationCounts(f),invocation=f.store.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(f.source.id).checkpoint_invocation_json;await f.reopen();assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,a.id,a.contentHash,'malformed-owned-import'),/custody/);assert.deepEqual(allocationCounts(f),before);assert.equal(f.store.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(f.source.id).checkpoint_invocation_json,invocation);assert.equal(f.branches.claimScript('must-not-dispatch'),undefined);
});

// Written for the consolidated implementation run; not executed in this source slice.
for(const mode of ['async','sync','exit'])test(`standalone human gate ${mode}: immutable review frontier recreates fresh gates and resumes with edited state`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'human-rewind-'));const store=new AgentStore(dir),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 t.after(async()=>{await branches.unitSaver.drain();store.close();rmSync(dir,{recursive:true,force:true});});
 const branch=branches.create('Review frontier',randomUUID());
 const definition={schema:'ponderosa.branch.v1',name:'Review frontier',trigger:{kind:'manual'},entry:'review',steps:[{id:'review',kind:'human_gate',prompt:'Review the supplied state',editable:true},{id:'next',kind:'human_gate',prompt:'Review again',editable:true}],controls:[],edges:[{id:'approved',from:'review',to:'next',on:'approved'}],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 branches.deploy({chatId:'',branchId:branch.id,expectedVersionId:'',idempotencyKey:randomUUID(),definition,bindings:{agents:{},directories:{}}});
 if(mode!=='async')branches.configure(branch.id,{...branches.configuration(branch.id),checkpointMode:mode},0);
 const source=branches.accept(branch.id,randomUUID(),'original state');
 for(let i=0;i<12&&!branches.detail(source.id).gates.length;i++){branches.advance();await branches.unitSaver.drain();}
 if(mode==='exit')await branches.unitSaver.completeExits();
 const originalGate=branches.detail(source.id).gates[0];assert.equal(originalGate.state,'waiting');
 const cp=branches.historicalCheckpoints(branch.id,source.id).find(c=>c.restoreSupported);assert.ok(cp,'Gate frontier is executable');
 assert.throws(()=>branches.rewindHistorical(branch.id,source.id,cp.id,cp.contentHash,'live-source'),/settled/);
 branches.cancel(source.id);for(let i=0;i<8&&branches.execution(source.id).state!=='canceled';i++){branches.advance();await branches.unitSaver.drain();}
 const next=branches.rewindHistorical(branch.id,source.id,cp.id,cp.contentHash,'review-again');
 assert.equal(branches.rewindHistorical(branch.id,source.id,cp.id,cp.contentHash,'review-again').id,next.id);
 const restored=branches.detail(next.id).gates[0];assert.notEqual(restored.id,originalGate.id);assert.equal(restored.state,'waiting');assert.equal(restored.proposal,'original state');
 assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM branch_gate_notifications WHERE gate_id=? AND state=\'pending\'').get(restored.id).n,1);
 assert.ok(branches.detail(next.id).attempts.every(a=>!a.requestId&&a.fence===0));
 for(let i=0;i<8&&branches.execution(next.id).state==='queued';i++){branches.advance();await branches.unitSaver.drain();}
 branches.resolveGate(restored.id,{commandKey:'edited',expectedRevision:0,decision:'approve',output:'edited state'});
 for(let i=0;i<12&&branches.detail(next.id).gates.length<2;i++){branches.advance();await branches.unitSaver.drain();}
 const second=branches.detail(next.id).gates.find(g=>g.id!==restored.id);assert.equal(second.proposal,'edited state');
 if(mode==='exit')await branches.unitSaver.completeExits();
 assert.ok(branches.historicalCheckpoints(branch.id,next.id).some(c=>c.restoreSupported),'A restored/resolved prefix remains checkpointable');
 assert.equal(branches.detail(source.id).gates[0].state,'canceled');
});

test('sync saved coverage survives saver reconstruction and rejects later external row changes',async t=>{
 const f=fixture(t,'sync');await f.prefix();
 const {BranchUnitSaver}=await import('../../packages/agents/dist/branch-unit-saver.js');
 const restarted=new BranchUnitSaver(f.store.sqlite);
 assert.equal(f.branches.unitSaver.ready(f.source.id,'sync'),true);
 assert.equal(restarted.ready(f.source.id,'sync'),true,'exact durable bytes recover readiness without a process-local ticket');
 const path=f.store.sqlite.prepare('SELECT id,input_text FROM branch_paths WHERE execution_id=?').get(f.source.id);
 // Bypass the owned unit to model another writer; never turn its rows into new coverage.
 f.store.sqlite.prepare('UPDATE branch_paths SET input_text=? WHERE id=?').run('foreign frontier',path.id);
 assert.equal(f.branches.unitSaver.ready(f.source.id,'sync'),false,'a saved ticket is not current coverage');
 assert.equal(restarted.ready(f.source.id,'sync'),false);
 f.store.sqlite.prepare('UPDATE branch_paths SET input_text=? WHERE id=?').run(path.input_text,path.id);
 assert.equal(restarted.ready(f.source.id,'sync'),true);
 const invocation=f.store.sqlite.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(f.source.id).checkpoint_invocation_json;
 f.store.sqlite.prepare("UPDATE branch_executions SET checkpoint_invocation_json=json_set(checkpoint_invocation_json,'$.id',?) WHERE id=?").run(randomUUID(),f.source.id);
 assert.equal(f.branches.unitSaver.ready(f.source.id,'sync'),false,'a ticket cannot cross invocation identities');
 assert.equal(restarted.ready(f.source.id,'sync'),false);
 f.store.sqlite.prepare('UPDATE branch_executions SET checkpoint_invocation_json=? WHERE id=?').run(invocation,f.source.id);
});

// Deferred source: the inert receipt exercises Branch ownership; server custody has its own byte tests.
for(const mode of ['async','sync','exit'])test(`prospective imported resource ${mode} cut rewinds with one fresh custody association`,async t=>{
 const f=await reservationHistoryFixture(t,mode),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);
 let checkpoint,retained;
 await f.finish(f.source.id,async c=>{
  retained=c;checkpoint=await f.capture(f.source.id);assert.ok(checkpoint);
  const saved=captureBytes(f,checkpoint.id),r=saved.selected.resources[0];
  assert.equal(JSON.parse(r.capture_json).receipt.custodyId,c.receipt.custodyId);assert.equal(r.root_agent_id,c.result.rootAgentId);
  assert.equal(saved.restore_supported,true);assert.equal(saved.hostDependencies.resourceMembers.length,1);
  assert.ok(saved.hostDependencies.resourceReceipts.some(x=>x.row.kind==='import'&&x.row.status==='completed'));
  assert.equal(f.branches.resourceCanRetire(c.stepId,c.result.agentIds),false);
  assert.throws(()=>f.branches.finishResourceCapture({...c.source,intent:{...c.source.intent,resourceGeneration:9}},c.receipt),/fenced/);
  f.resume(f.source.id);
 });
 const beforeFailure=allocationCounts(f);
 f.store.sqlite.exec("CREATE TRIGGER reject_resource_custody BEFORE INSERT ON branch_commands WHEN NEW.command_key LIKE 'resource-restore:%' BEGIN SELECT RAISE(ABORT,'resource custody insertion failed'); END");
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,checkpoint.id,checkpoint.contentHash,'rolled-back-resource'),/custody insertion failed/);
 assert.deepEqual(allocationCounts(f),beforeFailure);f.store.sqlite.exec('DROP TRIGGER reject_resource_custody');
 const fresh=f.branches.rewindHistorical(f.branch.id,f.source.id,checkpoint.id,checkpoint.contentHash,'retained-resource');
 const resource=f.reservation(fresh.id),journal=f.branches.resourceRestoreJournal(resource.step_execution_id);
 assert.deepEqual(journal.receipt,retained.receipt);assert.equal(journal.rootRef,retained.result.rootAgentId);
 assert.equal(resource.chat_id,null);assert.equal(resource.root_agent_id,null);assert.notEqual(resource.step_execution_id,retained.stepId);
 assert.equal(f.store.sqlite.prepare('SELECT request_id FROM branch_attempts WHERE step_execution_id=?').get(resource.step_execution_id).request_id,null);
 await f.branches.unitSaver.drain();const before=allocationCounts(f);await f.reopen();assert.equal(f.branches.rewindHistorical(f.branch.id,f.source.id,checkpoint.id,checkpoint.contentHash,'retained-resource').id,fresh.id);assert.deepEqual(allocationCounts(f),before);
 assert.ok(f.branches.custodyLifecycle.references(retained.source).some(ref=>ref.kind==='checkpoint'||ref.key.startsWith('resource-restore:')));
 assert.throws(()=>f.branches.resourceCaptureRelease(retained.stepId,'releasing'),/^Error: Checkpoint custody retains history\/admission references or unconfirmed owner cleanup$/);
 const inspection=f.branches.resourceInspection(retained.stepId);
 assert.throws(()=>f.branches.beginResourceCustodyRelease(retained.stepId,{commandKey:'referenced-release',expectedGeneration:inspection.generation,expectedCustodyId:inspection.custody.custodyId,expectedReceiptSha256:inspection.custody.receiptSha256}),/^Error: Checkpoint custody retains history\/admission references or unconfirmed owner cleanup$/);assert.deepEqual(allocationCounts(f),before);
});


test('final resource fence compares configuration values and rejects drift or malformed JSON',async t=>{
 const f=await reservationHistoryFixture(t),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);
 await assert.rejects(f.finish(f.source.id,undefined,async({stepId})=>{
  const db=f.store.sqlite,branch=db.prepare('SELECT configuration_json FROM branches WHERE id=?').get(f.branch.id);
  const execution=db.prepare('SELECT configuration_json FROM branch_executions WHERE id=?').get(f.source.id);
  const object=JSON.parse(branch.configuration_json),reordered=JSON.stringify(Object.fromEntries(Object.entries(object).sort(([a],[b])=>b.localeCompare(a))));
  db.prepare('UPDATE branches SET configuration_json=? WHERE id=?').run(reordered,f.branch.id);
  assert.notEqual(reordered,execution.configuration_json,'fixture exercises differing key order');
  const fence=f.branches.finalResourceExitFence(stepId);assert.ok(fence.intakeFence.sha256);
  db.prepare('UPDATE branches SET configuration_json=? WHERE id=?').run(JSON.stringify({...object,parameters:{...object.parameters,drift:true}}),f.branch.id);
  assert.throws(()=>f.branches.finalResourceExitFence(stepId),/configuration changed/);
  db.prepare('UPDATE branches SET configuration_json=? WHERE id=?').run('{malformed',f.branch.id);
  assert.throws(()=>f.branches.finalResourceExitFence(stepId));
  db.prepare('UPDATE branches SET configuration_json=? WHERE id=?').run(branch.configuration_json,f.branch.id);
  assert.deepEqual(f.branches.finalResourceExitFence(stepId),fence,'restored original configuration replays the same fence');
  throw Error('final fence regression complete');
 }),/final fence regression complete/);
});

// Deferred: source-only child custody, owner transaction rollback and restart readback.
for(const mode of ['async','sync'])test(`retained resource in ${mode} child owner rewinds under a fresh parent`,async t=>{
 const f=await reservationHistoryFixture(t,mode,true),prefix=await f.claim();
 assert.equal(prefix.executionId,f.source.id);f.settle(prefix);await f.advance(f.source.id);
 let checkpoint,retained;
 await f.finish(f.source.id,async c=>{
  retained=c;
  checkpoint=f.branches.historicalCheckpoints(f.parent.id,f.root.id).find(cp=>cp.restoreSupported&&captureBytes(f,cp.id).continuation?.owners.some(o=>o.executionId===f.source.id&&o.selected.resources[0]?.capture_json));
  assert.ok(checkpoint,'ancestor cut includes the exact retained child generation');
  const owners=captureBytes(f,checkpoint.id).continuation.owners;
  assert.equal(owners.length,2);assert.equal(owners.find(o=>o.executionId===f.source.id).selected.resources[0].root_agent_id,c.result.rootAgentId);
 });
 for(let n=0;n<20&&f.branches.execution(f.root.id).state!=='completed';n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(f.root.id).state,'completed');
 const before=allocationCounts(f);
 f.store.sqlite.exec("CREATE TRIGGER reject_child_custody BEFORE INSERT ON branch_commands WHEN NEW.command_key LIKE 'resource-restore:%' BEGIN SELECT RAISE(ABORT,'child custody insertion failed'); END");
 assert.throws(()=>f.branches.rewindHistorical(f.parent.id,f.root.id,checkpoint.id,checkpoint.contentHash,'child-rollback'),/child custody insertion failed/);
 assert.deepEqual(allocationCounts(f),before);f.store.sqlite.exec('DROP TRIGGER reject_child_custody');
 const next=f.branches.rewindHistorical(f.parent.id,f.root.id,checkpoint.id,checkpoint.contentHash,'child-custody');
 const child=f.store.sqlite.prepare('SELECT id FROM branch_executions WHERE parent_execution_id=?').get(next.id);
 assert.ok(child);assert.notEqual(child.id,f.source.id);
 const resource=f.reservation(child.id),journal=f.branches.resourceRestoreJournal(resource.step_execution_id);
 assert.deepEqual(journal.receipt,retained.receipt);assert.equal(journal.sourceStepId,retained.stepId);
 assert.equal(resource.chat_id,null);assert.equal(resource.root_agent_id,null);
 await f.reopen();const allocated=allocationCounts(f);
 assert.equal(f.branches.rewindHistorical(f.parent.id,f.root.id,checkpoint.id,checkpoint.contentHash,'child-custody').id,next.id);
 assert.deepEqual(allocationCounts(f),allocated);
 for(let n=0;n<20&&f.branches.resourceRelease(resource.step_execution_id)!=='ready';n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.resourceRelease(resource.step_execution_id),'ready','child release validates the mapped root receipt');
 await f.branches.unitSaver.drain();const readyCounts=allocationCounts(f);
 f.store.sqlite.prepare('UPDATE conversation_deletion_receipts SET storage_cleanup_completed=0 WHERE conversation_id=?').run(retained.source.sourceChatId);
 assert.equal(f.branches.resourceRelease(resource.step_execution_id),'fenced','ancestor readback checks child source cleanup');
 assert.throws(()=>f.branches.rewindHistorical(f.parent.id,f.root.id,checkpoint.id,checkpoint.contentHash,'child-new-command'),/custody/);
 assert.deepEqual(allocationCounts(f),readyCounts);
});

// Deferred public custody command invariants: no bytes are actually deleted by this mock engine.
test('resource custody release command survives response loss and never selects a later generation',async t=>{
 const f=await reservationHistoryFixture(t),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);
 let retained;const effects=await f.finish(f.source.id,async c=>{retained=c;});
 const cleanup=f.store.getAgentDeletionReceiptByPreviewHash(effects.deletionPreviewHash);assert.ok(cleanup);f.store.finishAgentDeletionStorageCleanup(cleanup);f.store.markAgentDeletionServerCleanupComplete(cleanup.id);
 const lifecycle=f.branches.custodyLifecycle,held=lifecycle.inspect(retained.source);assert.equal(held.releaseAllowed,false);
 const checkpoints=held.references.filter(ref=>ref.kind==='checkpoint').map(ref=>({id:Number(ref.key),sha256:ref.sha256}));assert.ok(checkpoints.length);
 lifecycle.retireCheckpoints(retained.source,{commandKey:'retire-opening-history-before-release',expectedRevision:held.revision,checkpoints});
 assert.equal(lifecycle.inspect(retained.source).references.filter(ref=>ref.kind!=='command'||!ref.key.startsWith('resource-capture:')).length,0);
 const before=f.store.sqlite.prepare('SELECT * FROM branch_commands ORDER BY execution_id,command_key').all();
 const inspection=f.branches.resourceInspection(retained.stepId);
 assert.equal(inspection.generation,retained.source.intent.resourceGeneration);
 assert.equal(inspection.destinationChatId,retained.source.sourceChatId);
 assert.equal(inspection.custody.custodyId,retained.receipt.custodyId);
 assert.deepEqual(f.branches.resourceInspection(retained.stepId),inspection);
 assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM branch_commands ORDER BY execution_id,command_key').all(),before,'pure inspection never stages a review or release');
 const input={commandKey:'release-original',expectedGeneration:inspection.generation,expectedCustodyId:inspection.custody.custodyId,expectedReceiptSha256:inspection.custody.receiptSha256};
 for(const changed of [{expectedGeneration:99},{expectedCustodyId:'e'.repeat(64)},{expectedReceiptSha256:'f'.repeat(64)}])assert.throws(()=>f.branches.beginResourceCustodyRelease(retained.stepId,{...input,...changed}),/changed/);
 assert.deepEqual(f.branches.resourceCustodyReleaseStatus(retained.stepId,'unknown'),{commandKey:'unknown',state:'not_found'});
 const {BranchResourceService}=await import('../../apps/server/dist/branch-resource-service.js');
 const create=()=>new BranchResourceService(f.branches,f.store,async()=>assert.fail('Agents'),async()=>assert.fail('Chat'),async()=>assert.fail('Chat'));
 let calls=0;
 const service=create();service.setPackageEngine({releaseCheckpoint:async receipt=>{calls++;assert.deepEqual(receipt,retained.receipt);throw Error('response lost after durable release');}});
 const lost=await service.releaseCapture(retained.stepId,input);assert.equal(lost.state,'releasing');assert.match(lost.error,/response lost/);
 const statusBefore=f.store.sqlite.prepare('SELECT * FROM branch_commands ORDER BY execution_id,command_key').all();
 assert.deepEqual(f.branches.resourceCustodyReleaseStatus(retained.stepId,input.commandKey),lost);
 assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM branch_commands ORDER BY execution_id,command_key').all(),statusBefore,'command inspection does not retry deletion');
 assert.throws(()=>f.branches.beginResourceCustodyRelease(retained.stepId,{...input,expectedGeneration:inspection.generation+1}),/conflict/);
 await f.reopen();
 const captureKey=`resource-capture:${f.reservation(f.source.id).creation_key}`,captureRow=f.store.sqlite.prepare('SELECT * FROM branch_commands WHERE execution_id=? AND command_key=?').get(f.source.id,captureKey);
 assert.throws(()=>f.store.sqlite.transaction(()=>{const changed=JSON.parse(captureRow.result_json);changed.source.checkpointId='foreign-original-capture';f.store.sqlite.prepare('UPDATE branch_commands SET input_hash=?,result_json=? WHERE execution_id=? AND command_key=?').run(hash(stableJson(changed.source)),stableJson(changed),f.source.id,captureKey);assert.throws(()=>f.branches.beginResourceCustodyRelease(retained.stepId,input),/^Error: Original resource custody release intent unavailable$/);assert.equal(calls,1);throw Error('restore original capture source');})(),/restore original capture source/);
 const pinKey='adversarial-new-original-custody-pin',pin=stableJson({receipt:retained.receipt});f.store.sqlite.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(f.source.id,pinKey,hash(pin),pin,new Date().toISOString());
 const pinned=allocationCounts(f);assert.throws(()=>f.branches.beginResourceCustodyRelease(retained.stepId,input),/^Error: Original resource custody release acquired conflicting references$/);assert.equal(calls,1);assert.deepEqual(allocationCounts(f),pinned);
 f.store.sqlite.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,pinKey);
 // A later generation must not redirect an existing command's byte ownership.
 f.store.sqlite.prepare('UPDATE branch_resources SET generation=generation+1,creation_key=? WHERE step_execution_id=?').run('later-generation',retained.stepId);
 const recovered=create();recovered.setPackageEngine({releaseCheckpoint:async receipt=>{calls++;assert.deepEqual(receipt,retained.receipt);}});
 assert.equal((await recovered.releaseCapture(retained.stepId,input)).state,'released');assert.equal(calls,2);
 assert.equal(f.branches.resourceInspection(retained.stepId).generation,inspection.generation+1);
 assert.equal(f.branches.resourceCustodyReleaseStatus(retained.stepId,input.commandKey).generation,inspection.generation);
 assert.equal((await recovered.releaseCapture(retained.stepId,input)).state,'released');assert.equal(calls,2,'finished command readback does not call byte release');
 assert.throws(()=>f.branches.beginResourceCustodyRelease(retained.stepId,{...input,commandKey:'new-stale-command'}),/changed/);
});

test('fresh resource access choice accepts a pure review and refuses a different current hash',async t=>{
 const f=await reservationHistoryFixture(t),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);
 let checkpoint;await f.finish(f.source.id,async()=>{checkpoint=await f.capture(f.source.id);assert.ok(checkpoint);});
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,checkpoint.id,checkpoint.contentHash,'pure-review-destination');await f.advance(next.id);
 const r=f.reservation(next.id),token=f.branches.beginResourceOperation(r.step_execution_id,r.creation_key,'chat');assert.ok(token);await f.branches.unitSaver.drain();
 assert.equal(f.branches.releaseResourceChat(r.step_execution_id,r.creation_key,token),true);
 const p=f.store.createProject({label:'Fresh pure review destination',hostPath:f.branches.localConfiguration(f.branch.id).directories.root,defaultEngine:'codex',chatOwned:true,branchId:f.branch.id,executionId:next.id});
 f.branches.completeResourceOperation(r.step_execution_id,'chat',token,{chatId:p.lastConversationId});await f.branches.unitSaver.drain();
 assert.equal(f.branches.resourceRestoreJournal(r.step_execution_id).review,undefined);
 const review={reviewSha256:'a'.repeat(64),source:[],destination:{restrictedCapabilityIds:[]}};
 assert.throws(()=>f.branches.resourceRestoreReview(r.step_execution_id,review,{action:'use_source',reviewSha256:'b'.repeat(64)}),/changed/);
 assert.doesNotThrow(()=>f.branches.resourceRestoreReview(r.step_execution_id,review,{action:'keep_destination',reviewSha256:review.reviewSha256}));
 assert.equal(f.branches.resourceRestoreJournal(r.step_execution_id).choice.reviewSha256,review.reviewSha256);
 const importToken=f.branches.beginResourceOperation(r.step_execution_id,r.creation_key,'import');assert.ok(importToken);
 assert.throws(()=>f.branches.resourceRestoreReview(r.step_execution_id,review,{action:'use_source',reviewSha256:review.reviewSha256}),/unavailable/);
});

// Deferred: actual Branch/resource/Request fixture, no provider execution.
test('issued resource seal binds later host facts and keeps ordinary rewind refused',async t=>{
 const f=await reservationHistoryFixture(t),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);
 let saved;
 await f.finish(f.source.id,undefined,async({stepId,generation})=>{
  const journal=f.branches.reserveIssuedResourceCapture(f.source.id,stepId,generation,'issued-cut');
  assert.equal(journal.source.intent.resourceStepId,stepId);assert.match(journal.source.intent.hostCutSha256,/^[a-f0-9]{64}$/);
  assert.equal(f.branches.resourceCanRetire(stepId,journal.source.agentIds),false);
  assert.throws(()=>f.branches.reserveIssuedResourceCapture(f.source.id,stepId,generation+1,'issued-cut'),/conflict/);
  const receipt={...journal.source,version:1,custodyId:hash(journal.source.checkpointId),boundaryId:'issued-inert-boundary',sha256:hash('later-issued-private-bytes'),byteLength:2};
  const db=f.store.sqlite,request=journal.snapshot.hostDependencies.requests[0].row,before=db.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n;
  db.prepare('UPDATE coordination_requests SET updated_at=? WHERE id=?').run('changed-after-intent',request.id);
  assert.throws(()=>db.transaction(()=>f.branches.sealIssuedResourceCapture(f.source.id,stepId,'issued-cut',receipt))(),/frontier changed/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_unit_snapshots').get().n,before);
  db.prepare('UPDATE coordination_requests SET updated_at=? WHERE id=?').run(request.updated_at,request.id);
  db.transaction(()=>f.branches.sealIssuedResourceCapture(f.source.id,stepId,'issued-cut',receipt))();
  saved=f.branches.issuedResourceCapture(f.source.id,stepId,'issued-cut');assert.equal(saved.state,'retained');assert.equal(saved.snapshot.restore_supported,false);
  const snapshot=JSON.parse(db.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(saved.checkpointId).snapshot_json);
  assert.equal(readIssuedResourceContinuation(db,f.source.id,saved.checkpointId,saved.checkpointHash).selected.paths[0].state,'completed','a completed path waiting only for resource cleanup retains executable evidence');
  assert.deepEqual(snapshot.issuedResourceCustody,receipt);assert.notEqual(receipt.sha256,JSON.parse(journal.snapshot.selected.resources[0].capture_json).receipt.sha256);
  const {BranchResourceService}=await import('../../apps/server/dist/branch-resource-service.js');
  const service=new BranchResourceService(f.branches,f.store,async()=>assert.fail('Agents'),async()=>assert.fail('Chat'),async()=>assert.fail('Chat'));
  await assert.rejects(service.verifyHistoricalCustody(f.source.id,saved.checkpointId,saved.checkpointHash),/package service unavailable/);
  const reads=[];service.setPackageEngine({readCheckpoint:async value=>{reads.push(value);return {};}});
  await service.verifyHistoricalCustody(f.source.id,saved.checkpointId,saved.checkpointHash);
  assert.deepEqual(reads,[receipt],'verify issued bytes, never the pre-opening package');
  service.setPackageEngine({readCheckpoint:async()=>{throw Error('issued bytes missing');}});
  await assert.rejects(service.verifyHistoricalCustody(f.source.id,saved.checkpointId,saved.checkpointHash),/issued bytes missing/);
  const sealedRow=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=?').get(saved.checkpointId);
  const changed=structuredClone(snapshot);changed.issuedResourceCustody.intent.hostCutSha256='a'.repeat(64);
  const substituted=stableJson(changed);
  corruptCheckpoint(db,saved.checkpointId,substituted,hash(substituted));
  service.setPackageEngine({readCheckpoint:async()=>assert.fail('mismatched host digest must refuse before package access')});
  await assert.rejects(service.verifyHistoricalCustody(f.source.id,saved.checkpointId,hash(substituted)),/exact retained host graph/);
  corruptCheckpoint(db,saved.checkpointId,sealedRow.snapshot_json,sealedRow.content_hash);
  service.setPackageEngine({readCheckpoint:async()=>{corruptCheckpoint(db,saved.checkpointId,sealedRow.snapshot_json,'f'.repeat(64));return {};}});
  await assert.rejects(service.verifyHistoricalCustody(f.source.id,saved.checkpointId,saved.checkpointHash),/changed during custody verification/);
  corruptCheckpoint(db,saved.checkpointId,sealedRow.snapshot_json,sealedRow.content_hash);
  assert.equal(f.branches.issuedResourceCapturePending(stepId),false);
  assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,saved.checkpointId,saved.checkpointHash,'not-admitted'),/unsupported|continuation|settled/);
 });
 await f.reopen();const replay=f.branches.issuedResourceCapture(f.source.id,saved.source.intent.resourceStepId,'issued-cut');assert.equal(replay.checkpointId,saved.checkpointId);assert.deepEqual(replay.receipt,saved.receipt);
});


// Deferred: capture an open resource Request, then validate its immutable prefix after source settlement/cleanup.
test('issued resource executable envelope replays original prefix and reconstructs explicit fresh identities',async t=>{
 const f=await reservationHistoryFixture(t),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);
 let saved,maps,destination,reconstructed;
 await f.finish(f.source.id,undefined,undefined,async({stepId,generation,requestId})=>{
  const journal=f.branches.reserveIssuedResourceCapture(f.source.id,stepId,generation,'executable-issued');
  const c=journal.snapshot.issuedContinuation;assert.equal(c.schema,'ponderosa.branch.issued-resource-continuation.v1');
  assert.equal(c.auditSha256,hash(stableJson(c.audit)));assert.ok(c.audit.some(e=>e.kind==='resource_created'));
  const receipt={...journal.source,version:1,custodyId:hash(journal.source.checkpointId),boundaryId:'executable-inert',sha256:hash('executable-private-package'),byteLength:2};
  const db=f.store.sqlite,last=c.audit.at(-1),changedTime='changed-during-capture';
  db.prepare('UPDATE branch_checkpoints SET created_at=? WHERE id=?').run(changedTime,last.id);
  assert.throws(()=>db.transaction(()=>f.branches.sealIssuedResourceCapture(f.source.id,stepId,'executable-issued',receipt))(),/continuation|audit|unsupported/);
  db.prepare('UPDATE branch_checkpoints SET created_at=? WHERE id=?').run(last.created_at,last.id);
  db.transaction(()=>f.branches.sealIssuedResourceCapture(f.source.id,stepId,'executable-issued',receipt))();
  saved=f.branches.issuedResourceCapture(f.source.id,stepId,'executable-issued');
  const read=readIssuedResourceContinuation(db,f.source.id,saved.checkpointId,saved.checkpointHash);
  assert.deepEqual(read.continuation,c);assert.equal(read.selected.attempts.find(a=>a.request_id).request_id,requestId);
  const wrongGeneration=structuredClone(read.selected),wrongHost=structuredClone(read.hostDependencies);
  wrongGeneration.resources[0].generation=1;wrongHost.resources[0].row.generation=1;wrongHost.resources[0].sha256=hash(stableJson(wrongHost.resources[0].row));
  const {resourceCaptureFrontierHash}=await import('../../packages/agents/dist/index.js');
  assert.equal(issuedResourceContinuationSupported(db,f.source.id,wrongGeneration,wrongHost,{...c,frontierSha256:resourceCaptureFrontierHash(wrongGeneration),hostCutSha256:hash(stableJson(wrongHost))}),false,'rehashing cannot select a different resource generation');
  const wrongRoot=structuredClone(read.hostDependencies);wrongRoot.roots[0].attemptId=randomUUID();
  assert.equal(issuedResourceContinuationSupported(db,f.source.id,read.selected,wrongRoot,{...c,hostCutSha256:hash(stableJson(wrongRoot))}),false,'root must identify the exact issued Branch attempt');
  const {branchContinuationIds}=await import('../../packages/agents/dist/branch-continuation-remap.js');
  maps={idMap:Object.fromEntries(branchContinuationIds(read.selected).map(id=>[id,randomUUID()])),requestMap:Object.fromEntries(read.hostDependencies.requests.map(({row})=>[row.id,randomUUID()])),agentMap:Object.fromEntries(receipt.agentIds.map(id=>[id,randomUUID()]))};
  destination={executionId:randomUUID(),conversationId:randomUUID(),resourceGeneration:0};
  reconstructed=reconstructIssuedResourceContinuation(db,f.source.id,saved.checkpointId,saved.checkpointHash,destination,maps);
  assert.equal(reconstructed.resource.step_execution_id,maps.idMap[stepId]);assert.equal(reconstructed.resource.chat_id,destination.conversationId);
  assert.equal(reconstructed.frontier.attempts.find(a=>a.request_id).request_id,maps.requestMap[requestId]);
  assert.deepEqual(reconstructed.requestBindings,[{sourceRequestId:requestId,requestId:maps.requestMap[requestId],stepExecutionId:maps.idMap[stepId]}]);
  assert.equal(reconstructed.resource.root_agent_id,maps.agentMap[read.selected.resources[0].root_agent_id]);
  assert.equal('chat_operation_json' in reconstructed.resource,false);assert.equal('import_operation_json' in reconstructed.resource,false);assert.equal('capture_json' in reconstructed.resource,false);
  assert.throws(()=>reconstructIssuedResourceContinuation(db,f.source.id,saved.checkpointId,saved.checkpointHash,destination,{...maps,agentMap:{}}),/mapping/);
  assert.throws(()=>reconstructIssuedResourceContinuation(db,f.source.id,saved.checkpointId,saved.checkpointHash,destination,{...maps,requestMap:{}}),/Request map/);
  const omitted=structuredClone(c);omitted.audit=omitted.audit.filter(e=>e.kind!=='resource_created');omitted.auditSha256=hash(stableJson(omitted.audit));
  assert.equal(issuedResourceContinuationSupported(db,f.source.id,read.selected,read.hostDependencies,omitted),false,'a rehashed dropped audit event cannot replace the owned prefix');
  const oldSnapshot={...saved.snapshot,issuedResourceCustody:receipt};delete oldSnapshot.issuedContinuation;
  const oldJson=stableJson(oldSnapshot),old=db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(f.source.id,oldJson,hash(oldJson));
  assert.throws(()=>readIssuedResourceContinuation(db,f.source.id,Number(old.lastInsertRowid),hash(oldJson)),/unsupported/);
 });
 await f.reopen();
 assert.deepEqual(reconstructIssuedResourceContinuation(f.store.sqlite,f.source.id,saved.checkpointId,saved.checkpointHash,destination,maps),reconstructed,'source progress and cleanup cannot substitute later audit or identities');
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,saved.checkpointId,saved.checkpointHash,'still-needs-destination-admission'),/unsupported|continuation/);
});

// Deferred: durable human review slice only. Package bytes are inert fixture receipts;
// no destination composition or runtime execution is claimed by these tests.
async function issuedDisclosureFixture(t){
 const f=await reservationHistoryFixture(t),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);
 let saved;
 await f.finish(f.source.id,undefined,async({stepId,generation})=>{
  const intent=f.branches.reserveIssuedResourceCapture(f.source.id,stepId,generation,'disclosure-cut');
  const receipt={...intent.source,version:1,custodyId:hash(intent.source.checkpointId),boundaryId:'inert-disclosure-boundary',sha256:hash('inert-issued-bytes'),byteLength:1};
  f.store.sqlite.transaction(()=>f.branches.sealIssuedResourceCapture(f.source.id,stepId,'disclosure-cut',receipt))();
  saved=f.branches.issuedResourceCapture(f.source.id,stepId,'disclosure-cut');
 });
 const {BranchDisclosureReviewService,BRANCH_DISCLOSURE_OPERATOR}=await import('../../apps/server/dist/branch-disclosure-review.js');
 const {BranchResourceService}=await import('../../apps/server/dist/branch-resource-service.js');
 const {workspaceCreationId}=await import('../../packages/agents/dist/index.js');
 const db=f.store.sqlite,coordination=new CoordinationV3Store(db),project=f.store.createProject({label:'Disclosure destination',hostPath:f.branches.localConfiguration(f.branch.id).directories.root,defaultEngine:'codex'});
 const creationKey='disclosure-fresh-chat',chatId=workspaceCreationId('conversation',project.id,creationKey);
 const reservation={branchId:f.branch.id,sourceExecutionId:f.source.id,checkpointId:saved.checkpointId,checkpointHash:saved.checkpointHash,commandKey:'disclosure-destination',operatorId:BRANCH_DISCLOSURE_OPERATOR,reconcileEffects:true,custody:saved.receipt,
  destination:{projectId:project.id,conversationId:chatId,executionId:randomUUID(),resourceStepId:randomUUID(),resourceGeneration:0}};
 const reserved=db.transaction(()=>coordination.reserveCoordinationDestination(reservation,{requireCustodyAndOwner:()=> 'inert-reservation-only-proof',authorizeDisclosure:()=>assert.fail('reserve grants no disclosure'),resolveArtifact:()=>assert.fail('artifact')}))();
 f.store.createConversation(project.id,{title:'Review held'},{idempotencyKey:creationKey,payloadHash:hash('disclosure-chat')});
 const op=f.store.beginAgentCreationOperation({projectId:project.id,conversationId:chatId,actorScope:'disclosure-fixture',kind:'import',idempotencyKey:'disclosure-import',payloadHash:hash('disclosure-import')}).operation;
 const agentMap=Object.fromEntries(saved.receipt.agentIds.map(id=>[id,randomUUID()]));
 Object.values(agentMap).forEach((id,index)=>f.store.addAgentCreationOperationMember(op.id,id,index));
 const stage={importPlan:{creationOperationId:op.id,projectId:project.id,conversationId:chatId,agents:Object.entries(agentMap).map(([sourceRef,agentId])=>({sourceRef,agentId})),artifacts:[]},agentMap,artifactMap:{}};
 db.transaction(()=>coordination.stageCoordinationDestination(reserved.admissionId,stage))();
 for(const id of Object.values(agentMap))f.store.createAgent(project.id,{title:'Fresh recipient',engine:'codex',conversationId:chatId},undefined,id);
 let reads=0,missing=false;
 const resources=new BranchResourceService(f.branches,f.store,async()=>assert.fail('delete'),async()=>assert.fail('create'),async()=>assert.fail('delete Chat'));
 resources.setPackageEngine({readCheckpoint:async receipt=>{reads++;assert.deepEqual(receipt,saved.receipt);if(missing)throw Error('missing issued bytes');return {};}});
 const service=new BranchDisclosureReviewService(f.store,f.branches,coordination,(...args)=>resources.verifyHistoricalCustody(...args));
 const prepare=()=>service.prepare(f.branch.id,f.source.id,reserved.admissionId),choose=input=>service.choose(f.branch.id,f.source.id,reserved.admissionId,input);
 return {f,db,saved,reservation,stage,service,resources,coordination,id:reserved.admissionId,prepare,choose,get reads(){return reads},setMissing(value){missing=value}};
}
test('human disclosure preview never approves; exact choice survives response loss and a new service instance',async t=>{
 const x=await issuedDisclosureFixture(t),before=x.db.prepare('SELECT COUNT(*) n FROM branch_commands').get().n,preview=await x.prepare();
 assert.equal(preview.state,'unreviewed');assert.equal(preview.revision,0);assert.ok(preview.facts.length);
 assert.equal(x.db.prepare('SELECT COUNT(*) n FROM branch_commands').get().n,before);
 assert.throws(()=>x.db.transaction(()=>x.service.authorizeDisclosure(preview.review))(),/approval required/);
 const input={commandKey:'explicit-human-approve',action:'approve',reviewHash:preview.reviewHash,expectedRevision:0};
 const receipt=await x.choose(input);assert.equal(receipt.active,true);assert.equal(receipt.revision,1);
 const reads=x.reads;
 assert.deepEqual(await x.choose(input),receipt);assert.equal(x.reads,reads,'exact replay reads command before package access');
 const {BranchDisclosureReviewService}=await import('../../apps/server/dist/branch-disclosure-review.js');
 const reopened=new BranchDisclosureReviewService(x.f.store,x.f.branches,new CoordinationV3Store(x.db),async()=>assert.fail('readback must not read package'));
 assert.deepEqual(reopened.readCommand(x.f.branch.id,x.f.source.id,x.id,input.commandKey),receipt);
 assert.match(x.db.transaction(()=>reopened.authorizeDisclosure(preview.review))(),/^branch-disclosure:/);
 await assert.rejects(x.choose({...input,reviewHash:'0'.repeat(64)}),/conflict/);
 assert.equal(x.db.prepare("SELECT COUNT(*) n FROM agent_activations WHERE agent_id=?").get(Object.values(x.stage.agentMap)[0]).n,0);
 await x.f.reopen();
 const restarted=new BranchDisclosureReviewService(x.f.store,x.f.branches,new CoordinationV3Store(x.f.store.sqlite),async()=>assert.fail('restart readback must not read package'));
 assert.deepEqual(restarted.readCommand(x.f.branch.id,x.f.source.id,x.id,input.commandKey),receipt);
 assert.match(restarted.authorizeDisclosure(preview.review),/^branch-disclosure:/);
});
test('human revocation invalidates old approval and old command replay cannot revive it',async t=>{
 const x=await issuedDisclosureFixture(t),p=await x.prepare(),approve={commandKey:'approve',action:'approve',reviewHash:p.reviewHash,expectedRevision:0};
 await x.choose(approve);x.setMissing(true);
 const revoked=await x.choose({commandKey:'revoke',action:'revoke',reviewHash:p.reviewHash,expectedRevision:1});
 assert.equal(revoked.state,'revoked');assert.equal(revoked.revision,2);assert.equal(revoked.active,false);
 assert.equal((await x.choose(approve)).active,false);
 assert.throws(()=>x.db.transaction(()=>x.service.authorizeDisclosure(p.review))(),/approval required/);
 await assert.rejects(x.choose({...approve,commandKey:'new-approve-without-bytes',expectedRevision:2}),/missing issued bytes/);
});
test('human approval refuses changed facts, recipients, custody and policy revisions including equal-content updates',async t=>{
 const x=await issuedDisclosureFixture(t),p=await x.prepare();
 await x.choose({commandKey:'approve',action:'approve',reviewHash:p.reviewHash,expectedRevision:0});
 const mutated=structuredClone(p.review);mutated.facts[0].sha256='f'.repeat(64);
 assert.throws(()=>x.db.transaction(()=>x.service.authorizeDisclosure(mutated))(),/approval required/);
 const mapped=structuredClone(p.review);mapped.stage.agentMap[Object.keys(mapped.stage.agentMap)[0]]=randomUUID();
 assert.throws(()=>x.db.transaction(()=>x.service.authorizeDisclosure(mapped))(),/approval required/);
 const policy=new CapabilityPolicyStore(x.db);
 policy.put({scopeKind:'chat',scopeId:x.reservation.destination.conversationId,expectedRevision:0,restrictedCapabilityIds:[]});
 assert.throws(()=>x.db.transaction(()=>x.service.authorizeDisclosure(p.review))(),/approval required/);
 await assert.rejects(x.choose({commandKey:'old-policy',action:'approve',reviewHash:p.reviewHash,expectedRevision:1}),/changed/);
 const next=await x.prepare();assert.notEqual(next.reviewHash,p.reviewHash);
 await assert.rejects(x.choose({commandKey:'stale-revision',action:'approve',reviewHash:next.reviewHash,expectedRevision:0}),/revision changed/);
 x.setMissing(true);await assert.rejects(x.prepare(),/missing issued bytes/);
});
test('disclosure API exposes exact human confirmation and rejects fabricated identity fields',async t=>{
 const x=await issuedDisclosureFixture(t),{registerBranchRoutes}=await import('../../apps/server/dist/routes/branches.js');
 const {createRequire}=await import('node:module'),require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
 const app=require('fastify')();t.after(()=>app.close());
 registerBranchRoutes(app,{coordination:x.coordination,store:x.f.store,branches:x.f.branches,resources:x.resources,installations:{setPublisher(){}},notify(){assert.fail('choice cannot wake work')}});
 const url=`/api/branches/${x.f.branch.id}/executions/${x.f.source.id}/destinations/${x.id}/disclosure`;
 const preview=await app.inject({method:'GET',url});assert.equal(preview.statusCode,200);const p=preview.json();
 const choice={commandKey:'route-choice',action:'approve',reviewHash:p.reviewHash,expectedRevision:p.revision};
 for(const extra of [{operatorId:'invented'},{identityHeader:'invented'},{facts:[]},{agentMap:{}}])assert.equal((await app.inject({method:'POST',url,payload:{...choice,...extra}})).statusCode,409);
 const approved=await app.inject({method:'POST',url,payload:choice});assert.equal(approved.statusCode,200);assert.equal(approved.json().active,true);
 assert.deepEqual((await app.inject({method:'GET',url:url+'?commandKey=route-choice'})).json(),approved.json());
});

// Deferred composer regression: actual SQLite owner/runtime paths, inert package
// and managed-folder adapters; no provider, Script or browser process is started.
async function issuedDestinationFixture(t,mode='async',parallel=false,existing){
 const f=existing?.f??await reservationHistoryFixture(t,mode,false,parallel);
 if(!existing){const prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);}
 let saved=existing?.saved;
 if(!existing)await f.finish(f.source.id,undefined,undefined,async({stepId,generation})=>{
  const intent=f.branches.reserveIssuedResourceCapture(f.source.id,stepId,generation,'composer-cut');
  const receipt={...intent.source,version:1,custodyId:hash(intent.source.checkpointId),boundaryId:'inert-composer-boundary',sha256:hash('inert-composer-package'),byteLength:1};
  f.store.sqlite.transaction(()=>f.branches.sealIssuedResourceCapture(f.source.id,stepId,'composer-cut',receipt))();
  saved=f.branches.issuedResourceCapture(f.source.id,stepId,'composer-cut');
 });
 const {BranchIssuedDestinationService}=await import('../../apps/server/dist/branch-issued-destination.js');
 const {BranchDisclosureReviewService}=await import('../../apps/server/dist/branch-disclosure-review.js');
 const {BranchResourceService}=await import('../../apps/server/dist/branch-resource-service.js');
 const retry=saved.snapshot.issuedContinuation?.generationRetry,historical=retry?(retry.history?.map(v=>v.selection)??[retry.selection]):undefined;
 const allowedReceipts=[saved.receipt,...(historical??[]).map(selection=>f.branches.generationExitCapture(f.source.id,selection.stepId,selection.generation).receipt)];
 let bytes=true,creates=0,imports=0,reads=0,verifications=0;
 const packageFor=receipt=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date(0).toISOString(),sourceLabel:'Inert captured organization',rootRef:receipt.agentIds[0],
  agents:receipt.agentIds.map(ref=>({ref,title:'Retained worker',engine:'codex',sourceChat:{ref:receipt.sourceChatId,title:'Source'},managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}))});
 const engine={
  readCheckpoint:async receipt=>{reads++;assert.ok(allowedReceipts.some(r=>stableJson(r)===stableJson(receipt)));if(!bytes)throw Error('missing issued bytes');return packageFor(receipt);},
  verifyCheckpointNow:receipt=>{verifications++;assert.deepEqual(receipt,saved.receipt);if(!bytes)throw Error('missing issued bytes');return receipt.sha256;},
  validateAgent:()=>{},
  importAgent:async(projectId,chatId,pkg,engines,key,{branchHooks:hooks})=>{
   imports++;const store=f.store,db=store.sqlite,op=store.beginAgentCreationOperation({projectId,conversationId:chatId,actorScope:'user:local-operator',kind:'import',idempotencyKey:key,payloadHash:hash(stableJson(pkg))}).operation;
   const agentMap=Object.fromEntries(pkg.agents.map(a=>[a.ref,randomUUID()]));
   db.transaction(()=>{
    Object.values(agentMap).forEach((id,index)=>store.addAgentCreationOperationMember(op.id,id,index));
    hooks.stage({creationOperationId:op.id,projectId,conversationId:chatId,agents:Object.entries(agentMap).map(([sourceRef,agentId])=>({sourceRef,agentId})),artifacts:[]});
   })();
   await hooks.plan(Object.values(agentMap),op.id);
   for(const id of Object.values(agentMap))store.createAgent(projectId,{title:'Fresh held worker',engine:'codex',conversationId:chatId},undefined,id);
   const result={rootAgentId:agentMap[pkg.rootRef],agentIds:Object.values(agentMap),agentRefs:agentMap};
   hooks.transaction(()=>{store.updateAgentCreationOperation(op.id,{status:'canonical_committed',result:{...result,branchDestinationPrepared:true}});hooks.holdForDisclosure(result);});
   return result;
  },
  finishDestinationImport:(id,compose)=>{
   const op=f.store.getAgentCreationOperation(id);assert.equal(op.status,'canonical_committed');assert.equal(op.result.branchDestinationPrepared,true);
   compose(op.result,()=>f.store.updateAgentCreationOperation(id,{status:'completed'}));
  },
 };
 const services=()=>{
  const coordination=new CoordinationV3Store(f.store.sqlite),resources=new BranchResourceService(f.branches,f.store,async()=>assert.fail('delete'),async()=>assert.fail('create'),async()=>assert.fail('delete Chat'));
  resources.setPackageEngine(engine);
  const disclosure=new BranchDisclosureReviewService(f.store,f.branches,coordination,(...args)=>resources.verifyHistoricalCustody(...args),false,receipt=>engine.readCheckpoint(receipt));
  const createChat=async(input,key,owner)=>{creates++;assert.ok(f.store.sqlite.prepare('SELECT 1 FROM coordination_destination_admissions WHERE conversation_id IS NOT NULL AND state=\'reserved\'').get(),'hold commits before any Chat publication');
   const project=f.store.createProject({...input,hostPath:f.branches.localConfiguration(f.branch.id).directories.root,chatOwned:true,...owner},{idempotencyKey:key,payloadHash:hash(stableJson({input,owner}))});return f.store.getConversation(project.lastConversationId);};
  return {disclosure,composer:new BranchIssuedDestinationService(f.store,f.branches,coordination,disclosure,()=>engine,createChat)};
 };
 const input={commandKey:'restore-issued-cut',checkpointId:saved.checkpointId,expectedHash:saved.checkpointHash,reconcileEffects:true,...(historical?{historicalReviewHash:hash(stableJson(historical))}:{})};
 return {f,saved,input,services,setBytes:value=>{bytes=value;},get counts(){return {creates,imports,reads,verifications};}};
}
for(const mode of ['async','sync'])test(`issued ${mode} composer reserves -> stages -> human approves -> atomically admits -> exact restart readback`,async t=>{
 const x=await issuedDestinationFixture(t,mode);let {composer,disclosure}=x.services();const {f,input}=x,db=f.store.sqlite;
 const prepared=await composer.prepare(f.branch.id,f.source.id,input);
 assert.equal(prepared.state,'awaiting_disclosure');assert.equal(prepared.restoreSupported,false);
 assert.equal(composer.list(f.branch.id,f.source.id)[0].admissionId,prepared.admissionId,'public discovery returns canonical admission identity');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_activations WHERE scope_key=?').get(`conversation:${prepared.destination.conversationId}`).n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_step_executions WHERE execution_id=?').get(prepared.destination.executionId).n,0);
 f.branches.advance();await f.branches.unitSaver.drain();assert.equal(f.branches.execution(prepared.destination.executionId).state,'waiting','staged acceptance cannot advance an empty frontier');
 const preview=await disclosure.prepare(f.branch.id,f.source.id,prepared.admissionId);
 await assert.rejects(composer.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash),/approval/);
 await disclosure.choose(f.branch.id,f.source.id,prepared.admissionId,{commandKey:'explicit-human-choice',action:'approve',reviewHash:preview.reviewHash,expectedRevision:0});
 x.setBytes(false);await assert.rejects(composer.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash),/missing issued bytes/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_resources WHERE execution_id=?').get(prepared.destination.executionId).n,0,'failed custody writes no owner rows');x.setBytes(true);
 const admitted=await composer.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash);
 assert.equal(admitted.state,'admitted');assert.equal(admitted.restoreSupported,true);assert.ok(admitted.receipt.activationIds.length,'only final open Request wakes');
 const receipt=admitted.receipt,resource=db.prepare('SELECT * FROM branch_resources WHERE step_execution_id=?').get(receipt.owner.resourceStepId);
 assert.equal(resource.execution_id,prepared.destination.executionId);assert.equal(resource.chat_id,prepared.destination.conversationId);assert.equal(resource.generation,0);
 assert.notEqual(resource.root_agent_id,x.saved.receipt.agentIds[0]);assert.equal(f.store.getAgentCreationOperation(receipt.owner.creationOperationId).status,'completed');
 for(const binding of receipt.owner.requestBindings)assert.ok(db.prepare('SELECT 1 FROM branch_attempts WHERE step_execution_id=? AND request_id=?').get(binding.stepExecutionId,binding.requestId));
 const owner=JSON.parse(db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(receipt.owner.executionId,receipt.owner.receiptId).result_json);
 assert.ok(db.prepare('SELECT 1 FROM branch_unit_snapshots WHERE id=? AND execution_id=? AND content_hash=?').get(owner.readiness.checkpointId,receipt.owner.executionId,owner.readiness.checkpointHash));
 await f.branches.unitSaver.drain();await f.reopen();({composer,disclosure}=x.services());x.setBytes(false);const counts=x.counts;
 const read=await composer.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash);assert.equal(read.receipt.admissionId,receipt.admissionId);assert.deepEqual(x.counts,counts,'exact committed readback never reads packages or creates effects');
 await assert.rejects(composer.admit(f.branch.id,f.source.id,input.commandKey,'a'.repeat(64)),/conflict/);
 await assert.rejects(composer.prepare(f.branch.id,f.source.id,{...input,expectedHash:'b'.repeat(64)}),/conflict/);
 assert.deepEqual(x.counts,counts);assert.equal(db.open,false,'original source connection was closed during restart');
});
test('issued composer final policy drift and explicit revocation hold all owner rows',async t=>{
 const x=await issuedDestinationFixture(t),{composer,disclosure}=x.services(),f=x.f,p=await composer.prepare(f.branch.id,f.source.id,x.input);
 const review=await disclosure.prepare(f.branch.id,f.source.id,p.admissionId),choice={commandKey:'human-approve',action:'approve',reviewHash:review.reviewHash,expectedRevision:0};
 await disclosure.choose(f.branch.id,f.source.id,p.admissionId,choice);
 x.setBytes(false);
 assert.deepEqual(composer.list(f.branch.id,f.source.id)[0].disclosure,{revision:1,state:'approved',reviewHash:review.reviewHash});
 x.setBytes(true);
 const policies=new CapabilityPolicyStore(f.store.sqlite);policies.put({scopeKind:'chat',scopeId:p.destination.conversationId,expectedRevision:0,restrictedCapabilityIds:[]});
 await assert.rejects(composer.admit(f.branch.id,f.source.id,x.input.commandKey,review.reviewHash),/approval/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resources WHERE execution_id=?').get(p.destination.executionId).n,0);
 x.setBytes(false);
 await disclosure.choose(f.branch.id,f.source.id,p.admissionId,{commandKey:'human-revoke',action:'revoke',reviewHash:review.reviewHash,expectedRevision:1});
 assert.deepEqual(composer.list(f.branch.id,f.source.id)[0].disclosure,{revision:2,state:'revoked',reviewHash:review.reviewHash});
 x.setBytes(true);
 await assert.rejects(composer.admit(f.branch.id,f.source.id,x.input.commandKey,review.reviewHash),/approval/);
 assert.equal(composer.inspect(f.branch.id,f.source.id,x.input.commandKey).state,'awaiting_disclosure');
});
test('issued composer owner failure rolls back graph, import completion, readiness and all wakes',async t=>{
 const x=await issuedDestinationFixture(t),{composer,disclosure}=x.services(),f=x.f,p=await composer.prepare(f.branch.id,f.source.id,x.input),db=f.store.sqlite;
 const preview=await disclosure.prepare(f.branch.id,f.source.id,p.admissionId);
 await disclosure.choose(f.branch.id,f.source.id,p.admissionId,{commandKey:'human-choice',action:'approve',reviewHash:preview.reviewHash,expectedRevision:0});
 const original=f.branches.composeIssuedDestination;
 f.branches.composeIssuedDestination=function(...args){original.apply(this,args);throw Error('owner commit refused');};
 await assert.rejects(composer.admit(f.branch.id,f.source.id,x.input.commandKey,preview.reviewHash),/owner commit refused/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_resources WHERE execution_id=?').get(p.destination.executionId).n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_step_executions WHERE execution_id=?').get(p.destination.executionId).n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM coordination_requests WHERE conversation_id=?').get(p.destination.conversationId).n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_activations WHERE scope_key=?').get(`conversation:${p.destination.conversationId}`).n,0);
 assert.equal(composer.inspect(f.branch.id,f.source.id,x.input.commandKey).state,'awaiting_disclosure');
 f.branches.composeIssuedDestination=original;
 const checkpoint=f.branches.checkpointIssuedDestination;
 const assertHeld=()=>{
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_resources WHERE execution_id=?').get(p.destination.executionId).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM coordination_requests WHERE conversation_id=?').get(p.destination.conversationId).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_activations WHERE scope_key=?').get(`conversation:${p.destination.conversationId}`).n,0);
  assert.equal(composer.inspect(f.branch.id,f.source.id,x.input.commandKey).state,'awaiting_disclosure');
 };
 const plan=f.branches.issuedDestinationPlan(f.branch.id,f.source.id,x.input.commandKey);
 assert.throws(()=>checkpoint.call(f.branches,plan),/same transaction/);
 assert.throws(()=>db.transaction(()=>checkpoint.call(f.branches,plan))(),/admitted graph/);
 f.branches.checkpointIssuedDestination=function(...args){
  const admission=db.prepare('SELECT state,receipt_json FROM coordination_destination_admissions WHERE id=?').get(p.admissionId);
  assert.equal(admission.state,'admitted');assert.ok(admission.receipt_json);
  checkpoint.apply(this,args);throw Error('final checkpoint refused');
 };
 await assert.rejects(composer.admit(f.branch.id,f.source.id,x.input.commandKey,preview.reviewHash),/final checkpoint refused/);assertHeld();
 const stage=JSON.parse(db.prepare('SELECT stage_json FROM coordination_destination_admissions WHERE id=?').get(p.admissionId).stage_json);
 assert.equal(f.store.getAgentCreationOperation(stage.importPlan.creationOperationId).status,'canonical_committed');
 f.branches.checkpointIssuedDestination=checkpoint;
 assert.equal((await composer.admit(f.branch.id,f.source.id,x.input.commandKey,preview.reviewHash)).state,'admitted');
});

// Deferred: same real composer/Runtime owner path with local fork/join rows.
for(const mode of ['async','sync'])test(`issued destination ${mode} preserves local parallel fork/join with one organization`,async t=>{
 const x=await issuedDestinationFixture(t,mode,true),{composer,disclosure}=x.services(),f=x.f;
 const {issuedResourceContinuationSupported}=await import('../../packages/agents/dist/index.js');
 const selected=x.saved.snapshot.selected,host=x.saved.snapshot.hostDependencies,envelope=x.saved.snapshot.issuedContinuation;
 assert.equal(f.branches.resourceCaptureJournal(selected.resources[0].step_execution_id),undefined,'independent issued custody does not require a serial pre-opening capture');
 assert.equal(issuedResourceContinuationSupported(f.store.sqlite,f.source.id,selected,host,envelope),true);
 const omitted=structuredClone(envelope);omitted.audit=omitted.audit.filter(event=>event.kind!=='resource_created');omitted.auditSha256=hash(stableJson(omitted.audit));
 assert.equal(issuedResourceContinuationSupported(f.store.sqlite,f.source.id,selected,host,omitted),false,'rehashing cannot replace the complete owned prefix');
 const wrongGeneration=structuredClone(selected);wrongGeneration.resources[0].generation++;
 assert.equal(issuedResourceContinuationSupported(f.store.sqlite,f.source.id,wrongGeneration,host,envelope),false);
 const prepared=await composer.prepare(f.branch.id,f.source.id,x.input);
 const preview=await disclosure.prepare(f.branch.id,f.source.id,prepared.admissionId);
 await disclosure.choose(f.branch.id,f.source.id,prepared.admissionId,{commandKey:'parallel-human',action:'approve',reviewHash:preview.reviewHash,expectedRevision:0});
 const admitted=await composer.admit(f.branch.id,f.source.id,x.input.commandKey,preview.reviewHash);
 assert.equal(admitted.state,'admitted');
 const db=f.store.sqlite,destination=prepared.destination.executionId;
 assert.ok(db.prepare('SELECT COUNT(*) n FROM branch_paths WHERE execution_id=?').get(destination).n>1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_resources WHERE execution_id=?').get(destination).n,1);
 const sourceIds=db.prepare('SELECT id FROM branch_paths WHERE execution_id=?').all(f.source.id).map(r=>r.id);
 assert.ok(db.prepare('SELECT id FROM branch_paths WHERE execution_id=?').all(destination).every(r=>!sourceIds.includes(r.id)));
 x.setBytes(false);assert.equal(composer.inspect(f.branch.id,f.source.id,x.input.commandKey).state,'admitted');
});

// Deferred lifecycle adapter checks: no package bytes or external reconciliation run here.
test('Branch custody inventory pins exact checkpoint and staged admission without releasing bytes',async t=>{
 const x=await issuedDestinationFixture(t),{composer}=x.services(),f=x.f,source=x.saved.source,api=f.branches.custodyLifecycle;
 const before=api.inspect(source);
 assert.equal(before.custodyId,x.saved.receipt.custodyId);
 assert.equal(before.releaseAllowed,false);
 assert.ok(before.references.some(r=>r.kind==='checkpoint'&&r.key===String(x.saved.checkpointId)));
 const opening=f.branches.resourceCaptureJournal(source.intent.resourceStepId);
 assert.ok(api.references(opening.source).some(r=>r.kind==='checkpoint'),'serialized capture_json in a retained checkpoint remains a pin');
 assert.throws(()=>api.assertRelease(source,before.revision),/same owner transaction/);
 assert.throws(()=>f.branches.unitTransaction(()=>api.assertRelease(source,before.revision))(),/held/);
 await composer.prepare(f.branch.id,f.source.id,x.input);
 const staged=api.inspect(source);assert.ok(staged.references.some(r=>r.kind==='admission'));
 assert.notEqual(staged.revision,before.revision);
 assert.throws(()=>api.retireCheckpoints(source,{commandKey:'pinned-history',expectedRevision:staged.revision,checkpoints:[{id:x.saved.checkpointId,sha256:x.saved.checkpointHash}]}),/held/);
 assert.ok(f.store.sqlite.prepare('SELECT 1 FROM branch_unit_snapshots WHERE id=?').get(x.saved.checkpointId));
});
test('Branch explicit checkpoint retirement preserves disposition and fences old issued identity',async t=>{
 const x=await issuedDestinationFixture(t),f=x.f,source=x.saved.source,api=f.branches.custodyLifecycle;
 const review=api.inspect(source),input={commandKey:'retire-exact-issued-cut',expectedRevision:review.revision,checkpoints:[{id:x.saved.checkpointId,sha256:x.saved.checkpointHash}]};
 const originalSnapshot=f.store.sqlite.prepare('SELECT * FROM branch_unit_snapshots WHERE id=?').get(x.saved.checkpointId);
 const receipt=api.retireCheckpoints(source,input);
 assert.deepEqual(receipt.checkpointEvidence,[originalSnapshot]);
 assert.equal(receipt.state,'retired');assert.deepEqual(api.retireCheckpoints(source,input),receipt);
 assert.throws(()=>api.retireCheckpoints(source,{...input,checkpoints:[]}),/selection/);
 assert.equal(f.store.sqlite.prepare('SELECT 1 FROM branch_unit_snapshots WHERE id=?').get(x.saved.checkpointId),undefined);
 assert.throws(()=>f.branches.issuedResourceCapture(f.source.id,source.intent.resourceStepId,'composer-cut'),/abandoned/);
 const current=api.inspect(source);assert.equal(current.references.length,0);
 f.branches.unitTransaction(()=>assert.equal(api.assertRelease(source,current.revision).releaseAllowed,true))();
});

test('Branch abandoned capture needs synchronous package retirement and cannot resume or seal',async t=>{
 const x=await issuedDestinationFixture(t),f=x.f,db=f.store.sqlite,api=f.branches.custodyLifecycle;
 const source={...x.saved.source,checkpointId:randomUUID()},commandKey='fixture-pending',captureKey=`issued-resource-capture:${commandKey}`;
 const capture={schema:'branch-issued-resource-capture.v1',state:'capturing',source,snapshot:x.saved.snapshot};
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(f.source.id,captureKey,hash(stableJson({stepId:source.intent.resourceStepId,generation:0,commandKey})),stableJson(capture),new Date().toISOString());
 assert.equal(f.branches.issuedResourceCapturePending(source.intent.resourceStepId),true);
 const review=api.inspect(source),input={commandKey:'abandon-inert-capture',captureKey,captureSha256:hash(stableJson(capture)),expectedRevision:review.revision};
 assert.throws(()=>api.abandonCapture(source,input,()=>({custodyId:'wrong',sourceSha256:'wrong',revision:'wrong'})),/retirement proof/);
 const inertPackageRetirement=()=>{assert.equal(db.inTransaction,true);return {custodyId:review.custodyId,sourceSha256:hash(stableJson(source)),revision:'inert-package-retirement-receipt'};};
 const receipt=api.abandonCapture(source,input,inertPackageRetirement);
 assert.equal(receipt.state,'abandoned');assert.deepEqual(api.abandonCapture(source,input,()=>assert.fail('exact replay must not repeat package action')),receipt);
 assert.equal(f.branches.issuedResourceCapturePending(source.intent.resourceStepId),false);
 assert.ok(db.prepare('SELECT 1 FROM branch_commands WHERE execution_id=? AND command_key=?').get(f.source.id,captureKey),'original intent remains audit evidence');
 assert.throws(()=>f.branches.reserveIssuedResourceCapture(f.source.id,source.intent.resourceStepId,0,commandKey),/abandoned/);
 assert.throws(()=>db.transaction(()=>f.branches.sealIssuedResourceCapture(f.source.id,source.intent.resourceStepId,commandKey,{...x.saved.receipt,...source}))(),/abandoned/);
 assert.equal(api.inspect(source).references.length,0);
});


// Deferred source: canonical Request failure drives the real fresh-context retry.
// Deferred serial gen1 consumer source follows retirement; parallel remains retirement-only and nothing is qualified.
for(const mode of ['async','sync'])for(const parallel of [false,true])test(`fresh resource generation ${mode} parallel=${parallel} retirement retains exact evidence transactionally`,async t=>{
 const f=await reservationHistoryFixture(t,mode,false,parallel,true),prefix=await f.claim();
 f.settle(prefix);await f.advance(f.source.id);
 const stopped=new Error('fixture stops after canonical retirement');let retained;
 await assert.rejects(()=>f.finish(f.source.id,undefined,undefined,async({stepId,requestId})=>{
  const db=f.store.sqlite,coordination=new CoordinationV3Store(db);
  const oldResource=db.prepare('SELECT * FROM branch_resources WHERE step_execution_id=?').get(stepId);
  const members=db.prepare('SELECT * FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(stepId);
  coordination.updateRequest({requestId,updateId:'failed-first-generation',kind:'failed',actor:{kind:'agent',id:oldResource.root_agent_id},payload:{text:'known failed generation'}});
  for(let n=0;n<16&&!db.prepare('SELECT retry_draining FROM branch_resources WHERE step_execution_id=?').get(stepId).retry_draining;n++){
   f.branches.advance();await f.branches.unitSaver.drain();
  }
  assert.equal(db.prepare('SELECT retry_draining FROM branch_resources WHERE step_execution_id=?').get(stepId).retry_draining,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_attempts WHERE step_execution_id=?').get(stepId).n,2);
  const ids=members.map(m=>m.agent_id);
  const fenced=f.branches.fenceGenerationExit(stepId);assert.equal(fenced.state,'fencing');
  const fenceRow=db.prepare("SELECT * FROM host_lifecycle_commits WHERE kind='branch-generation-exit-fence' AND identity=?").get(fenced.intakeFence.identity);
  assert.equal(fenceRow.receipt_sha256,fenced.intakeFence.sha256);
  assert.deepEqual(f.branches.fenceGenerationExit(stepId),fenced);
  const fenceKey=`resource-generation-exit:${stepId}:0`,fenceJournal=db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(f.source.id,fenceKey);
  db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(stableJson({...fenced,intakeFence:{...fenced.intakeFence,sha256:'tampered'}}),f.source.id,fenceKey);
  assert.throws(()=>f.branches.generationExitCapture(f.source.id,stepId,0),/fence receipt differs/);
  db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(fenceJournal.result_json,f.source.id,fenceKey);
  assert.equal(f.branches.resourceCanRetire(stepId,ids),false);
  const heldBefore=allocationCounts(f),heldJournal=db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(f.source.id,fenceKey).result_json;
  assert.ok(db.prepare("SELECT 1 FROM agent_activations WHERE agent_id IN (SELECT agent_id FROM branch_resource_members WHERE step_execution_id=?) AND state IN ('pending','attached','retry_pending','outcome_unknown')").get(stepId));
  assert.throws(()=>f.branches.reserveGenerationExit(f.source.id,stepId,0),/^Error: Generation participant effects remain unresolved$/);
  assert.deepEqual(allocationCounts(f),heldBefore);assert.equal(db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(f.source.id,fenceKey).result_json,heldJournal);
  const {ProviderProcessAuthority}=await import('../../apps/server/dist/provider-process-authority.js');
  const authority=new ProviderProcessAuthority(db,'inert-generation-provider');const handles=new Map();authority.recover=identity=>handles.get(identity.pid);
  for(const [index,agentId] of ids.entries()){
   const agent=f.store.getAgent(agentId),runId=randomUUID(),now=new Date().toISOString();
   // Synthetic terminal Run/process lifetime; real canonical evidence writers below.
   db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,terminal_at) VALUES(?,?,?,'completed','fixture',?,1,'injected',?,?,?,?)").run(runId,agent.projectId,agentId,now,now,now,now,now);
   for(const activation of db.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND state IN ('pending','retry_pending')").all(agentId))coordination.cancelPendingActivation({activationId:activation.id,projectId:agent.projectId,idempotencyKey:`exit-fixture:${activation.id}`});
   let alive=true;const handle={processIdentity:{pid:424242+index,pgid:424242+index,birthMarker:`inert-generation-${index}`},isAlive:()=>alive,close:async()=>{alive=false;}};handles.set(handle.processIdentity.pid,handle);
   authority.register(handle,{purpose:'provider Run',projectId:agent.projectId,agentId,runId,runFence:1});
  }
  await authority.terminateAgents(new Set(ids),'inert precleanup fixture');
  const journal=f.branches.reserveGenerationExit(f.source.id,stepId,0);assert.equal(journal.state,'capturing');assert.deepEqual(journal.envelope.intakeFence,fenced.intakeFence);
  const custody={...journal.source,version:1,custodyId:hash(journal.source.checkpointId),boundaryId:'inert-generation-exit',sha256:hash('private generation bytes'),byteLength:1};
  const originalWait=db.prepare('SELECT wait_reason FROM branch_executions WHERE id=?').get(f.source.id).wait_reason;
  db.prepare('UPDATE branch_executions SET wait_reason=? WHERE id=?').run('changed cut',f.source.id);
  assert.throws(()=>db.transaction(()=>f.branches.sealGenerationExit(f.source.id,stepId,0,custody))(),/changed/);
  assert.equal(f.branches.resourceCanRetire(stepId,ids),false);db.prepare('UPDATE branch_executions SET wait_reason=? WHERE id=?').run(originalWait,f.source.id);
  db.transaction(()=>f.branches.sealGenerationExit(f.source.id,stepId,0,custody))();
  const sealed=f.branches.generationExitCapture(f.source.id,stepId,0);assert.equal(sealed.state,'sealed');assert.equal(sealed.envelope.providerExitEvidence.receipts.length,ids.length);
  assert.equal(sealed.envelope.nativeScriptExits.length>0,true);assert.equal(f.branches.resourceCanRetire(stepId,ids),true);
  const preview=f.store.previewAgentDeletion(ids);
  f.store.deleteAgentSubtrees(ids,preview.previewHash,x=>coordination.handleAgentDeletion(x));
  const deletion=f.store.commitConversationDeletion(oldResource.chat_id);
  f.store.finishConversationDeletionStorageCleanup(deletion);f.store.markConversationDeletionServerCleanupComplete(oldResource.chat_id);
  await f.branches.unitSaver.drain();
  const key=`resource-generation-retired:${stepId}:0`;
  db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(f.source.id,key,hash('conflict'),stableJson({conflict:true}),new Date().toISOString());
  assert.throws(()=>f.branches.resourceRetired(stepId),/generation evidence differs/);
  assert.equal(db.prepare('SELECT generation FROM branch_resources WHERE step_execution_id=?').get(stepId).generation,0);
  assert.deepEqual(db.prepare('SELECT * FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(stepId),members);
  db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,key);
  f.branches.resourceRetired(stepId);await f.branches.unitSaver.drain();
  retained=db.prepare('SELECT * FROM branch_commands WHERE execution_id=? AND command_key=?').get(f.source.id,key);
  assert.equal(hash(retained.result_json),retained.input_hash);
  const value=JSON.parse(retained.result_json);
  assert.equal(value.schema,'branch-resource-generation-retired.v1');
  assert.equal(value.priorGeneration.checkpointHash,sealed.checkpointHash);
  assert.deepEqual(f.branches.generationExitCapture(f.source.id,stepId,0),sealed);
  // Historical disclosure retains ALL original bytes; no old actor is remapped or dispatched.
  const selection={executionId:f.source.id,stepId,generation:0,checkpointId:sealed.checkpointId,checkpointHash:sealed.checkpointHash,envelopeSha256:sealed.envelopeSha256,intakeFence:sealed.intakeFence,discloseTo:['current-source-ref']};
  const historicalReservation={branchId:sealed.identity.branchId,sourceExecutionId:f.source.id,historicalPartition:[selection],custody:{...sealed.receipt,sourceChatId:'current-generation-chat',agentIds:['current-source-ref'],intent:{...sealed.receipt.intent,resourceGeneration:1}},destination:{projectId:sealed.identity.projectId}};
  const historicalStage={agentMap:{'current-source-ref':'fresh-current-destination'}};
  const readHistory=()=>db.transaction(()=>readDestinationHistoricalPartition(db,historicalReservation,historicalStage))();
  const beforeHistory=db.prepare('SELECT (SELECT count(*) FROM coordination_requests) requests,(SELECT count(*) FROM agent_activations) activations,(SELECT count(*) FROM agents) agents').get();
  const partition=readHistory();assert.equal(partition.length,1);assert.equal(partition[0].dispatchable,false);assert.deepEqual(partition[0].seal,sealed);
  assert.deepEqual(destinationHistoricalFacts(partition)[0].destinationAgentIds,['fresh-current-destination']);
  assert.deepEqual(partition[0].seal.envelope.hostDependencies,sealed.envelope.hostDependencies);
  assert.deepEqual(db.prepare('SELECT (SELECT count(*) FROM coordination_requests) requests,(SELECT count(*) FROM agent_activations) activations,(SELECT count(*) FROM agents) agents').get(),beforeHistory);
  selection.envelopeSha256='0'.repeat(64);assert.throws(readHistory,/sealed historical/);selection.envelopeSha256=sealed.envelopeSha256;
  selection.discloseTo=['unmapped-old-ref'];assert.throws(readHistory,/current import refs/);selection.discloseTo=['current-source-ref'];
  historicalReservation.historicalPartition.push(selection);assert.throws(readHistory,/alias/);historicalReservation.historicalPartition.pop();
  assert.throws(()=>db.transaction(()=>readDestinationHistoricalPartition(db,historicalReservation,historicalStage,{requests:[sealed.envelope.hostDependencies.requests[0]]}))(),/executable root/);
  assert.throws(()=>db.transaction(()=>{db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,`resource-generation-exit:${stepId}:0`);assert.throws(readHistory,/sealed historical/);throw Error('restore journal');})(),/restore journal/);
  assert.throws(()=>db.transaction(()=>{
   const retainedSnapshot={selected:sealed.envelope.selected,hostDependencies:sealed.envelope.hostDependencies};
   const sourceReservation={...historicalReservation,checkpointHash:hash(stableJson(retainedSnapshot))};
   const entries=commitDestinationHistoricalPartition(db,'partition-rollback',sourceReservation,historicalStage,{requests:[]},'review-hash');
   // Retained source validation must preserve the REAL admission ID after original seal removal.
   // This partition-only fixture has no issued current owner; consumer source checks run on the genuine generation-one admission below.
   const auditPartition=()=>readDestinationHistoricalPartition(db,sourceReservation,historicalStage,{requests:[]},'partition-rollback');
   const evidenceReceipt={reviewHash:'review-hash',historicalPartition:entries};
   verifyDestinationHistoricalPartition(db,'partition-rollback',sourceReservation,historicalStage,{requests:[]},evidenceReceipt);
   evidenceReceipt.reviewHash='changed';assert.throws(()=>verifyDestinationHistoricalPartition(db,'partition-rollback',sourceReservation,historicalStage,{requests:[]},evidenceReceipt),/receipt differs/);evidenceReceipt.reviewHash='review-hash';
   db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key IN (?,?)').run(f.source.id,`resource-generation-exit:${stepId}:0`,`resource-generation-retired:${stepId}:0`);
   db.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(sealed.checkpointId);
   assert.throws(readHistory,/sealed historical/);
   verifyDestinationHistoricalPartition(db,'partition-rollback',sourceReservation,historicalStage,{requests:[]},evidenceReceipt);
   const auditChanges=db.prepare('SELECT total_changes() n').get().n;
   assert.deepEqual(auditPartition()[0].seal,sealed);
   assert.equal(db.prepare('SELECT total_changes() n').get().n,auditChanges);
   assert.throws(()=>readDestinationHistoricalPartition(db,sourceReservation,historicalStage,{requests:[]}),/sealed historical/);
   const immutable=db.prepare("SELECT receipt_sha256 FROM host_lifecycle_commits WHERE kind='coordination-historical-partition' AND identity='partition-rollback'").get();
   db.exec('DROP TRIGGER host_lifecycle_commit_immutable_update');
   db.prepare("UPDATE host_lifecycle_commits SET receipt_sha256=? WHERE kind='coordination-historical-partition' AND identity='partition-rollback'").run('0'.repeat(64));
   assert.throws(auditPartition,/Immutable historical evidence receipt differs/);
   db.prepare("UPDATE host_lifecycle_commits SET receipt_sha256=? WHERE kind='coordination-historical-partition' AND identity='partition-rollback'").run(immutable.receipt_sha256);
   throw Error('partition owner rollback');
  })(),/partition owner rollback/);
  assert.equal(db.prepare("SELECT 1 FROM host_lifecycle_commits WHERE kind='coordination-historical-partition' AND identity='partition-rollback'").get(),undefined);
  // Exact sealed evidence survives original cleanup; owner deletion is atomic.
  const branchId=sealed.identity.branchId;
  const beforeOwner=db.prepare('SELECT * FROM branches WHERE id=?').get(branchId);
  assert.throws(()=>f.branches.unitTransaction(()=>{
   f.branches.beginDeletion(branchId);
   // Model already-drained unrelated owner metadata in this rollback-only fixture.
   db.prepare('UPDATE conversations SET branch_id=NULL,branch_execution_id=NULL WHERE branch_id=?').run(branchId);
   db.prepare("UPDATE branch_executions SET state='canceled' WHERE branch_id=?").run(branchId);
   db.prepare('UPDATE branch_checkpoints SET audit_published=1 WHERE execution_id IN (SELECT id FROM branch_executions WHERE branch_id=?)').run(branchId);
   db.prepare("UPDATE branch_gate_notifications SET state='resolved' WHERE execution_id IN (SELECT id FROM branch_executions WHERE branch_id=?)").run(branchId);
   db.prepare('UPDATE branch_execution_budget_events SET audit_published=1 WHERE branch_id=?').run(branchId);
   f.branches.deleteBranch(branchId);
   assert.equal(db.prepare('SELECT 1 FROM branches WHERE id=?').get(branchId),undefined);
   assert.equal(generationExitHeld(db,ids[0],oldResource.chat_id),true);
   throw Error('owner deletion rollback');
  })(),/owner deletion rollback/);
  assert.deepEqual(db.prepare('SELECT * FROM branches WHERE id=?').get(branchId),beforeOwner);
  assert.deepEqual(f.branches.generationExitCapture(f.source.id,stepId,0),sealed);
  assert.equal(value.resource.generation,0);assert.equal(value.resource.chat_id,oldResource.chat_id);
  assert.deepEqual(value.members,members);assert.equal(value.context.chat_id,oldResource.chat_id);
  assert.deepEqual(value.operations.map(row=>JSON.parse(row.result_json).phase),['chat','import']);
  assert.ok(value.audit.some(row=>row.kind==='retry_scheduled'));
  assert.equal(db.prepare('SELECT generation FROM branch_resources WHERE step_execution_id=?').get(stepId).generation,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_resource_members WHERE step_execution_id=?').get(stepId).n,0);
  throw stopped;
 }),error=>error===stopped);
 // Readback after a lost response/reopen observes the same immutable evidence;
 // it does not invoke retirement on a new generation or import prior Agents.
 await f.reopen();
 const saved=f.store.sqlite.prepare('SELECT * FROM branch_commands WHERE execution_id=? AND command_key=?').get(retained.execution_id,retained.command_key);
 assert.deepEqual(saved,retained);
 if(!parallel)await completeGenerationOneDestination(t,f,mode);
});

// Full deferred serial producer->retry->current capture->human review->one admission source.
async function completeGenerationOneDestination(t,f,mode){
 const db=f.store.sqlite,current=await openCalledTreeResource(f.store,f.branches,f.branches.localConfiguration(f.branch.id).directories.root,f.source.id,f.branch.id);
 const preview=f.branches.previewGenerationOneCapture(f.source.id);
 assert.throws(()=>db.transaction(()=>{db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,`resource-generation-retired:${current.stepId}:0`);assert.throws(()=>f.branches.previewGenerationOneCapture(f.source.id),/retirement linkage/);throw Error('restore retirement');})(),/restore retirement/);
 assert.equal(preview.historicalPartition[0].generation,0);assert.equal(preview.historicalPartition[0].stepId,current.stepId);
 assert.throws(()=>f.branches.reserveIssuedResourceCapture(f.source.id,current.stepId,1,'gen1-cut','0'.repeat(64)),/preview/);
 const journal=f.branches.reserveIssuedResourceCapture(f.source.id,current.stepId,1,'gen1-cut',preview.reviewHash);
 assert.equal(journal.snapshot.hostDependencies.roots.length,1);assert.equal(journal.snapshot.hostDependencies.roots[0].requestId,current.requestId);
 assert.equal(journal.snapshot.selected.attempts.filter(a=>a.request_id).length,1);
 assert.equal(journal.snapshot.issuedContinuation.generationRetry.originalSelected.attempts.filter(a=>a.request_id).length,2);
 const receipt={...journal.source,version:1,custodyId:hash(journal.source.checkpointId),boundaryId:'inert-gen1-current',sha256:hash('gen1 current private bytes'),byteLength:1};
 db.transaction(()=>f.branches.sealIssuedResourceCapture(f.source.id,current.stepId,'gen1-cut',receipt))();
 const saved=f.branches.issuedResourceCapture(f.source.id,current.stepId,'gen1-cut');
 new CoordinationV3Store(db).updateRequest({requestId:current.requestId,updateId:'gen1-source-settled',kind:'completed',actor:{kind:'agent',id:current.agentId},payload:{text:'known gen1 result'}});
 const suffix=await f.claim();f.settle(suffix);await f.branches.unitSaver.drain();
 const deletion=f.store.previewAgentDeletion([current.agentId]);f.store.deleteAgentSubtrees([current.agentId],deletion.previewHash,x=>new CoordinationV3Store(db).handleAgentDeletion(x));
 const chat=f.store.commitConversationDeletion(current.chatId);f.store.finishConversationDeletionStorageCleanup(chat);f.store.markConversationDeletionServerCleanupComplete(current.chatId);f.branches.resourceRetired(current.stepId);await f.branches.unitSaver.drain();
 const x=await issuedDestinationFixture(t,mode,false,{f,saved}),{composer,disclosure}=x.services();
 assert.equal(f.branches.execution(f.source.id).state,'completed');
 await assert.rejects(composer.prepare(f.branch.id,f.source.id,{...x.input,historicalReviewHash:'0'.repeat(64)}),/historical selection/);
 const prepared=await composer.prepare(f.branch.id,f.source.id,x.input);
 const oldProject=f.branches.generationExitCapture(f.source.id,current.stepId,0).identity.projectId,getProject=f.store.getProject;
 f.store.getProject=function(id){return id===oldProject?undefined:getProject.call(this,id);};
 await assert.rejects(disclosure.prepare(f.branch.id,f.source.id,prepared.admissionId),/historical Project operator audit-read/);f.store.getProject=getProject;
 const review=await disclosure.prepare(f.branch.id,f.source.id,prepared.admissionId);
 const historical=review.facts.filter(f=>f.kind==='historical_generation');assert.equal(historical.length,1);assert.equal(historical[0].destinationAgentIds.length,1);
 await disclosure.choose(f.branch.id,f.source.id,prepared.admissionId,{commandKey:'explicit-gen1-human',action:'approve',reviewHash:review.reviewHash,expectedRevision:0});
 new CapabilityPolicyStore(db).put({scopeKind:'chat',scopeId:prepared.destination.conversationId,expectedRevision:0,restrictedCapabilityIds:[]});
 await assert.rejects(composer.admit(f.branch.id,f.source.id,x.input.commandKey,review.reviewHash),/approval/);
 const freshReview=await disclosure.prepare(f.branch.id,f.source.id,prepared.admissionId);
 await disclosure.choose(f.branch.id,f.source.id,prepared.admissionId,{commandKey:'explicit-gen1-final-policy',action:'approve',reviewHash:freshReview.reviewHash,expectedRevision:1});
 const finalReviewHash=freshReview.reviewHash;
 const compose=f.branches.composeIssuedDestination;f.branches.composeIssuedDestination=function(...args){compose.apply(this,args);throw Error('gen1 owner rollback');};
 await assert.rejects(composer.admit(f.branch.id,f.source.id,x.input.commandKey,finalReviewHash),/gen1 owner rollback/);f.branches.composeIssuedDestination=compose;
 assert.equal(db.prepare("SELECT 1 FROM host_lifecycle_commits WHERE kind='coordination-historical-partition' AND identity=?").get(prepared.admissionId),undefined);
 const admitted=await composer.admit(f.branch.id,f.source.id,x.input.commandKey,finalReviewHash),proof=admitted.receipt.historicalPartition;
 assert.equal(proof.length,1);assert.equal(proof[0].dispatchable,false);assert.deepEqual(proof[0].selection,preview.historicalPartition[0]);
 assert.deepEqual(Object.keys(admitted.receipt.requestMap),[current.requestId]);assert.deepEqual(Object.keys(admitted.receipt.agentMap),[current.agentId]);
 assert.equal(db.prepare('SELECT count(*) n FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? AND a.number=1 AND s.id=?').get(prepared.destination.executionId,admitted.receipt.owner.resourceStepId).n,0,'old failed attempt is evidence only');
 await f.reopen();const counts=x.counts,read=await x.services().composer.admit(f.branch.id,f.source.id,x.input.commandKey,finalReviewHash);
 assert.deepEqual(read.receipt.historicalPartition,proof);assert.deepEqual(x.counts,counts);
}

// Deferred isolation fixture: the second group slot must hold Branch dispatch too.
for(const mode of ['async','sync'])test(`group reservation ${mode} holds every destination execution until whole admission`,async t=>{
 const f=fixture(t,mode),lease=await f.claim(),db=f.store.sqlite;
 const checkpoint=db.prepare('SELECT id,snapshot_json FROM branch_unit_snapshots WHERE execution_id=? ORDER BY id DESC LIMIT 1').get(f.source.id);
 const id=randomUUID(),now=new Date().toISOString();
 const reservation={resources:[{destination:{executionId:randomUUID()}},{destination:{executionId:f.source.id}},{destination:{executionId:f.source.id}}]};
 db.prepare(`INSERT INTO coordination_destination_admissions(id,branch_id,source_execution_id,checkpoint_id,command_key,reservation_hash,reservation_json,snapshot_json,project_id,conversation_id,state,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`).run(id,f.branch.id,f.source.id,checkpoint.id,'group-dispatch-isolation',hash(stableJson(reservation)),stableJson(reservation),checkpoint.snapshot_json,randomUUID(),randomUUID(),now,now);
 assert.equal(f.branches.checkpointDispatch(lease),'waiting');
 db.prepare("UPDATE coordination_destination_admissions SET state='staged' WHERE id=?").run(id);
 assert.equal(f.branches.checkpointDispatch(lease),'waiting');
 db.prepare("UPDATE coordination_destination_admissions SET state='admitted' WHERE id=?").run(id);
 assert.equal(f.branches.checkpointDispatch(lease),'ready');
});

// These inert Requests never have a scheduler consumer; cancel their pending activations canonically.
function cancelInertGroupActivations(f,issued){
 const db=f.store.sqlite,coordination=new CoordinationV3Store(db);
 for(const item of issued){
  const agent=f.store.getAgent(item.agentId);assert.ok(agent);
  assert.equal(db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown')").get(agent.id),undefined);
  for(const a of db.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND state IN ('pending','retry_pending')").all(agent.id))coordination.cancelPendingActivation({activationId:a.id,projectId:agent.projectId,idempotencyKey:`inert-group-drain:${a.id}`});
  assert.equal(db.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','attached','retry_pending','outcome_unknown')").get(agent.id),undefined);
 }
}

// Deferred complete host consumer source. Package bytes/import effects are inert
// adapters; Branch/Runtime/Chat/Step/Request/disclosure/transaction writers are real.
async function twoIssuedResources(t,mode,count=2,parallel=false,completedIndices=parallel?[]:Array.from({length:count-1},(_,i)=>i),partialCapture=false){
 const f=await reservationHistoryFixture(t,mode,false,parallel,false,count),db=()=>f.store.sqlite,coord=()=>new CoordinationV3Store(db());
 const prefix=await f.claim();f.settle(prefix);const issued=[];
 async function openResource(){
  let r;for(let n=0;n<30;n++){f.branches.advance();await f.branches.unitSaver.drain();r=db().prepare("SELECT * FROM branch_resources WHERE execution_id=? AND state='reserved' ORDER BY rowid DESC LIMIT 1").get(f.source.id);if(r)break;}assert.ok(r);
  for(let n=0;n<6&&f.branches.resourceRelease(r.step_execution_id)!=='ready';n++){await f.branches.unitSaver.drain();f.branches.advance();}
  const chatToken=f.branches.beginResourceOperation(r.step_execution_id,r.creation_key,'chat');await f.branches.unitSaver.drain();assert.equal(f.branches.releaseResourceChat(r.step_execution_id,r.creation_key,chatToken),true);
  const p=f.store.createProject({label:'Group source organization',hostPath:f.branches.localConfiguration(f.branch.id).directories.root,defaultEngine:'codex',chatOwned:true,branchId:f.branch.id,executionId:f.source.id});
  const chat=f.store.getConversation(p.lastConversationId);f.branches.completeResourceOperation(r.step_execution_id,'chat',chatToken,{chatId:chat.id});await f.branches.unitSaver.drain();
  const token=f.branches.beginResourceOperation(r.step_execution_id,r.creation_key,'import');await f.branches.unitSaver.drain();
  const op=f.store.beginAgentCreationOperation({projectId:p.id,conversationId:chat.id,actorScope:'inert-group-source',kind:'import',idempotencyKey:r.creation_key,payloadHash:'inert'}).operation,id=randomUUID();
  f.store.addAgentCreationOperationMember(op.id,id,0);f.branches.observeResourceImportPlan(r.step_execution_id,token,op.id);await f.branches.unitSaver.drain();f.branches.planResource(r.step_execution_id,[id],token);
  const agent=f.store.createAgent(p.id,{title:'Inert group source',engine:'codex',conversationId:chat.id},undefined,id),result={rootAgentId:id,agentIds:[id],agentRefs:{worker:id}};
  f.store.updateAgentCreationOperation(op.id,{status:'completed',result});f.branches.completeResourceOperation(r.step_execution_id,'import',token,result);await f.branches.unitSaver.drain();
  if(f.branches.resourceCaptureEligible(r.step_execution_id)){
   const source=f.branches.reserveResourceCapture(r.step_execution_id),receipt={...source,version:1,custodyId:hash(source.checkpointId),boundaryId:'inert-opening',sha256:hash('opening'),byteLength:1};f.branches.finishResourceCapture(source,receipt);await f.branches.unitSaver.drain();
  }
  f.branches.bindResource(r.step_execution_id,result);await f.branches.unitSaver.drain();
  const request=db().prepare('SELECT request_id FROM branch_attempts WHERE step_execution_id=?').get(r.step_execution_id).request_id;
  const item={stepId:r.step_execution_id,request,chatId:chat.id,agentId:agent.id};issued.push(item);return item;
 }
 const complete=item=>coord().updateRequest({requestId:item.request,updateId:`completed-${item.request}`,kind:'completed',actor:{kind:'agent',id:item.agentId},payload:{text:'selected evidence'}});
 for(let i=0;i<count;i++){const item=await openResource();if(!parallel&&completedIndices.includes(i))complete(item);}
 if(parallel)for(const index of completedIndices)complete(issued[index]);
 let bytes=true,imports=0,failSecond=false;
 const custody=new Map();let captures=0;
 const packageFor=receipt=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date(0).toISOString(),sourceLabel:'Inert group custody',rootRef:receipt.agentIds[0],agents:receipt.agentIds.map(ref=>({ref,title:'Retained group worker',engine:'codex',sourceChat:{ref:receipt.sourceChatId,title:'Source'},managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}))});
 const engine={
  captureCheckpoint:async(source,seal)=>{if(partialCapture&&++captures===count)throw Error('injected final capture failure');const receipt={...source,version:1,custodyId:hash(source.checkpointId),boundaryId:'inert-issued-group',sha256:hash(stableJson(source)),byteLength:1};custody.set(receipt.custodyId,receipt);db().transaction(()=>seal(receipt))();return receipt;},
  readCheckpoint:async receipt=>{assert.deepEqual(receipt,custody.get(receipt.custodyId));if(!bytes)throw Error('missing group bytes');return packageFor(receipt);},
  verifyCheckpointNow:receipt=>{assert.deepEqual(receipt,custody.get(receipt.custodyId));if(!bytes)throw Error('missing group bytes');return receipt.sha256;},validateAgent:()=>{},
  importAgent:async(projectId,chatId,pkg,engines,key,{branchHooks:hooks})=>{
   imports++;const op=f.store.beginAgentCreationOperation({projectId,conversationId:chatId,actorScope:'user:local-operator',kind:'import',idempotencyKey:key,payloadHash:hash(stableJson(pkg))}).operation,map=Object.fromEntries(pkg.agents.map(a=>[a.ref,randomUUID()]));
   db().transaction(()=>{Object.values(map).forEach((id,index)=>f.store.addAgentCreationOperationMember(op.id,id,index));hooks.stage({creationOperationId:op.id,projectId,conversationId:chatId,agents:Object.entries(map).map(([sourceRef,agentId])=>({sourceRef,agentId})),artifacts:[]});})();await hooks.plan();
   for(const id of Object.values(map))f.store.createAgent(projectId,{title:'Fresh group worker',engine:'codex',conversationId:chatId},undefined,id);
   const result={rootAgentId:map[pkg.rootRef],agentIds:Object.values(map),agentRefs:map};hooks.transaction(()=>{f.store.updateAgentCreationOperation(op.id,{status:'canonical_committed',result:{...result,branchDestinationPrepared:true}});hooks.holdForDisclosure();});return result;
  },
  finishDestinationImport:(id,compose)=>{const op=f.store.getAgentCreationOperation(id);assert.equal(op.status,'canonical_committed');compose(op.result,()=>{if(failSecond&&id===lastOperation())throw Error('injected final completion');f.store.updateAgentCreationOperation(id,{status:'completed'});});assert.equal(f.store.getAgentCreationOperation(id).status,'completed');},
 };
 const {BranchIssuedGroupDestinationService}=await import('../../apps/server/dist/branch-issued-group-destination.js');
 const service=()=>new BranchIssuedGroupDestinationService(f.store,f.branches,coord(),()=>engine);
 const beforePreview=db().prepare('SELECT COUNT(*) n FROM branch_commands').get().n;
 const preview=service().previewCapture(f.branch.id,f.source.id);
 assert.deepEqual(service().previewCapture(f.branch.id,f.source.id),preview);
 assert.equal(preview.resources.length,count);assert.equal(db().prepare('SELECT COUNT(*) n FROM branch_commands').get().n,beforePreview);assert.equal(custody.size,0);
 await assert.rejects(service().capture(f.branch.id,f.source.id,'stale-preview',{...preview,reviewHash:'0'.repeat(64)}),/preview changed/);
 assert.equal(db().prepare('SELECT COUNT(*) n FROM branch_commands').get().n,beforePreview);assert.equal(custody.size,0);
 const oldWait=db().prepare('SELECT wait_reason FROM branch_executions WHERE id=?').get(f.source.id).wait_reason;
 db().prepare('UPDATE branch_executions SET wait_reason=? WHERE id=?').run('changed after operator preview',f.source.id);
 await assert.rejects(service().capture(f.branch.id,f.source.id,'changed-cut',preview));
 assert.equal(db().prepare('SELECT COUNT(*) n FROM branch_commands').get().n,beforePreview);assert.equal(custody.size,0);
 db().prepare('UPDATE branch_executions SET wait_reason=? WHERE id=?').run(oldWait,f.source.id);

 if(partialCapture){
  await assert.rejects(service().capture(f.branch.id,f.source.id,'two-resource-cut',preview),/injected final capture failure/);
  return {f,service,issued,complete};
 }
 const captured=await service().capture(f.branch.id,f.source.id,'two-resource-cut',preview);
 const discovery=service().discover({kind:'captures',limit:1});assert.equal(discovery.items[0].commandKey,'two-resource-cut');assert.equal(discovery.items[0].discovery,'exact');
 assert.equal(service().captureStatus(f.branch.id,f.source.id,discovery.items[0].commandKey).checkpointId,captured.checkpointId);

 for(const [index,item] of issued.entries())if(!completedIndices.includes(index))complete(item);
 const suffix=await f.claim();f.settle(suffix);await f.branches.unitSaver.drain();
 for(const item of issued){const preview=f.store.previewAgentDeletion([item.agentId]);f.store.deleteAgentSubtrees([item.agentId],preview.previewHash,id=>coord().handleAgentDeletion(id));const receipt=f.store.commitConversationDeletion(item.chatId);f.store.finishConversationDeletionStorageCleanup(receipt);f.store.markConversationDeletionServerCleanupComplete(item.chatId);f.branches.resourceRetired(item.stepId);await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(f.source.id).state,'completed');
 const input={commandKey:'restore-two-resource-cut',checkpointId:captured.checkpointId,expectedHash:captured.checkpointHash,reconcileEffects:true};
 function lastOperation(){const row=db().prepare('SELECT stage_json FROM coordination_destination_admissions WHERE command_key=?').get(input.commandKey);if(!row?.stage_json)return;const plan=f.branches.issuedGroupDestinationPlan(f.branch.id,f.source.id,input.commandKey);return JSON.parse(row.stage_json).imports[plan.reservation.resources.at(-1).custody.sourceChatId].creationOperationId;}
 return {f,captured,input,service,issued,get imports(){return imports},setBytes:v=>{bytes=v},setFailure:v=>{failSecond=v}};
}
for(const mode of ['async','sync'])test(`two-resource ${mode} capture -> held imports -> whole human review -> admit -> no-byte restart readback`,async t=>{
 const x=await twoIssuedResources(t,mode),{f,input}=x,s=x.service(),prepared=await s.prepare(f.branch.id,f.source.id,input);
 assert.equal(prepared.state,'awaiting_disclosure');assert.equal(prepared.resources.length,2);assert.equal(new Set(prepared.resources.map(r=>r.destination.projectId)).size,1);
 for(const item of prepared.resources)assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agent_activations WHERE scope_key=?').get(`conversation:${item.destination.conversationId}`).n,0);
 const preview=await s.disclosures.prepare(f.branch.id,f.source.id,prepared.admissionId);assert.ok(preview.facts.length);
 await assert.rejects(s.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash),/approval/);
 await s.disclosures.choose(f.branch.id,f.source.id,prepared.admissionId,{commandKey:'approve-group',action:'approve',reviewHash:preview.reviewHash,expectedRevision:0});
 const admitted=await s.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash);assert.equal(admitted.state,'admitted');assert.equal(admitted.receipt.owners.length,2);
 assert.equal(new Set(admitted.receipt.owners.map(o=>o.executionId)).size,1);
 assert.equal(admitted.receipt.owners.flatMap(o=>o.requestBindings).length,2);
 assert.equal(admitted.receipt.activationIds.length,1,'only the selected open second root wakes after both imports/owners commit');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resources WHERE execution_id=?').get(admitted.receipt.owner.executionId).n,2);
 const before=x.imports;x.setBytes(false);await f.reopen();const replay=await x.service().admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash);
 assert.deepEqual(replay.receipt,admitted.receipt);assert.equal(x.imports,before);
});
for(const mode of ['async','sync'])test(`two-resource ${mode} composer second-import failure rolls back all graph owners and receipts`,async t=>{
 const x=await twoIssuedResources(t,mode),{f,input}=x,s=x.service(),p=await s.prepare(f.branch.id,f.source.id,input),preview=await s.disclosures.prepare(f.branch.id,f.source.id,p.admissionId);
 await s.disclosures.choose(f.branch.id,f.source.id,p.admissionId,{commandKey:'approve',action:'approve',reviewHash:preview.reviewHash,expectedRevision:0});
 x.setFailure(true);await assert.rejects(s.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash),/injected final completion/);
 assert.equal(f.store.sqlite.prepare('SELECT state FROM coordination_destination_admissions WHERE id=?').get(p.admissionId).state,'staged');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resources WHERE execution_id=?').get(p.resources[0].destination.executionId).n,0);
 for(const item of p.resources){const slot=f.store.sqlite.prepare('SELECT stage_json FROM coordination_destination_group_chats WHERE admission_id=? AND source_chat_id=?').get(p.admissionId,item.custody.sourceChatId);assert.equal(f.store.getAgentCreationOperation(JSON.parse(slot.stage_json).importPlan.creationOperationId).status,'canonical_committed');}
 x.setFailure(false);assert.equal((await s.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash)).state,'admitted');
});
for(const mode of ['async','sync'])test(`two-resource ${mode} second-policy change invalidates whole review and no-byte revocation remains possible`,async t=>{
 const x=await twoIssuedResources(t,mode),{f,input}=x,s=x.service(),p=await s.prepare(f.branch.id,f.source.id,input),preview=await s.disclosures.prepare(f.branch.id,f.source.id,p.admissionId);
 await s.disclosures.choose(f.branch.id,f.source.id,p.admissionId,{commandKey:'approve',action:'approve',reviewHash:preview.reviewHash,expectedRevision:0});
 const policies=new CapabilityPolicyStore(f.store.sqlite);policies.put({scopeKind:'chat',scopeId:p.resources[1].destination.conversationId,expectedRevision:0,restrictedCapabilityIds:[]});
 await assert.rejects(s.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash),/approval/);
 x.setBytes(false);const revoked=await s.disclosures.choose(f.branch.id,f.source.id,p.admissionId,{commandKey:'revoke',action:'revoke',reviewHash:preview.reviewHash,expectedRevision:1});
 assert.equal(revoked.active,false);assert.equal(revoked.state,'revoked');
});
test('two-resource saved host/custody omission or rehashed changed generation refuses before destination effects',async t=>{
 const x=await twoIssuedResources(t,'async'),{f,input}=x,db=f.store.sqlite,row=db.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(input.checkpointId),original=JSON.parse(row.snapshot_json);
 for(const mutate of [s=>s.issuedGroupCustody.pop(),s=>s.selected.resources[1].generation++,s=>s.issuedContinuation.audit.splice(s.issuedContinuation.audit.findIndex(e=>e.kind==='resource_created'),1)]){
  const value=structuredClone(original);mutate(value);if(value.issuedContinuation.audit)value.issuedContinuation.auditSha256=hash(stableJson(value.issuedContinuation.audit));
  const changedHash=hash(stableJson(value));corruptCheckpoint(db,input.checkpointId,stableJson(value),changedHash);
  await assert.rejects(x.service().prepare(f.branch.id,f.source.id,{...input,expectedHash:changedHash}),/integrity|custody|unsupported/);assert.equal(x.imports,0);
 }
 corruptCheckpoint(db,input.checkpointId,row.snapshot_json,input.expectedHash);
});

// Deferred count/order extensions use the same complete canonical host fixture.
for(const mode of ['async','sync'])for(const [count,parallel,completed] of [[3,false,[0,1]],[32,false,Array.from({length:31},(_,i)=>i)],[2,true,[]],[3,true,[2]],[4,true,[1,3]],[32,true,[31]]])test(`${count}-resource ${parallel?'parallel':'serial'} ${mode} whole-cut admission and exact restart`,async t=>{
 const x=await twoIssuedResources(t,mode,count,parallel,completed),{f,input}=x,s=x.service(),prepared=await s.prepare(f.branch.id,f.source.id,input);
 assert.equal(prepared.resources.length,count);assert.equal(x.imports,count);assert.equal(prepared.state,'awaiting_disclosure');
 const preview=await s.disclosures.prepare(f.branch.id,f.source.id,prepared.admissionId);
 await s.disclosures.choose(f.branch.id,f.source.id,prepared.admissionId,{commandKey:'approve-count',action:'approve',reviewHash:preview.reviewHash,expectedRevision:0});
 const admitted=await s.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash);
 assert.equal(admitted.receipt.owners.length,count);assert.equal(admitted.receipt.owners.flatMap(o=>o.requestBindings).length,count);
 assert.equal(new Set(admitted.receipt.owners.flatMap(o=>o.requestBindings).map(b=>b.sourceRequestId)).size,count);
 assert.equal(admitted.receipt.activationIds.length,count-completed.length,'only selected open resource roots wake');
 let wholeGraph;
 for(const item of prepared.resources){
  const owner=admitted.receipt.owners.find(o=>o.resourceStepId===item.destination.resourceStepId);assert.ok(owner);
  const command=f.store.sqlite.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(owner.executionId,owner.receiptId);
  const result=JSON.parse(command.result_json);wholeGraph??=result.coordinationDestination;assert.deepEqual(result.coordinationDestination,wholeGraph);
  for(const key of ['restorationId','checkpointId','checkpointHash','requestMap','updateMap','joinMap'])assert.deepEqual(wholeGraph[key],admitted.receipt[key]);
  assert.ok(result.readiness.checkpointHash);
 }
 const imports=x.imports;x.setBytes(false);await f.reopen();assert.deepEqual((await x.service().admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash)).receipt,admitted.receipt);assert.equal(x.imports,imports);
});
for(const parallel of [false,true])test(`three-resource ${parallel?'parallel':'serial'} last completion rollback and non-first policy invalidation`,async t=>{
 const x=await twoIssuedResources(t,'sync',3,parallel),{f,input}=x,s=x.service(),p=await s.prepare(f.branch.id,f.source.id,input),preview=await s.disclosures.prepare(f.branch.id,f.source.id,p.admissionId);
 await s.disclosures.choose(f.branch.id,f.source.id,p.admissionId,{commandKey:'approve-last',action:'approve',reviewHash:preview.reviewHash,expectedRevision:0});
 x.setFailure(true);await assert.rejects(s.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash),/injected final completion/);
 assert.equal(f.store.sqlite.prepare('SELECT state FROM coordination_destination_admissions WHERE id=?').get(p.admissionId).state,'staged');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_resources WHERE execution_id=?').get(p.resources[0].destination.executionId).n,0);
 for(const item of p.resources){const row=f.store.sqlite.prepare('SELECT stage_json FROM coordination_destination_group_chats WHERE admission_id=? AND source_chat_id=?').get(p.admissionId,item.custody.sourceChatId);assert.equal(f.store.getAgentCreationOperation(JSON.parse(row.stage_json).importPlan.creationOperationId).status,'canonical_committed');}
 x.setFailure(false);new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'chat',scopeId:p.resources.at(-1).destination.conversationId,expectedRevision:0,restrictedCapabilityIds:[]});
 await assert.rejects(s.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash),/approval/);
 const current=await s.disclosures.prepare(f.branch.id,f.source.id,p.admissionId);
 await s.disclosures.choose(f.branch.id,f.source.id,p.admissionId,{commandKey:'approve-new-policy',action:'approve',reviewHash:current.reviewHash,expectedRevision:1});
 assert.equal((await s.admit(f.branch.id,f.source.id,input.commandKey,current.reviewHash)).state,'admitted');
});

for(const parallel of [false,true])test(`three-resource ${parallel?'parallel':'serial'} partial capture retains all pins and honest unsupported abandonment after reopen`,async t=>{
 const x=await twoIssuedResources(t,'sync',3,parallel,parallel?[]:[0,1],true),{f}=x;
 const status=x.service().captureStatus(f.branch.id,f.source.id,'two-resource-cut');
 assert.equal(status.state,'capturing');assert.equal(status.cleanupHeld,true);assert.equal(status.abandonment,'unsupported');assert.equal(status.sources.filter(s=>s.sealed).length,2);
 for(const source of status.sources)assert.equal(f.branches.issuedResourceCapturePending(source.resourceStepId),true);
 await f.reopen();assert.deepEqual(x.service().captureStatus(f.branch.id,f.source.id,'two-resource-cut'),status);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.captureKind')='issued_group'").get(f.source.id).n,0);
});
for(const count of [1,33])test(`group capture refuses ${count} resources without issuing group packages`,async t=>{
 await assert.rejects(twoIssuedResources(t,'async',count),/Two to thirty-two/);
});

test('parallel three-resource rehashed audit/custody/member tampering refuses before destination effects',async t=>{
 const x=await twoIssuedResources(t,'async',3,true,[2]),{f,input}=x,db=f.store.sqlite,row=db.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(input.checkpointId),original=JSON.parse(row.snapshot_json);
 const mutations=[
  s=>s.issuedGroupCustody.splice(1,1),
  s=>s.hostDependencies.resourceMembers[1].row.agent_id=s.hostDependencies.resourceMembers[0].row.agent_id,
  s=>{const openings=s.issuedContinuation.audit.filter(e=>e.kind==='resource_created');s.issuedContinuation.audit.splice(s.issuedContinuation.audit.indexOf(openings.at(-1)),1);},
  s=>{const op=s.issuedContinuation.audit.find(e=>e.kind==='resource_operation'&&e.transition_key.includes(s.selected.resources.at(-1).creation_key));op.evidence_json=stableJson({...JSON.parse(op.evidence_json),token:'wrong-resource-token'});},
 ];
 for(const mutate of mutations){
  const value=structuredClone(original);mutate(value);value.issuedContinuation.auditSha256=hash(stableJson(value.issuedContinuation.audit));
  for(const member of value.hostDependencies.resourceMembers)member.sha256=hash(stableJson(member.row));
  value.issuedContinuation.hostCutSha256=hash(stableJson(value.hostDependencies));
  const changedHash=hash(stableJson(value));corruptCheckpoint(db,input.checkpointId,stableJson(value),changedHash);
  await assert.rejects(x.service().prepare(f.branch.id,f.source.id,{...input,expectedHash:changedHash}),/integrity|custody|unsupported/);assert.equal(x.imports,0);
 }
 corruptCheckpoint(db,input.checkpointId,row.snapshot_json,input.expectedHash);
});

for(const parallel of [false,true])test(`group ${parallel?'parallel':'serial'} discovery validates keys and legacy capture disposition`,async t=>{
 const x=await twoIssuedResources(t,'sync',3,parallel),{f}=x,s=x.service(),db=f.store.sqlite;
 await s.prepare(f.branch.id,f.source.id,x.input);
 const page=s.discover({kind:'admissions',limit:1});assert.equal(page.items[0].commandKey,x.input.commandKey);assert.equal(page.items[0].branchId,f.branch.id);
 // Simulate an absent source owner lookup; discovery must use retained audit scope.
 const execution=f.branches.execution;f.branches.execution=()=>undefined;
 try{const absent=s.discover({kind:'admissions'}).items[0];assert.equal(absent.ownerPresent,false);assert.equal(absent.commandKey,x.input.commandKey);}finally{f.branches.execution=execution;}

 const row=db.prepare("SELECT command_key,result_json FROM branch_commands WHERE execution_id=? AND command_key LIKE 'issued-group-capture:%'").get(f.source.id),saved=JSON.parse(row.result_json);
 delete saved.commandKey;delete saved.reviewHash;delete saved.versionId;
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(stableJson(saved),f.source.id,row.command_key);
 const legacy=s.discover({kind:'captures'}).items.find(i=>i.executionId===f.source.id);assert.equal(legacy.discovery,'unsupported_legacy_key');assert.equal(legacy.commandKey,undefined);
 assert.equal(s.captureStatus(f.branch.id,f.source.id,'two-resource-cut').state,'retained');
 await f.reopen();assert.equal(x.service().discover({kind:'captures'}).items.find(i=>i.executionId===f.source.id).discovery,'unsupported_legacy_key');
});

test('group discovery pagination rejects changed inventory and finds partial exact intents after reopen',async t=>{
 const x=await twoIssuedResources(t,'sync',3,true,[],true),{f}=x,s=x.service();
 const preview=s.previewCapture(f.branch.id,f.source.id);
 f.branches.reserveIssuedGroupCapture(f.source.id,'second-reviewed-intent',preview);
 const first=s.discover({kind:'captures',limit:1});assert.equal(first.items.length,1);assert.ok(first.nextCursor);
 const second=s.discover({kind:'captures',limit:1,cursor:first.nextCursor});assert.deepEqual(new Set([...first.items,...second.items].map(item=>item.commandKey)),new Set(['two-resource-cut','second-reviewed-intent']));assert.equal(second.nextCursor,undefined);
 f.branches.reserveIssuedGroupCapture(f.source.id,'third-reviewed-intent',preview);
 assert.throws(()=>s.discover({kind:'captures',limit:1,cursor:first.nextCursor}),/stale/);
 await f.reopen();assert.equal(x.service().discover({kind:'captures'}).items.filter(i=>i.executionId===f.source.id).length,3);
 for(const resource of preview.resources)assert.equal(f.branches.issuedResourceCapturePending(resource.resourceStepId),true);
});

for(const parallel of [false,true])test(`partial group ${parallel?'parallel':'serial'} abandonment commits one disposition and fences revival`,async t=>{
 const x=await twoIssuedResources(t,'sync',3,parallel,parallel?[]:[0,1],true),{f}=x,db=f.store.sqlite;
 for(const item of x.issued)if(db.prepare('SELECT state FROM coordination_requests WHERE id=?').get(item.request).state!=='completed')x.complete(item);
 f.branches.cancel(f.source.id);await f.branches.unitSaver.drain();cancelInertGroupActivations(f,x.issued);
 const row=db.prepare("SELECT command_key,result_json FROM branch_commands WHERE execution_id=? AND command_key LIKE 'issued-group-capture:%'").get(f.source.id),l=f.branches.custodyLifecycle;
 const originalSources=JSON.parse(row.result_json).sources,nonFirst=originalSources[1].intent.resourceStepId;
 db.prepare('UPDATE branch_resources SET generation=generation+1 WHERE step_execution_id=?').run(nonFirst);
 assert.equal(l.inspectGroupCapture(f.source.id,row.command_key).abandonmentAllowed,false);
 for(const source of originalSources)assert.equal(f.branches.issuedResourceCapturePending(source.intent.resourceStepId),true);
 db.prepare('UPDATE branch_resources SET generation=generation-1 WHERE step_execution_id=?').run(nonFirst);
 const review=l.inspectGroupCapture(f.source.id,row.command_key);assert.equal(review.abandonmentAllowed,true);
 const input={executionId:f.source.id,captureKey:row.command_key,commandKey:'whole-group-abandon',captureSha256:review.captureSha256,expectedRevision:review.revision};
 const proofs=review.members.map(m=>({custodyId:m.custodyId,sourceSha256:m.sourceSha256,revision:'inert-durable-package-receipt'}));let calls=0;
 assert.throws(()=>l.abandonGroupCapture(input,()=>{calls++;return proofs.slice(1);}));assert.equal(calls,1);
 for(const source of review.sources)assert.equal(f.branches.issuedResourceCapturePending(source.intent.resourceStepId),true);
 const receipt=l.abandonGroupCapture(input,inventory=>{calls++;assert.equal(inventory.sources.length,3);return proofs;});assert.equal(calls,2);assert.equal(receipt.state,'abandoned');
 assert.equal(db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(f.source.id,row.command_key).result_json,row.result_json);
 for(const source of review.sources)assert.equal(f.branches.issuedResourceCapturePending(source.intent.resourceStepId),false);
 assert.throws(()=>f.branches.reserveIssuedGroupCapture(f.source.id,'two-resource-cut'),/abandoned/);
 const seal=JSON.parse(row.result_json).receipts[0];assert.throws(()=>db.transaction(()=>f.branches.sealIssuedGroupMember(f.source.id,'two-resource-cut',seal))(),/abandoned/);
 await f.reopen();assert.deepEqual(f.branches.custodyLifecycle.abandonGroupCapture(input,()=>proofs),receipt);
 assert.throws(()=>f.branches.custodyLifecycle.abandonGroupCapture(input,()=>proofs.map((p,i)=>i? p:{...p,revision:'changed'})),/proof replay differs/);
});

// Compose the actual Branch group hook and host package protocol; payloads remain synthetic.
test('whole-group host filesystem success and SQL failure retain all canonical Branch pins',async t=>{
 const x=await twoIssuedResources(t,'sync',3,false,[0,1],true),{f}=x,db=f.store.sqlite;
 for(const item of x.issued)if(db.prepare('SELECT state FROM coordination_requests WHERE id=?').get(item.request).state!=='completed')x.complete(item);
 f.branches.cancel(f.source.id);await f.branches.unitSaver.drain();cancelInertGroupActivations(f,x.issued);
 const row=db.prepare("SELECT * FROM branch_commands WHERE execution_id=? AND command_key LIKE 'issued-group-capture:%'").get(f.source.id),capture=JSON.parse(row.result_json);
 const payload='inert original package bytes';
 capture.receipts=capture.receipts.map(receipt=>({...receipt,sha256:hash(payload),byteLength:Buffer.byteLength(payload)}));
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(stableJson(capture),f.source.id,row.command_key);
 const dataDir=mkdtempSync(join(tmpdir(),'composed-group-host-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
 const directory=join(dataDir,'checkpoint-package-custody');mkdirSync(directory,{mode:0o700});
 for(const source of capture.sources){
  const id=hash(source.checkpointId),receipt=capture.receipts.find(receipt=>receipt.checkpointId===source.checkpointId);
  writeFileSync(join(directory,id+'.payload'),payload);writeFileSync(join(directory,id+'.pending.json'),JSON.stringify({...source,state:'failed'}));
  if(receipt)writeFileSync(join(directory,id+'.json'),JSON.stringify(receipt));
 }
 const {checkpointGroupCaptureAbandonment}=await import('../../apps/server/dist/checkpoint-group-capture-abandonment.js');
 const api=checkpointGroupCaptureAbandonment(dataDir,db,()=>f.branches.custodyLifecycle),selection={executionId:f.source.id,captureKey:row.command_key};
 const review=api.review(selection),input={...selection,commandKey:'whole-host-command',reviewSha256:review.reviewSha256,preserveEvidence:true};
 db.exec("CREATE TRIGGER group_host_failure BEFORE INSERT ON host_lifecycle_commits WHEN NEW.kind='checkpoint_group_abandonment' BEGIN SELECT RAISE(ABORT,'injected host SQL failure'); END");
 assert.throws(()=>api.abandon(input),/injected host SQL failure/);
 for(const source of capture.sources)assert.equal(f.branches.issuedResourceCapturePending(source.intent.resourceStepId),true);
 assert.equal(db.prepare("SELECT count(*) n FROM branch_commands WHERE command_key LIKE 'group-custody-abandoned:%'").get().n,0);
 db.exec('DROP TRIGGER group_host_failure');const result=api.abandon(input);assert.equal(result.packages.length,3);
 for(const source of capture.sources)assert.equal(f.branches.issuedResourceCapturePending(source.intent.resourceStepId),false);
 assert.deepEqual(api.abandon(input),result);
 const original=capture.sources[2],id=hash(original.checkpointId),receipt=result.packages.find(receipt=>receipt.custodyId===id);
 assert.equal(readFileSync(join(receipt.evidenceDirectory,id+'.payload'),'utf8'),payload);
 writeFileSync(join(receipt.evidenceDirectory,id+'.payload'),'changed');assert.throws(()=>api.abandon(input),/evidence changed/);
});

// Deferred audit composition; synthetic removal tests retained identity, not deletion eligibility.
test('operator group journal readback survives source owner loss without current disclosure substitution',async t=>{
 const x=await twoIssuedResources(t,'sync'),{f,input}=x,s=x.service(),db=f.store.sqlite;
 const prepared=await s.prepare(f.branch.id,f.source.id,input),preview=await s.disclosures.prepare(f.branch.id,f.source.id,prepared.admissionId);
 await s.disclosures.choose(f.branch.id,f.source.id,prepared.admissionId,{commandKey:'audit-fixture-approval',action:'approve',reviewHash:preview.reviewHash,expectedRevision:0});
 const admitted=await s.admit(f.branch.id,f.source.id,input.commandKey,preview.reviewHash);await f.branches.unitSaver.drain();
 const selection=s.discover({kind:'admissions'}).items.find(item=>item.admissionId===prepared.admissionId).auditSelection;
 const captureSelection=s.discover({kind:'captures'}).items.find(item=>item.commandKey==='two-resource-cut').auditSelection;
 const {groupJournalAudit}=await import('../../apps/server/dist/group-journal-audit.js');
 const audit=groupJournalAudit(db,new CoordinationV3Store(db)),changes=db.prepare('SELECT total_changes() n').get().n;
 const initial=audit.read(selection);assert.deepEqual(initial.receipt.requestMap,admitted.receipt.requestMap);assert.equal(initial.actionEligible,false);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 db.prepare('DELETE FROM coordination_destination_group_chats WHERE admission_id=?').run(prepared.admissionId);
 const slotChanges=db.prepare('SELECT total_changes() n').get().n;
 assert.deepEqual(audit.read(selection).receipt,initial.receipt);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,slotChanges);
 assert.throws(()=>new CoordinationV3DestinationAdmissionAuthority(db,()=>{},true).source(db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(prepared.admissionId)),/Group Chat reservation map/);
 db.pragma('foreign_keys = OFF');db.prepare('DELETE FROM branch_executions WHERE id=?').run(f.source.id);
 assert.throws(()=>s.captureStatus(f.branch.id,f.source.id,'two-resource-cut'),/owner unavailable/);
 const historical=audit.read(selection);assert.equal(historical.sourceOwnerPresent,false);assert.equal(historical.currentAuthority,false);assert.equal(historical.held,true);assert.deepEqual(historical.receipt.agentMap,admitted.receipt.agentMap);
 assert.equal(audit.read(captureSelection).capture.receipts.length,2);
 const plan=JSON.parse(db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(f.source.id,selection.journalKey).result_json),resource=plan.reservation.resources[1];
 db.prepare('UPDATE agent_creation_operations SET conversation_id=? WHERE id=?').run('wrong-owner',historical.imports[1].operationId);
 assert.throws(()=>audit.read(selection),/import ownership/);
 db.prepare('UPDATE agent_creation_operations SET conversation_id=? WHERE id=?').run(resource.destination.conversationId,historical.imports[1].operationId);
 const original=db.prepare('SELECT receipt_json FROM coordination_destination_admissions WHERE id=?').get(prepared.admissionId).receipt_json,receipt=JSON.parse(original);
 db.exec('DROP TRIGGER coordination_destination_identity_immutable');
 receipt.requestMap[Object.keys(receipt.requestMap)[0]]='wrong-mapped-request';db.prepare('UPDATE coordination_destination_admissions SET receipt_json=? WHERE id=?').run(stableJson(receipt),prepared.admissionId);
 assert.throws(()=>audit.read(selection),/map differs/);db.prepare('UPDATE coordination_destination_admissions SET receipt_json=? WHERE id=?').run(original,prepared.admissionId);
});

for(const mode of ['async','sync'])test(`called issued owner tree ${mode} captures exact parent/child custody and refuses ordinary rewind`,async t=>{
 const f=await reservationHistoryFixture(t,mode,true,false,false,false,true),prefix=await f.claim();f.settle(prefix);
 const child=await openCalledTreeResource(f.store,f.branches,f.branches.localConfiguration(f.branch.id).directories.root,f.source.id,f.branch.id);
 const db=f.store.sqlite,preview=f.branches.previewIssuedTreeCapture(f.root.id);
 assert.equal(preview.resources.length,2);assert.deepEqual(new Set(preview.resources.map(r=>r.executionId)),new Set([f.root.id,f.source.id]));
 const owners=preview.snapshot.continuation.owners;
 assert.equal(owners.find(o=>o.executionId===f.source.id).selected.execution[0].parent_execution_id,f.root.id);
 const expected={reviewHash:preview.reviewHash,versionId:preview.versionId};
 assert.throws(()=>f.branches.reserveIssuedTreeCapture(f.root.id,'called-tree',{...expected,reviewHash:'f'.repeat(64)}),/preview changed/);
 const v=f.branches.reserveIssuedTreeCapture(f.root.id,'called-tree',expected);
 for(const source of v.sources){const owner=owners.find(o=>o.executionId===source.intent.executionId);assert.ok(owner);assert.equal(source.intent.bindingSha256,owner.bindingHash);assert.equal(source.sourceChatId,owner.selected.resources[0].chat_id);assert.equal(f.branches.issuedResourceCapturePending(source.intent.resourceStepId),true);}
 const receipts=v.sources.map(source=>({...source,version:1,custodyId:hash(source.checkpointId),boundaryId:'inert-called-issued',sha256:hash(stableJson(source)),byteLength:1}));
 db.transaction(()=>f.branches.sealIssuedTreeMember(f.root.id,'called-tree',receipts[0]))();
 assert.equal(f.branches.issuedTreeCapture(f.root.id,'called-tree').state,'capturing');
 const request=db.prepare('SELECT updated_at FROM coordination_requests WHERE id=?').get(child.requestId);
 db.prepare('UPDATE coordination_requests SET updated_at=? WHERE id=?').run('changed-child-cut',child.requestId);
 assert.throws(()=>db.transaction(()=>f.branches.sealIssuedTreeMember(f.root.id,'called-tree',receipts[1]))(),/frontier changed/);
 db.prepare('UPDATE coordination_requests SET updated_at=? WHERE id=?').run(request.updated_at,child.requestId);
 db.transaction(()=>f.branches.sealIssuedTreeMember(f.root.id,'called-tree',receipts[1]))();
 const retained=f.branches.issuedTreeCapture(f.root.id,'called-tree');assert.equal(retained.state,'retained');
 const saved=captureBytes(f,retained.checkpointId);assert.equal(saved.restore_supported,false);assert.deepEqual(saved.issuedGroupCustody,receipts);
 const counts=allocationCounts(f),maps=f.branches.issuedTreeFreshOwnerMap(f.root.id,'called-tree');assert.deepEqual(allocationCounts(f),counts);
 const mappedChild=maps.owners.find(o=>o.sourceExecutionId===f.source.id),mappedRoot=maps.owners.find(o=>o.sourceExecutionId===f.root.id);
 assert.equal(mappedChild.parentExecutionId,mappedRoot.executionId);assert.notEqual(mappedChild.conversationId,mappedRoot.conversationId);
 assert.equal(maps.actionEligible,false);assert.throws(()=>f.branches.beginDeletion(f.parent.id),/custody holds/);assert.throws(()=>f.branches.deleteBranch(f.branch.id),/custody holds/);
 assert.throws(()=>f.branches.rewindHistorical(f.parent.id,f.root.id,retained.checkpointId,retained.checkpointHash,'called-no-admission'),/unsupported|continuation|settled/);
 const row=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=?').get(retained.checkpointId);
 corruptCheckpoint(db,retained.checkpointId,row.snapshot_json,'f'.repeat(64));
 assert.throws(()=>f.branches.issuedTreeCapture(f.root.id,'called-tree'),/sealed checkpoint/);
 corruptCheckpoint(db,retained.checkpointId,row.snapshot_json,row.content_hash);
 await f.reopen();assert.equal(f.branches.issuedTreeCapture(f.root.id,'called-tree').checkpointHash,retained.checkpointHash);
});

// Deferred real serial/local-parallel chain source. No execution/qualification claim; provider/package handles remain inert.
for(const mode of ['async','sync'])for(const [parallel,generation,budgetOverride] of [[false,2,100],[false,2],[false,3],[false,32],[true,1],[true,2],[true,32],['map',1],['map',2],['map',32]])test(`${parallel?'local parallel':'serial'} ${parallel==='map'?'map':'fork'} generation ${generation} ${mode} discloses every prior generation and preserves budget`,async t=>{
 const maxAttempts=budgetOverride??generation+1;
 const f=await reservationHistoryFixture(t,mode,false,parallel,maxAttempts),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);
 const db=f.store.sqlite,coordination=new CoordinationV3Store(db),dir=f.branches.localConfiguration(f.branch.id).directories.root;
 const {ProviderProcessAuthority}=await import('../../apps/server/dist/provider-process-authority.js');
 const seals=[],requests=[],agents=[],chats=[];
 for(let g=0;g<generation;g++){
  const opened=await openCalledTreeResource(f.store,f.branches,dir,f.source.id,f.branch.id);requests.push(opened.requestId);agents.push(opened.agentId);chats.push(opened.chatId);
  assert.equal(db.prepare('SELECT generation FROM branch_resources WHERE step_execution_id=?').get(opened.stepId).generation,g);
  coordination.updateRequest({requestId:opened.requestId,updateId:`failed-chain-${g}`,kind:'failed',actor:{kind:'agent',id:opened.agentId},payload:{text:`known failed generation ${g}`}});
  for(let n=0;n<20&&!db.prepare('SELECT retry_draining FROM branch_resources WHERE step_execution_id=?').get(opened.stepId).retry_draining;n++){f.branches.advance();await f.branches.unitSaver.drain();}
  assert.equal(db.prepare('SELECT retry_draining FROM branch_resources WHERE step_execution_id=?').get(opened.stepId).retry_draining,1);
  const fence=f.branches.fenceGenerationExit(opened.stepId);assert.equal(fence.identity.generation,g);
  const agent=f.store.getAgent(opened.agentId),runId=randomUUID(),now=new Date().toISOString();
  db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,terminal_at) VALUES(?,?,?,'completed','fixture',?,1,'injected',?,?,?,?)").run(runId,agent.projectId,agent.id,now,now,now,now,now);
  for(const activation of db.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND state IN ('pending','retry_pending')").all(agent.id))coordination.cancelPendingActivation({activationId:activation.id,projectId:agent.projectId,idempotencyKey:`chain-exit:${activation.id}`});
  let alive=true;const handle={processIdentity:{pid:525252+g,pgid:525252+g,birthMarker:`inert-chain-${g}`},isAlive:()=>alive,close:async()=>{alive=false;}};
  const authority=new ProviderProcessAuthority(db,`inert-chain-provider-${g}`);authority.recover=()=>handle;authority.register(handle,{purpose:'provider Run',projectId:agent.projectId,agentId:agent.id,runId,runFence:1});await authority.terminateAgents(new Set([agent.id]),'inert complete chain');
  const journal=f.branches.reserveGenerationExit(f.source.id,opened.stepId,g);
  assert.deepEqual(journal.envelope.hostDependencies.roots.map(r=>r.requestId),[opened.requestId]);
  assert.equal(journal.envelope.selected.attempts.filter(a=>a.step_execution_id===opened.stepId).length,g+2);
  const receipt={...journal.source,version:1,custodyId:hash(journal.source.checkpointId),boundaryId:`inert-chain-seal-${g}`,sha256:hash(`private generation ${g}`),byteLength:1};
  db.transaction(()=>f.branches.sealGenerationExit(f.source.id,opened.stepId,g,receipt))();seals.push(f.branches.generationExitCapture(f.source.id,opened.stepId,g));
  const deletion=f.store.previewAgentDeletion([agent.id]);f.store.deleteAgentSubtrees([agent.id],deletion.previewHash,x=>coordination.handleAgentDeletion(x));
  const chat=f.store.commitConversationDeletion(opened.chatId);f.store.finishConversationDeletionStorageCleanup(chat);f.store.markConversationDeletionServerCleanupComplete(opened.chatId);f.branches.resourceRetired(opened.stepId);await f.branches.unitSaver.drain();
 }
 const current=await openCalledTreeResource(f.store,f.branches,dir,f.source.id,f.branch.id),preview=f.branches.previewGenerationHistoryCapture(f.source.id);
 assert.equal(preview.generation,generation);assert.equal(preview.consumedAttempts,generation+1);assert.equal(preview.maxAttempts,maxAttempts);
 assert.deepEqual(preview.historicalPartition.map(v=>v.generation),Array.from({length:generation},(_,i)=>i));
 assert.ok(preview.historicalPartition.every(v=>stableJson(v.discloseTo)===stableJson([current.agentId])));
 if(generation>1)assert.throws(()=>f.branches.previewGenerationOneCapture(f.source.id),/requires current generation one/);else assert.equal(f.branches.previewGenerationOneCapture(f.source.id).generation,1);
 assert.equal(preview.historyKind,parallel?'local_parallel':'serial');
 // Every missing prior journal is refused independently, including the oldest retained generation.
 for(let g=0;g<generation;g++)assert.throws(()=>db.transaction(()=>{db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,`resource-generation-retired:${current.stepId}:${g}`);assert.throws(()=>f.branches.previewGenerationHistoryCapture(f.source.id),/retirement linkage/);throw Error('restore chain');})(),/restore chain/);
 for(let g=0;g<generation;g++)assert.throws(()=>db.transaction(()=>{db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,`resource-generation-exit:${current.stepId}:${g}`);assert.throws(()=>f.branches.previewGenerationHistoryCapture(f.source.id),/prior-generation seal/);throw Error('restore seal');})(),/restore seal/);
 assert.throws(()=>f.branches.reserveIssuedResourceCapture(f.source.id,current.stepId,generation,'chain-cut','0'.repeat(64)),/preview/);
 const journal=f.branches.reserveIssuedResourceCapture(f.source.id,current.stepId,generation,'chain-cut',preview.reviewHash);
 assert.deepEqual(journal.snapshot.hostDependencies.roots.map(r=>r.requestId),[current.requestId]);assert.equal(journal.snapshot.selected.attempts.find(a=>a.step_execution_id===current.stepId).number,generation+1);
 assert.equal((journal.snapshot.issuedContinuation.generationRetry.history??[journal.snapshot.issuedContinuation.generationRetry]).length,generation);
 for(const tamper of [...(generation>1?[v=>v.history.pop(),v=>v.history.reverse(),v=>{v.history[1].selection={...v.history[0].selection};},v=>{v.history[0].retirementSha256='0'.repeat(64);}]:[v=>{v.retirementSha256='0'.repeat(64);}]),v=>{v.originalSelected.attempts=v.originalSelected.attempts.filter(a=>a.step_execution_id!==current.stepId||a.number!==1);},...(parallel?[v=>{v.originalSelected.steps.find(s=>s.id===current.stepId).path_id=v.originalSelected.paths.find(p=>p.parent_path_id===null).id;},v=>{v.originalSelected.steps.find(s=>s.id!==current.stepId).state='prepared';},v=>{v.originalSelected.paths.find(p=>p.parent_path_id===null).state='active';},v=>{v.originalSelected.attempts.find(a=>a.step_execution_id===current.stepId&&a.number===generation+1).request_id=v.originalSelected.attempts.find(a=>a.step_execution_id===current.stepId&&a.number===1).request_id;},v=>{v.originalSelected.attempts.find(a=>a.step_execution_id===current.stepId&&a.number===1).state='outcome_unknown';}]:[])]){
  const changed=structuredClone(journal.snapshot.issuedContinuation);tamper(changed.generationRetry);
  assert.equal(issuedResourceContinuationSupported(db,f.source.id,journal.snapshot.selected,journal.snapshot.hostDependencies,changed),false,'omitted/reordered/aliased/rehashed attempt history refuses');
 }

 const receipt={...journal.source,version:1,custodyId:hash(journal.source.checkpointId),boundaryId:'inert-current-chain',sha256:hash('current chain package'),byteLength:1};
 assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE branch_executions SET wait_reason=? WHERE id=?').run('changed chain during package capture',f.source.id);assert.throws(()=>f.branches.sealIssuedResourceCapture(f.source.id,current.stepId,'chain-cut',receipt),/frontier changed/);throw Error('restore current cut');})(),/restore current cut/);
 db.transaction(()=>f.branches.sealIssuedResourceCapture(f.source.id,current.stepId,'chain-cut',receipt))();
 const saved=f.branches.issuedResourceCapture(f.source.id,current.stepId,'chain-cut');
 const {BranchResourceService}=await import('../../apps/server/dist/branch-resource-service.js');const resourceService=new BranchResourceService(f.branches,f.store,async()=>assert.fail('delete'),async()=>assert.fail('create'),async()=>assert.fail('delete Chat'));
 assert.deepEqual(resourceService.listGenerationHistoryCaptures(f.source.id,current.stepId)[0].historicalPartition,preview.historicalPartition);
 // Empty-client recovery uses only saved capture identity, never a new preview.
 const status=resourceService.issuedResourceCaptureStatus(f.source.id,current.stepId,'chain-cut'),budget=status.retryBudget;
 assert.equal(budget.state,'verified');assert.equal(status.consumedAttempts,generation+1);assert.equal(status.maxAttempts,maxAttempts);assert.match(budget.evidenceHash,/^[a-f0-9]{64}$/);
 assert.deepEqual(resourceService.listGenerationHistoryCaptures(f.source.id,current.stepId)[0].retryBudget,budget);assert.equal(status.historyKind,preview.historyKind);
 assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE branches SET configuration_json=? WHERE id=?').run('{}',f.branch.id);assert.deepEqual(resourceService.issuedResourceCaptureStatus(f.source.id,current.stepId,'chain-cut').retryBudget,budget);throw Error('restore mutable policy');})(),/restore mutable policy/);

 const {issuedCaptureRetryBudget}=await import('../../packages/agents/dist/index.js');
 const corrupted=structuredClone(saved);corrupted.snapshot.issuedContinuation.generationRetry.originalSelected.attempts.find(a=>a.number===generation+1).number=1;
 assert.throws(()=>issuedCaptureRetryBudget(db,f.source.id,corrupted),/budget proof/);
 const legacy=structuredClone(saved);delete legacy.snapshot.issuedContinuation.generationRetry;
 assert.deepEqual(issuedCaptureRetryBudget(db,f.source.id,legacy),{state:'unavailable',reason:'missing_saved_retry_proof'});

 coordination.updateRequest({requestId:current.requestId,updateId:'current-chain-completed',kind:'completed',actor:{kind:'agent',id:current.agentId},payload:{text:'current chain result'}});
 const suffix=await f.claim();f.settle(suffix);await f.branches.unitSaver.drain();
 const deletion=f.store.previewAgentDeletion([current.agentId]);f.store.deleteAgentSubtrees([current.agentId],deletion.previewHash,x=>coordination.handleAgentDeletion(x));
 const chat=f.store.commitConversationDeletion(current.chatId);f.store.finishConversationDeletionStorageCleanup(chat);f.store.markConversationDeletionServerCleanupComplete(current.chatId);f.branches.resourceRetired(current.stepId);await f.branches.unitSaver.drain();
 const x=await issuedDestinationFixture(t,mode,false,{f,saved}),{composer,disclosure}=x.services();
 const prepared=await composer.prepare(f.branch.id,f.source.id,x.input),review=await disclosure.prepare(f.branch.id,f.source.id,prepared.admissionId);
 assert.equal(review.facts.filter(v=>v.kind==='historical_generation').length,generation);
 const destinationMap=f.branches.issuedDestinationPlan(f.branch.id,f.source.id,x.input.commandKey).idMap;
 for(const item of journal.snapshot.selected.items)assert.equal(destinationMap[item.id],`${destinationMap[item.map_invocation_id]}:${item.item_index}`);
 await disclosure.choose(f.branch.id,f.source.id,prepared.admissionId,{commandKey:'all-chain-human-approval',action:'approve',reviewHash:review.reviewHash,expectedRevision:0});
 const originalCompose=f.branches.composeIssuedDestination;f.branches.composeIssuedDestination=function(...args){originalCompose.apply(this,args);throw Error('chain owner rollback');};
 await assert.rejects(composer.admit(f.branch.id,f.source.id,x.input.commandKey,review.reviewHash),/chain owner rollback/);f.branches.composeIssuedDestination=originalCompose;
 assert.equal(db.prepare("SELECT 1 FROM host_lifecycle_commits WHERE kind='coordination-historical-partition' AND identity=?").get(prepared.admissionId),undefined);
 const admitted=await composer.admit(f.branch.id,f.source.id,x.input.commandKey,review.reviewHash);
 assert.deepEqual(admitted.receipt.historicalPartition.map(v=>v.selection),preview.historicalPartition);assert.ok(admitted.receipt.historicalPartition.every(v=>v.historical&&v.dispatchable===false));
 assert.deepEqual(Object.keys(admitted.receipt.requestMap),[current.requestId]);assert.deepEqual(Object.keys(admitted.receipt.agentMap),[current.agentId]);
 const destinationAttempts=db.prepare('SELECT a.* FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? AND s.id=?').all(prepared.destination.executionId,admitted.receipt.owner.resourceStepId);
 assert.deepEqual(destinationAttempts.map(a=>a.number),[generation+1]);
 assert.ok(requests.every(id=>!Object.hasOwn(admitted.receipt.requestMap,id)));assert.ok(agents.every(id=>!Object.hasOwn(admitted.receipt.agentMap,id)));
 if(generation===1||!parallel){
  // Real issued owner/custody and admission receipt exercise historical fallback without fabricated current pins.
  const row=db.prepare('SELECT * FROM coordination_destination_admissions WHERE id=?').get(prepared.admissionId),sourceAudit=new CoordinationV3DestinationAdmissionAuthority(db,()=>assert.fail('audit cannot deliver'));
  assert.throws(()=>db.transaction(()=>{
   for(const seal of seals){db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key IN (?,?)').run(f.source.id,`resource-generation-exit:${seal.identity.stepId}:${seal.identity.generation}`,`resource-generation-retired:${seal.identity.stepId}:${seal.identity.generation}`);db.prepare('DELETE FROM branch_unit_snapshots WHERE id=?').run(seal.checkpointId);}
   const changes=db.prepare('SELECT total_changes() n').get().n;
   assert.deepEqual(sourceAudit.source(row,'audit').reservation,JSON.parse(row.reservation_json));assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
   assert.throws(()=>sourceAudit.source({...row,id:undefined},'audit'),/sealed historical/);assert.throws(()=>sourceAudit.source({...row,id:'foreign-admission'},'audit'),/^Error: Committed historical evidence receipt unavailable$/);
   const immutable=db.prepare("SELECT receipt_sha256 FROM host_lifecycle_commits WHERE kind='coordination-historical-partition' AND identity=?").get(prepared.admissionId);
   db.exec('DROP TRIGGER host_lifecycle_commit_immutable_update');db.prepare("UPDATE host_lifecycle_commits SET receipt_sha256=? WHERE kind='coordination-historical-partition' AND identity=?").run('0'.repeat(64),prepared.admissionId);
   assert.throws(()=>sourceAudit.source(row,'audit'),/Immutable historical evidence receipt differs/);db.prepare("UPDATE host_lifecycle_commits SET receipt_sha256=? WHERE kind='coordination-historical-partition' AND identity=?").run(immutable.receipt_sha256,prepared.admissionId);
   throw Error('restore genuine historical source');
  })(),/restore genuine historical source/);
 }
 await f.reopen();const read=await x.services().composer.admit(f.branch.id,f.source.id,x.input.commandKey,review.reviewHash);assert.deepEqual(read.receipt,admitted.receipt);
 const restartedResources=new BranchResourceService(f.branches,f.store,async()=>assert.fail('delete'),async()=>assert.fail('create'),async()=>assert.fail('delete Chat'));assert.deepEqual(restartedResources.listGenerationHistoryCaptures(f.source.id,current.stepId)[0].retryBudget,budget);
 // Original remaining budget is preserved, including policies above the evidence count bound.
 new CoordinationV3Store(f.store.sqlite).updateRequest({requestId:read.receipt.requestMap[current.requestId],updateId:'consumed-budget-failure',kind:'failed',actor:{kind:'agent',id:read.receipt.agentMap[current.agentId]},payload:{text:'remaining retry budget is zero'}});
 for(let n=0;n<8;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 const remaining=f.store.sqlite.prepare('SELECT a.number FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? AND s.id=?').all(prepared.destination.executionId,read.receipt.owner.resourceStepId);
 assert.deepEqual(remaining.map(a=>a.number),maxAttempts>generation+1?[generation+1,generation+2]:[generation+1]);
 assert.equal(f.store.sqlite.prepare('SELECT retry_draining FROM branch_resources WHERE step_execution_id=?').get(read.receipt.owner.resourceStepId).retry_draining,maxAttempts>generation+1?1:0);
});

// Deferred SOURCE: actual Branch deletion transaction; package proofs remain synthetic.
test('canonical owner deletion preserves selectable group capture and disposition atomically',async t=>{
 const x=await twoIssuedResources(t,'sync',2,false,[0],true),{f}=x,db=f.store.sqlite;
 for(const item of x.issued)if(db.prepare('SELECT state FROM coordination_requests WHERE id=?').get(item.request).state!=='completed')x.complete(item);
 f.branches.cancel(f.source.id);await f.branches.unitSaver.drain();cancelInertGroupActivations(f,x.issued);
 const original=db.prepare("SELECT * FROM branch_commands WHERE execution_id=? AND command_key LIKE 'issued-group-capture:%'").get(f.source.id);
 const review=f.branches.custodyLifecycle.inspectGroupCapture(f.source.id,original.command_key);
 assert.equal(review.abandonmentAllowed,true);
 f.branches.custodyLifecycle.abandonGroupCapture({executionId:f.source.id,captureKey:original.command_key,commandKey:'retain-audit-on-delete',captureSha256:review.captureSha256,expectedRevision:review.revision},()=>review.members.map(member=>({custodyId:member.custodyId,sourceSha256:member.sourceSha256,revision:'synthetic-durable-package-proof'})));
 const selection=x.service().discover({kind:'captures'}).items.find(item=>item.executionId===f.source.id).auditSelection;
 const {groupJournalAudit}=await import('../../apps/server/dist/group-journal-audit.js');
 const audit=()=>groupJournalAudit(f.store.sqlite,new CoordinationV3Store(f.store.sqlite));
 assert.equal(audit().read(selection).state,'abandoned');
 // Actual canonical Agent/Chat cleanup precedes the final Branch deletion; retention grants no drain proof.
 for(const item of x.issued){
  const preview=f.store.previewAgentDeletion([item.agentId]);
  f.store.deleteAgentSubtrees([item.agentId],preview.previewHash,ids=>new CoordinationV3Store(db).handleAgentDeletion(ids));
  const deletion=f.store.commitConversationDeletion(item.chatId);
  f.store.finishConversationDeletionStorageCleanup(deletion);f.store.markConversationDeletionServerCleanupComplete(item.chatId);
  f.branches.resourceRetired(item.stepId);await f.branches.unitSaver.drain();
 }
 for(let n=0;n<20&&f.branches.execution(f.source.id).state!=='canceled';n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(f.source.id).state,'canceled');
 f.branches.beginDeletion(f.branch.id);f.branches.publishAudit(()=>{});await f.branches.unitSaver.drain();
 db.exec("CREATE TEMP TRIGGER reject_group_retention BEFORE INSERT ON host_lifecycle_commits WHEN NEW.kind='branch-group-journal-retention' BEGIN SELECT RAISE(ABORT,'retention failure'); END");
 assert.throws(()=>f.branches.deleteBranch(f.branch.id),/retention failure/);
 assert.deepEqual(db.prepare('SELECT * FROM branch_commands WHERE execution_id=? AND command_key=?').get(f.source.id,original.command_key),original);
 assert.ok(f.branches.getBranch(f.branch.id));
 db.exec('DROP TRIGGER reject_group_retention');f.branches.deleteBranch(f.branch.id);
 assert.ok(!f.branches.getBranch(f.branch.id));
 assert.equal(db.prepare('SELECT 1 FROM branch_commands WHERE execution_id=?').get(f.source.id),undefined);
 const before=db.prepare('SELECT total_changes() n').get().n;
 const retained=audit().read(selection);assert.equal(retained.sourceOwnerPresent,false);assert.equal(retained.state,'abandoned');assert.equal(retained.currentAuthority,false);assert.equal(retained.actionEligible,false);assert.equal(retained.held,true);
 assert.deepEqual(x.service().discover({kind:'captures'}).items.find(item=>item.executionId===f.source.id).auditSelection,selection);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
 assert.throws(()=>x.service().captureStatus(f.branch.id,f.source.id,'two-resource-cut'),/owner unavailable/);
 await f.reopen();assert.equal(audit().read(selection).state,'abandoned');
});

// Deferred real multi-item generation-zero map consumer: one writer/transaction/admission.
for(const mode of ['async','sync'])for(const count of [2,3,32])test(`map ${count} resources ${mode} exact fresh items and whole admission`,async t=>{
 const x=await twoIssuedResources(t,mode,count,'map',[]),{f,input}=x,s=x.service(),p=await s.prepare(f.branch.id,f.source.id,input);
 const review=await s.disclosures.prepare(f.branch.id,f.source.id,p.admissionId);
 await s.disclosures.choose(f.branch.id,f.source.id,p.admissionId,{commandKey:'map-all-facts',action:'approve',reviewHash:review.reviewHash,expectedRevision:0});
 x.setFailure(true);await assert.rejects(s.admit(f.branch.id,f.source.id,input.commandKey,review.reviewHash),/final completion/);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_resources WHERE execution_id=?').get(p.resources[0].destination.executionId).n,0);
 x.setFailure(false);const admitted=await s.admit(f.branch.id,f.source.id,input.commandKey,review.reviewHash),id=p.resources[0].destination.executionId;
 assert.equal(admitted.receipt.owners.length,count);assert.equal(Object.keys(admitted.receipt.requestMap).length,count);assert.equal(admitted.receipt.activationIds.length,count);
 const items=f.store.sqlite.prepare('SELECT i.* FROM branch_map_items i JOIN branch_map_invocations m ON m.id=i.map_invocation_id WHERE m.execution_id=? ORDER BY i.item_index').all(id);
 assert.equal(items.length,count);for(const item of items)assert.equal(item.id,`${item.map_invocation_id}:${item.item_index}`);
 await f.reopen();x.setBytes(false);assert.deepEqual((await x.service().admit(f.branch.id,f.source.id,input.commandKey,review.reviewHash)).receipt,admitted.receipt);
});

// Deferred real called-owner producer -> settled source -> whole human review -> one group admit.
async function calledTreeDestinationFixture(t,mode){
 const f=await reservationHistoryFixture(t,mode,true,false,false,false,true),prefix=await f.claim();f.settle(prefix);
 const child=await openCalledTreeResource(f.store,f.branches,f.branches.localConfiguration(f.branch.id).directories.root,f.source.id,f.branch.id);
 const db=()=>f.store.sqlite,coord=()=>new CoordinationV3Store(db()),custody=new Map();let bytes=true,fail=false,imports=0;
 const packageFor=receipt=>({schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date(0).toISOString(),sourceLabel:'Tree custody',rootRef:receipt.agentIds[0],agents:receipt.agentIds.map(ref=>({ref,title:'Tree worker',engine:'codex',sourceChat:{ref:receipt.sourceChatId,title:'Original owner'},managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}))});
 const engine={
  captureCheckpoint:async(source,seal)=>{const r={...source,version:1,custodyId:hash(source.checkpointId),boundaryId:'inert-tree-package',sha256:hash(stableJson(source)),byteLength:1};custody.set(r.custodyId,r);db().transaction(()=>seal(r))();return r;},
  readCheckpoint:async r=>{assert.deepEqual(r,custody.get(r.custodyId));if(!bytes)throw Error('missing tree bytes');return packageFor(r);},
  verifyCheckpointNow:r=>{assert.deepEqual(r,custody.get(r.custodyId));if(!bytes)throw Error('missing tree bytes');return r.sha256;},validateAgent:()=>{},
  importAgent:async(projectId,chatId,pkg,engines,key,{branchHooks:hooks})=>{
   imports++;const op=f.store.beginAgentCreationOperation({projectId,conversationId:chatId,actorScope:'user:local-operator',kind:'import',idempotencyKey:key,payloadHash:hash(stableJson(pkg))}).operation,map=Object.fromEntries(pkg.agents.map(a=>[a.ref,randomUUID()]));
   db().transaction(()=>{Object.values(map).forEach((id,index)=>f.store.addAgentCreationOperationMember(op.id,id,index));hooks.stage({creationOperationId:op.id,projectId,conversationId:chatId,agents:Object.entries(map).map(([sourceRef,agentId])=>({sourceRef,agentId})),artifacts:[]});})();await hooks.plan();
   for(const id of Object.values(map))f.store.createAgent(projectId,{title:'Fresh called owner worker',engine:'codex',conversationId:chatId},undefined,id);
   const result={rootAgentId:map[pkg.rootRef],agentIds:Object.values(map),agentRefs:map};hooks.transaction(()=>{f.store.updateAgentCreationOperation(op.id,{status:'canonical_committed',result:{...result,branchDestinationPrepared:true}});hooks.holdForDisclosure();});return result;
  },
  finishDestinationImport:(id,compose)=>{const op=f.store.getAgentCreationOperation(id);compose(op.result,()=>{if(fail)throw Error('called final owner rollback');f.store.updateAgentCreationOperation(id,{status:'completed'});});},
 };
 const {BranchIssuedGroupDestinationService}=await import('../../apps/server/dist/branch-issued-group-destination.js');
 const service=()=>new BranchIssuedGroupDestinationService(f.store,f.branches,coord(),()=>engine),s=service(),preview=s.previewTreeCapture(f.parent.id,f.root.id);
 const saved=await s.captureTree(f.parent.id,f.root.id,'tree-consumer-source',preview);
 coord().updateRequest({requestId:child.requestId,updateId:'tree-child-completed',kind:'completed',actor:{kind:'agent',id:child.agentId},payload:{text:'known child result'}});
 const suffix=await f.claim();f.settle(suffix);await f.branches.unitSaver.drain();
 // The child retires before the parent's call can settle; neither identity is reassigned to the root.
 const receipts=[...saved.receipts].sort((a,b)=>Number(a.intent.executionId===f.root.id)-Number(b.intent.executionId===f.root.id));
 for(const r of receipts){
  for(let n=0;n<8;n++){f.branches.advance();await f.branches.unitSaver.drain();}
  const deletion=f.store.previewAgentDeletion(r.agentIds);f.store.deleteAgentSubtrees(r.agentIds,deletion.previewHash,id=>coord().handleAgentDeletion(id));
  const chat=f.store.commitConversationDeletion(r.sourceChatId);f.store.finishConversationDeletionStorageCleanup(chat);f.store.markConversationDeletionServerCleanupComplete(r.sourceChatId);f.branches.resourceRetired(r.intent.resourceStepId);await f.branches.unitSaver.drain();
 }
 for(let n=0;n<8;n++){f.branches.advance();await f.branches.unitSaver.drain();}
 assert.equal(f.branches.execution(f.root.id).state,'completed');assert.equal(f.branches.execution(f.source.id).state,'completed');
 return {f,saved,service,input:{commandKey:'restore-called-tree',checkpointId:saved.checkpointId,expectedHash:saved.checkpointHash,reconcileEffects:true},setFailure:v=>{fail=v},setBytes:v=>{bytes=v},get imports(){return imports}};
}
for(const mode of ['async','sync'])test(`called owner tree ${mode} retains exact owner ancestry and atomically admits both resources`,async t=>{
 const x=await calledTreeDestinationFixture(t,mode),{f,input}=x,s=x.service(),db=f.store.sqlite;
 const cp=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=?').get(input.checkpointId),forged=JSON.parse(cp.snapshot_json);
 const rootProof=forged.continuation.owners.find(o=>o.executionId===f.root.id),childProof=forged.continuation.owners.find(o=>o.executionId===f.source.id);
 childProof.bindingHash=rootProof.bindingHash;const forgedHash=hash(stableJson(forged));
 corruptCheckpoint(db,input.checkpointId,stableJson(forged),forgedHash);
 const {readIssuedGroup}=await import('../../packages/agents/dist/index.js');assert.throws(()=>readIssuedGroup(db,f.root.id,input.checkpointId,forgedHash),/integrity|replay|custody|differs/);
 corruptCheckpoint(db,input.checkpointId,cp.snapshot_json,cp.content_hash);
 const accepted=db.prepare('SELECT count(*) n FROM branch_executions').get().n;
 db.prepare('UPDATE branches SET enabled=0 WHERE id=?').run(f.branch.id);
 await assert.rejects(s.prepare(f.parent.id,f.root.id,input),/owner unavailable/);assert.equal(db.prepare('SELECT count(*) n FROM branch_executions').get().n,accepted);
 db.prepare('UPDATE branches SET enabled=1 WHERE id=?').run(f.branch.id);
 const p=await s.prepare(f.parent.id,f.root.id,input);
 assert.equal(p.scope,'owner_tree');assert.equal(new Set(p.resources.map(r=>r.destination.executionId)).size,2);
 assert.equal(p.reviewEvidence.state,'verified');assert.equal(p.reviewEvidence.ancestry,'prospective');
 assert.deepEqual(p.reviewEvidence.ownerMap,p.ownerMap);
 const childEvidence=p.reviewEvidence.owners.find(o=>o.sourceExecutionId===f.source.id);
 assert.equal(childEvidence.acceptance.source,'call');assert.ok(Number.isSafeInteger(childEvidence.acceptance.budget.used));
 const savedBudget=structuredClone(childEvidence.acceptance);
 const planRow=db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key LIKE ?').get(f.root.id,'issued-group-destination:%'),originalPlan=JSON.parse(planRow.result_json);
 const badPlan=structuredClone(originalPlan);badPlan.reviewEvidence.owners[0].counters.traversals++;
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key LIKE ?').run(stableJson(badPlan),f.root.id,'issued-group-destination:%');
 assert.throws(()=>s.inspect(f.parent.id,f.root.id,input.commandKey),/review evidence/);
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key LIKE ?').run(planRow.result_json,f.root.id,'issued-group-destination:%');
 // Mutable current quota cannot replace the immutable fresh-acceptance snapshot.
 db.prepare('UPDATE branch_execution_budgets SET allowance=allowance+5,revision=revision+1 WHERE branch_id=?').run(f.branch.id);
 assert.deepEqual(s.inspect(f.parent.id,f.root.id,input.commandKey).reviewEvidence.owners.find(o=>o.sourceExecutionId===f.source.id).acceptance,savedBudget);

 const savedSource=JSON.parse(cp.snapshot_json),childProject=savedSource.continuation.owners.find(o=>o.executionId===f.source.id).hostDependencies.requests[0].row.project_id,getProject=f.store.getProject.bind(f.store);
 f.store.getProject=id=>id===childProject?undefined:getProject(id);await assert.rejects(s.disclosures.prepare(f.parent.id,f.root.id,p.admissionId),/Original Project operator audit-read/);f.store.getProject=getProject;
 const review=await s.disclosures.prepare(f.parent.id,f.root.id,p.admissionId);
 const rootSource=f.branches.issuedTreeCapture(f.root.id,'tree-consumer-source').sources;
 for(const source of rootSource)assert.ok(review.facts.some(v=>v.kind==='request'&&v.content.conversation_id===source.sourceChatId),'human sees every original owner');
 await s.disclosures.choose(f.parent.id,f.root.id,p.admissionId,{commandKey:'approve-both-owners',action:'approve',reviewHash:review.reviewHash,expectedRevision:0});
 new CapabilityPolicyStore(db).put({scopeKind:'chat',scopeId:p.resources.find(r=>r.custody.intent.executionId===f.source.id).destination.conversationId,expectedRevision:0,restrictedCapabilityIds:[]});
 await assert.rejects(s.admit(f.parent.id,f.root.id,input.commandKey,review.reviewHash),/approval/);
 const fresh=await s.disclosures.prepare(f.parent.id,f.root.id,p.admissionId);
 await s.disclosures.choose(f.parent.id,f.root.id,p.admissionId,{commandKey:'approve-final-child-policy',action:'approve',reviewHash:fresh.reviewHash,expectedRevision:1});
 const finalReviewHash=fresh.reviewHash,childTarget=p.ownerMap[f.source.id],rootTarget=p.ownerMap[f.root.id];
 assert.equal(f.branches.execution(childTarget).parentExecutionId,rootTarget);assert.equal(f.branches.execution(childTarget).admissionSource,'call');assert.ok(f.branches.execution(childTarget).admittedAt);
 x.setFailure(true);await assert.rejects(s.admit(f.parent.id,f.root.id,input.commandKey,finalReviewHash),/called final owner rollback/);
 for(const id of [rootTarget,childTarget])assert.equal(db.prepare('SELECT count(*) n FROM branch_resources WHERE execution_id=?').get(id).n,0);
 assert.equal(db.prepare('SELECT receipt_json FROM coordination_destination_admissions WHERE id=?').get(p.admissionId).receipt_json,null);
 x.setFailure(false);const admitted=await s.admit(f.parent.id,f.root.id,input.commandKey,finalReviewHash);
 assert.equal(admitted.receipt.owners.length,2);assert.equal(Object.keys(admitted.receipt.requestMap).length,2);
 assert.equal(admitted.reviewEvidence.ancestry,'committed');assert.equal(admitted.reviewEvidence.evidenceHash,p.reviewEvidence.evidenceHash);
 assert.equal(admitted.reviewEvidence.owners.find(o=>o.sourceExecutionId===f.source.id).destinationParentAttemptId,admitted.reviewEvidence.idMap[childEvidence.sourceParentAttemptId]);
 for(const item of p.resources){const chat=f.store.getConversation(item.destination.conversationId),original=f.branches.execution(item.custody.intent.executionId);assert.equal(chat.branchId,original.branchId);assert.equal(chat.executionId,p.ownerMap[original.id]);}
 const childOwner=f.branches.execution(childTarget),plan=f.branches.issuedGroupDestinationPlan(f.parent.id,f.root.id,input.commandKey);
 const original=f.store.sqlite.prepare('SELECT parent_attempt_id FROM branch_executions WHERE id=?').get(f.source.id);
 assert.equal(childOwner.parentAttemptId,plan.idMap[original.parent_attempt_id]);
 const {groupJournalAudit}=await import('../../apps/server/dist/group-journal-audit.js');const selection=s.discover({kind:'admissions',limit:50}).items.find(v=>v.admissionId===p.admissionId).auditSelection;assert.deepEqual(groupJournalAudit(db,new CoordinationV3Store(db)).read(selection).receipt.requestMap,admitted.receipt.requestMap);
 await f.reopen();x.setBytes(false);const before=x.imports;const restarted=await x.service().admit(f.parent.id,f.root.id,input.commandKey,finalReviewHash);assert.deepEqual(restarted.receipt,admitted.receipt);assert.deepEqual(restarted.reviewEvidence,admitted.reviewEvidence);assert.equal(x.imports,before);
});

// Deferred actual scheduler/state/checkpoint integration. Script bodies remain inert.
for(const mode of ['async','sync'])test(`shared reducer state survives ${mode} capture, rewind and restart without prefix writes`,async t=>{
 const f=fixture(t,mode,false,false,false,false,true),first=await f.claim();
 assert.deepEqual(first.state.values,{total:0,notes:[],phase:'new'});assert.equal(first.state.revision,0);
 const output=JSON.stringify({total:2,notes:['prefix'],phase:'prefix'});
 f.settleState(first,{failed:false,output});await f.branches.unitSaver.drain();
 const state=f.branches.sharedState(f.source.id);assert.deepEqual(state.values,{total:2,notes:['prefix'],phase:'prefix'});assert.equal(state.revision,1);
 const cp=f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(cp=>{const cut=JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);return cp.restoreSupported&&cut.selected.paths[0]?.node_id==='c';});assert.ok(cp);
 const suffix=await f.claim();assert.deepEqual(suffix.state,state);
 assert.throws(()=>f.branches.settleScript(suffix,{failed:false,output:JSON.stringify({undeclared:1})}),/declared|Unknown/);
 assert.deepEqual(f.branches.sharedState(f.source.id),state);
 f.settleState(suffix,{failed:false,output:JSON.stringify({total:3,notes:['old suffix'],phase:'old done'})});await f.branches.unitSaver.drain();
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'state-fork');
 assert.deepEqual(f.branches.sharedState(next.id),state);await f.reopen();assert.deepEqual(f.branches.sharedState(next.id),state);
 const resumed=await f.claim();assert.equal(resumed.executionId,next.id);assert.deepEqual(resumed.state,state);
 f.settleState(resumed,{failed:false,output:JSON.stringify({total:5,notes:['new suffix'],phase:'done'})});await f.branches.unitSaver.drain();
 assert.deepEqual(f.branches.sharedState(next.id).values,{total:7,notes:['prefix','new suffix'],phase:'done'});
 assert.equal(f.branches.sharedState(next.id).revision,2);
 const row=f.store.sqlite.prepare("SELECT * FROM branch_sealed_results WHERE execution_id=? AND json_extract(result_json,'$.stateUpdate.revision')=2").get(next.id),bad=JSON.parse(row.result_json);bad.stateUpdate.revision=1;
 f.store.sqlite.prepare('UPDATE branch_sealed_results SET result_json=?,content_hash=? WHERE id=?').run(stableJson(bad),hash(stableJson(bad)),row.id);
 assert.throws(()=>f.branches.sharedState(next.id),/revision/);
});

for(const mode of ['async','sync'])test(`parallel shared state ${mode} folds committed contributions once across rewind`,async t=>{
 const f=fixture(t,mode,false,false,false,false,'parallel'),a=await f.claim(),b=await f.claim();
 assert.equal(a.state.revision,0);assert.equal(b.state.revision,0);
 f.settleState(b,{failed:false,output:JSON.stringify({total:3,notes:['second lease'],phase:'b'})});await f.branches.unitSaver.drain();
 f.settleState(a,{failed:false,output:JSON.stringify({total:2,notes:['first lease'],phase:'a'})});await f.branches.unitSaver.drain();
 const state=f.branches.sharedState(f.source.id);assert.equal(state.revision,2);assert.deepEqual(state.values,{total:5,notes:['second lease','first lease'],phase:'a'});
 const cp=f.branches.historicalCheckpoints(f.branch.id,f.source.id).find(cp=>{const cut=JSON.parse(f.store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json);return cp.restoreSupported&&cut.selected.sealedResults.length===2;});assert.ok(cp);
 const reducer=await f.claim();assert.deepEqual(reducer.state,state);
 f.settleState(reducer,{failed:false,output:JSON.stringify({phase:'original reducer'})});await f.branches.unitSaver.drain();
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cp.id,cp.contentHash,'parallel-state-fork');assert.deepEqual(f.branches.sharedState(next.id),state);
 await f.reopen();const resumed=await f.claim();assert.equal(resumed.executionId,next.id);assert.deepEqual(resumed.state,state);
 f.settleState(resumed,{failed:false,output:JSON.stringify({phase:'fresh custom aggregate'})});await f.branches.unitSaver.drain();
 assert.deepEqual(f.branches.sharedState(next.id).values,{total:5,notes:['second lease','first lease'],phase:'fresh custom aggregate'});
 assert.equal(f.branches.sharedState(next.id).revision,3);
});

test('shared state rejects rehashed alias, missing revision, undeclared writes and invalid reducer values',async()=>{
 const {branchSharedState,branchStateResult,validateBranchStateSeal}=await import('../../packages/agents/dist/index.js');
 const definition={state:{count:{initial:0,reducer:'sum'}},steps:[{id:'write',stateWrites:['count']}]},steps=[{id:'one',step_id:'write'},{id:'two',step_id:'write'}];
 const make=(id,result)=>({step_execution_id:id,result_json:stableJson(result),content_hash:hash(stableJson(result))});
 const first=make('one',branchStateResult(definition,steps,[],'write',{failed:false,output:'{"count":2}'}));
 const second=make('two',branchStateResult(definition,steps,[first],'write',{failed:false,output:'{"count":3}'}));
 assert.equal(branchSharedState(definition,steps,[second,first]).values.count,5);
 assert.throws(()=>validateBranchStateSeal(definition,steps,[],second),/revision/);
 assert.throws(()=>branchSharedState(definition,steps,[first,make('two',JSON.parse(first.result_json))]),/revision/);
 assert.throws(()=>branchSharedState(definition,steps,[make('one',{failed:false,output:'{"count":2}'})]),/missing/);
 assert.throws(()=>branchStateResult(definition,steps,[],'write',{failed:false,output:'{"foreign":2}'}),/declared/);
 assert.throws(()=>branchStateResult(definition,steps,[],'write',{failed:false,output:'{"count":"wrong"}'}),/finite/);
 assert.throws(()=>branchStateResult(definition,steps,[],'write',{failed:false,output:'{}',stateUpdate:{revision:1,updates:{}}}),/Caller/);
 const failed={failed:true,output:'retained failure'};assert.deepEqual(branchStateResult(definition,steps,[first],'write',failed),failed);
});

for(const valid of [true,false])test(`Agent shared-state Request ${valid?'commits exact update':'holds malformed terminal output visibly'}`,async t=>{
 const f=await reservationHistoryFixture(t,'sync',false,false,false,false,false,true),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);
 const opened=await openCalledTreeResource(f.store,f.branches,f.branches.localConfiguration(f.branch.id).directories.root,f.source.id,f.branch.id),db=f.store.sqlite;
 const request=db.prepare('SELECT payload_json FROM coordination_requests WHERE id=?').get(opened.requestId);
 assert.deepEqual(JSON.parse(request.payload_json).sharedState.values,{count:0});
 new CoordinationV3Store(db).updateRequest({requestId:opened.requestId,updateId:'state-agent-terminal',kind:'completed',actor:{kind:'agent',id:opened.agentId},payload:{text:valid?'{"count":7}':'unstructured output'}});
 for(let n=0;n<4;n++){assert.doesNotThrow(()=>f.branches.advance());await f.branches.unitSaver.drain();}
 if(valid){
  assert.deepEqual(f.branches.sharedState(f.source.id).values,{count:7});assert.equal(f.branches.sharedState(f.source.id).revision,1);
  const suffix=await f.claim();assert.equal(suffix.state.values.count,7);
 }else{
  const attempt=db.prepare('SELECT state,error FROM branch_attempts WHERE step_execution_id=? ORDER BY number DESC LIMIT 1').get(opened.stepId);
  assert.equal(attempt.state,'waiting');assert.match(attempt.error,/State update rejected.*explicit reconciliation/);
  assert.equal(f.branches.sharedState(f.source.id).revision,0);
 }
 await f.reopen();assert.equal(f.branches.sharedState(f.source.id).values.count,valid?7:0);
});

// Later-generation local final exit uses the exact sealed history and a drained provider source.
// The existing retry fixture uses inert process/package custody; this asserts only local exit authority.
for(const [kind,parallel] of [['serial',false],['fork',true],['map','map']])for(const mode of ['async','sync'])test(`${kind} later-generation final exit ${mode} requires complete history and drained effects`,async t=>{
 const generation=2,budgetOverride=undefined;
 const maxAttempts=budgetOverride??generation+1;
 const f=await reservationHistoryFixture(t,mode,false,parallel,maxAttempts),prefix=await f.claim();f.settle(prefix);await f.advance(f.source.id);
 const db=f.store.sqlite,coordination=new CoordinationV3Store(db),dir=f.branches.localConfiguration(f.branch.id).directories.root;
 const {ProviderProcessAuthority}=await import('../../apps/server/dist/provider-process-authority.js');
 const seals=[],requests=[],agents=[],chats=[];
 for(let g=0;g<generation;g++){
  const opened=await openCalledTreeResource(f.store,f.branches,dir,f.source.id,f.branch.id);requests.push(opened.requestId);agents.push(opened.agentId);chats.push(opened.chatId);
  assert.equal(db.prepare('SELECT generation FROM branch_resources WHERE step_execution_id=?').get(opened.stepId).generation,g);
  coordination.updateRequest({requestId:opened.requestId,updateId:`failed-chain-${g}`,kind:'failed',actor:{kind:'agent',id:opened.agentId},payload:{text:`known failed generation ${g}`}});
  for(let n=0;n<20&&!db.prepare('SELECT retry_draining FROM branch_resources WHERE step_execution_id=?').get(opened.stepId).retry_draining;n++){f.branches.advance();await f.branches.unitSaver.drain();}
  assert.equal(db.prepare('SELECT retry_draining FROM branch_resources WHERE step_execution_id=?').get(opened.stepId).retry_draining,1);
  const fence=f.branches.fenceGenerationExit(opened.stepId);assert.equal(fence.identity.generation,g);
  const agent=f.store.getAgent(opened.agentId),runId=randomUUID(),now=new Date().toISOString();
  db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,terminal_at) VALUES(?,?,?,'completed','fixture',?,1,'injected',?,?,?,?)").run(runId,agent.projectId,agent.id,now,now,now,now,now);
  for(const activation of db.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND state IN ('pending','retry_pending')").all(agent.id))coordination.cancelPendingActivation({activationId:activation.id,projectId:agent.projectId,idempotencyKey:`chain-exit:${activation.id}`});
  let alive=true;const handle={processIdentity:{pid:525252+g,pgid:525252+g,birthMarker:`inert-chain-${g}`},isAlive:()=>alive,close:async()=>{alive=false;}};
  const authority=new ProviderProcessAuthority(db,`inert-chain-provider-${g}`);authority.recover=()=>handle;authority.register(handle,{purpose:'provider Run',projectId:agent.projectId,agentId:agent.id,runId,runFence:1});await authority.terminateAgents(new Set([agent.id]),'inert complete chain');
  const journal=f.branches.reserveGenerationExit(f.source.id,opened.stepId,g);
  assert.deepEqual(journal.envelope.hostDependencies.roots.map(r=>r.requestId),[opened.requestId]);
  assert.equal(journal.envelope.selected.attempts.filter(a=>a.step_execution_id===opened.stepId).length,g+2);
  const receipt={...journal.source,version:1,custodyId:hash(journal.source.checkpointId),boundaryId:`inert-chain-seal-${g}`,sha256:hash(`private generation ${g}`),byteLength:1};
  db.transaction(()=>f.branches.sealGenerationExit(f.source.id,opened.stepId,g,receipt))();seals.push(f.branches.generationExitCapture(f.source.id,opened.stepId,g));
  const deletion=f.store.previewAgentDeletion([agent.id]);f.store.deleteAgentSubtrees([agent.id],deletion.previewHash,x=>coordination.handleAgentDeletion(x));
  const chat=f.store.commitConversationDeletion(opened.chatId);f.store.finishConversationDeletionStorageCleanup(chat);f.store.markConversationDeletionServerCleanupComplete(opened.chatId);f.branches.resourceRetired(opened.stepId);await f.branches.unitSaver.drain();
 }
 const {enableProviderStartCoverage,sealProviderNeverStarted}=await import('../../packages/agents/dist/provider-start-journal.js');
 enableProviderStartCoverage(db,'fixture-runtime');
 const current=await openCalledTreeResource(f.store,f.branches,dir,f.source.id,f.branch.id),preview=f.branches.previewGenerationHistoryCapture(f.source.id);
 assert.equal(preview.generation,generation);assert.equal(preview.consumedAttempts,generation+1);assert.equal(preview.maxAttempts,maxAttempts);
 assert.deepEqual(preview.historicalPartition.map(v=>v.generation),Array.from({length:generation},(_,i)=>i));
 assert.ok(preview.historicalPartition.every(v=>stableJson(v.discloseTo)===stableJson([current.agentId])));
 if(generation>1)assert.throws(()=>f.branches.previewGenerationOneCapture(f.source.id),/requires current generation one/);else assert.equal(f.branches.previewGenerationOneCapture(f.source.id).generation,1);
 assert.equal(preview.historyKind,parallel?'local_parallel':'serial');
 // Every missing prior journal is refused independently, including the oldest retained generation.
 for(let g=0;g<generation;g++)assert.throws(()=>db.transaction(()=>{db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,`resource-generation-retired:${current.stepId}:${g}`);assert.throws(()=>f.branches.previewGenerationHistoryCapture(f.source.id),/retirement linkage/);throw Error('restore chain');})(),/restore chain/);
 for(let g=0;g<generation;g++)assert.throws(()=>db.transaction(()=>{db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,`resource-generation-exit:${current.stepId}:${g}`);assert.throws(()=>f.branches.previewGenerationHistoryCapture(f.source.id),/prior-generation seal/);throw Error('restore seal');})(),/restore seal/);
 assert.throws(()=>f.branches.reserveIssuedResourceCapture(f.source.id,current.stepId,generation,'chain-cut','0'.repeat(64)),/preview/);
 const journal=f.branches.reserveIssuedResourceCapture(f.source.id,current.stepId,generation,'chain-cut',preview.reviewHash);
 assert.deepEqual(journal.snapshot.hostDependencies.roots.map(r=>r.requestId),[current.requestId]);assert.equal(journal.snapshot.selected.attempts.find(a=>a.step_execution_id===current.stepId).number,generation+1);
 assert.equal((journal.snapshot.issuedContinuation.generationRetry.history??[journal.snapshot.issuedContinuation.generationRetry]).length,generation);
 for(const tamper of [...(generation>1?[v=>v.history.pop(),v=>v.history.reverse(),v=>{v.history[1].selection={...v.history[0].selection};},v=>{v.history[0].retirementSha256='0'.repeat(64);}]:[v=>{v.retirementSha256='0'.repeat(64);}]),v=>{v.originalSelected.attempts=v.originalSelected.attempts.filter(a=>a.step_execution_id!==current.stepId||a.number!==1);},...(parallel?[v=>{v.originalSelected.steps.find(s=>s.id===current.stepId).path_id=v.originalSelected.paths.find(p=>p.parent_path_id===null).id;},v=>{v.originalSelected.steps.find(s=>s.id!==current.stepId).state='prepared';},v=>{v.originalSelected.paths.find(p=>p.parent_path_id===null).state='active';},v=>{v.originalSelected.attempts.find(a=>a.step_execution_id===current.stepId&&a.number===generation+1).request_id=v.originalSelected.attempts.find(a=>a.step_execution_id===current.stepId&&a.number===1).request_id;},v=>{v.originalSelected.attempts.find(a=>a.step_execution_id===current.stepId&&a.number===1).state='outcome_unknown';}]:[])]){
  const changed=structuredClone(journal.snapshot.issuedContinuation);tamper(changed.generationRetry);
  assert.equal(issuedResourceContinuationSupported(db,f.source.id,journal.snapshot.selected,journal.snapshot.hostDependencies,changed),false,'omitted/reordered/aliased/rehashed attempt history refuses');
 }

 const receipt={...journal.source,version:1,custodyId:hash(journal.source.checkpointId),boundaryId:'inert-current-chain',sha256:hash('current chain package'),byteLength:1};
 assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE branch_executions SET wait_reason=? WHERE id=?').run('changed chain during package capture',f.source.id);assert.throws(()=>f.branches.sealIssuedResourceCapture(f.source.id,current.stepId,'chain-cut',receipt),/frontier changed/);throw Error('restore current cut');})(),/restore current cut/);
 db.transaction(()=>f.branches.sealIssuedResourceCapture(f.source.id,current.stepId,'chain-cut',receipt))();
 const saved=f.branches.issuedResourceCapture(f.source.id,current.stepId,'chain-cut');
 const {BranchResourceService}=await import('../../apps/server/dist/branch-resource-service.js');const resourceService=new BranchResourceService(f.branches,f.store,async()=>assert.fail('delete'),async()=>assert.fail('create'),async()=>assert.fail('delete Chat'));
 assert.deepEqual(resourceService.listGenerationHistoryCaptures(f.source.id,current.stepId)[0].historicalPartition,preview.historicalPartition);
 // Empty-client recovery uses only saved capture identity, never a new preview.
 const status=resourceService.issuedResourceCaptureStatus(f.source.id,current.stepId,'chain-cut'),budget=status.retryBudget;
 assert.equal(budget.state,'verified');assert.equal(status.consumedAttempts,generation+1);assert.equal(status.maxAttempts,maxAttempts);assert.match(budget.evidenceHash,/^[a-f0-9]{64}$/);
 assert.deepEqual(resourceService.listGenerationHistoryCaptures(f.source.id,current.stepId)[0].retryBudget,budget);assert.equal(status.historyKind,preview.historyKind);
 assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE branches SET configuration_json=? WHERE id=?').run('{}',f.branch.id);assert.deepEqual(resourceService.issuedResourceCaptureStatus(f.source.id,current.stepId,'chain-cut').retryBudget,budget);throw Error('restore mutable policy');})(),/restore mutable policy/);

 const {issuedCaptureRetryBudget}=await import('../../packages/agents/dist/index.js');
 const corrupted=structuredClone(saved);corrupted.snapshot.issuedContinuation.generationRetry.originalSelected.attempts.find(a=>a.number===generation+1).number=1;
 assert.throws(()=>issuedCaptureRetryBudget(db,f.source.id,corrupted),/budget proof/);
 const legacy=structuredClone(saved);delete legacy.snapshot.issuedContinuation.generationRetry;
 assert.deepEqual(issuedCaptureRetryBudget(db,f.source.id,legacy),{state:'unavailable',reason:'missing_saved_retry_proof'});

 coordination.updateRequest({requestId:current.requestId,updateId:'current-chain-completed',kind:'completed',actor:{kind:'agent',id:current.agentId},payload:{text:'current chain result'}});
 const suffix=await f.claim();f.settle(suffix);await f.branches.unitSaver.drain();
 const pendingActivations=db.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND state IN ('pending','retry_pending')").all(current.agentId);
 assert.ok(pendingActivations.length);
 assert.throws(()=>db.transaction(()=>{db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,`resource-generation-retired:${current.stepId}:0`);assert.throws(()=>f.branches.finalResourceExitFence(current.stepId),/retirement linkage/);throw Error('restore history');})(),/restore history/);
 const rootPath=db.prepare('SELECT id,result_json FROM branch_paths WHERE execution_id=? AND parent_path_id IS NULL').get(f.source.id),rootResult=JSON.parse(rootPath.result_json);
 assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE branch_paths SET result_json=? WHERE id=?').run(JSON.stringify({...rootResult,output:'tampered final output'}),rootPath.id);assert.throws(()=>f.branches.finalResourceExitFence(current.stepId),/continuation replay unsupported/);throw Error('restore terminal path');})(),/restore terminal path/);
 assert.equal(db.prepare("SELECT count(*) n FROM host_lifecycle_commits WHERE kind='branch-generation-exit-fence' AND json_extract(receipt_json,'$.input.conversationId')=?").get(current.chatId).n,0);
 const finalFence=f.branches.finalResourceExitFence(current.stepId);assert.equal(finalFence.identity.generation,generation);
 assert.throws(()=>f.branches.captureFinalResourceExit(finalFence),/participant effects remain unresolved/);
 for(const activation of pendingActivations)coordination.cancelPendingActivation({activationId:activation.id,projectId:f.store.getAgent(current.agentId).projectId,idempotencyKey:`final-exit:${activation.id}`});
 sealProviderNeverStarted(db,'fixture-runtime',[current.agentId]);
 f.branches.captureFinalResourceExit(finalFence);
 assert.equal(f.branches.requireFinalResourceExit(f.source.id,current.stepId).identity.generation,generation);
 assert.throws(()=>db.transaction(()=>{db.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(f.source.id,`resource-generation-retired:${current.stepId}:0`);assert.throws(()=>f.branches.requireFinalResourceExit(f.source.id,current.stepId),/retirement linkage/);throw Error('restore committed history');})(),/restore committed history/);
 assert.throws(()=>db.transaction(()=>{const row=db.prepare('SELECT * FROM branch_commands WHERE execution_id=? AND command_key=?').get(f.source.id,`resource-final-exit:${current.stepId}:${generation}`);db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(row.execution_id,`resource-final-exit:${current.stepId}:999`,row.input_hash,row.result_json,row.created_at);assert.throws(()=>f.branches.requireFinalResourceExit(f.source.id,current.stepId),/ambiguous/);throw Error('restore duplicate');})(),/restore duplicate/);

 const deletion=f.store.previewAgentDeletion([current.agentId]);f.store.deleteAgentSubtrees([current.agentId],deletion.previewHash,x=>coordination.handleAgentDeletion(x));
 const chat=f.store.commitConversationDeletion(current.chatId);f.store.finishConversationDeletionStorageCleanup(chat);f.store.markConversationDeletionServerCleanupComplete(current.chatId);f.branches.resourceRetired(current.stepId);await f.branches.unitSaver.drain();
 assert.equal(f.branches.requireFinalResourceExit(f.source.id,current.stepId).identity.generation,generation);
});
