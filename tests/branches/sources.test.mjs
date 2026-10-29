import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,readFile,symlink,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {BranchTriggerSourceService,normalizeTriggerSourceConfig} from '../../apps/server/dist/branch-trigger-service.js';
import {triggerSourceConfig} from '../../apps/server/dist/branch-trigger-config.js';
import {until} from '../shared/fixture.mjs';

async function fixture(t,kind,config,{nextFireAt}={}){
 const root=await mkdtemp(path.join(tmpdir(),'branch-source-current-')),dataDir=path.join(root,'data'),workspace=path.join(root,'work');await mkdir(workspace);
 let store,branches,sources,passed=false,available=true;const notices=[],failures=[];
 const open=()=>{store=new AgentStore(dataDir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));sources=new BranchTriggerSourceService({store,triggers:branches.triggers,notify:id=>notices.push(id),sourceAvailable:()=>available,onSourceFailure:value=>failures.push(value)})};open();
 t.after(async()=>{let clean=false;try{await sources.stop();clean=true}finally{store.close();if(passed&&clean)await rm(root,{recursive:true,force:true});else t.diagnostic(`Retained source fixture: ${root}`)}});
 const owner=branches.create('Source','source');
 const definition={schema:'ponderosa.branch.v1',name:'Source',trigger:{kind,configRef:'source'},entry:'work',steps:[{id:'work',kind:'script',runtime:'node',source:'process.stdout.write("unused")',cwdRef:'workspace',timeoutMs:1000}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 const bindings={agents:{},directories:{workspace},triggers:{source:{sourceConfig:config,enabled:true}}};
 const branch=branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition,bindings},new Date().toISOString(),{sourceConfig:config,...(nextFireAt?{nextFireAt}:{})});
 return {root,workspace,branch,definition,bindings,notices,failures,get store(){return store},get branches(){return branches},get sources(){return sources},get triggers(){return branches.triggers},pause(){available=false},resume(){available=true},async reopen(){await sources.stop();store.close();open()},pass(){passed=true},noProviderWork(){assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);assert.equal(store.sqlite.prepare('SELECT count(*) n FROM coordination_requests').get().n,0)}};
}

test('schedule recovery admits each due interval, retains a bounded backlog and resumes without duplicates',async t=>{
 const now=Date.parse('2026-10-30T10:00:00Z');t.mock.timers.enable({apis:['Date'],now});
 const startsAt=new Date(now-204*60000).toISOString(),f=await fixture(t,'schedule',{scheduleKind:'interval',everyMs:60000,startsAt,whenRunning:'queue_all'},{nextFireAt:startsAt});
 for(const expected of [100,200,205,205]){
  await f.sources.processDueSchedules();
  assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,expected);
 }
 const events=f.store.sqlite.prepare('SELECT payload_json,provenance_json FROM trigger_occurrences ORDER BY created_at,id').all();
 const times=events.map(row=>JSON.parse(row.payload_json).scheduledTimes[0]).sort();
 assert.deepEqual(times,Array.from({length:205},(_,i)=>new Date(Date.parse(startsAt)+i*60000).toISOString()));
 for(const row of events)assert.equal(JSON.parse(row.provenance_json).evaluatedAt,new Date(now).toISOString());
 assert.equal(f.triggers.getTriggerDefinition(f.branch.triggerId).nextFireAt,new Date(now+60000).toISOString());
 await f.reopen();t.mock.timers.setTime(now-60000);await f.sources.processDueSchedules();t.mock.timers.setTime(now);await f.sources.processDueSchedules();
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,205);f.noProviderWork();f.pass();
});

test('unsigned webhook intake deduplicates across reopening and cannot smuggle manual or direct Agent authority',async t=>{
 const f=await fixture(t,'webhook',{replayWindowSeconds:30});await f.sources.start();
 const payload={text:'Untrusted external content',operatorManual:true,recipientAgentId:'unrelated'},input={triggerId:f.branch.triggerId,eventId:'external-event',payload};
 const event=f.sources.verifyAndRecordWebhook(input);assert.equal(event.replayed,false);const occurrence=f.triggers.getTriggerOccurrence(event.occurrenceId);assert.equal(f.branches.execution(occurrence.branchExecutionId).admissionSource,'automatic');
 assert.equal(occurrence.provenance.source,'webhook');assert.equal(occurrence.provenance.signatureVersion,undefined);
 await assert.rejects(stat(path.join(f.root,'data','trigger-secrets.key')),{code:'ENOENT'});
 await f.reopen();await f.sources.start();assert.equal(f.sources.verifyAndRecordWebhook(input).occurrenceId,event.occurrenceId);assert.equal(f.sources.verifyAndRecordWebhook(input).replayed,true);
 assert.throws(()=>f.sources.verifyAndRecordWebhook({...input,payload:{text:'changed'}}),/idempotency conflict/);
 for(const eventId of ['', ' '.repeat(3), 'x'.repeat(201)])assert.throws(()=>f.sources.verifyAndRecordWebhook({...input,eventId}),/Event-Id/);
 f.pause();assert.throws(()=>f.sources.verifyAndRecordWebhook({...input,eventId:'next'}),/unavailable/);f.resume();
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
 assert.deepEqual(triggerSourceConfig('webhook',{}),{});assert.throws(()=>triggerSourceConfig('webhook',{replayWindowSeconds:300}),/unknown/);assert.throws(()=>triggerSourceConfig('webhook',{extraAuthority:true}),/unknown/);assert.throws(()=>normalizeTriggerSourceConfig('filesystem',{include:['../outside'],exclude:[],quietMs:100,maxWindowMs:500}),/relative/);
 const normalized=normalizeTriggerSourceConfig('schedule',{scheduleKind:'cron',expression:'0 9 * * *',timezone:'America/New_York'},new Date('2026-03-07T15:00:00Z'));assert.equal(normalized.nextFireAt,'2026-03-08T13:00:00.000Z');
});

test('repeating schedules preserve explicit busy policies and leave legacy queue behavior implicit',()=>{
 const now=new Date('2030-01-01T00:00:00Z'),configs=[{scheduleKind:'interval',everyMs:60000,startsAt:'2030-01-02T00:00:00Z'},{scheduleKind:'cron',expression:'0 9 * * *',timezone:'UTC'}];
 for(const config of configs){
  const legacy=normalizeTriggerSourceConfig('schedule',triggerSourceConfig('schedule',config),now);
  assert.equal(Object.hasOwn(legacy.config,'whenRunning'),false,'Republishing a legacy schedule must not opt it into a new policy');
  for(const whenRunning of ['update_current','run_latest','queue_all']){
   const normalized=normalizeTriggerSourceConfig('schedule',triggerSourceConfig('schedule',{...config,whenRunning}),now);
   assert.equal(normalized.config.whenRunning,whenRunning);assert.equal(normalized.nextFireAt,legacy.nextFireAt,'Busy policy must not change cadence calculation');
  }
  for(const whenRunning of [null,false,0,{},'latest','']){
   assert.throws(()=>triggerSourceConfig('schedule',{...config,whenRunning}),/whenRunning/);
   assert.throws(()=>normalizeTriggerSourceConfig('schedule',{...config,whenRunning},now),/whenRunning/);
  }
  assert.throws(()=>triggerSourceConfig('schedule',{...config,unknownPolicy:true}),/unknown/);
 }
 assert.throws(()=>triggerSourceConfig('schedule',{scheduleKind:'once',at:'2030-01-02T00:00:00Z',whenRunning:'run_latest'}),/unknown/);
});

test('template and full Branch packages preserve explicit and legacy schedule policies through publication',async t=>{
 const {BranchInstallationService}=await import('../../apps/server/dist/branch-installation-service.js');
 for(const whenRunning of [undefined,'update_current','run_latest','queue_all']){
  const config={scheduleKind:'interval',everyMs:60000,startsAt:'2030-01-02T00:00:00.000Z',...(whenRunning?{whenRunning}:{})},f=await fixture(t,'schedule',config),unexpected=()=>{throw Error('No Agent or Chat lifecycle operation is needed for this schedule-only package')};
  const installation=new BranchInstallationService(f.store,f.branches,unexpected,unexpected,unexpected);installation.setEngine({validateAgent:unexpected,exportAgent:unexpected,importAgent:unexpected});
  installation.setPublisher((input,configuration)=>{const source=input.bindings.triggers.source.sourceConfig,normalized=normalizeTriggerSourceConfig('schedule',triggerSourceConfig('schedule',source));return f.branches.deploy(input,new Date().toISOString(),{sourceConfig:normalized.config,nextFireAt:normalized.nextFireAt},configuration)});
  for(const mode of ['template','full']){
   const pkg=await installation.export(f.branch.id,mode);assert.deepEqual(pkg.triggers.source.sourceConfig,config);
   const preview=installation.preview(pkg,{agents:{},directories:{workspace:f.workspace}}),result=await installation.confirm(preview.id,mode==='full');assert.equal(result.state,'completed',result.error);
   assert.deepEqual(f.branches.localConfiguration(result.branchId).triggers.source.sourceConfig,config);assert.deepEqual(f.branches.trigger(result.branchId).sourceConfig,config);
  }
  await installation.stop();f.noProviderWork();f.pass();
 }
});

// A folder/configuration edit must not reinterpret already accepted file paths.
test('publishing a new binding seals pending filesystem evidence against its previous version',async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*'],exclude:[],quietMs:1000,maxWindowMs:5000});
 f.triggers.recordFilesystemTriggerEvent({triggerId:f.branch.triggerId,path:'old-workspace.txt',eventType:'add',maxCapturedPaths:500});
 const newer=path.join(f.root,'newer');await mkdir(newer);
 f.branches.deploy({chatId:'',branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'new-binding',definition:f.definition,bindings:{...f.bindings,directories:{workspace:newer}}},new Date().toISOString(),{sourceConfig:f.triggers.getTriggerDefinition(f.branch.triggerId).sourceConfig});
 const event=f.triggers.listTriggerOccurrences(f.branch.triggerId)[0];assert.ok(event,'Pending accepted events must seal before binding replacement');const execution=f.branches.execution(event.branchExecutionId);assert.equal(execution.bindingRevisionId,f.branch.bindingRevisionId);assert.equal(execution.versionId,f.branch.versionId);assert.equal(f.triggers.getFilesystemTriggerBurst(f.branch.triggerId),undefined);f.noProviderWork();f.pass();
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
 await f.sources.start();assert.equal(f.triggers.listTriggerOccurrences(f.branch.triggerId).length,3);f.noProviderWork();f.pass();
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

test('failed schedule acceptance stays due, reports a stable sanitized episode, and recovers without duplicate work',async t=>{
 const at=new Date(Date.now()-60000).toISOString(),f=await fixture(t,'schedule',{scheduleKind:'interval',everyMs:60000,startsAt:at},{nextFireAt:at});
 f.store.sqlite.exec("CREATE TEMP TRIGGER fail_schedule BEFORE INSERT ON branch_executions BEGIN SELECT RAISE(ABORT,'SQL payload secret/path'); END");
 for(let i=0;i<3;i++)await f.sources.processDueSchedules();
 const failures=f.failures.filter(row=>row.kind==='schedule');assert.equal(failures.length,3);assert.equal(new Set(failures.map(row=>row.trigger.id+row.episode+row.error)).size,1);assert.doesNotMatch(failures[0].error,/SQL|secret|path/);
 assert.equal(f.triggers.getTriggerDefinition(f.branch.triggerId).nextFireAt,at);assert.equal(f.triggers.listTriggerOccurrences(f.branch.triggerId).length,0);
 f.store.sqlite.exec('DROP TRIGGER fail_schedule');await f.sources.processDueSchedules();await f.sources.processDueSchedules();
 assert.equal(f.triggers.listTriggerOccurrences(f.branch.triggerId).length,2);assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,2);f.noProviderWork();f.pass();
});

test('an idle schedule scan advances its cutoff when a future tick becomes due',async t=>{
 const now=Date.now(),at=new Date(now+5000).toISOString(),f=await fixture(t,'schedule',{scheduleKind:'once',at},{nextFireAt:at});
 t.mock.timers.enable({apis:['Date'],now});await f.sources.processDueSchedules();assert.equal(f.triggers.listTriggerOccurrences(f.branch.triggerId).length,0);
 t.mock.timers.setTime(now+10000);await f.sources.processDueSchedules();assert.equal(f.triggers.listTriggerOccurrences(f.branch.triggerId).length,1);f.noProviderWork();f.pass();
});

test('cron forward catchup admits distinct times and retains existing DST and backward-clock semantics',async t=>{
 for(const [name,initial,expression,observations] of [
  ['forward','2026-10-30T10:00:00Z','* * * * *',[['2026-10-30T10:03:01Z',3],['2026-10-30T09:59:00Z',3],['2026-10-30T10:03:01Z',3]]],
  ['fall','2026-11-01T04:00:00Z','30 1 * * *',[['2026-11-01T05:30:00Z',1],['2026-11-01T06:30:00Z',1],['2026-11-02T06:30:00Z',2]]],
  ['spring','2026-03-08T05:00:00Z','30 2 * * *',[['2026-03-08T07:00:00Z',0],['2026-03-08T07:30:00Z',1],['2026-03-09T06:30:00Z',2]]],
 ])await t.test(name,async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(initial)});
  const config={scheduleKind:'cron',expression,timezone:'America/New_York',whenRunning:'queue_all'};
  const normalized=normalizeTriggerSourceConfig('schedule',config),f=await fixture(t,'schedule',config,{nextFireAt:normalized.nextFireAt});
  for(const [at,count] of observations){t.mock.timers.setTime(Date.parse(at));await f.sources.processDueSchedules();assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,count);}
  f.noProviderWork();f.pass();
 });
});

test('partial catchup failure retries only the unaccepted scheduled times after reopening',async t=>{
 const now=Date.parse('2026-10-30T10:03:01Z'),startsAt='2026-10-30T10:01:00.000Z';t.mock.timers.enable({apis:['Date'],now});
 const f=await fixture(t,'schedule',{scheduleKind:'interval',everyMs:60000,startsAt,whenRunning:'queue_all'},{nextFireAt:startsAt});
 f.store.sqlite.exec("CREATE TEMP TRIGGER fail_third BEFORE INSERT ON branch_executions WHEN (SELECT count(*) FROM branch_executions)=2 BEGIN SELECT RAISE(ABORT,'Controlled third admission failure'); END");
 await f.sources.processDueSchedules();assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,2);
 assert.equal(f.triggers.getTriggerDefinition(f.branch.triggerId).nextFireAt,'2026-10-30T10:03:00.000Z');
 await f.reopen();await f.sources.processDueSchedules();await f.sources.processDueSchedules();
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,3);
 const events=f.triggers.listTriggerOccurrences(f.branch.triggerId);assert.equal(new Set(events.map(event=>event.payload.scheduledTimes[0])).size,3);f.noProviderWork();f.pass();
});
