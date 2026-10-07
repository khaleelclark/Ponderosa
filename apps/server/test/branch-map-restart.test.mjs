import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {BranchScriptService} from '../dist/branch-script-service.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let i=0;i<160;i++){if(predicate())return;await pause(25)}throw new Error('Map state did not become ready')}

test('SIGKILL after Map admission preserves item identities, completed results, and uncertain work',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'branch-map-restart-'));
 let store=new AgentStore(dir),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 let child,service;
 t.after(async()=>{if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited}await service?.stop().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true})});
 const branch=branches.create('Restart Map','map-restart');
 const source=`import {writeFileSync} from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;if(input==='slow'){writeFileSync('slow-started','yes');setInterval(()=>{},1000)}else process.stdout.write(input);`;
 const definition={schema:'ponderosa.branch.v1',name:'Restart Map',trigger:{kind:'manual'},entry:'map',steps:[{id:'worker',kind:'script',runtime:'node',source,cwdRef:'root',timeoutMs:30_000}],controls:[{id:'map',kind:'map',joinId:'join',workerId:'worker',source:'list',maxItems:3,maxConcurrentItems:2},{id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}],edges:[{id:'item',from:'map',to:'worker',on:'selected'},{id:'return',from:'worker',to:'join',on:'success'}],policy:{maxConcurrentExecutions:1,maxPathInstances:10,maxStepInvocations:10,failure:{action:'stop'}}};
 branches.deploy({chatId:'',branchId:branch.id,expectedVersionId:branch.versionId,idempotencyKey:'deploy',definition,bindings:{agents:{},directories:{root:dir}}});
 const execution=branches.accept(branch.id,'run','["done","slow","pending"]');branches.advance();
 const first=branches.claimScript('setup');assert.equal(first.input,'done');branches.settleScript(first,{failed:false,output:'done'});
 const original=branches.detail(execution.id),mapId=original.maps[0].id,itemsHash=original.maps[0].itemsHash,doneResult=original.sealedResults[0].id;
 store.close();
 child=fork(new URL('./branch-crash-worker.mjs',import.meta.url),[dir,'1'],{stdio:['ignore','ignore','inherit','ipc']});
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error(`worker exited ${code}`)))});
 await until(()=>existsSync(join(dir,'slow-started')));
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;child=undefined;
 store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 service=new BranchScriptService(branches,store,'restart',{maxConcurrentScripts:1});await service.tick(true);
 const recovered=branches.detail(execution.id);
 assert.equal(recovered.maps[0].id,mapId);assert.equal(recovered.maps[0].itemsHash,itemsHash);
 assert.equal(recovered.sealedResults.filter(result=>result.id===doneResult).length,1);
 assert.equal(recovered.steps.find(step=>step.input==='slow').state,'outcome_unknown');
 assert.equal(recovered.mapItems.length,3);
 for(let i=0;i<80&&branches.detail(execution.id).mapItems.filter(item=>item.state==='arrived').length<2;i++){await service.tick(true);await pause(25)}
 assert.equal(branches.detail(execution.id).sealedResults.filter(result=>result.id===doneResult).length,1);
 assert.equal(branches.detail(execution.id).mapItems.filter(item=>item.state==='arrived').length,2,JSON.stringify({items:branches.detail(execution.id).mapItems,attempts:branches.detail(execution.id).attempts}));
 assert.equal(branches.execution(execution.id).state,'waiting');
 assert.equal(branches.detail(execution.id).maps.length,1);
});
