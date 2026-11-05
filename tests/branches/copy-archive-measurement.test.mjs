import assert from 'node:assert/strict';
import test from 'node:test';
import {readdir,stat,writeFile,access,readFile} from 'node:fs/promises';
import path from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store,readBranchExpertCopy} from '../../packages/agents/dist/index.js';
import {checkpointPackageCustody} from '../../apps/server/dist/checkpoint-agent-packages.js';
import {decodePortableArtifactData} from '../../apps/server/dist/agent-package-codec.js';
import {withFixture,until} from '../shared/fixture.mjs';

async function custodySizes(root){
 const dir=path.join(root,'checkpoint-package-custody');
 let names;try{names=await readdir(dir);}catch(error){if(error.code==='ENOENT')return {logical:0,allocated:0,files:0,payload:0};throw error;}
 let logical=0,allocated=0,payload=0;const pending=[],receipts=[],payloadIds=[];
 for(const name of names){
  const info=await stat(path.join(dir,name));if(!info.isFile())continue;logical+=info.size;allocated+=info.blocks*512;
  if(name.endsWith('.payload')){payload+=info.size;payloadIds.push(name.slice(0,-8));}
  else if(name.endsWith('.pending.json')){const r=JSON.parse(await readFile(path.join(dir,name),'utf8'));pending.push({id:name.slice(0,-13),state:r.state,reason:r.reason??null});}
  else if(/^[a-f0-9]{64}\.json$/.test(name)){const r=JSON.parse(await readFile(path.join(dir,name),'utf8'));receipts.push({id:r.custodyId,bytes:r.byteLength});}
 }
 return {logical,allocated,files:names.length,payload,receiptCount:receipts.length,pending,payloadsWithoutReceipt:payloadIds.filter(id=>!receipts.some(r=>r.id===id)).length};
}
async function inspectPackage(custody,receipt,expectedAgent){
 const pkg=await custody.read(receipt),node=pkg.agents.find(a=>a.ref===expectedAgent);assert.ok(node);
 const archives=[];for(const artifact of node.artifacts??[])if(artifact.mediaType==='application/vnd.ponderosa.execution-archive+json'){
  const {data}=await decodePortableArtifactData(artifact);archives.push(JSON.parse(data.toString('utf8')));
 }
 return {pkg,node,archives};
}

test('measure six reviewed temporary copies in two overlapping waves',{timeout:240000},async t=>{
 let store,sourceId;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Synthetic copy measurement'),source=await f.createIdleAgent(chat,'Persistent source');sourceId=source.id;
  const sourceRoot=store.getAgent(source.id).workingCopy.rootPath;
  await writeFile(path.join(sourceRoot,'source-only.txt'),'Source-only file intentionally not copied.\n',{flag:'wx'});
  const sourceSession=await f.hold(source.id);
  f.ok(await f.tool(sourceSession,'ponderosa_message',{intent:'direct_to_user',text:'Synthetic source history marker.'}));
  sourceSession.finish();await f.settled(source.id);
  const sourceRuns=store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs WHERE agent_id=?').get(source.id).n;
  const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const definition={schema:'ponderosa.branch.v1',name:'Copy measurement',trigger:{kind:'manual'},entry:'work',controls:[],
   steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'source'},instructions:'Complete the exact independent synthetic task',jobHandling:'copy'}],edges:[],
   policy:{maxConcurrentExecutions:3,maxEphemeralAgents:1,failure:{action:'stop'}}};
  const branch=branches.deploy({chatId:chat.id,idempotencyKey:'measurement-deploy',definition,bindings:{agents:{source:source.id},directories:{workspace:f.root}}});
  const custody=checkpointPackageCustody(f.dataDir),before=await custodySizes(f.dataDir),waves=[];
  for(let wave=1;wave<=2;wave++){
   const jobs=Array.from({length:3},(_,i)=>branches.accept(branch.id,'measurement-'+wave+'-'+(i+1),'Synthetic task wave '+wave+' item '+(i+1)));
   const items=[];
   for(const job of jobs){
    const resource=await until(()=>store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id),'copy reservation',30000);
    const url=`/api/branches/${branch.id}/executions/${job.id}/resources/${resource.step_execution_id}`;
    const review=await until(async()=>{const r=await f.api('GET',url);return r.status===200&&r.body.currentPolicyReview&&r.body.expertCopyReview?r.body:undefined;},'copy review',60000);
    assert.equal(review.expertCopyReview.sourceMemoryAvailable,false);
    const approved=await f.api('POST',url+'/access-review',{accessSettingsResolution:{action:'keep_destination',reviewSha256:review.expertCopyReview.reviewWithoutMemorySha256,agentActions:Object.fromEntries(review.currentPolicyReview.source.filter(x=>x.settings).map(x=>[x.ref,'keep_destination']))},snapshotSha256:review.expertCopyReview.snapshotSha256,copySourceMemory:false,allowFindingsWriteback:false});
    assert.equal(approved.status,200,JSON.stringify(approved.body));items.push({job,resource,url});
   }
   for(const item of items)item.receipt=await until(()=>{const r=readBranchExpertCopy(store.sqlite,item.job.id,item.resource.step_execution_id);return r?.state==='active'&&r;},'copy active',60000);
   assert.equal(new Set(items.map(x=>x.receipt.copyAgentId)).size,3);
   await until(()=>items.every(x=>f.turns.some(t=>t.agentId===x.receipt.copyAgentId)&&store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status='running' AND prompt_injection_state='injected'").get(x.receipt.copyAgentId)),'three simultaneously running copies',60000);
   const measured=[];
   for(let i=0;i<items.length;i++){
    const item=items[i],copy=item.receipt.copyAgentId,root=store.getAgent(copy).workingCopy.rootPath;
    await assert.rejects(access(path.join(root,'source-only.txt')),error=>error.code==='ENOENT');
    assert.equal(await (await import('node:fs/promises')).readFile(path.join(root,'job-output.txt'),'utf8'),'Synthetic job-created output for '+copy+'\n');
    const response=await f.tool(f.sessions.get(copy),'ponderosa_update_request',{requestId:item.receipt.requestId,text:'Synthetic completed result '+wave+'-'+(i+1)});
    assert.equal(response.status,200,JSON.stringify(response.body));f.sessions.get(copy).finish();
   }
   for(const [i,item] of items.entries()){
    await until(()=>branches.execution(item.job.id)?.state==='completed','copy job completion',60000);
    await until(()=>store.sqlite.prepare("SELECT 1 FROM branch_resources WHERE step_execution_id=? AND state='retired'").get(item.resource.step_execution_id),'copy cleanup',90000);
    const r=readBranchExpertCopy(store.sqlite,item.job.id,item.resource.step_execution_id);assert.ok(r.finalSnapshotReceipt);assert.equal(r.finalVerifiedSha256,r.finalSnapshotReceipt.sha256);
    const details=await f.api('GET',item.url);assert.equal(details.status,200,JSON.stringify(details.body));
    const trace=details.body.temporaryCopyTrace;assert.ok(trace);assert.equal(trace.sourceAgentId,source.id);assert.equal(trace.copyAgentId,r.copyAgentId);assert.equal(trace.requestId,r.requestId);assert.equal(trace.task.input,item.job.input);assert.ok(trace.result);assert.equal(trace.historyAvailable,true);
    assert.ok(JSON.stringify(trace.task).includes('Synthetic task wave '+wave),'operator trace retains the exact task');
    assert.ok(JSON.stringify(trace.result).includes('Synthetic completed result '+wave+'-'+(i+1)),'operator trace retains the exact result');
    const readback=await f.api('GET',item.url+'/copy-history');assert.equal(readback.status,200,JSON.stringify(readback.body));
    assert.equal(readback.body.sourceAgentId,source.id);assert.equal(readback.body.copyAgentId,r.copyAgentId);assert.equal(readback.body.requestId,r.requestId);
    assert.ok(readback.body.runs.some(run=>run.agentId===r.copyAgentId&&run.status==='completed'),'operator readback contains the completed copy Run');
    assert.ok(readback.body.events.some(event=>event.agentId===r.copyAgentId),'operator readback contains copy Work log');
    assert.ok(readback.body.runs.some(run=>run.agentId===source.id),'operator readback contains the source Run');
    assert.ok(JSON.stringify(readback.body.messages).includes('Synthetic source history marker.'),'operator readback contains the source history');
    assert.equal(store.getAgent(r.copyAgentId),undefined,'temporary Agent has been deleted');
    assert.equal(store.getConversation(r.copyChatId),undefined,'temporary Chat has been deleted');
    const original=await inspectPackage(custody,r.snapshotReceipt,source.id),final=await inspectPackage(custody,r.finalSnapshotReceipt,r.copyAgentId);
    const sourceHistory=JSON.stringify(original.node.history??[]),finalHistory=JSON.stringify(final.node.history??[]);
    assert.ok(sourceHistory.includes('Synthetic source history marker.'),'source history retained');
    assert.ok(!(original.node.workingFiles??[]).some(v=>v.path==='source-only.txt'),'source snapshot deliberately does not include source folder file');
    const output=(final.node.workingFiles??[]).find(v=>v.path==='job-output.txt');assert.ok(output,'final copy workspace file captured');
    const outputArtifact=final.node.artifacts.find(v=>v.ref===output.artifactRef);assert.equal((await decodePortableArtifactData(outputArtifact)).data.toString('utf8'),'Synthetic job-created output for '+r.copyAgentId+'\n');
    const copyArchive=final.archives.find(a=>a.sourceAgentId===r.copyAgentId);assert.ok(copyArchive,'temporary copy execution archive retained');
    assert.ok(copyArchive.runs.some(x=>x.status==='completed'),'completed Run metadata retained');
    assert.equal(copyArchive.runs.length,1,'this exact copied task had one Run');
    const archived=JSON.stringify({history:final.node.history,archives:final.archives});
    const remainingEvents=store.sqlite.prepare('SELECT count(*) n FROM events WHERE agent_id=?').get(r.copyAgentId).n;
    const remainingRuns=store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs WHERE agent_id=?').get(r.copyAgentId).n;
    assert.equal(remainingEvents,0);assert.equal(remainingRuns,0);
    measured.push({sourceBytes:r.snapshotReceipt.byteLength,finalBytes:r.finalSnapshotReceipt.byteLength,sourceHistoryMessages:original.node.history?.length??0,sourceArchives:original.archives.length,finalHistoryMessages:final.node.history?.length??0,finalArchives:final.archives.length,copyArchiveEvents:copyArchive.events.length,copyArchiveRuns:copyArchive.runs.length,sourceHistoryPresent:sourceHistory.includes('Synthetic source history marker.'),sourceHistoryInFinal:finalHistory.includes('Synthetic source history marker.'),operatorReadback:true,operatorSourceRunPresent:readback.body.runs.some(run=>run.agentId===source.id),operatorSourceHistoryPresent:JSON.stringify(readback.body.messages).includes('Synthetic source history marker.'),operatorTaskMarkerPresent:JSON.stringify(trace.task).includes('Synthetic task wave '+wave),operatorResultMarkerPresent:JSON.stringify(trace.result).includes('Synthetic completed result '+wave+'-'+(i+1)),taskMarkerInFinal:archived.includes('Synthetic task wave '+wave),resultMarkerInFinal:archived.includes('Synthetic completed result '+wave+'-'+(i+1)),finalJobFileBytes:Buffer.byteLength('Synthetic job-created output for '+r.copyAgentId+'\n'),sourceFileCopied:false,remainingLiveEvents:remainingEvents,remainingLiveRuns:remainingRuns});
   }
   const size=await custodySizes(f.dataDir);waves.push({wave,copies:measured,custody:size});
  }
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs WHERE agent_id=?').get(source.id).n,sourceRuns,'original never awakened by copies');
  console.log('COPY_ARCHIVE_MEASUREMENT',JSON.stringify({concurrentPerWave:3,waves,baseline:before,memory:'disabled',provider:'synthetic',sourceFolderCopied:false}));
 },{storeFactory:dir=>(store=new AgentStore(dir)),providerRunPlan:({agentId})=>agentId===sourceId?undefined:{hold:true,onStart:async()=>{
   const root=store.getAgent(agentId).workingCopy.rootPath;
   await writeFile(path.join(root,'job-output.txt'),'Synthetic job-created output for '+agentId+'\n',{flag:'wx'});
  }}});
});
