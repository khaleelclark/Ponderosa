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
function fixture(t,{nested=false,mode='async'}={}){
 const dir=mkdtempSync(join(tmpdir(),'parallel-continuation-'));let store,branches;
 const open=()=>{store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));};open();
 const project=store.createProject({label:'Parallel continuation',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Parallel'});
 const definition={schema:'ponderosa.branch.v1',name:'Parallel continuation',trigger:{kind:'manual'},entry:nested?'fork':'map',steps:[script('worker'),script('tail'),...(nested?[script('sibling')]:[])],
  controls:[{id:'map',kind:'map',joinId:'mapped',workerId:'worker',source:'list',maxItems:4,maxConcurrentItems:1},{id:'mapped',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]},...(nested?[{id:'fork',kind:'fork',joinId:'joined'},{id:'joined',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['right','left']}]:[])],
  edges:[edge('item','map','worker','selected'),edge('return','worker','mapped'),edge('after-map','mapped',nested?'joined':'tail'),...(nested?[edge('left','fork','map','selected',{input:{kind:'literal',text:'["one","two"]'}}),edge('right','fork','sibling','selected'),edge('sibling-return','sibling','joined'),edge('tail-edge','joined','tail')]:[])],policy:{maxConcurrentExecutions:8,maxPathInstances:20,maxStepInvocations:20,failure:{action:'stop'}}};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{},directories:{root:dir}}});
 branches.configure(branch.id,{...branches.configuration(branch.id),checkpointMode:mode},0);
 const source=branches.accept(branch.id,'source','["one","two"]');
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const settle=lease=>{const output=lease.input;branches.authorizeScript(lease,identity);branches.recordScriptEvidence(lease,identity,{stdout:output,outputHash:hash(output),code:0});branches.settleScript(lease,{failed:false,output});};
 const tick=async()=>{branches.advance();await branches.unitSaver.drain();};
 const points=id=>branches.historicalCheckpoints(branch.id,id).filter(cp=>cp.restoreSupported).map(cp=>({...cp,snapshot:JSON.parse(store.sqlite.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE id=?').get(cp.id).snapshot_json)}));
 const finish=async id=>{for(let n=0;n<150&&branches.execution(id).state!=='completed';n++){await tick();const lease=branches.claimScript('inert');if(lease)settle(lease);await branches.unitSaver.drain();}assert.equal(branches.execution(id).state,'completed');};
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
 for(const mutate of [d=>d.controls.find(c=>c.kind==='join').mode='any',d=>d.edges[0].loop=true,d=>d.steps[0]={id:'worker',kind:'agent',target:{kind:'bound',agentRef:'a'}},d=>d.parameters={secret:{type:'secret'}}]){const d=structuredClone(f.definition);mutate(d);assert.equal(parallelDefinitionSupported(d),false);}
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
