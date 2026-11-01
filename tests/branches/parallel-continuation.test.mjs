import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store} from '../../packages/agents/dist/index.js';
import {replayParallelCut,parallelDefinitionSupported} from '../../packages/agents/dist/branch-parallel-continuation.js';
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
 const extraBindings=transform?.(definition,{branches,chat,dir})??{};
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
 f.branches.checkpointInterruption(f.branch.id,f.source.id,'resume',old.id,'parallel-resume');
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
