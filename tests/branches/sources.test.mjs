import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,readFile,symlink,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {BranchTriggerSourceService,normalizeTriggerSourceConfig} from '../../apps/server/dist/branch-trigger-service.js';
import {triggerSourceConfig} from '../../apps/server/dist/branch-trigger-config.js';
import {BranchTriggerSecretStore} from '../../apps/server/dist/branch-trigger-secrets.js';
import {until} from '../shared/fixture.mjs';

async function fixture(t,kind,config,{secret=false,nextFireAt}={}){
 const root=await mkdtemp(path.join(tmpdir(),'branch-source-current-')),dataDir=path.join(root,'data'),workspace=path.join(root,'work');await mkdir(workspace);
 let store,branches,sources,passed=false,available=true;const notices=[],failures=[];
 const open=()=>{store=new AgentStore(dataDir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));sources=new BranchTriggerSourceService({store,triggers:branches.triggers,dataDir,notify:id=>notices.push(id),sourceAvailable:()=>available,onSourceFailure:value=>failures.push(value)})};open();
 t.after(async()=>{let clean=false;try{await sources.stop();clean=true}finally{store.close();if(passed&&clean)await rm(root,{recursive:true,force:true});else t.diagnostic(`Retained source fixture: ${root}`)}});
 const owner=branches.create('Source','source'),signing=secret?sources.createWebhookSecret():undefined;
 const definition={schema:'ponderosa.branch.v1',name:'Source',trigger:{kind,configRef:'source'},entry:'work',steps:[{id:'work',kind:'script',runtime:'node',source:'process.stdout.write("unused")',cwdRef:'workspace',timeoutMs:1000}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 const bindings={agents:{},directories:{workspace},triggers:{source:{sourceConfig:config,enabled:true}}};
 const branch=branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition,bindings},new Date().toISOString(),{sourceConfig:config,...(nextFireAt?{nextFireAt}:{}),...(signing?{secretCiphertext:signing.ciphertext,secretFingerprint:signing.fingerprint}:{})});
 return {root,workspace,branch,definition,bindings,signing,notices,failures,get store(){return store},get branches(){return branches},get sources(){return sources},get triggers(){return branches.triggers},pause(){available=false},resume(){available=true},async reopen(){await sources.stop();store.close();open()},pass(){passed=true},noProviderWork(){assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);assert.equal(store.sqlite.prepare('SELECT count(*) n FROM coordination_requests').get().n,0)}};
}

test('schedule recovery collapses a long exact interval range into one durable Branch admission and advances its cursor once',async t=>{
 const startsAt=new Date(Date.now()-10005*60000).toISOString(),f=await fixture(t,'schedule',{scheduleKind:'interval',everyMs:60000,startsAt},{nextFireAt:startsAt});
 await f.sources.start();await f.sources.processDueSchedules();
 const events=f.triggers.listTriggerOccurrences(f.branch.triggerId);assert.equal(events.length,1);assert.equal(events[0].payload.collapsedRecovery,true);assert.ok(events[0].payload.exactIntervalRange.count>=10005);assert.equal(events[0].payload.scheduledTimes,undefined);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,1);assert.ok(Date.parse(f.triggers.getTriggerDefinition(f.branch.triggerId).nextFireAt)>Date.now());f.noProviderWork();f.pass();
});

test('signed webhook replay survives reopening, rejects tampering and cannot smuggle manual or direct Agent authority',async t=>{
 const f=await fixture(t,'webhook',{replayWindowSeconds:300},{secret:true});await f.sources.start();
 const payload={text:'Untrusted external content',operatorManual:true,recipientAgentId:'unrelated'},rawBody=Buffer.from(JSON.stringify(payload)),timestamp=String(Math.floor(Date.now()/1000)),eventId='external-event';
 const signature='v1='+createHmac('sha256',f.signing.secret).update(`${timestamp}.${eventId}.`).update(rawBody).digest('hex'),input={triggerId:f.branch.triggerId,eventId,timestamp,signature,rawBody,payload};
 const event=f.sources.verifyAndRecordWebhook(input);assert.equal(event.replayed,false);const occurrence=f.triggers.getTriggerOccurrence(event.occurrenceId);assert.equal(f.branches.execution(occurrence.branchExecutionId).admissionSource,'automatic');
 assert.equal(JSON.stringify(f.triggers.getTriggerDefinition(f.branch.triggerId)).includes(f.signing.secret),false);
 await f.reopen();await f.sources.start();assert.equal(f.sources.verifyAndRecordWebhook(input).occurrenceId,event.occurrenceId);assert.equal(f.sources.verifyAndRecordWebhook(input).replayed,true);
 for(const invalid of [{signature:'v1=invalid'},{rawBody:Buffer.from('{}')},{timestamp:'0'},{timestamp:'not-a-time'}])assert.throws(()=>f.sources.verifyAndRecordWebhook({...input,...invalid}),/signature|timestamp/);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,1);f.noProviderWork();f.pass();
});

test('filesystem bursts cap captured paths, retain one identity through restart and roll back the entire flush on admission failure',async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*'],exclude:[],quietMs:10000,maxWindowMs:20000});
 for(const name of ['a','b','c'])f.triggers.recordFilesystemTriggerEvent({triggerId:f.branch.triggerId,path:name,eventType:'add',maxCapturedPaths:2});
 f.triggers.recordFilesystemTriggerEvent({triggerId:f.branch.triggerId,path:'a',eventType:'change',maxCapturedPaths:2});const before=f.triggers.getFilesystemTriggerBurst(f.branch.triggerId);assert.equal(before.eventCount,4);assert.equal(before.changes.length,2);assert.equal(before.droppedPathEventCount,1);
 f.store.sqlite.exec("CREATE TEMP TRIGGER abort_source_admission BEFORE INSERT ON branch_executions BEGIN SELECT RAISE(ABORT,'Controlled admission failure'); END");
 assert.throws(()=>f.triggers.flushFilesystemTriggerBurst(f.branch.triggerId),/Controlled/);assert.deepEqual(f.triggers.getFilesystemTriggerBurst(f.branch.triggerId),before);assert.equal(f.triggers.listTriggerOccurrences(f.branch.triggerId).length,0);f.store.sqlite.exec('DROP TRIGGER abort_source_admission');
 await f.reopen();assert.equal(f.triggers.getFilesystemTriggerBurst(f.branch.triggerId).occurrenceKey,before.occurrenceKey);
 const flushed=f.triggers.flushFilesystemTriggerBurst(f.branch.triggerId),event=f.triggers.getTriggerOccurrence(flushed.occurrenceId);assert.equal(event.payload.lowLevelEventCount,4);assert.equal(event.payload.pathLimitReached,true);assert.deepEqual(event.payload.changes[0].types,['add','change']);assert.equal(f.triggers.flushFilesystemTriggerBurst(f.branch.triggerId),undefined);f.noProviderWork();f.pass();
});

test('a real filesystem watcher records only matching path metadata and stops observing after shutdown', {timeout:20000},async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*.txt'],exclude:['ignored/**'],quietMs:100,maxWindowMs:500});await mkdir(path.join(f.workspace,'ignored'));await mkdir(path.join(f.workspace,'node_modules'));
 await f.sources.start();await f.sources.waitUntilReady();
 await writeFile(path.join(f.workspace,'included.txt'),'Do not inject these private contents');await writeFile(path.join(f.workspace,'ignored','hidden.txt'),'Ignored');await writeFile(path.join(f.workspace,'node_modules','hidden.txt'),'Ignored');
 const event=await until(()=>f.triggers.listTriggerOccurrences(f.branch.triggerId)[0],'real filesystem occurrence');assert.ok(event.payload.changes.some(item=>item.path==='included.txt'));assert.ok(event.payload.changes.every(item=>!item.path.startsWith('ignored/')&&!item.path.startsWith('node_modules/')));assert.equal(JSON.stringify(event.payload).includes('private contents'),false);
 await f.sources.stop();const count=f.triggers.listTriggerOccurrences(f.branch.triggerId).length;await writeFile(path.join(f.workspace,'late.txt'),'Late');await f.sources.processDueSchedules();assert.equal(f.triggers.listTriggerOccurrences(f.branch.triggerId).length,count);f.noProviderWork();f.pass();
});

test('an unavailable bound workspace disables its inert source and reports a visible failure instead of claiming to watch it',async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*'],exclude:[],quietMs:100,maxWindowMs:500});await rm(f.workspace,{recursive:true});await f.sources.start();await f.sources.waitUntilReady();
 assert.equal(f.triggers.getTriggerDefinition(f.branch.triggerId).enabled,false);assert.equal(f.failures.length,1);assert.match(f.failures[0].error,/workspace is unavailable/);f.noProviderWork();f.pass();
});

test('source configuration validates exact current fields and preserves the minute-level schedule ceiling',()=>{
 for(const value of [{scheduleKind:'interval',everyMs:1000,startsAt:new Date().toISOString()},{scheduleKind:'cron',expression:'* * * * * *',timezone:'UTC'}])assert.throws(()=>normalizeTriggerSourceConfig('schedule',value));
 assert.throws(()=>triggerSourceConfig('webhook',{replayWindowSeconds:300,extraAuthority:true}),/unknown/);assert.throws(()=>normalizeTriggerSourceConfig('filesystem',{include:['../outside'],exclude:[],quietMs:100,maxWindowMs:500}),/relative/);
 const normalized=normalizeTriggerSourceConfig('schedule',{scheduleKind:'cron',expression:'0 9 * * *',timezone:'America/New_York'},new Date('2026-03-07T15:00:00Z'));assert.equal(normalized.nextFireAt,'2026-03-08T13:00:00.000Z');
});

// A folder/configuration edit must not reinterpret already accepted file paths.
test('publishing a new binding seals pending filesystem evidence against its previous version',async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*'],exclude:[],quietMs:1000,maxWindowMs:5000});
 f.triggers.recordFilesystemTriggerEvent({triggerId:f.branch.triggerId,path:'old-workspace.txt',eventType:'add',maxCapturedPaths:500});
 const newer=path.join(f.root,'newer');await mkdir(newer);
 f.branches.deploy({chatId:'',branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'new-binding',definition:f.definition,bindings:{...f.bindings,directories:{workspace:newer}}},new Date().toISOString(),{sourceConfig:f.triggers.getTriggerDefinition(f.branch.triggerId).sourceConfig});
 const event=f.triggers.listTriggerOccurrences(f.branch.triggerId)[0];assert.ok(event,'Pending accepted events must seal before binding replacement');const execution=f.branches.execution(event.branchExecutionId);assert.equal(execution.bindingRevisionId,f.branch.bindingRevisionId);assert.equal(execution.versionId,f.branch.versionId);assert.equal(f.triggers.getFilesystemTriggerBurst(f.branch.triggerId),undefined);f.noProviderWork();f.pass();
});

test('webhook envelope keys use durable owner-only publication and refuse linked, oversized or broadly readable replacements',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'branch-webhook-key-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const original=new BranchTriggerSecretStore(root),secret=original.create(),key=path.join(root,'trigger-secrets.key');assert.equal((await readFile(key)).length,32);if(process.platform!=='win32')assert.equal((await stat(key)).mode&0o777,0o600);
 assert.equal(new BranchTriggerSecretStore(root).decrypt(secret.ciphertext),secret.secret);
 if(process.platform!=='win32'){
  await chmod(key,0o644);assert.throws(()=>new BranchTriggerSecretStore(root),/owner-only/);await chmod(key,0o600);
  const linked=path.join(root,'linked');await mkdir(linked);await symlink(key,path.join(linked,'trigger-secrets.key'));assert.throws(()=>new BranchTriggerSecretStore(linked),/regular file/);
 }
 await writeFile(key,Buffer.alloc(33));assert.throws(()=>new BranchTriggerSecretStore(root));
});

test('more than one due page of disabled Branches cannot starve an enabled schedule',async t=>{
 const startsAt=new Date(Date.now()-120000).toISOString(),f=await fixture(t,'schedule',{scheduleKind:'interval',everyMs:60000,startsAt},{nextFireAt:startsAt});
 const older=new Date(Date.now()-240000).toISOString();
 for(let index=0;index<101;index++){
  const owner=f.branches.create(`Disabled ${index}`,`disabled-${index}`);
  f.branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:`disabled-deploy-${index}`,definition:f.definition,bindings:f.bindings},new Date().toISOString(),{sourceConfig:{scheduleKind:'interval',everyMs:60000,startsAt:older},nextFireAt:older});
  f.branches.setEnabled(owner.id,false);
 }
 assert.deepEqual(f.triggers.listDueScheduleTriggers().map(item=>item.id),[f.branch.triggerId]);
 await f.sources.start();assert.equal(f.triggers.listTriggerOccurrences(f.branch.triggerId).length,1);f.noProviderWork();f.pass();
});

test('changing configuration seals a pending file burst against the immutable previous configuration',async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*'],exclude:[],quietMs:10000,maxWindowMs:20000});
 f.triggers.recordFilesystemTriggerEvent({triggerId:f.branch.triggerId,path:'before.txt',eventType:'add',maxCapturedPaths:500});
 const previous=f.branches.configuration(f.branch.id);
 f.branches.configure(f.branch.id,{...previous,limits:{...previous.limits,maxTraversals:previous.limits.maxTraversals+1}},0);
 const event=f.triggers.listTriggerOccurrences(f.branch.triggerId)[0];assert.ok(event);assert.deepEqual(f.branches.execution(event.branchExecutionId).configuration,previous);assert.equal(f.triggers.getFilesystemTriggerBurst(f.branch.triggerId),undefined);f.noProviderWork();f.pass();
});

test('pausing a Branch seals accepted file events before disabling admission so paused configuration remains editable',async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*'],exclude:[],quietMs:10000,maxWindowMs:20000});
 f.triggers.recordFilesystemTriggerEvent({triggerId:f.branch.triggerId,path:'accepted-before-pause.txt',eventType:'add',maxCapturedPaths:500});
 f.branches.setEnabled(f.branch.id,false);
 const previous=f.branches.configuration(f.branch.id);
 f.branches.configure(f.branch.id,{...previous,limits:{...previous.limits,maxTraversals:previous.limits.maxTraversals+1}},0);
 const events=f.triggers.listTriggerOccurrences(f.branch.triggerId);assert.equal(events.length,1);assert.equal(events[0].payload.changes[0].path,'accepted-before-pause.txt');
 assert.equal(f.branches.getBranch(f.branch.id).enabled,false);assert.equal(f.triggers.getFilesystemTriggerBurst(f.branch.triggerId),undefined);f.noProviderWork();f.pass();
});
