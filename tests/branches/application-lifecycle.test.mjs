import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {recoveredRuntimeProcessHandle} from '@ponderosa/engines';
import {createServer} from '../../apps/server/dist/app.js';
import {until} from '../shared/fixture.mjs';

const options={timeout:30000,skip:process.platform==='win32'?'Recoverable Branch Scripts currently require POSIX containment':false};
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'branch-app-current-')),dataDir=path.join(root,'data'),store=new AgentStore(dataDir),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 let app,passed=false;const identities=[];
 t.after(async()=>{let closed=false;try{if(app){if(!passed){const debug=await app.inject({method:'GET',url:'/api/ready'});console.log('LIFECYCLE_FAILURE_STATUS',debug.body);}app.prepareForShutdown();await app.close()}else store.close();closed=true;for(const identity of identities)assert.equal(recoveredRuntimeProcessHandle(identity,{label:'Observed test Script'}).isAlive(),false)}finally{if(passed&&closed)await rm(root,{recursive:true,force:true});else t.diagnostic(`Retained application fixture: ${root}`)}});
 const deploy=(name,steps,edges=[])=>{const owner=branches.create(name,name.replaceAll(' ','-'));return branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:steps[0].id,steps,controls:[],edges,policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:root}}})};
 return {root,store,branches,deploy,identities,async open(){app=createServer({dataDir,store,logger:false,startDrained:true,engines:[],allowedBrowseRoots:[root],communicationV3:{pollMs:10}});await app.ready()},api:async(method,url,payload,expectedStatus=200)=>{const r=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.equal(r.statusCode,expectedStatus,r.body);return r.json()},async close(){app.prepareForShutdown();await app.close();app=undefined},pass(){passed=true}};
}

test('application drain sees real Branch Script authority even with zero provider Runs, and shutdown observes its complete process exit',options,async t=>{
 const f=await fixture(t),branch=f.deploy('Supervised Script',[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:15000,source:"import {writeFileSync,existsSync} from 'node:fs';import {setTimeout} from 'node:timers/promises';writeFileSync('started','yes');while(!existsSync('release'))await setTimeout(20);process.stdout.write('finished');"}]);
 const execution=f.branches.accept(branch.id,'one','Test input');await f.open();
 const initially=await f.api('GET','/api/ready',undefined,503);assert.equal(initially.checks.runtimes.ok,false,'The fixture intentionally configures no provider account');assert.equal(initially.deploymentDrain.workflowAuthorities,0);assert.equal(f.branches.execution(execution.id).state,'queued');
 await f.api('POST','/api/deployment/resume');await until(()=>existsSync(path.join(f.root,'started')),'owned Script start');
 const identity=JSON.parse(f.store.sqlite.prepare("SELECT process_identity_json FROM branch_attempts WHERE state='running'").get().process_identity_json);f.identities.push(identity);
 const drain=await f.api('POST','/api/deployment/drain');assert.equal(drain.schedulerRuns,0);assert.equal(drain.localRuns,0);assert.ok(drain.workflowAuthorities>0);assert.equal(drain.readyForRestart,false);assert.ok(drain.blockers.some(row=>row.kind==='workflow'));
 await writeFile(path.join(f.root,'release'),'release');await until(()=>f.branches.execution(execution.id).state==='completed','Script result');
 const idle=await until(async()=>{const ready=await f.api('GET','/api/ready',undefined,503);return ready.deploymentDrain.readyForRestart&&ready.deploymentDrain},'observed Script drain');assert.equal(idle.workflowAuthorities,0);assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
 await f.close();assert.equal(recoveredRuntimeProcessHandle(identity,{label:'Observed test Script'}).isAlive(),false);f.pass();
});

test('application shutdown closes a Branch Script still waiting for external input rather than leaving it behind',options,async t=>{
 const f=await fixture(t),branch=f.deploy('Shutdown Script',[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:15000,source:"import {writeFileSync} from 'node:fs';writeFileSync('started','yes');await new Promise(()=>setInterval(()=>{},1000));"}]);
 f.branches.accept(branch.id,'one','Test input');await f.open();await f.api('POST','/api/deployment/resume');await until(()=>existsSync(path.join(f.root,'started')),'owned Script start');
 const identity=JSON.parse(f.store.sqlite.prepare("SELECT process_identity_json FROM branch_attempts WHERE state='running'").get().process_identity_json);f.identities.push(identity);
 await f.close();assert.equal(recoveredRuntimeProcessHandle(identity,{label:'Observed test Script'}).isAlive(),false);f.pass();
});

test('application schedule intake stays fenced during deployment drain and admits one durable catch-up after resume',options,async t=>{
 const f=await fixture(t),owner=f.branches.create('Scheduled source','scheduled-source'),startsAt=new Date(Date.now()-120000).toISOString();
 const branch=f.branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Scheduled source',trigger:{kind:'schedule',configRef:'source'},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('scheduled result');"}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:f.root},triggers:{source:{sourceConfig:{scheduleKind:'interval',everyMs:60000,startsAt},enabled:true}}}},new Date().toISOString(),{sourceConfig:{scheduleKind:'interval',everyMs:60000,startsAt},nextFireAt:startsAt});
 await f.open();assert.equal(f.branches.triggers.listTriggerOccurrences(branch.triggerId).length,0);
 await f.api('POST','/api/deployment/resume');
 const event=await until(()=>f.branches.triggers.listTriggerOccurrences(branch.triggerId)[0],'application schedule admission');
 await until(()=>f.branches.execution(event.branchExecutionId).state==='completed','scheduled Script result');
 await f.api('POST','/api/deployment/drain');
 await until(async()=>{const ready=await f.api('GET','/api/ready',undefined,503);return ready.deploymentDrain.readyForRestart},'source drain');
 f.branches.triggers.updateTriggerDefinition(branch.triggerId,{nextFireAt:startsAt});
 assert.equal(f.branches.triggers.listTriggerOccurrences(branch.triggerId).length,1);assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
 await f.close();f.pass();
});

test('deployment drain closes Branch filesystem watchers, preserves accepted bursts, and resumes their exact evidence',options,async t=>{
 const f=await fixture(t),owner=f.branches.create('Filesystem source','filesystem-source'),config={include:['input-*.txt'],exclude:[],quietMs:10000,maxWindowMs:20000};
 const branch=f.branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Filesystem source',trigger:{kind:'filesystem',configRef:'source'},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('file result');"}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:f.root},triggers:{source:{sourceConfig:config,enabled:true}}}},new Date().toISOString(),{sourceConfig:config});
 await f.open();await f.api('POST','/api/deployment/resume');
 // Repeated writes are an observation handshake, not a fixed sleep: startup
 // deliberately does not wait for chokidar's initial directory inventory.
 await until(async()=>{await writeFile(path.join(f.root,'input-before.txt'),'before');return f.branches.triggers.getFilesystemTriggerBurst(branch.triggerId)},'real application watcher');
 await f.api('POST','/api/deployment/drain');await until(async()=>{const ready=await f.api('GET','/api/ready',undefined,503);return ready.deploymentDrain.readyForRestart},'watcher shutdown');
 const before=f.branches.triggers.getFilesystemTriggerBurst(branch.triggerId);assert.ok(before);
 await writeFile(path.join(f.root,'input-drained.txt'),'while drained');assert.deepEqual(f.branches.triggers.getFilesystemTriggerBurst(branch.triggerId),before);
 await f.api('POST','/api/deployment/resume');
 await until(async()=>{await writeFile(path.join(f.root,'input-after.txt'),'after');return f.branches.triggers.getFilesystemTriggerBurst(branch.triggerId)?.changes.some(item=>item.path==='input-after.txt')},'replacement watcher');
 const after=f.branches.triggers.getFilesystemTriggerBurst(branch.triggerId);assert.equal(after.occurrenceKey,before.occurrenceKey);assert.ok(after.changes.some(item=>item.path==='input-before.txt'));assert.equal(after.changes.some(item=>item.path==='input-drained.txt'),false);
 await f.close();f.pass();
});
