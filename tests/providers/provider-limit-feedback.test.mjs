import assert from 'node:assert/strict';
import test from 'node:test';
import { withFixture, until, fixtureTestOptions } from '../shared/fixture.mjs';

for (const engine of ['codex','claude']) test(`UI014 ${engine} exact quota survives Chat pagination/recheck/restart; other work stays usable; explicit recovery clears it`, fixtureTestOptions, async t => {
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
    f.plans.set(agent.id,[{hold:true}]);
    const retry=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/message-deliveries/${receipt.activationId}/retry`,{idempotencyKey:'quota-live-explicit-retry'}));
    assert.equal(retry.accepted,true);
    await until(()=>f.turns.filter(turn=>turn.agentId===agent.id).length===before+1,'explicit recovery starts once');
    assert.ok((await read()).providerFailureMessages.length,'Keep the notice until recovery succeeds');
    const session=f.sessions.get(agent.id);
    const reply=await f.tool(session,'ponderosa_message',{text:'Recovered exact quota work'});assert.equal(reply.status,200);session.finish();
    await until(async()=>!(await read()).providerFailureMessages.length,'successful recovery clears active notice');
    assert.equal(f.turns.filter(turn=>turn.agentId===agent.id).length,before+1);
  },{diagnosticProvider:true});
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
