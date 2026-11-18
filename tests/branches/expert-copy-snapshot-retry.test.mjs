import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store,readBranchExpertCopy,SourceCaptureChangedError} from '@ponderosa/agents';
import {BranchResourceService} from '../../apps/server/dist/branch-resource-service.js';
import {checkpointPackageCustody} from '../../apps/server/dist/checkpoint-agent-packages.js';
import {until} from '../shared/fixture.mjs';

for(const scenario of ['confirmed_source_changed','capturing','failed_other','missing_after_exception'])test(`temporary copy snapshot retry preserves custody for ${scenario}`,{timeout:30000},async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'copy-snapshot-retry-')),store=new AgentStore(root);
 const coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const project=store.createProject({label:'Source',hostPath:root,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Source'});
 const agent=store.createAgent(project.id,{title:'Source agent',engine:'codex',conversationId:chat.id});
 const definition={schema:'ponderosa.branch.v1',name:'Snapshot retry',trigger:{kind:'manual'},entry:'work',controls:[],
  steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'source'},instructions:'Work',jobHandling:'copy'}],edges:[],
  policy:{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}}};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'copy-snapshot-deploy',definition,bindings:{agents:{source:agent.id},directories:{workspace:root}}});
 const job=branches.accept(branch.id,'copy-snapshot-job','input');for(let i=0;i<6;i++)branches.advance();
 const resource=store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id);
 const before=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
 await until(()=>branches.resourceRelease(resource.step_execution_id,resource.creation_key)==='ready','resource snapshot release',5000);
 const custody=checkpointPackageCustody(root),directory=path.join(root,'checkpoint-package-custody');
 let retainedBytes,stagedNames=[];
 if(scenario==='confirmed_source_changed'){
  const pkg={schema:'ponderosa.agent-package.v1',mode:'full',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Synthetic',rootRef:agent.id,agents:[{ref:agent.id,title:'Source',engine:'codex',sourceChat:{ref:chat.id,title:'Source'},managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]};
  await assert.rejects(()=>custody.capture(before.snapshotSource,'controlled-boundary',async()=>pkg,()=>{throw new SourceCaptureChangedError()}),/source changed/i);
  const status=await custody.inspect(before.snapshotSource);assert.equal(status.state,'failed');assert.equal(status.reason,'source_changed');
  stagedNames=readdirSync(directory).sort();assert.ok(stagedNames.some(x=>x.endsWith('.pending.json')));assert.ok(stagedNames.some(x=>x.endsWith('.payload')));
  retainedBytes=new Map(stagedNames.map(name=>[name,readFileSync(path.join(directory,name))]));
 }
 const service=new BranchResourceService(branches,store,async()=>{},async()=>{throw Error('Chat creation must not run')},async()=>{});
 service.setImporter(async()=>{throw Error('Import must not run')});
 service.setPackageEngine({
  inspectCheckpoint:scenario==='confirmed_source_changed'?custody.inspect:async()=>scenario==='capturing'?{state:'capturing'}:scenario==='failed_other'?{state:'failed',reason:'capture_failed'}:{state:'missing'},
  captureExpertSnapshot:async()=>{throw new SourceCaptureChangedError()},
 });
 t.after(async()=>{await service.stop();store.close()});
 await service.tick(true);
 const after=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
 if(scenario==='confirmed_source_changed'){
  assert.notEqual(after.snapshotSource.checkpointId,before.snapshotSource.checkpointId);
  assert.equal(after.snapshotFailures.length,1);assert.equal(after.snapshotFailures[0].reason,'source_changed');
  assert.deepEqual(readdirSync(directory).sort(),stagedNames);
  for(const [name,bytes] of retainedBytes)assert.deepEqual(readFileSync(path.join(directory,name)),bytes,'failed staged evidence was preserved');
 }else{
  assert.equal(after.snapshotSource.checkpointId,before.snapshotSource.checkpointId,'unconfirmed or different outcomes are not retried');
  assert.equal(after.snapshotFailures,undefined);
  assert.ok(store.sqlite.prepare('SELECT error FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id).error);
 }
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM coordination_requests WHERE recipient_agent_id=?').get(agent.id).n,0);
});
