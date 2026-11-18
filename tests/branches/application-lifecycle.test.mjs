import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {recoveredRuntimeProcessHandle} from '@ponderosa/engines';
import {createServer} from '../../apps/server/dist/app.js';
import {BranchResourceService} from '../../apps/server/dist/branch-resource-service.js';
import {describeBranchDeletionFailure} from '../../apps/server/dist/branch-installation-service.js';
import {describeExpertMemoryPreflightFailure,describeChatDeletionIntentFailure} from '../../apps/server/dist/branch-deletion-diagnostics.js';
import {MEMORY_CLEANUP_HOLD_REASONS} from '../../apps/server/dist/local-memory-authority.js';
import {payloadHash,stableJson} from '../../packages/agents/dist/coordination-v3-canonical-json.js';
import {until} from '../shared/fixture.mjs';

const options={timeout:30000,skip:process.platform==='win32'?'Recoverable Branch Scripts currently require POSIX containment':false};
function registerSyntheticSecret(t,name,value){
 const previous=process.env[name];process.env[name]=value;
 t.after(()=>{if(previous===undefined)delete process.env[name];else process.env[name]=previous;});
}

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

test('application schedule intake stays fenced during deployment drain and admits each durable due time after resume',options,async t=>{
 const f=await fixture(t),owner=f.branches.create('Scheduled source','scheduled-source'),startsAt=new Date(Date.now()-120000).toISOString();
 const branch=f.branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Scheduled source',trigger:{kind:'schedule',configRef:'source'},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('scheduled result');"}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:f.root},triggers:{source:{sourceConfig:{scheduleKind:'interval',everyMs:60000,startsAt},enabled:true}}}},new Date().toISOString(),{sourceConfig:{scheduleKind:'interval',everyMs:60000,startsAt},nextFireAt:startsAt});
 await f.open();assert.equal(f.branches.triggers.listTriggerOccurrences(branch.triggerId).length,0);
 await f.api('POST','/api/deployment/resume');
 await until(()=>f.branches.triggers.listTriggerOccurrences(branch.triggerId)[0],'application schedule admission');
 await until(()=>{const events=f.branches.triggers.listTriggerOccurrences(branch.triggerId);return events.length===3&&events.every(item=>f.branches.execution(item.branchExecutionId).state==='completed')},'all scheduled Script results');
 await f.api('POST','/api/deployment/drain');
 await until(async()=>{const ready=await f.api('GET','/api/ready',undefined,503);return ready.deploymentDrain.readyForRestart},'source drain');
 f.branches.triggers.updateTriggerDefinition(branch.triggerId,{nextFireAt:startsAt});
 assert.deepEqual(f.branches.triggers.listTriggerOccurrences(branch.triggerId).map(item=>item.payload.scheduledTimes[0]).sort(),[0,1,2].map(index=>new Date(Date.parse(startsAt)+index*60000).toISOString()));assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
 await f.close();f.pass();
});

test('schedule admission retains its actionable cause in stored Trigger Events while redacting known secrets and preserving due work',options,async t=>{
 const f=await fixture(t),secret='schedule-known-bare-credential',labeled='schedule-pattern-credential';
 registerSyntheticSecret(t,'PONDEROSA_TEST_SCHEDULE_TOKEN',secret);
 const owner=f.branches.create('Diagnostic source','diagnostic-source'),at=new Date(Date.now()-1000).toISOString(),config={scheduleKind:'once',at};
 const branch=f.branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'diagnostic',definition:{schema:'ponderosa.branch.v1',name:'Diagnostic source',trigger:{kind:'schedule',configRef:'source'},entry:'gate',steps:[{id:'gate',kind:'human_gate',prompt:'Review',editable:false}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{},triggers:{source:{sourceConfig:config,enabled:true}}}},new Date().toISOString(),{sourceConfig:config,nextFireAt:at});
 const cause='Selected workflow directory binding is missing; restore the selected folder.';
 const interception=t.mock.method(Object.getPrototypeOf(f.branches.triggers),'recordScheduledTriggerOccurrence',()=>{
  throw Object.assign(new Error(cause+' '+secret+' API_KEY='+labeled),{code:'SQLITE_UNRECOGNIZED'});
 });
 const read=()=>f.api('GET',`/api/branches/${branch.id}/lifecycle`);let originalOpen=false;
 try{
  await f.open();originalOpen=true;await f.api('POST','/api/deployment/resume');
  const lifecycle=await until(async()=>{const value=await read();return value.sourceDiagnostics.length&&value},'stored schedule cause');
  assert.equal(lifecycle.sourceDiagnostics.length,1);
  const notice=lifecycle.sourceDiagnostics[0];
  assert.equal(notice.title,'Schedule Check Delayed');
  assert.match(notice.body,/Scheduled check could not be accepted: an internal scheduler error occurred/);
  assert.ok(notice.body.includes(cause),'The fresh actionable cause survives the app boundary');
  assert.match(notice.body,/unchanged due checks retry automatically/);
  for(const value of [secret,labeled])assert.ok(!JSON.stringify(lifecycle).includes(value),'Known and credential-pattern values stay out of the public stored diagnostic');
  assert.equal(f.branches.trigger(branch.id).nextFireAt,at);
  assert.equal(f.branches.triggers.listTriggerOccurrences(branch.triggerId).length,0);
  assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,0);
  assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);

  // Render the real Trigger Events component with the actual HTTP diagnostic.
  // Only query readiness, opening state and Dialog's portal are controlled.
  const {createRequire}=await import('node:module'),{readFileSync}=await import('node:fs'),vm=await import('node:vm');
  const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),ts=require('typescript'),exports={};
  const input=readFileSync(new URL('../../apps/web/src/components/branches/BranchOperations.tsx',import.meta.url),'utf8');
  const source=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const dependency=name=>{
   if(name==='react')return {...React,useState:()=>[true,()=>{}]};
   if(name==='@tanstack/react-query')return {useInfiniteQuery:()=>({data:{pages:[]},isPending:false})};
   if(name==='@mui/material')return {...require(name),Dialog:({children})=>React.createElement('section',null,children)};
   if(name==='../WorkspaceRefreshContext')return {useReportWorkspaceRead(){}};
   if(name==='../WorkspaceQueryError')return {WorkspaceQueryError(){throw Error('No query failure in this stored-diagnostic fixture')}};
   if(name==='../../workspaceAvailability')return {workspaceRead:(owner,resource,query)=>({owner,resource,...query})};
   if(name==='../../api/real')return {requestJson(){throw Error('Unexpected UI request')}};
   if(name==='../TriggerOccurrenceAudit')return {OccurrenceAudit(){throw Error('No accepted occurrence exists')}};
   if(name==='react/jsx-runtime')return require(name);
   throw Error('Unexpected UI dependency '+name);
  };
  vm.runInNewContext(source,{exports,require:dependency});
  const html=renderToStaticMarkup(React.createElement(exports.BranchTriggerAudit,{branchId:branch.id,diagnostics:lifecycle.sourceDiagnostics,onNavigate(){throw Error('Rendering cannot navigate')}}));
  assert.ok(html.includes(cause),'Trigger Events exposes the same actionable cause');
  assert.match(html,/Schedule Check Delayed/);assert.match(html,/No trigger events yet/);
  for(const value of [secret,labeled])assert.ok(!html.includes(value),'Rendered Trigger Events never recovers redacted values');
  await f.close();originalOpen=false;
  const store=new AgentStore(path.join(f.root,'data')),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const reopened=createServer({dataDir:path.join(f.root,'data'),store,logger:false,startDrained:true,engines:[],allowedBrowseRoots:[f.root],communicationV3:{pollMs:10}});
  try{
   await reopened.ready();
   const response=await reopened.inject({url:`/api/branches/${branch.id}/lifecycle`});assert.equal(response.statusCode,200,response.body);
   const retained=response.json();
   assert.equal(retained.sourceDiagnostics[0].id,notice.id);
   assert.equal(retained.sourceDiagnostics[0].body,notice.body,'Paused restart retains the already-redacted useful cause');
   assert.equal(branches.trigger(branch.id).nextFireAt,at);
   assert.equal(branches.triggers.listTriggerOccurrences(branch.triggerId).length,0);
  }finally{reopened.prepareForShutdown();await reopened.close();}
  f.pass();
 }finally{if(originalOpen)await f.close();interception.mock.restore();}
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


test('DELETE Workflow explains a missing final exit record and leaves the Workflow intact',options,async t=>{
 const f=await fixture(t),branch=f.deploy('Retained capture',[
  {id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:10000,source:'process.exit(0)'},
 ]);
 await f.open();
 // Controlled malformed-retention fixture: a canonical permanent fence has
 // no final exit command. The real deletion guard must stop before mutation.
 const input={executionId:'synthetic-execution',stepExecutionId:'synthetic-step',generation:0,
  projectId:'synthetic-project',conversationId:'synthetic-chat',agentIds:[]};
 const fence={schema:'branch-generation-exit-fence.v1',purpose:'final-resource',input,
  resource:{original_branch_id:branch.id}};
 const identity=payloadHash({executionId:input.executionId,stepExecutionId:input.stepExecutionId,generation:input.generation});
 f.store.sqlite.prepare('INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES(?,?,?,?,?)')
  .run('branch-generation-exit-fence',identity,stableJson(input),stableJson(fence),payloadHash(fence));
 const response=await f.api('DELETE',`/api/branches/${branch.id}`,undefined,409);
 assert.match(response.error,/final resource exit record is missing or ambiguous/);
 assert.match(response.error,/Keep the Workflow and its data/);
 assert.ok(f.branches.getBranch(branch.id),'the Workflow remains present');
 assert.equal(f.store.sqlite.prepare('SELECT deleting FROM branches WHERE id=?').get(branch.id).deleting,0);
 assert.ok(f.store.sqlite.prepare("SELECT 1 FROM host_lifecycle_commits WHERE kind='branch-generation-exit-fence' AND identity=?").get(identity),'the source fence remains intact');
 f.pass();
});

test('Branch deletion explains failures while redacting known secrets',t=>{
 const secret='fixture-bare-credential-value';
 process.env.PONDEROSA_TEST_DIAGNOSTIC_TOKEN=secret;process.env.PONDEROSA_TEST_SECOND_TOKEN='fixture-unlabeled-secret';
 t.after(()=>{delete process.env.PONDEROSA_TEST_DIAGNOSTIC_TOKEN;delete process.env.PONDEROSA_TEST_SECOND_TOKEN;});
 for(const format of [describeExpertMemoryPreflightFailure,describeChatDeletionIntentFailure,describeBranchDeletionFailure]){
  const diagnostic=format(Object.assign(new Error(`useful synthetic cause ${secret} API_KEY=labeled-secret`),{code:'UNTRUSTED_CODE'}));
  assert.match(diagnostic,/useful synthetic cause/);assert.doesNotMatch(diagnostic,/UNTRUSTED_CODE/);
  assert.ok(!diagnostic.includes(secret));assert.ok(!diagnostic.includes('labeled-secret'));
 }
 process.env.PONDEROSA_TEST_JOIN_TOKEN='failed. X';
 assert.ok(!describeBranchDeletionFailure(new Error('X')).includes('failed. X'));
 delete process.env.PONDEROSA_TEST_JOIN_TOKEN;
 for(const [code,phrase] of [
  ['SQLITE_CONSTRAINT_TRIGGER','A database trigger rejected the operation.'],
  ['SQLITE_CONSTRAINT_FOREIGNKEY','A related database record prevented the operation.'],
  ['SQLITE_CONSTRAINT_NOTNULL','A required database value was missing.'],
  ['SQLITE_CONSTRAINT_UNIQUE','A database uniqueness constraint was violated.'],
  ['SQLITE_CONSTRAINT_CHECK','A database check constraint was violated.'],
  ['SQLITE_FULL','The database could not write because storage was full.'],
  ['EACCES','The operating system denied access.'],
  ['ENOSPC','The operating system reported no space left.'],
 ]){
  const diagnostic=describeBranchDeletionFailure(Object.assign(new Error(`SQL API_KEY=labeled-secret ${secret}`),{code}));
  assert.ok(diagnostic.includes(code));assert.ok(diagnostic.includes(phrase));
  assert.ok(!diagnostic.includes(secret));assert.ok(!diagnostic.includes('labeled-secret'));
 }
 for(const message of [
  'Expert final context custody unavailable; cleanup held',
  'Observed expert provider drain unavailable; cleanup held',
  'Expert final context fence or provider drain changed',
  'Expert final capture receipt unavailable',
  'Expert final context receipt unavailable; cleanup held',
  'Temporary agent copy final custody unavailable',
  'Exact temporary agent copy final custody unavailable',
  'Temporary agent copy final fence is unavailable',
  'Temporary agent copy final fence identity differs',
  'Temporary agent copy final custody bytes changed',
  'Exact completed expert copy ownership required for final capture',
  'Final resource fence evidence changed',
  'Current checkpoint custody unavailable',
  'Current checkpoint custody bytes differ',
  'Checkpoint custody changed',
  'Checkpoint custody grew',
  'Checkpoint custody digest changed',
  'Checkpoint custody released during verification',
 ]){
  const visible=describeBranchDeletionFailure(new Error(message),'resource');
  assert.equal(visible,`${message}. Cleanup step: cleaning up a temporary Workflow resource.`);
  const altered=describeBranchDeletionFailure(new Error(`${message} ${secret} API_KEY=labeled-secret`),'resource');
  assert.match(altered,/API_KEY/);assert.ok(!altered.includes(secret));assert.ok(!altered.includes('labeled-secret'));
  assert.match(describeBranchDeletionFailure(new Error(message),'notifications'),/Cleanup step: settling notifications/);
 }
 assert.match(describeBranchDeletionFailure(Object.assign(new Error('Temporary agent copy final custody bytes changed'),{code:'EACCES'}),'resource'),/operating system denied access/);
 const finalExit='Authentic final resource exit command unavailable or ambiguous';
 for(const step of [undefined,'records']){
  const message=describeBranchDeletionFailure(new Error(finalExit),step);
  assert.match(message,/final resource exit record is missing or ambiguous/);
  assert.match(message,/Keep the Workflow and its data/);
 }
 assert.match(describeBranchDeletionFailure(new Error(finalExit),'notifications'),/Cleanup step: settling notifications/);
 assert.match(describeBranchDeletionFailure(Object.assign(new Error(finalExit),{code:'SQLITE_CONSTRAINT_TRIGGER'}),'records'),/database trigger rejected/);
 const alteredFinal=describeBranchDeletionFailure(new Error(finalExit+' '+secret),'records');
 assert.match(alteredFinal,/Authentic final resource exit/);assert.ok(!alteredFinal.includes(secret));
 const auditMismatch=describeBranchDeletionFailure(new Error('Retained group journal original scope differs'),'records');
 assert.match(auditMismatch,/retained group audit evidence does not match its Workflow and execution/i);
 assert.match(auditMismatch,/Workflow records were preserved/);
 assert.match(describeBranchDeletionFailure(new Error('Retained group journal original scope differs'),'notifications'),/Cleanup step: settling notifications/);
 assert.match(describeBranchDeletionFailure(Object.assign(new Error('Retained group journal original scope differs'),{code:'SQLITE_CONSTRAINT_TRIGGER'}),'records'),/database trigger rejected/);
 const decorated=describeBranchDeletionFailure(new Error(`Retained group journal original scope differs ${secret}`),'records');
 assert.match(decorated,/Retained group journal original scope differs/);assert.ok(!decorated.includes(secret));
 const unknown=describeBranchDeletionFailure(Object.assign(new Error(`unknown failure ${secret}`),{code:secret}));
 assert.match(unknown,/Workflow cleanup failed/);assert.ok(!unknown.includes(secret));
 assert.equal(describeBranchDeletionFailure(new Error('Other Branches depend on this Branch')),'Other Branches depend on this Branch');
 for(const [step,label] of [['pending','checking pending installation'],['receipts','compacting installation receipts'],['notifications','settling notifications'],['records','removing Workflow records']]){
  const diagnostic=describeBranchDeletionFailure(Object.assign(new Error('fixture-unlabeled-secret API_KEY=fixture-labeled-secret'),{code:'SQLITE_CONSTRAINT_TRIGGER'}),step);
  assert.ok(diagnostic.includes('Cleanup step: '+label+'.'));assert.ok(!diagnostic.includes('fixture-unlabeled-secret'));assert.ok(!diagnostic.includes('fixture-labeled-secret'));
 }
 for(const hold of MEMORY_CLEANUP_HOLD_REASONS)assert.equal(describeBranchDeletionFailure(new Error(hold),'records'),hold,'exact hold classification must not change');
});

test('final Branch deletion reports and retains a safe cleanup diagnostic until completion',options,async t=>{
 const f=await fixture(t),branch=f.deploy('Deletion diagnostic',[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('never runs')"}]);
 const fakeSecret='fixture-private-token-value',key='branch-finalize:'+branch.id;
 process.env.PONDEROSA_TEST_DIAGNOSTIC_TOKEN=fakeSecret;t.after(()=>delete process.env.PONDEROSA_TEST_DIAGNOSTIC_TOKEN);
 const other=f.branches.create('Other diagnostic','other-diagnostic'),otherKey='branch-finalize:'+other.id;
 f.store.sqlite.prepare('INSERT INTO branch_retirement_errors VALUES(?,?,?)').run(otherKey,'unrelated retained diagnostic',new Date().toISOString());
 const trigger=`CREATE TEMP TRIGGER block_final_branch_delete BEFORE DELETE ON branches WHEN OLD.id='${branch.id}' BEGIN SELECT RAISE(ABORT,'controlled final cleanup failure API_KEY=fixture-labeled-value fixture-private-token-value'); END`;
 f.store.sqlite.exec(trigger);await f.open();
 const pending=await f.api('DELETE',`/api/branches/${branch.id}`,undefined,202);
 assert.equal(pending.pending,true);assert.equal(pending.deleted,false);
 let lifecycle=await f.api('GET',`/api/branches/${branch.id}/lifecycle`);
 assert.equal(lifecycle.deleting,true);assert.match(lifecycle.deletionError,/SQLITE_CONSTRAINT_TRIGGER/);assert.match(lifecycle.deletionError,/database trigger rejected/);assert.match(lifecycle.deletionError,/Cleanup step: removing Workflow records/);assert.match(lifecycle.deletionError,/controlled final cleanup failure/);assert.ok(!JSON.stringify(lifecycle).includes(fakeSecret));assert.ok(!JSON.stringify(lifecycle).includes('fixture-labeled-value'));
 const saved=f.store.sqlite.prepare('SELECT error FROM branch_retirement_errors WHERE resource_id=?').get(key);
 assert.equal(saved.error,lifecycle.deletionError);assert.ok(!saved.error.includes(fakeSecret));
 await f.close();
 const dataDir=path.join(f.root,'data'),reopenedStore=new AgentStore(dataDir);
 let reopenedApp;
 try{
  assert.equal(reopenedStore.sqlite.prepare('SELECT error FROM branch_retirement_errors WHERE resource_id=?').get(key).error,saved.error,'the safe failure diagnostic survives a real store reopen');
  reopenedStore.sqlite.exec(trigger);
  reopenedApp=createServer({dataDir,store:reopenedStore,logger:false,startDrained:true,engines:[],allowedBrowseRoots:[f.root],communicationV3:{pollMs:10}});await reopenedApp.ready();
  const api=async(method,url,expected=200)=>{const r=await reopenedApp.inject({method,url});assert.equal(r.statusCode,expected,r.body);return r.json();};
  lifecycle=await api('GET',`/api/branches/${branch.id}/lifecycle`);
  assert.equal(lifecycle.deletionError,saved.error,'the failure remains visible after restart');
  assert.ok(reopenedStore.sqlite.prepare('SELECT id FROM branches WHERE id=? AND deleting=1').get(branch.id),'failed finalization preserves the fenced Branch');
  reopenedStore.sqlite.exec('DROP TRIGGER block_final_branch_delete');
  const done=await api('DELETE',`/api/branches/${branch.id}`);
  assert.equal(done.deleted,true);assert.equal(done.pending,false);
  assert.equal(reopenedStore.sqlite.prepare('SELECT id FROM branches WHERE id=?').get(branch.id),undefined);
  assert.equal(reopenedStore.sqlite.prepare('SELECT error FROM branch_retirement_errors WHERE resource_id=?').get(key),undefined,'successful deletion removes only the owned diagnostic');
  assert.equal(reopenedStore.sqlite.prepare('SELECT error FROM branch_retirement_errors WHERE resource_id=?').get(otherKey).error,'unrelated retained diagnostic','another Branch diagnostic survives');
 }finally{if(reopenedApp){reopenedApp.prepareForShutdown();await reopenedApp.close()}else reopenedStore.close();}
 f.pass();
});

test('an immediate Branch deletion failure does not expose an unlabeled synthetic secret',options,async t=>{
 const f=await fixture(t),branch=f.deploy('Immediate deletion diagnostic',[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('never runs')"}]),fakeSecret='fixture-unlabeled-private-value';
 process.env.PONDEROSA_TEST_DIAGNOSTIC_TOKEN=fakeSecret;t.after(()=>delete process.env.PONDEROSA_TEST_DIAGNOSTIC_TOKEN);
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_branch_deletion_start BEFORE UPDATE OF deleting ON branches WHEN OLD.id='${branch.id}' AND NEW.deleting=1 BEGIN SELECT RAISE(ABORT,'controlled start failure fixture-unlabeled-private-value'); END`);
 await f.open();
 const response=await f.api('DELETE',`/api/branches/${branch.id}`,undefined,409);
 assert.match(response.error,/SQLITE_CONSTRAINT_TRIGGER/);assert.match(response.error,/database trigger rejected/);assert.match(response.error,/controlled start failure/);assert.ok(!JSON.stringify(response).includes(fakeSecret));
 assert.equal(f.store.sqlite.prepare('SELECT deleting FROM branches WHERE id=?').get(branch.id).deleting,0);
 f.store.sqlite.exec('DROP TRIGGER fail_branch_deletion_start');
 const done=await f.api('DELETE',`/api/branches/${branch.id}`);assert.equal(done.deleted,true);
 await f.close();f.pass();
});


test('Branch deletion reports retained group audit scope mismatch without exposing its contents',options,async t=>{
 const f=await fixture(t),branch=f.deploy('Group audit diagnostic',[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('never runs')"}]);
 const execution=f.branches.accept(branch.id,'one','Test input');
 f.branches.cancel(execution.id);await f.branches.unitSaver.drain();
 assert.equal(f.branches.execution(execution.id).state,'canceled');
 f.branches.publishAudit(()=>{});await f.branches.unitSaver.drain();
 const key='issued-group-capture:'+'a'.repeat(64),secret='fixture-bare-audit-secret';
 const result=JSON.stringify({secret,snapshot:{selected:{execution:[{branch_id:'different-branch',id:execution.id}]}}});
 f.store.sqlite.prepare('INSERT INTO branch_commands(execution_id,command_key,input_hash,result_json,created_at) VALUES(?,?,?,?,?)').run(execution.id,key,'input-hash',result,new Date().toISOString());
 assert.throws(()=>f.branches.deleteBranch(branch.id),/Retained group journal original scope differs/,'actual retention guard rejects the saved original scope');
 assert.equal(f.store.sqlite.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(execution.id,key).result_json,result);
 await f.open();
 const deletion=await f.api('DELETE',`/api/branches/${branch.id}`,undefined,202);
 assert.equal(deletion.pending,true);
 const lifecycle=await f.api('GET',`/api/branches/${branch.id}/lifecycle`);
 assert.equal(lifecycle.deleting,true);
 assert.match(lifecycle.deletionError,/retained group audit evidence does not match its Workflow and execution/i);
 assert.ok(!JSON.stringify(lifecycle).includes(secret));
 assert.equal(f.store.sqlite.prepare('SELECT error FROM branch_retirement_errors WHERE resource_id=?').get('branch-finalize:'+branch.id).error,lifecycle.deletionError);
 assert.equal(f.store.sqlite.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(execution.id,key).result_json,result);
 assert.ok(f.branches.getBranch(branch.id));
 await f.close();f.pass();
});


test('Branch Chat retirement preserves safe cause without exposing an unlabeled credential',options,async t=>{
 const f=await fixture(t),branch=f.deploy('Retirement diagnostic',[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('never runs')"}]);
 const project=f.store.createProject({label:'Retirement Chat',hostPath:f.root,defaultEngine:'codex',chatOwned:true,branchId:branch.id});
 const chat=f.store.getConversation(project.lastConversationId),secret='fixture-private-retirement-credential';
 registerSyntheticSecret(t,'PONDEROSA_TEST_RETIREMENT_TOKEN',secret);
 f.store.sqlite.prepare('UPDATE branches SET package_id=? WHERE id=?').run('probe',branch.id);
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,'chat','',?,'active')").run(branch.id,'probe',chat.id);
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_retirement_intent BEFORE INSERT ON conversation_deletion_receipts WHEN NEW.conversation_id='${chat.id}' BEGIN SELECT RAISE(ABORT,'controlled chat deletion ${secret}'); END`);
 await f.open();
 const deletion=await f.api('DELETE',`/api/branches/${branch.id}`,undefined,202);
 assert.equal(deletion.pending,true);
 const lifecycle=await f.api('GET',`/api/branches/${branch.id}/lifecycle`);
 const pending=lifecycle.pendingRemoval.find(item=>item.id===chat.id);
 assert.ok(pending);
 assert.match(pending.error,/SQLITE_CONSTRAINT_TRIGGER/);
 assert.match(pending.error,/database trigger rejected/);
 assert.match(pending.error,/controlled chat deletion/);
 assert.match(pending.error,/removing a Workflow Chat/);
 assert.ok(!JSON.stringify(lifecycle).includes(secret));
 assert.equal(f.store.sqlite.prepare('SELECT error FROM branch_retirement_errors WHERE resource_id=?').get(chat.id).error,pending.error);
 assert.ok(f.store.getConversation(chat.id,{includeDeleting:true}));
 f.store.sqlite.exec('DROP TRIGGER fail_retirement_intent');
 await f.close();f.pass();
});


test('direct Chat deletion reports a safe structured cause without a credential',options,async t=>{
 const f=await fixture(t);
 const project=f.store.createProject({label:'Core Chat',hostPath:f.root,defaultEngine:'codex',chatOwned:true});
 const chat=f.store.getConversation(project.lastConversationId),secret='fixture-direct-chat-credential';
 registerSyntheticSecret(t,'PONDEROSA_TEST_DIRECT_TOKEN',secret);
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_direct_intent BEFORE INSERT ON conversation_deletion_receipts WHEN NEW.conversation_id='${chat.id}' BEGIN SELECT RAISE(ABORT,'controlled chat deletion ${secret}'); END`);
 await f.open();
 const result=await f.api('DELETE',`/api/conversations/${chat.id}`,undefined,503);
 assert.match(result.error,/SQLITE_CONSTRAINT_TRIGGER/);assert.match(result.error,/database trigger rejected/);assert.match(result.error,/controlled chat deletion/);
 assert.ok(!JSON.stringify(result).includes(secret));assert.equal(result.retryable,true);assert.equal(result.cleanupPending,false);
 assert.ok(f.store.getConversation(chat.id,{includeDeleting:true}));
 f.store.sqlite.exec('DROP TRIGGER fail_direct_intent');
 const retried=await f.api('DELETE',`/api/conversations/${chat.id}`);assert.equal(retried.deleted,true);
 await f.close();f.pass();
});


test('temporary resource cleanup preserves safe diagnostic without a credential',options,async t=>{
 const f=await fixture(t),owner=f.branches.create('Probe temporary','probe-temporary');
 const permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
 const template={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Worker',rootRef:'worker',agents:[{ref:'worker',title:'Worker',engine:'codex',managementPermissions:permissions}]};
 const branch=f.branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'probe-deploy',definition:{schema:'ponderosa.branch.v1',name:'Probe temporary',trigger:{kind:'manual'},entry:'team',templates:{team:template},steps:[{id:'team',kind:'agent',target:{kind:'ephemeral_organization',templateRef:'team'},instructions:'Review'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:f.root},engines:{codex:'codex'}}});
 const execution=f.branches.accept(branch.id,'input','Review');f.branches.advance();const provision=f.branches.resourceProvisions()[0];assert.ok(provision);
 const project=f.store.createProject({label:'Temporary',hostPath:f.root,defaultEngine:'codex',chatOwned:true,branchId:branch.id,executionId:execution.id});
 const chat=f.store.getConversation(project.lastConversationId);f.branches.bindResourceChat(provision.stepExecutionId,chat.id);
 f.store.sqlite.exec(`CREATE TEMP TRIGGER hold_temporary_cleanup BEFORE INSERT ON conversation_deletion_receipts WHEN NEW.conversation_id='${chat.id}' BEGIN SELECT RAISE(ABORT,'fixture holds actual cleanup'); END`);
 f.branches.cancel(execution.id);await f.branches.waitResourceCheckpoint(provision.stepExecutionId);
 const secret='fixture-temporary-resource-credential';let calls=0;
 registerSyntheticSecret(t,'PONDEROSA_TEST_RESOURCE_TOKEN',secret);
 const service=new BranchResourceService(f.branches,f.store,async()=>{},async()=>{throw Error('Unexpected creation')},async()=>{calls++;throw Error('controlled temporary cleanup '+secret)});
 t.after(()=>service.stop());
 await f.open();await service.tick(false);
 assert.equal(calls,1);
 const detail=await f.api('GET',`/api/branch-executions/${execution.id}`);
 assert.ok(!JSON.stringify(detail).includes(secret));
 assert.match(JSON.stringify(detail),/controlled temporary cleanup/);
 assert.ok(f.store.getConversation(chat.id,{includeDeleting:true}));
 f.store.sqlite.exec('DROP TRIGGER hold_temporary_cleanup');
 await service.stop();
 await until(()=>!f.store.getConversation(chat.id,{includeDeleting:true}),'disposable temporary Chat cleanup after probe');
 await until(()=>f.branches.resourceErrors().length===0,'temporary cleanup diagnostic recovery');
 await f.close();f.pass();
});
