import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {AgentStore,BranchStore,CoordinationV3Store} from '../dist/index.js';
const script={id:'script',kind:'script',runtime:'node',source:'console.log("ok")',cwdRef:'root',timeoutMs:1000};
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'branch-script-claims-'));let store,branches;
 function open(){store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite))}open();
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
 return {dir,get branches(){return branches},get db(){return store.sqlite},reopen(){store.close();open()},
 deploy(name,steps=[script],bindings={}){const owner=branches.create(name,name);return branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:name,
 definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:steps[0].id,steps,controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:dir},...bindings}})},
 advance(){for(let i=0;i<8;i++)branches.advance()}};
}
test('more than a batch of disabled Calls cannot starve a frozen Script, including after reopening',t=>{
 const f=fixture(t),child=f.deploy('child'),parent=f.deploy('parent',[{id:'call',kind:'branch_call',branchRef:'child'}],{branches:{child:child.id}});
 f.branches.setEnabled(child.id,false);
 const calls=Array.from({length:120},(_,i)=>f.branches.accept(parent.id,'call-'+i,'waiting'));
 const independent=f.deploy('independent'),execution=f.branches.accept(independent.id,'eligible','input');f.advance();f.reopen();
 const lease=f.branches.claimScript('worker');assert.equal(lease?.executionId,execution.id);
 assert.equal(f.branches.claimScript('duplicate'),undefined);
 for(const call of calls)assert.equal(f.branches.detail(call.id).attempts[0].state,'prepared','unrelated Calls remain waiting');
 f.branches.settleScript(lease,{failed:false,output:'ok'});assert.equal(f.branches.execution(execution.id).state,'completed');
 assert.throws(()=>f.branches.settleScript(lease,{failed:false,output:'late'}),/fenced/);
});
function blocked(f){
 const full=f.deploy('full'),executions=Array.from({length:121},(_,i)=>f.branches.accept(full.id,'blocked-'+i,'input'));
 f.advance();const active=f.branches.claimScript('holder');assert.equal(active.executionId,executions[0].id);
 const other=f.deploy('other'),eligible=f.branches.accept(other.id,'eligible','input');f.advance();
 return {active,executions,eligible};
}
test('bounded rotation passes more than 100 capacity-ineligible Scripts after restart without claiming them',t=>{
 const f=fixture(t),{active,executions,eligible}=blocked(f);f.reopen();
 assert.equal(f.branches.claimScript('worker'),undefined,'first bounded batch stays full');
 const lease=f.branches.claimScript('worker');assert.equal(lease?.executionId,eligible.id);
 for(const e of executions.slice(1))assert.equal(f.branches.detail(e.id).attempts[0].state,'prepared');
 f.branches.cancel(eligible.id);assert.throws(()=>f.branches.settleScript(lease,{failed:false,output:'late'}),/fenced/);
 f.branches.settleScript(active,{failed:false,output:'done'});
 const next=f.branches.claimScript('worker');assert.ok(executions.some(e=>e.id===next?.executionId),'released capacity remains claimable');
});
test('concurrent processes scan blocked batches but claim the independent attempt exactly once',{timeout:15000},async t=>{
 const f=fixture(t),{eligible}=blocked(f);
 const workers=[0,1].map(()=>fork(new URL('./branch-script-claim-worker.mjs',import.meta.url),[join(f.dir,'ponderosa.db')],{stdio:['ignore','ignore','inherit','ipc']}));
 t.after(()=>workers.forEach(w=>{if(w.exitCode===null)w.kill()}));
 await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('message',v=>v==='ready'?resolve():reject(v));w.once('error',reject);w.once('exit',c=>reject(Error('early exit '+c)))})));
 const results=workers.map(w=>new Promise((resolve,reject)=>{let result;w.on('message',v=>result=v);w.once('error',reject);w.once('exit',c=>c===0?resolve(result):reject(Error('worker exit '+c+' '+JSON.stringify(result))))}));
 workers.forEach(w=>w.send('go'));const claimed=(await Promise.all(results)).flatMap(r=>r.lease?[r.lease]:[]);
 assert.equal(claimed.length,1);assert.equal(claimed[0].executionId,eligible.id);f.reopen();
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='script_leased'").get(eligible.id).n,1);
 f.branches.settleScript(claimed[0],{failed:false,output:'done'});assert.equal(f.branches.execution(eligible.id).state,'completed');
});
