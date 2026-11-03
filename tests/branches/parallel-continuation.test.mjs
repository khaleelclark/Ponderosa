import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store,branchSharedState,branchStateResult} from '../../packages/agents/dist/index.js';
import {replayParallelCut,parallelDefinitionSupported,parallelFrontierSupported} from '../../packages/agents/dist/branch-parallel-continuation.js';
import {stableJson} from '../../packages/agents/dist/coordination-v3-canonical-json.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const identity={pid:2147483647,pgid:2147483647,birthMarker:'controlled-no-process'};
const script=id=>({id,kind:'script',runtime:'node',source:`// ${id}: no process is launched by this regression`,cwdRef:'root',timeoutMs:5000});
const edge=(id,from,to,on='success',extra={})=>({id,from,to,on,...extra});
function fixture(t,{nested=false,mode='async',transform}={}){
 const dir=mkdtempSync(join(tmpdir(),'parallel-continuation-'));let store,branches;
 const open=()=>{store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));};open();
 const project=store.createProject({label:'Parallel continuation',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Parallel'});
 const definition={schema:'ponderosa.branch.v1',name:'Parallel continuation',trigger:{kind:'manual'},entry:nested?'fork':'map',steps:[script('worker'),script('tail'),...(nested?[script('sibling')]:[])],
  controls:[{id:'map',kind:'map',joinId:'mapped',workerId:'worker',source:'list',maxItems:4,maxConcurrentItems:1},{id:'mapped',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]},...(nested?[{id:'fork',kind:'fork',joinId:'joined'},{id:'joined',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['right','left']}]:[])],
  edges:[edge('item','map','worker','selected'),edge('return','worker','mapped'),edge('after-map','mapped',nested?'joined':'tail'),...(nested?[edge('left','fork','map','selected',{input:{kind:'literal',text:'["one","two"]'}}),edge('right','fork','sibling','selected'),edge('sibling-return','sibling','joined'),edge('tail-edge','joined','tail')]:[])],policy:{maxConcurrentExecutions:8,maxPathInstances:20,maxStepInvocations:20,failure:{action:'stop'}}};
 const extraBindings=transform?.(definition,{branches,store,project,chat,dir})??{};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{},directories:{root:dir},...extraBindings}});
 branches.configure(branch.id,{...branches.configuration(branch.id),checkpointMode:mode},0);
 const source=branches.accept(branch.id,'source','["one","two"]');
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const settle=(lease,output=lease.input)=>{branches.authorizeScript(lease,identity);branches.recordScriptEvidence(lease,identity,{stdout:output,outputHash:hash(output),code:0});branches.settleScript(lease,{failed:false,output});};
 const tick=async()=>{branches.advance();await branches.unitSaver.drain();};
 const points=id=>branches.historicalCheckpoints(branch.id,id).filter(cp=>cp.restoreSupported).map(cp=>({...cp,snapshot:JSON.parse(store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json)}));
 const finish=async (id,output)=>{for(let n=0;n<150&&branches.execution(id).state!=='completed';n++){await tick();const lease=branches.claimScript('inert');if(lease)settle(lease,output??lease.input);await branches.unitSaver.drain();}assert.equal(branches.execution(id).state,'completed');};
 return {get store(){return store},get branches(){return branches},definition,branch,source,settle,tick,points,finish,async reopen(){await branches.unitSaver.drain();store.close();open();}};
}
for(const mode of ['async','sync'])for(const nested of [false,true])test(`actual ${mode} ${nested?'nested Fork/Map':'Map'} checkpoint restores all control rows and resumes once`,async t=>{
 const f=fixture(t,{nested,mode});let cut;
 for(let n=0;n<80&&!cut;n++){
  await f.tick();const lease=f.branches.claimScript('inert');if(lease)f.settle(lease);await f.branches.unitSaver.drain();
  cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.items.some(item=>item.dispatched===0)&&cp.snapshot.selected.steps.some(step=>step.state==='completed'));
 }
 assert.ok(cut,'a completed prefix and sealed undispatched Map suffix are eligible');
 await f.finish(f.source.id);
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'restore');
 const source=cut.snapshot.selected,db=f.store.sqlite;
 for(const [key,table] of [['paths','branch_paths'],['forks','branch_forks'],['maps','branch_map_invocations']])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE execution_id=?`).get(next.id).n,source[key].length);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_map_items WHERE map_invocation_id IN (SELECT id FROM branch_map_invocations WHERE execution_id=?)').get(next.id).n,source.items.length);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? AND (a.fence!=0 OR a.request_id IS NOT NULL OR a.process_identity_json IS NOT NULL)').get(next.id).n,0);
 assert.equal(f.branches.claimScript('before-admission'),undefined);
 await f.reopen();assert.equal(f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'restore').id,next.id);
 await f.finish(next.id);assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
 const recut=f.points(next.id).find(cp=>cp.snapshot.selected.maps.length&&cp.snapshot.selected.steps.some(step=>step.state==='completed'));
 assert.ok(recut,'restored prefix is independently verified and can be selected again');
 const lineage=f.store.sqlite.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.rewind-lineage.v1'").get(next.id);
 assert.ok(lineage,'the restored execution retains its exact prefix map');
 const seed={selected:cut.snapshot.selected,idMap:JSON.parse(lineage.snapshot_json).idMap};
 const resumed=recut.snapshot, replay=(saved)=>replayParallelCut(resumed.selected,f.definition,resumed.continuation.configuration,resumed.continuation.audit,resumed.continuation.checkpoint,saved);
 assert.equal(replay(seed),true,'a replay seeded with the original prefix reaches the saved frontier');
 const badSeed=structuredClone(seed),oldPath=seed.selected.paths[0].id;badSeed.idMap[oldPath]='foreign-seed-path';
 assert.equal(replay(badSeed),false,'a changed seed identity cannot authorize the saved frontier');
 const third=f.branches.rewindHistorical(f.branch.id,next.id,recut.id,recut.contentHash,'again');await f.finish(third.id);
 assert.equal(f.branches.execution(third.id).output,f.branches.execution(next.id).output);assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});

test('Map dispatch, ordered Join and owned audit bytes cannot be replaced with a rehashed inventory',async t=>{
 const f=fixture(t,{nested:true});await f.finish(f.source.id);
 const cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.forks.some(row=>row.state==='closed'));assert.ok(cut);
 const original=cut.snapshot,good=()=>structuredClone(original);
 for(const mutate of [
  s=>s.selected.paths[0].traversals++,
  s=>{const item=s.selected.items[0];item.input_text='changed';item.input_hash=hash('changed');},
  s=>{const fork=s.selected.forks.find(row=>row.selected_paths_json&&JSON.parse(row.selected_paths_json).length>1);assert.ok(fork);fork.selected_paths_json=stableJson(JSON.parse(fork.selected_paths_json).reverse());},
  s=>s.continuation.audit.splice(s.continuation.audit.findIndex(row=>row.kind==='map_item_started'),1),
  s=>s.selected.attempts[0].request_id='foreign',
  s=>s.selected.attempts[0].state='outcome_unknown',
 ]){
  const value=good();mutate(value);assert.equal(replayParallelCut(value.selected,f.definition,value.continuation.configuration,value.continuation.audit),false);
 }
 assert.equal(replayParallelCut(original.selected,f.definition,original.continuation.configuration,original.continuation.audit),true);
});

test('parallel frontier refuses duplicate and orphaned identities before replay',async t=>{
 const f=fixture(t,{nested:true});await f.finish(f.source.id);
 const cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.forks.some(row=>row.state==='closed')&&cp.snapshot.selected.steps.length&&cp.snapshot.selected.attempts.length&&cp.snapshot.selected.sealedResults.length);
 assert.ok(cut);
 const selected=cut.snapshot.selected;
 assert.equal(parallelFrontierSupported(selected,f.definition),true);
 for(const [name,mutate] of [
  ['duplicate Step',s=>s.steps.push(structuredClone(s.steps[0]))],
  ['duplicate Path',s=>s.paths.push(structuredClone(s.paths[0]))],
  ['duplicate Attempt',s=>s.attempts.push(structuredClone(s.attempts[0]))],
  ['duplicate seal',s=>s.sealedResults.push(structuredClone(s.sealedResults[0]))],
  ['orphan Attempt',s=>{s.attempts[0].step_execution_id='missing-step';}],
  ['orphan seal',s=>{s.sealedResults[0].step_execution_id='missing-step';}],
  ['non-string Step identity',s=>{s.steps[0].id=NaN;}],
 ]){
  const bad=structuredClone(selected);mutate(bad);
  assert.equal(parallelFrontierSupported(bad,f.definition),false,name);
  assert.equal(replayParallelCut(bad,f.definition,cut.snapshot.continuation.configuration,cut.snapshot.continuation.audit),false,name);
 }
});

test('shared state uses the first matching identity and rejects orphan or NaN ownership',()=>{
 const definition={state:{count:{initial:0,reducer:'sum'}},steps:[{id:'write',stateWrites:['count']},{id:'write',stateWrites:[]},{id:'other',stateWrites:[]}]};
 const steps=[{id:'same',step_id:'write'},{id:'same',step_id:'other'}];
 const result=branchStateResult(definition,steps,[],'write',{failed:false,output:'{"count":2}'});
 const make=(step,result)=>({step_execution_id:step,result_json:stableJson(result),content_hash:hash(stableJson(result))});
 const seal=make('same',result);
 assert.equal(branchSharedState(definition,steps,[seal]).values.count,2,'first matching Step and definition govern the seal');
 assert.throws(()=>branchSharedState(definition,[{id:'same',step_id:'other'},...steps],[seal]),/Undeclared state update/);
 assert.throws(()=>branchSharedState(definition,steps,[make('missing',result)]),/Step unavailable/);
 assert.throws(()=>branchSharedState(definition,[{id:NaN,step_id:'write'}],[make(NaN,result)]),/Step unavailable/);
 assert.throws(()=>branchSharedState({...definition,steps:[{id:NaN,stateWrites:['count']}]},[{id:'step',step_id:NaN}],[make('step',result)]),/Step unavailable/);
});

test('control insertion failure rolls back fresh owner, data and lineage before admission',async t=>{
 const f=fixture(t);await f.finish(f.source.id);const cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.maps.length);assert.ok(cut);
 const db=f.store.sqlite,count=()=>db.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,before=count();
 db.exec("CREATE TEMP TRIGGER refuse_map_restore BEFORE INSERT ON branch_map_invocations BEGIN SELECT RAISE(ABORT,'control insertion failed'); END");
 assert.throws(()=>f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'atomic'),/control insertion failed/);
 assert.equal(count(),before);assert.equal(db.prepare("SELECT COUNT(*) n FROM branch_commands WHERE command_key LIKE 'historical-rewind:%'").get().n,0);
 db.exec('DROP TRIGGER refuse_map_restore');const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'atomic');await f.finish(next.id);
});

test('unsupported parallel dependency families stay closed',async t=>{
 const f=fixture(t);
 for(const mutate of [d=>d.steps[0]={id:'worker',kind:'agent',target:{kind:'bound',agentRef:'a'}},d=>d.parameters={secret:{type:'secret'}}]){const d=structuredClone(f.definition);mutate(d);assert.equal(parallelDefinitionSupported(d),false);}
});

test('exit interruption saves a closed parallel invocation and restores under a fresh invocation',async t=>{
 const f=fixture(t,{mode:'exit'});
 for(let n=0;n<30&&!f.store.sqlite.prepare('SELECT 1 FROM branch_map_invocations WHERE execution_id=?').get(f.source.id);n++)await f.tick();
 assert.ok(f.store.sqlite.prepare('SELECT 1 FROM branch_map_invocations WHERE execution_id=?').get(f.source.id));
 const old=f.branches.execution(f.source.id).checkpointInvocation;
 f.branches.checkpointInterruption(f.branch.id,f.source.id,'interrupt',old.id,'parallel-cut');
 await f.branches.unitSaver.completeExits();
 const cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.maps.length);assert.ok(cut);
 f.branches.checkpointInterruption(f.branch.id,f.source.id,'resume',f.branches.execution(f.source.id).checkpointInvocation.interruptionId,'parallel-resume');
 await f.finish(f.source.id);
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'exit-restore');
 assert.notEqual(f.branches.execution(next.id).checkpointInvocation.id,old.id);
 await f.finish(next.id);assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
});

for(const mode of ['any','quorum'])for(const remainder of ['finish','cancel'])test(`${mode} Join preserves the selected prefix and ${remainder} remainder`,async t=>{
 const f=fixture(t,{transform:d=>{const j=d.controls.find(c=>c.kind==='join');j.mode=mode;j.remainder=remainder;if(mode==='quorum')j.quorum=1;}});
 await f.finish(f.source.id);
 const cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.forks.some(fork=>fork.state==='closed')&&cp.snapshot.selected.items.some(item=>item.dispatched===0));assert.ok(cut);
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,`${mode}-${remainder}`);await f.finish(next.id);
 assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_map_items WHERE map_invocation_id IN (SELECT id FROM branch_map_invocations WHERE execution_id=?)').get(next.id).n,2);
});

test('condition exclusion in parallel survives a historical cut',async t=>{
 const f=fixture(t,{nested:true,transform:d=>{
  d.controls.push({id:'exclude',kind:'condition',predicate:{source:'input',equals:'never'},otherwise:'joined'},{id:'route',kind:'route',otherwise:'joined'},{id:'again',kind:'condition',predicate:{source:'input',equals:'repeat'},otherwise:'joined'});
  d.edges.find(e=>e.id==='right').to='exclude';d.edges.find(e=>e.id==='sibling-return').to='route';
  d.edges.push({id:'exclude-yes',from:'exclude',to:'sibling',on:'selected'},{id:'exclude-no',from:'exclude',to:'joined',on:'failure'},{id:'route-yes',from:'route',to:'again',on:'selected',choice:'repeat'},{id:'route-no',from:'route',to:'joined',on:'failure'},{id:'loop',from:'again',to:'sibling',on:'selected',loop:true,input:{kind:'literal',text:'stop'}},{id:'stop',from:'again',to:'joined',on:'failure'});
 }});
 await f.finish(f.source.id);const cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.joins.some(row=>row.outcome==='unselected'));assert.ok(cut);
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'excluded');await f.finish(next.id);assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
});

test('failed Script exit summary is sealed without treating stderr or stdout as authority',async t=>{
 const f=fixture(t,{transform:d=>{const j=d.controls.find(c=>c.kind==='join');j.onUnmet='continue';}});let failed=false;
 for(let n=0;n<100&&f.branches.execution(f.source.id).state!=='completed';n++){
  await f.tick();const lease=f.branches.claimScript('inert');if(lease){if(!failed){failed=true;f.branches.authorizeScript(lease,identity);const output='Script exited with code 3. Inspect Step evidence for error output.';f.branches.recordScriptEvidence(lease,identity,{stdout:'untrusted stdout',outputHash:hash('untrusted stdout'),code:3,error:output});f.branches.settleScript(lease,{failed:true,output});}else f.settle(lease);}await f.branches.unitSaver.drain();
 }
 const cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.steps.some(row=>row.state==='failed'));assert.ok(cut);
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'known-failure');await f.finish(next.id);
 assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
});

test('waiting human review alongside a Map remains an explicit fresh review after restoration',async t=>{
 const f=fixture(t,{nested:true,transform:d=>{d.steps[d.steps.findIndex(step=>step.id==='sibling')]={id:'sibling',kind:'human_gate',prompt:'Review this item',editable:true};d.edges.find(edge=>edge.id==='sibling-return').on='approved';}});
 for(let n=0;n<40&&!f.points(f.source.id).some(cp=>cp.snapshot.selected.gates.some(g=>g.state==='waiting'));n++)await f.tick();
 const cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.gates.some(g=>g.state==='waiting'));assert.ok(cut);
 const approve=async id=>{for(let n=0;n<100&&f.branches.execution(id).state!=='completed';n++){await f.tick();for(const g of f.store.sqlite.prepare("SELECT g.id,g.revision FROM branch_gates g JOIN branch_step_executions s ON s.id=g.step_execution_id WHERE s.execution_id=? AND g.state='waiting'").all(id))f.branches.resolveGate(g.id,{expectedRevision:g.revision,decision:'approve',commandKey:`review-${g.id}`});const lease=f.branches.claimScript('inert');if(lease)f.settle(lease);await f.branches.unitSaver.drain();}assert.equal(f.branches.execution(id).state,'completed');};
 await approve(f.source.id);const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'review');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_gates g JOIN branch_step_executions s ON s.id=g.step_execution_id WHERE s.execution_id=? AND g.state='waiting' AND g.response_json IS NULL").get(next.id).n,1);
 await approve(next.id);assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
});

test('route choice and per-path loop counts are reconstructed before parallel restoration',async t=>{
 const f=fixture(t,{nested:true,transform:d=>{
  d.edges.find(e=>e.id==='right').input={kind:'literal',text:'repeat'};d.edges.find(e=>e.id==='sibling-return').to='route';
  d.controls.push({id:'route',kind:'route',otherwise:'joined'});
  d.edges.push({id:'repeat',from:'route',to:'sibling',on:'selected',choice:'repeat',loop:true,input:{kind:'literal',text:'stop'}},{id:'otherwise',from:'route',to:'joined',on:'failure'});
 }});
 await f.finish(f.source.id);const cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.loops.length);assert.ok(cut);
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'looped');await f.finish(next.id);
 assert.equal(f.store.sqlite.prepare('SELECT loop_iterations FROM branch_executions WHERE id=?').get(next.id).loop_iterations,1);
 assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
 const bad=structuredClone(cut.snapshot);bad.selected.loops[0].iterations++;bad.selected.execution[0].loop_iterations++;
 assert.equal(replayParallelCut(bad.selected,f.definition,bad.continuation.configuration,bad.continuation.audit),false);
});

test('owned oversized Join bundle bytes survive remapping and new Script input uses the fresh bundle identity',async t=>{
 const f=fixture(t);let cut;
 for(let n=0;n<100&&!cut;n++){
  await f.tick();const lease=f.branches.claimScript('inert');if(lease){const output='x'.repeat(6000);f.branches.authorizeScript(lease,identity);f.branches.recordScriptEvidence(lease,identity,{stdout:output,outputHash:hash(output),code:0});f.branches.settleScript(lease,{failed:false,output});}await f.branches.unitSaver.drain();cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.bundles.length);
 }
 assert.ok(cut);await f.finish(f.source.id,'source bundle consumed');
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'bundle'),old=cut.snapshot.selected.bundles[0],fresh=f.store.sqlite.prepare('SELECT * FROM branch_result_bundles WHERE execution_id=?').get(next.id);
 assert.notEqual(fresh.id,old.id);assert.equal(fresh.content_text,old.content_text);assert.equal(fresh.content_hash,old.content_hash);
 let lease;for(let n=0;n<30&&!lease;n++){await f.tick();lease=f.branches.claimScript('inert');}assert.ok(lease);assert.equal(lease.executionId,next.id);assert.equal(lease.input,fresh.content_text);assert.equal(lease.inputBundleId,fresh.id);
 // The worker's resolved input can exceed inline size; its result still obeys the inline contract.
 f.branches.authorizeScript(lease,identity);f.branches.recordScriptEvidence(lease,identity,{stdout:'bundle consumed',outputHash:hash('bundle consumed'),code:0});f.branches.settleScript(lease,{failed:false,output:'bundle consumed'});await f.finish(next.id);
});

test('unfinished parallel child owner inside a Map restores as a fresh owned tree',async t=>{
 const f=fixture(t,{transform:(d,{branches,chat,dir})=>{
  const leaf=branches.deploy({chatId:chat.id,idempotencyKey:'leaf',definition:{schema:'ponderosa.branch.v1',name:'Parallel leaf',trigger:{kind:'manual'},entry:'fork',steps:[script('leaf-a'),script('leaf-b')],controls:[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['b','a']}],edges:[edge('a','fork','leaf-a','selected'),edge('b','fork','leaf-b','selected'),edge('a-join','leaf-a','join'),edge('b-join','leaf-b','join')],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:dir}}});
  d.steps[0]={id:'worker',kind:'branch_call',branchRef:'leaf'};return {branches:{leaf:leaf.id}};
 }});
 let cut;for(let n=0;n<100&&!cut;n++){await f.tick();cut=f.points(f.source.id).find(cp=>cp.snapshot.continuation.schema==='ponderosa.branch.script-tree-continuation.v1'&&cp.snapshot.continuation.owners.some(o=>o.executionId!==f.source.id&&o.selected.forks.length&&o.selected.execution[0].state!=='completed'));}
 assert.ok(cut,'the actual unfinished parallel child is part of the root cut');await f.finish(f.source.id);
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'parallel-child');await f.finish(next.id);
 assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
 const oldIds=new Set(cut.snapshot.continuation.owners.map(o=>o.executionId)),fresh=f.store.sqlite.prepare('WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT e.id FROM branch_executions e JOIN tree t ON e.parent_execution_id=t.id) SELECT id FROM tree').all(next.id);
 assert.ok(fresh.length>1);assert.ok(fresh.every(row=>!oldIds.has(row.id)));assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
 assert.equal(f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'parallel-child').id,next.id);
});
test('a settled failed child remains historical data while a parallel Map suffix is restored',async t=>{
 const f=fixture(t,{transform:(d,{branches,chat,dir})=>{
  const leaf=branches.deploy({chatId:chat.id,idempotencyKey:'failed-leaf',definition:{schema:'ponderosa.branch.v1',name:'Failed leaf',trigger:{kind:'manual'},entry:'leaf',steps:[script('leaf')],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:dir}}});
  d.steps[0]={id:'worker',kind:'branch_call',branchRef:'leaf'};d.controls.find(c=>c.id==='mapped').onUnmet='continue';return {branches:{leaf:leaf.id}};
 }});
 let failed=false,cut;
 for(let n=0;n<150&&!cut;n++){
  await f.tick();const lease=f.branches.claimScript('inert');
  if(lease&&!failed){const stdout='Private raw failure output',output='Script exited with code 1. Inspect Step evidence for error output.';f.branches.authorizeScript(lease,identity);f.branches.recordScriptEvidence(lease,identity,{stdout,outputHash:hash(stdout),code:1});f.branches.settleScript(lease,{failed:true,output});failed=true;}
  else if(lease)f.settle(lease);
  await f.branches.unitSaver.drain();cut=f.points(f.source.id).find(cp=>cp.snapshot.continuation.schema==='ponderosa.branch.script-tree-continuation.v1'&&cp.snapshot.selected.steps.some(s=>s.state==='failed')&&cp.snapshot.continuation.owners.some(o=>o.executionId!==f.source.id&&o.selected.execution[0].state==='failed'));
 }
 assert.ok(cut,'the failed child and exact parent failure are retained in a restorable cut');await f.finish(f.source.id);
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'failed-child'),line=JSON.parse(f.store.sqlite.prepare("SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=? AND json_extract(snapshot_json,'$.schema')='ponderosa.branch.tree-rewind-lineage.v1'").get(next.id).snapshot_json),old=cut.snapshot.continuation.owners.find(o=>o.selected.execution[0].state==='failed'),freshId=line.idMap[old.executionId];
 assert.equal(f.branches.execution(freshId).state,'failed');assert.equal(f.branches.execution(freshId).output,old.selected.execution[0].output_text);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='script_authorized'").get(freshId).n,0);
 await f.finish(next.id);assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
 assert.ok(f.points(next.id).some(cp=>cp.snapshot.continuation.schema==='ponderosa.branch.script-tree-continuation.v1'&&cp.snapshot.continuation.owners.some(o=>o.selected.execution[0].state==='failed')),'restored failed prefix is verified on a later selection');
});

// Deferred: no issued Request is restored, including within a concurrency-limited Map.
test('Map Agent frontier re-admits fresh Requests and routes their results through the restored Join',async t=>{
 let worker;const f=fixture(t,{transform(d,{store,project,chat}){
  worker=store.createAgent(project.id,{title:'Map worker',engine:'codex',conversationId:chat.id});
  d.steps[0]={id:'worker',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Process this item'};
  return {agents:{worker:worker.id}};
 }});
 const coordination=new CoordinationV3Store(f.store.sqlite);let cut;
 const finish=async id=>{
  const requests=new Set();
  for(let n=0;n<150&&f.branches.execution(id).state!=='completed';n++){
   await f.tick();const lease=f.branches.claimScript('inert');if(lease)f.settle(lease);
   for(const attempt of f.branches.detail(id).attempts)if(attempt.requestId&&!requests.has(attempt.requestId)){
    requests.add(attempt.requestId);coordination.updateRequest({requestId:attempt.requestId,updateId:`done:${attempt.requestId}`,kind:'completed',actor:{kind:'agent',id:worker.id},payload:{text:'item result'}});
   }
   await f.branches.unitSaver.drain();
  }
  assert.equal(f.branches.execution(id).state,'completed');return requests;
 };
 for(let n=0;n<30&&!cut;n++){await f.tick();cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.steps.some(step=>step.step_id==='worker')&&cp.snapshot.selected.attempts.every(a=>!a.request_id));}
 assert.ok(cut);const old=await finish(f.source.id);assert.equal(old.size,2);
 const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'map-agent');
 assert.ok(f.branches.detail(next.id).attempts.every(a=>!a.requestId&&a.fence===0));
 const fresh=await finish(next.id);assert.equal(fresh.size,2);assert.ok([...fresh].every(id=>!old.has(id)));
 assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
});

// Deferred: host-controlled observations only; never starts a native process.
for(const delayMs of [0,250])test(`Map Script retry generation and ${delayMs}ms availability survive rewind`,async t=>{
 const f=fixture(t,{transform(d){d.steps[0].failure={action:'retry',maxAttempts:3,delayMs};}});let cut,failed=false;
 const claim=()=>f.branches.claimScript('inert',new Date(Date.now()+10_000).toISOString());
 for(let n=0;n<70&&!cut;n++){
  await f.tick();const lease=claim();
  if(lease&&!failed){
   const stdout='retained failed attempt',output='Script exited with code 1. Inspect Step evidence for error output.';
   f.branches.authorizeScript(lease,identity);f.branches.recordScriptEvidence(lease,identity,{stdout,outputHash:hash(stdout),code:1});f.branches.settleScript(lease,{failed:true,output});failed=true;
  }else if(lease)f.settle(lease);
  await f.branches.unitSaver.drain();cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.attempts.some(a=>a.number===2&&a.state==='prepared'));
 }
 assert.ok(cut,'a failed generation and its unlaunched retry form an executable cut');
 const original=cut.snapshot,attempt=original.selected.attempts.find(a=>a.number===2);assert.ok(attempt.available_at);
 assert.equal(replayParallelCut(original.selected,f.definition,original.continuation.configuration,original.continuation.audit),true);
 for(const change of [
  s=>{s.selected.attempts.find(a=>a.number===2).number=3;},
  s=>{s.selected.attempts.find(a=>a.number===2).available_at='2000-01-01T00:00:00.000Z';},
  s=>{s.continuation.audit=s.continuation.audit.filter(a=>a.kind!=='retry_scheduled');},
  s=>{s.continuation.audit=s.continuation.audit.filter(a=>a.kind!=='script_process_exit');},
 ]){const bad=structuredClone(original);change(bad);assert.equal(replayParallelCut(bad.selected,f.definition,bad.continuation.configuration,bad.continuation.audit),false);}
 const finish=async id=>{for(let n=0;n<150&&f.branches.execution(id).state!=='completed';n++){await f.tick();const lease=claim();if(lease)f.settle(lease);await f.branches.unitSaver.drain();}assert.equal(f.branches.execution(id).state,'completed');};
 await finish(f.source.id);const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,`retry-${delayMs}`);
 const restored=f.branches.detail(next.id).attempts;assert.equal(restored.length,original.selected.attempts.length);assert.ok(restored.every(a=>a.fence===0));
 assert.equal(f.store.sqlite.prepare('SELECT available_at FROM branch_attempts WHERE id=?').get(restored.find(a=>a.number===2).id).available_at,attempt.available_at);
 await f.reopen();assert.equal(f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,`retry-${delayMs}`).id,next.id);
 await finish(next.id);assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
 assert.ok(f.points(next.id).some(cp=>cp.snapshot.selected.attempts.some(a=>a.number===2)),'the restored generation prefix can be selected again');
});

// Deferred: the identity and exit observations are controlled fixture evidence, not native execution.
test('an observed drained Script remainder restores canceled without relaunching the canceled effect',async t=>{
 const f=fixture(t,{transform(d){d.controls.find(c=>c.kind==='map').maxConcurrentItems=2;const j=d.controls.find(c=>c.kind==='join');j.mode='any';j.remainder='cancel';}});
 const leases=[];for(let n=0;n<40&&leases.length<2;n++){await f.tick();const lease=f.branches.claimScript('inert');if(lease){f.branches.authorizeScript(lease,identity);leases.push(lease);}}
 assert.equal(leases.length,2);const [winner,loser]=leases;
 f.branches.recordScriptEvidence(winner,identity,{stdout:'winner',outputHash:hash('winner'),code:0});f.branches.settleScript(winner,{failed:false,output:'winner'});
 for(let n=0;n<20&&f.branches.detail(f.source.id).attempts.find(a=>a.id===loser.attemptId).state!=='outcome_unknown';n++)await f.tick();
 assert.equal(f.branches.detail(f.source.id).attempts.find(a=>a.id===loser.attemptId).state,'outcome_unknown');
 assert.ok(!f.points(f.source.id).some(cp=>cp.snapshot.selected.attempts.some(a=>a.id===loser.attemptId&&a.state==='outcome_unknown')));
 f.branches.recordScriptEvidence(loser,identity,{stdout:'discarded canceled output',outputHash:hash('discarded canceled output'),code:null});
 f.branches.recoverScript(loser.attemptId);await f.branches.unitSaver.drain();
 const cut=f.points(f.source.id).find(cp=>cp.snapshot.selected.attempts.some(a=>a.id===loser.attemptId&&a.state==='canceled'));assert.ok(cut);
 const original=cut.snapshot;assert.equal(replayParallelCut(original.selected,f.definition,original.continuation.configuration,original.continuation.audit),true);
 for(const kind of ['script_cleanup_observed','script_process_exit']){
  const bad=structuredClone(original);bad.continuation.audit=bad.continuation.audit.filter(a=>!(a.kind===kind&&(a.transition_key.includes(loser.attemptId)||JSON.parse(a.evidence_json).attemptId===loser.attemptId)));
  assert.equal(replayParallelCut(bad.selected,f.definition,bad.continuation.configuration,bad.continuation.audit),false);
 }
 await f.finish(f.source.id);const next=f.branches.rewindHistorical(f.branch.id,f.source.id,cut.id,cut.contentHash,'drained');
 const canceled=f.branches.detail(next.id).attempts.find(a=>a.state==='canceled');assert.ok(canceled);assert.equal(canceled.fence,0);assert.equal(canceled.result,undefined);
 await f.finish(next.id);assert.equal(f.branches.execution(next.id).output,f.branches.execution(f.source.id).output);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='script_authorized' AND json_extract(evidence_json,'$.attemptId')=?").get(next.id,canceled.id).n,0);
});
