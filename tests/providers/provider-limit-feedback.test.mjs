import assert from 'node:assert/strict';
import test from 'node:test';
import { withFixture, until, fixtureTestOptions } from '../shared/fixture.mjs';
import { AgentStore } from '@ponderosa/agents';

for (const engine of ['codex','claude']) test(`UI014 ${engine} exact quota survives Chat pagination/recheck/restart; other work stays usable; verified successor clears it`, fixtureTestOptions, async t => {
  let store;
  await withFixture(t, async f => {
    const chat=await f.createChat('Quota feedback'), other=await f.createChat('Unaffected Chat');
    const agent=await f.createIdleAgent(chat,'Limited agent'), healthy=await f.createIdleAgent(chat,'Healthy agent');
    if(engine==='claude') f.ok(await f.api('PATCH','/api/agents/'+agent.id,{activeEngine:'claude'}));
    f.plans.set(agent.id,[{run:session=>session.events.push({type:'error',code:'quota_exhausted',category:'quota_exhausted',message:'Quota exhausted'})}]);
    const sent=await f.send(agent.id,'Preserve this exact limited request');
    const read=()=>f.api('GET',`/api/conversations/${chat.id}?limit=1`).then(f.ok);
    const first=await until(async()=>{const data=await read();return data.providerFailureMessages?.length?data:false},'scoped Chat quota notice');
    const receipt=first.providerFailureMessages.flatMap(m=>m.deliveryReceipts).find(r=>r.providerFailure);
    assert.equal(receipt.providerFailure.providerId,engine);assert.equal(receipt.providerFailure.category,'quota_exhausted');
    assert.equal(receipt.providerFailure.recovery,'action_required');assert.equal(receipt.retryMayDuplicate,true);
    const failed=await until(()=>store.sqlite.prepare("SELECT r.* FROM scheduler_runs r JOIN scheduler_run_activations a ON a.run_id=r.id WHERE a.activation_id=? AND r.status NOT IN ('leased','running') ORDER BY r.fencing_token DESC LIMIT 1").get(receipt.activationId),'exact quota source terminal');
    const failedInput=f.ok(await f.api('GET',`/api/runs/${failed.id}/provider-input?exact=1`));
    const source=store.sqlite.prepare('SELECT state,payload_json FROM agent_activations WHERE id=?').get(receipt.activationId);assert.equal(source.state,'outcome_unknown');
    const before=f.turns.filter(turn=>turn.agentId===agent.id).length;
    f.ok(await f.api('PATCH','/api/agents/'+agent.id,{activeEngine:engine==='codex'?'claude':'codex'}));
    assert.equal((await read()).providerFailureMessages[0].deliveryReceipts.find(r=>r.providerFailure).providerFailure.providerId,engine,'Attribute the failed Run, not current selection');
    await f.send(healthy.id,'A separate healthy request');await f.settled(healthy.id);
    const paged=await read();assert.equal(paged.messages.some(m=>m.communicationEventId===sent.communicationEventId),false);
    assert.equal(paged.providerFailureMessages.some(m=>m.communicationEventId===sent.communicationEventId),true);
    assert.deepEqual(f.ok(await f.api('GET',`/api/conversations/${other.id}?limit=1`)).providerFailureMessages,[]);
    f.ok(await f.api('POST',`/api/engines/${engine}/recheck`));
    assert.ok((await read()).providerFailureMessages.length,'A sign-in recheck is not quota recovery evidence');
    assert.equal(f.turns.filter(turn=>turn.agentId===agent.id).length,before);
    await f.reopen();
    assert.equal((await read()).providerFailureMessages[0].deliveryReceipts.find(r=>r.providerFailure).providerFailure.providerId,engine);
    // Selection changes test attribution; retained native context must be
    // recovered with its original provider, never silently discarded.
    f.ok(await f.api('PATCH','/api/agents/'+agent.id,{activeEngine:engine}));
    f.plans.set(agent.id,[{hold:true}]);
    const commandsBefore=f.commands.length;
    const retry=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/message-deliveries/${receipt.activationId}/retry`,{idempotencyKey:'quota-live-explicit-retry'}));
    assert.equal(retry.accepted,true);assert.notEqual(retry.activationId,receipt.activationId);assert.equal(retry.retryMayDuplicate,true);
    const recovered=await until(()=>store.sqlite.prepare("SELECT * FROM provider_context_recovery_requests WHERE agent_id=? AND source_run_id=? AND state='dismissed'").get(agent.id,failed.id),'automatic context recovery for explicit successor');
    const progress=JSON.parse(recovered.progress_json);
    assert.equal(recovered.project_id,chat.projectId);assert.equal(recovered.provider_session_id,failed.provider_session_id);assert.equal(recovered.source_fence,failed.fencing_token);assert.equal(recovered.scope_key,failed.scope_key);assert.equal(recovered.tool_contract_hash,store.getProviderInput(failed.id,true).sourceManifest.normalRuntimeContract.contractHash);
    assert.equal(progress.phase,'context_accepted');assert.equal(progress.automaticMaintenance,true);assert.equal(progress.nativeInvoked,true);assert.equal(progress.nativeOutcome,'completed');assert.equal(progress.sourceWork,'held_unknown');
    const measured=store.readEvents(agent.id).find(row=>row.seq===progress.contextUsageEventSequence);
    assert.ok(measured);assert.equal(measured.event.type,'context_usage');assert.equal(progress.usedTokens,1000);assert.equal(progress.windowTokens,200000);assert.equal(measured.event.usedTokens,progress.usedTokens);assert.equal(measured.event.windowTokens,progress.windowTokens);assert.equal(measured.event.providerSessionId,failed.provider_session_id);
    assert.deepEqual(measured.event.providerCommand,{name:'compact',executionId:failed.id,fencingToken:failed.fencing_token,invocationId:recovered.id});
    assert.equal(f.commands.length,commandsBefore+1);assert.equal(f.commands.at(-1).name,'compact');assert.equal(f.commands.at(-1).sessionId,failed.provider_session_id);
    await until(()=>f.turns.filter(turn=>turn.agentId===agent.id).length===before+1,'user-approved successor starts once after measured recovery');
    const successor=store.sqlite.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(retry.activationId);assert.ok(successor.payload_json.includes('Preserve this exact limited request'));
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(retry.activationId).n,1);
    assert.equal(store.sqlite.prepare(`SELECT count(*) n FROM agent_activations a JOIN scheduler_run_activations r ON r.activation_id=a.id WHERE a.kind='required_reply_recovery' AND json_extract(a.payload_json,'$.requiredReplyRecovery.sourceRunId')=?`).get(failed.id).n,0,'context repair never replays uncertain original work');
    assert.ok((await read()).providerFailureMessages.length,'Keep the notice until recovery succeeds');
    const session=f.sessions.get(agent.id);
    const reply=await f.tool(session,'ponderosa_message',{text:'Recovered exact quota work'});assert.equal(reply.status,200);session.finish();
    await until(async()=>!(await read()).providerFailureMessages.length,'successful recovery clears active notice');
    assert.equal(f.turns.filter(turn=>turn.agentId===agent.id).length,before+1);
    assert.deepEqual(store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(failed.id),failed,'A successful successor cannot rewrite the unknown source Run');
    assert.deepEqual(f.ok(await f.api('GET',`/api/runs/${failed.id}/provider-input?exact=1`)),failedInput);
    assert.deepEqual(store.sqlite.prepare('SELECT state,payload_json FROM agent_activations WHERE id=?').get(receipt.activationId),source);
    const retried=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/message-deliveries/${receipt.activationId}/retry`,{idempotencyKey:'quota-live-explicit-retry'}));assert.equal(retried.replayed,true);assert.equal(retried.activationId,retry.activationId);
    assert.equal(f.turns.filter(turn=>turn.agentId===agent.id).length,before+1);assert.equal(f.commands.length,commandsBefore+1);
  },{diagnosticProvider:true,storeFactory:root=>store=new AgentStore(root),providerValidatesResumeBeforeTurn:true,
    providerContextRecoverySupport:{status:'managed_compaction',crashReconciliation:'hold_without_native_query'},
    providerCommandResult:({sessionId})=>({outcome:'completed',contextUsage:{usedTokens:1000,windowTokens:200000,providerSessionGeneration:sessionId}})});
});

test('UI014 unresolved-notice lookup uses exact indexed communication IDs, never a per-message Project history scan', fixtureTestOptions, async t => {
  const { default:Database }=await import('better-sqlite3');
  const original=Database.prototype.prepare,plans=[];
  Database.prototype.prepare=function(sql,...args){
    const statement=original.call(this,sql,...args);
    if(sql.includes('chain(root, id, event_id)')){
      const all=statement.all.bind(statement);
      statement.all=(...bindings)=>{plans.push(original.call(this,'EXPLAIN QUERY PLAN '+sql).all(...bindings).map(row=>row.detail));return all(...bindings)};
    }
    return statement;
  };
  try { await withFixture(t,async f=>{
    const chat=await f.createChat('Notice query plan');
    f.ok(await f.api('GET','/api/conversations/'+chat.id));
    assert.ok(plans.length);
    for(const plan of plans){
      assert.ok(plan.some(row=>row.includes('runtime_communications_authored_event')),plan.join('\n'));
      assert.equal(plan.some(row=>/SEARCH communication USING INDEX runtime_communications_project_created|SCAN communication/u.test(row)),false,plan.join('\n'));
    }
  }); } finally { Database.prototype.prepare=original; }
});
