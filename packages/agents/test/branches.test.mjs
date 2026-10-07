import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentStore, CoordinationV3Store, BranchStore, CapabilityPolicyStore } from '../dist/index.js';
import {CAPABILITY_IDS} from '@ponderosa/core';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'branches-'));
  let store = new AgentStore(dir);
  let coordination = new CoordinationV3Store(store.sqlite);
  let branches = new BranchStore(store.sqlite, coordination);
  const project = store.createProject({label:'Test',hostPath:dir,defaultEngine:'codex'});
  const chat = store.createConversation(project.id, {title:'Chat'});
  const agent = store.createAgent(project.id,{title:'Specialist',engine:'codex',conversationId:chat.id});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const definition = {
    schema:'ponderosa.branch.v1',name:'Summary',trigger:{kind:'manual'},entry:'agent',controls:[],
    steps:[{id:'agent',kind:'agent',target:{kind:'persistent_organization',ref:'reviewer'},instructions:'Summarize input'},
      {id:'script',kind:'script',runtime:'node',source:'console.log("done")',cwdRef:'workspace',timeoutMs:1000}],
    edges:[{id:'next',from:'agent',to:'script',on:'success'}],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}},
  };
  const deployment = {chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{reviewer:agent.id},directories:{workspace:dir}}};
  const branch = branches.deploy(deployment);
  return {get store(){return store},get coordination(){return coordination},get branches(){return branches}, agent,branch,deployment,
    reopen(){store.close();store=new AgentStore(dir);coordination=new CoordinationV3Store(store.sqlite);branches=new BranchStore(store.sqlite,coordination);}};
}
function complete(f,id,text='result') {
 const requestId=f.branches.detail(id).attempts[0].requestId;
 f.coordination.updateRequest({requestId,updateId:`done:${requestId}`,kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text}});
}
test('duplicate intake pins accepted version and restart never creates another Request',t=>{
 const f=fixture(t), e=f.branches.accept(f.branch.id,'event','one');
 assert.equal(f.branches.accept(f.branch.id,'event','one').id,e.id);
 assert.throws(()=>f.branches.accept(f.branch.id,'event','changed'),/idempotency/);
 const v2=f.branches.deploy({...f.deployment,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'v2',definition:{...f.deployment.definition,name:'v2'}});
 assert.equal(f.branches.execution(e.id).versionId,f.branch.versionId);
 assert.equal(f.branches.accept(f.branch.id,'next','two').versionId,v2.versionId);
 f.branches.advance(); const request=f.branches.detail(e.id).attempts[0].requestId;
 f.reopen();f.branches.advance();
 assert.equal(f.branches.detail(e.id).attempts[0].requestId,request);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM coordination_requests WHERE id=?').get(request).n,1);
});
test('Branch directory status reports availability, automatic intake, and active work',t=>{
 const f=fixture(t);
 const directory=()=>f.branches.listBranches().find(branch=>branch.id===f.branch.id);
 assert.equal(directory().activeExecutions,0);
 const execution=f.branches.accept(f.branch.id,'directory-status','input');
 assert.equal(directory().activeExecutions,1);
 f.branches.cancel(execution.id);assert.equal(directory().activeExecutions,0);
 f.branches.setEnabled(f.branch.id,false);assert.equal(directory().enabled,false);
 f.branches.setEnabled(f.branch.id,true);
 const definition={...f.deployment.definition,trigger:{kind:'schedule',configRef:'schedule'}};
 const sourceConfig={scheduleKind:'interval',everyMs:60000};
 const scheduled=f.branches.deploy({...f.deployment,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'scheduled',definition,
  bindings:{...f.deployment.bindings,triggers:{schedule:{enabled:true,sourceConfig}}}},new Date().toISOString(),{sourceConfig});
 assert.equal(directory().triggerEnabled,true);
 f.coordination.updateTriggerDefinition(scheduled.triggerId,{enabled:false});
 assert.equal(directory().triggerEnabled,false);
});
test('deleting a scheduled Branch disables its trigger and fences new intake',t=>{
 const f=fixture(t);
 const scheduled=f.branches.deploy({...f.deployment,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'scheduled-deletion',
  definition:{...f.deployment.definition,trigger:{kind:'schedule',configRef:'schedule'}},
  bindings:{...f.deployment.bindings,triggers:{schedule:{enabled:true,sourceConfig:{scheduleKind:'interval',everyMs:60000}}}}},
 new Date().toISOString(),{sourceConfig:{scheduleKind:'interval',everyMs:60000}});
 f.branches.beginDeletion(scheduled.id);
 f.branches.beginDeletion(scheduled.id);
 assert.equal(f.store.sqlite.prepare('SELECT deleting FROM branches WHERE id=?').get(scheduled.id).deleting,1);
 assert.equal(f.coordination.getTriggerDefinition(scheduled.triggerId).enabled,false);
 assert.throws(()=>f.branches.accept(scheduled.id,'after-deletion','input'),/disabled/);
});
test('only terminal Request advances; terminal checkpoint and script output survive restart',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'event','payload');f.branches.advance();
 f.branches.advance();assert.equal(f.branches.detail(e.id).steps.length,1);
 complete(f,e.id,'hello\r\nworld');f.reopen();f.branches.advance();
 const lease=f.branches.claimScript('worker');assert.equal(lease.input,'hello\nworld');
 f.branches.settleScript(lease,{failed:false,output:'finished'});
 f.reopen();f.branches.advance();assert.equal(f.branches.execution(e.id).state,'completed');
 assert.equal(f.branches.execution(e.id).output,'finished');assert.equal(f.branches.claimScript('worker'),undefined);
});
test('capability policy fails a Script Step explicitly before process admission',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'restricted-script','payload');f.branches.advance();complete(f,e.id);f.branches.advance();
 new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'branch',scopeId:f.branch.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.scripts]});
 assert.equal(f.branches.claimScript('worker'),undefined);
 assert.equal(f.branches.execution(e.id).state,'failed');
 assert.match(f.branches.detail(e.id).attempts.at(-1).result.output,/restricted by capability policy/);
});
test('a newly restricted notification is fenced before external delivery',t=>{
 const f=fixture(t),definition={schema:'ponderosa.branch.v1',name:'Notify',trigger:{kind:'manual'},entry:'notify',steps:[{id:'notify',kind:'action',action:'notify',configRefs:[]}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 const branch=f.branches.deploy({chatId:f.agent.conversationId,idempotencyKey:'notify-capability',definition,bindings:{agents:{},directories:{}}}),execution=f.branches.accept(branch.id,'notify','Result');
 f.branches.advance();
 assert.equal(f.store.sqlite.prepare("SELECT state FROM branch_actions").get().state,'pending');
 new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'branch',scopeId:branch.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.notifications]});
 assert.equal(f.branches.claimAction('delivery-worker'),undefined);
 assert.equal(f.branches.execution(execution.id).state,'failed');
 assert.match(f.branches.detail(execution.id).attempts[0].result.output,/restricted by capability policy/);
});
test('unknown provider result waits instead of duplicating the obligation',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'event','payload');f.branches.advance();
 const requestId=f.branches.detail(e.id).attempts[0].requestId;
 f.coordination.updateRequest({requestId,updateId:'unknown',kind:'outcome_unknown',actor:{kind:'supervisor'}});
 f.branches.advance();assert.equal(f.branches.execution(e.id).state,'waiting');
 f.reopen();f.branches.advance();assert.equal(f.branches.detail(e.id).attempts.length,1);
});
test('cancellation fences stale script completion; submitted script recovery never retries effects',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'event','payload');f.branches.advance();complete(f,e.id);f.branches.advance();
 const lease=f.branches.claimScript('old');
 f.branches.authorizeScript(lease,{pid:123,pgid:123,birthMarker:'linux:1'});
 f.reopen();assert.equal(f.branches.scriptRecoveries('new').length,1);
 f.branches.recoverScript(lease.attemptId);
 assert.equal(f.branches.execution(e.id).state,'waiting');assert.equal(f.branches.claimScript('new'),undefined);
 assert.throws(()=>f.branches.settleScript(lease,{failed:false}),/fenced/);
 f.branches.cancel(e.id);assert.equal(f.branches.execution(e.id).state,'canceled');
});
test('unsubmitted script lease can recover and cancel preserves unrelated Agent Requests',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'event','payload');f.branches.advance();
 const other=f.coordination.coordinate({projectId:f.agent.projectId,conversationId:f.agent.conversationId,actorScope:'user:local-operator',idempotencyKey:'other',requests:[{recipientAgentId:f.agent.id,lifetime:{kind:'indefinite'}}]}).requestIds[0];
 complete(f,e.id);f.branches.advance();const lease=f.branches.claimScript('old');
 f.reopen();f.branches.recoverScript(lease.attemptId);const replacement=f.branches.claimScript('new');assert.ok(replacement.fence>lease.fence);
 f.branches.cancel(e.id);assert.throws(()=>f.branches.settleScript(replacement,{failed:false}),/fenced/);
 assert.equal(f.store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(other).state,'open');
});
test('invalid graph structures and cross-chat bindings fail before deployment',t=>{
 const f=fixture(t);
 assert.throws(()=>f.branches.deploy({...f.deployment,idempotencyKey:'bad',definition:{...f.deployment.definition,controls:[{id:'fork',kind:'fork',joinId:'join'}]}}),/paired join/);
 const other=f.store.createConversation(f.agent.projectId,{title:'Other'});
 assert.throws(()=>f.branches.deploy({...f.deployment,chatId:other.id,idempotencyKey:'other'}),/unavailable/);
});
test('concurrency admission stays durable while queued versions retain their own bindings',t=>{
 const f=fixture(t);
 const v=f.branches.deploy({...f.deployment,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'single',definition:{...f.deployment.definition,policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}}});
 const first=f.branches.accept(f.branch.id,'first','1'),second=f.branches.accept(f.branch.id,'second','2');
 f.branches.advance();assert.equal(f.branches.execution(second.id).state,'queued');
 f.reopen();f.branches.advance();assert.equal(f.branches.execution(second.id).state,'queued');
 f.branches.cancel(first.id);f.branches.advance();assert.equal(f.branches.execution(second.id).state,'running');
 assert.equal(f.branches.execution(second.id).versionId,v.versionId);
 assert.equal(f.branches.execution(second.id).bindingRevisionId,v.bindingRevisionId);
});
test('checkpoint audit retries preserve logical identity without becoming runtime authority',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'audit','input');
 const deliveries=[];
 assert.throws(()=>f.branches.publishAudit(event=>{deliveries.push(event);throw new Error('journal acknowledgement lost');}),/acknowledgement/);
 f.branches.publishAudit(event=>deliveries.push(event));
 assert.equal(deliveries[0].checkpointId,deliveries[1].checkpointId);
 assert.equal(f.branches.execution(e.id).state,'queued');
 f.branches.publishAudit(()=>assert.fail('already acknowledged checkpoint was replayed'));
});

test('bounded reducer visits work beyond a saturated queue',t=>{
 const f=fixture(t);
 for(let i=0;i<101;i++)f.branches.accept(f.branch.id,`backlog-${i}`,'input');
 const other=f.branches.deploy({...f.deployment,idempotencyKey:'other-branch'});
 const e=f.branches.accept(other.id,'independent','input');
 for(let i=0;i<4;i++)f.branches.advance();
 assert.equal(f.branches.execution(e.id).state,'running');
 assert.ok(f.branches.detail(e.id).attempts[0].requestId);
});

test('Request creation and binding roll back together at a failed dispatch commit',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'atomic-request','input');
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_binding BEFORE UPDATE OF request_id ON branch_attempts BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END`);
 assert.throws(()=>f.branches.advance(),/injected binding/);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM coordination_requests').get().n,0);
 assert.equal(f.branches.execution(e.id).state,'queued');
 f.reopen();f.branches.advance();f.branches.advance();
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM coordination_requests').get().n,1);
});

test('terminal reduction and successor preparation are atomic across restart',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'atomic-next','input');f.branches.advance();complete(f,e.id);
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_next BEFORE INSERT ON branch_step_executions WHEN NEW.step_id='script' BEGIN SELECT RAISE(ABORT, 'injected successor failure'); END`);
 assert.throws(()=>f.branches.advance(),/injected successor/);
 assert.equal(f.branches.detail(e.id).steps[0].state,'waiting');
 f.reopen();f.branches.advance();f.reopen();f.branches.advance();
 assert.equal(f.branches.detail(e.id).steps.length,2);
 assert.equal(f.branches.claimScript('worker').input,'result');
});

test('cancel wins before terminal Request reduction without canceling unrelated obligations',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'cancel-terminal','input');f.branches.advance();complete(f,e.id);
 f.branches.cancel(e.id);f.reopen();f.branches.advance();
 assert.equal(f.branches.execution(e.id).state,'canceled');
 assert.equal(f.branches.detail(e.id).steps.length,1);
 assert.equal(f.branches.claimScript('worker'),undefined);
});

test('queued executions retain old Agent and Script bindings after deployment',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'old-binding','input');
 const replacement=f.store.createAgent(f.agent.projectId,{title:'Replacement',engine:'codex',conversationId:f.agent.conversationId});
 const v=f.branches.deploy({...f.deployment,idempotencyKey:'changed-binding',branchId:f.branch.id,expectedVersionId:f.branch.versionId,
 definition:{...f.deployment.definition,steps:f.deployment.definition.steps.map(s=>s.kind==='script'?{...s,source:'console.log("new")'}:s)},bindings:{...f.deployment.bindings,agents:{reviewer:replacement.id}}});
 f.reopen();f.branches.advance();
 const request=f.branches.detail(e.id).attempts[0].requestId;
 assert.equal(f.coordination.getRequest(request).recipientAgentId,f.agent.id);
 complete(f,e.id);f.branches.advance();assert.equal(f.branches.claimScript('worker').source,'console.log("done")');
 assert.notEqual(f.branches.execution(e.id).bindingRevisionId,v.bindingRevisionId);
 assert.throws(()=>f.store.sqlite.prepare('DELETE FROM branch_versions WHERE id=?').run(f.branch.versionId),/FOREIGN KEY/);
 assert.throws(()=>f.store.sqlite.prepare('DELETE FROM branch_bindings WHERE id=?').run(f.branch.bindingRevisionId),/FOREIGN KEY/);
});

test('ongoing intake cannot postpone settlement of an earlier Request forever',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'first','input');f.branches.advance();complete(f,e.id);
 for(let batch=0;batch<3;batch++){
  for(let i=0;i<101;i++)f.branches.accept(f.branch.id,`continuous-${batch}-${i}`,'input');
  f.branches.advance();
 }
 assert.equal(f.branches.detail(e.id).steps[0].state,'completed');
});

test('provider Run completion is not a Branch handoff',t=>{
 const f=fixture(t),e=f.branches.accept(f.branch.id,'run-only','input');f.branches.advance();
 const lease=f.coordination.leaseNextRun({workerId:'provider'});assert.ok(lease);
 f.coordination.markRunStarted(lease.runId,lease.fencingToken);
 const injection={injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken};
 f.coordination.preparePromptInjection({...injection,prompt:'done'});
 f.coordination.markPromptSubmitted(injection);f.coordination.acknowledgePromptInjection(injection);
 f.coordination.completeRun(lease.runId,lease.fencingToken);
 f.branches.advance();
 assert.equal(f.branches.detail(e.id).steps.length,1);
 assert.equal(f.branches.detail(e.id).steps[0].state,'waiting');
 assert.equal(f.branches.execution(e.id).state,'waiting');
 assert.match(f.branches.execution(e.id).waitReason,/outcome_unknown/);
});

test('intake rollback creates neither a partial execution nor a conflicting duplicate',t=>{
 const f=fixture(t);
 f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_accept BEFORE INSERT ON branch_checkpoints WHEN NEW.kind='trigger_accepted' BEGIN SELECT RAISE(ABORT, 'injected intake failure'); END`);
 assert.throws(()=>f.branches.accept(f.branch.id,'atomic-intake','input'),/injected intake/);
 assert.equal(f.branches.listExecutions(f.branch.id).length,0);
 f.reopen();const e=f.branches.accept(f.branch.id,'atomic-intake','input');f.reopen();
 assert.equal(f.branches.accept(f.branch.id,'atomic-intake','input').id,e.id);
});
