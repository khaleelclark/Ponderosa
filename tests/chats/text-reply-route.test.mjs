import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {matchesHumanTextReplyRoute} from '../../apps/web/src/components/chat/textReplyRoute.ts';
const source={id:'projection',communicationEventId:'source',conversationId:'chat',role:'user',communicationIntent:'broadcast'};
const reply={messageId:'source',conversationId:'chat',presentation:'text',replyIntent:'broadcast'};
test('shared human text rejects private, peer, voice and foreign source snapshots',()=>{
 assert.equal(matchesHumanTextReplyRoute(source,reply),true);
 for(const patch of [{replyIntent:'direct_to_user'},{replyIntent:'collaboration',recipientAgentIds:['peer']},{recipientAgentIds:['peer']},{presentation:'voice'},{messageId:'other'},{conversationId:'other'}])assert.equal(matchesHumanTextReplyRoute(source,{...reply,...patch}),false);
});
test('Direct Message text requires the explicit direct route',()=>{
 const direct={...source,communicationIntent:'user_dm'};
 assert.equal(matchesHumanTextReplyRoute(direct,{...reply,replyIntent:'direct_to_user'}),true);
 assert.equal(matchesHumanTextReplyRoute(direct,reply),false);
 assert.equal(matchesHumanTextReplyRoute({...direct,role:'assistant'},{...reply,replyIntent:'direct_to_user'}),false);
});
test('peer drafts require the exact sole return recipient and never enter the human route',()=>{
 const peer={...source,role:'assistant',communicationIntent:'collaboration',communicationSender:{kind:'agent',agentId:'sender'},authorAgentId:'sender',collaborationRecipients:[{id:'receiver'}]};
 const draft={...reply,agentId:'receiver',replyIntent:'collaboration',recipientAgentIds:['sender']};
 assert.equal(matchesHumanTextReplyRoute(peer,draft,'receiver'),true);
 assert.equal(matchesHumanTextReplyRoute(source,draft),false);
 assert.equal(matchesHumanTextReplyRoute(peer,draft),false);
 for(const patch of [{recipientAgentIds:['other']},{recipientAgentIds:['sender','other']},{agentId:'other'},{replyIntent:'broadcast'}])assert.equal(matchesHumanTextReplyRoute(peer,{...draft,...patch},'receiver'),false);
 assert.equal(matchesHumanTextReplyRoute({...peer,coordinationRequests:[{id:'request'}]},draft,'receiver'),false);
});

test('explicit publication selects one exact document or mixed-route return',()=>{
 const direct={...source,communicationIntent:'user_dm'};
 const selected={...reply,replyIntent:undefined,publication:{kind:'message',intent:'direct_to_user',documentTitle:'Report',taskDelivery:'final'}};
 assert.equal(matchesHumanTextReplyRoute(direct,selected),true);
 assert.equal(matchesHumanTextReplyRoute(source,selected),false);
 assert.equal(matchesHumanTextReplyRoute(direct,{...selected,purpose:'acknowledgement'}),false);
 assert.equal(matchesHumanTextReplyRoute(direct,{...selected,publication:{...selected.publication,recipientAgentIds:['other']}}),false);
});


test('text preview follows only its exact recovering Run while voice retains original timing', {timeout:30000},async t=>{
 const {withFixture}=await import('../shared/fixture.mjs'),{AgentStore,CoordinationV3Store}=await import('../../packages/agents/dist/index.js'),{randomUUID,createHash}=await import('node:crypto');let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Owned preview lineage'),agent=await f.createIdleAgent(chat,'Preview recipient'),foreignChat=await f.createChat('Other owner'),foreignAgent=await f.createIdleAgent(foreignChat,'Foreign recipient');
  const db=store.sqlite,v3=new CoordinationV3Store(db),stamp=new Date().toISOString(),future='2099-01-01T00:00:00.000Z',scope='conversation:'+chat.id,message=randomUUID(),originalRun=randomUUID(),recoveryRun=randomUUID(),unrelatedRun=randomUUID(),injection=randomUUID();
  const sender={kind:'user',userId:'local-operator'},audience={kind:'user_agents',userId:'local-operator',agentIds:[agent.id]};const communication={schemaVersion:2,eventId:message,projectId:chat.projectId,conversationId:chat.id,sender,audience,intent:'user_dm',text:'Owned original input',createdAt:stamp};
  const root=v3.recordRuntimeCommunication({id:message,projectId:chat.projectId,scopeKey:scope,sender,intent:'user_dm',audience,payload:{communication},now:stamp,activation:{agentId:agent.id,kind:'user_message',priority:100,promptClass:'human'}});
  let fixtureFence=5;const addRun=(id,status)=>db.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,?,?,?,?,'injected',?,?,?,?)").run(id,chat.projectId,agent.id,status,'inert-read-fixture',future,++fixtureFence,stamp,stamp,stamp,scope);
  addRun(unrelatedRun,'completed');addRun(originalRun,'outcome_unknown');addRun(recoveryRun,'running');db.prepare("UPDATE agent_activations SET state='outcome_unknown' WHERE id=?").run(root.activationId);
  const recovery=db.prepare('SELECT * FROM agent_activations WHERE id=?').get(root.activationId);recovery.id=randomUUID();recovery.dedupe_key=randomUUID();recovery.state='attached';db.prepare(`INSERT INTO agent_activations(${Object.keys(recovery).join(',')}) VALUES(${Object.keys(recovery).map(()=>'?').join(',')})`).run(...Object.values(recovery));
  for(const [run,activation] of [[originalRun,root.activationId],[recoveryRun,recovery.id]])db.prepare('INSERT INTO scheduler_run_activations(run_id,activation_id,attached_at) VALUES(?,?,?)').run(run,activation,stamp);
  for(const [id,run,activation,kind] of [[injection,originalRun,root.activationId,'steer'],[randomUUID(),recoveryRun,recovery.id,'turn']])db.prepare("INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at,acknowledged_at) VALUES(?,?,?,0,'acknowledged',?,?,?, ?,?)").run(id,run,kind,createHash('sha256').update('Owned').digest('hex'),JSON.stringify([activation]),stamp,stamp,stamp);
  db.prepare("INSERT INTO scheduler_steering_recoveries(injection_id,run_id,agent_id,state,recover_at,created_at,updated_at) VALUES(?,?,?,'recovery_queued',?,?,?)").run(injection,originalRun,agent.id,future,stamp,stamp);db.prepare('INSERT INTO scheduler_steering_recovery_activations VALUES(?,?,?)').run(injection,root.activationId,recovery.id);
  for(const run of [originalRun,recoveryRun,unrelatedRun])db.prepare('INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(run,run,agent.id,chat.projectId,'Owned',createHash('sha256').update('Owned').digest('hex'),JSON.stringify({schemaVersion:3,conversationId:chat.id,memorySessionResetSeq:0,memoryScopes:[],sources:[],communicationEventIds:[message],activationIds:[run===recoveryRun?recovery.id:root.activationId]}),stamp,stamp);
  db.prepare('UPDATE scheduler_prompt_injections SET submitted_at=? WHERE run_id=?').run(stamp,recoveryRun);
  store.appendEvent(agent.id,{type:'voice_reply',reply:{presentation:'text',purpose:'answer',replyIntent:'direct_to_user',projectId:chat.projectId,conversationId:chat.id,agentId:agent.id,messageId:message,runId:recoveryRun,fence:8,streamId:randomUUID(),sequence:1,state:'streaming',text:'Exact recovery preview',acceptedAt:stamp}});
  const original=db.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(originalRun),activation=db.prepare('SELECT * FROM agent_activations WHERE id=?').get(root.activationId);
  const read=async(kind='reply-streams')=>f.ok(await f.api('GET',`/api/conversations/${chat.id}/${kind}/${message}/${agent.id}`));
  assert.equal(v3.deliveryReceiptsForCommunication(chat.projectId,message)[0].state,'recovering');const active=await read();assert.equal(active.runId,recoveryRun,'Real API must select exact recovery, not terminal original or unrelated Run');assert.equal(active.reply.text,'Exact recovery preview');assert.equal(active.memoryExposure.state,'disabled','Exact hash-verified source packet permits preview with memory disabled');assert.equal((await read('voice-replies')).runId,originalRun,'Voice recovery/playback contract is unchanged');
  db.prepare('UPDATE provider_inputs SET prompt_hash=? WHERE execution_id=?').run('invalid-hash',recoveryRun);assert.equal((await read()).memoryExposure.state,'invalid','Provider-input hash verification remains required');db.prepare('UPDATE provider_inputs SET prompt_hash=? WHERE execution_id=?').run(createHash('sha256').update('Owned').digest('hex'),recoveryRun);
  db.prepare('UPDATE provider_inputs SET agent_id=?,project_id=? WHERE execution_id=?').run(foreignAgent.id,foreignChat.projectId,recoveryRun);assert.equal((await read()).runId,undefined,'Foreign provider-input owner fails closed');db.prepare('UPDATE provider_inputs SET agent_id=?,project_id=? WHERE execution_id=?').run(agent.id,chat.projectId,recoveryRun);
  db.prepare('UPDATE scheduler_runs SET agent_id=?,project_id=? WHERE id=?').run(foreignAgent.id,foreignChat.projectId,recoveryRun);assert.equal((await read()).runId,undefined,'Foreign Run owner fails closed');db.prepare('UPDATE scheduler_runs SET agent_id=?,project_id=? WHERE id=?').run(agent.id,chat.projectId,recoveryRun);
  db.prepare('UPDATE scheduler_runs SET scope_key=? WHERE id=?').run('conversation:'+foreignChat.id,recoveryRun);assert.equal((await read()).runId,undefined,'Foreign Chat scope fails closed');db.prepare('UPDATE scheduler_runs SET scope_key=? WHERE id=?').run(scope,recoveryRun);
  db.prepare('UPDATE provider_inputs SET execution_id=? WHERE execution_id=?').run('alias-'+recoveryRun,recoveryRun);assert.equal((await read()).runId,undefined,'Non-Run execution aliases cannot authorize a preview');db.prepare('DELETE FROM provider_inputs WHERE scheduler_run_id=?').run(recoveryRun);assert.equal((await read()).runId,undefined,'Missing exact recovery input never falls back to original');
  assert.deepEqual(db.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(originalRun),original);assert.deepEqual(db.prepare('SELECT * FROM agent_activations WHERE id=?').get(root.activationId),activation);assert.equal(f.turns.length,0,'Status reads never start/replay a provider turn');
  // An explicit retry has its own activation even when it steers into an already running Run.
  const retryMessage=randomUUID(),retrySource=v3.recordRuntimeCommunication({id:retryMessage,projectId:chat.projectId,scopeKey:scope,sender,intent:'user_dm',audience,payload:{communication:{...communication,eventId:retryMessage}},now:stamp,activation:{agentId:agent.id,kind:'user_message',priority:100,promptClass:'human'}});
  db.prepare("UPDATE agent_activations SET state='failed' WHERE id=?").run(retrySource.activationId);
  db.prepare('INSERT INTO scheduler_run_activations(run_id,activation_id,attached_at) VALUES(?,?,?)').run(originalRun,retrySource.activationId,stamp);
  const retry=v3.retryMessageDelivery({projectId:chat.projectId,activationId:retrySource.activationId,idempotencyKey:randomUUID(),now:stamp});
  db.prepare("UPDATE agent_activations SET state='attached' WHERE id=?").run(retry.activationId);
  db.prepare('INSERT INTO scheduler_run_activations(run_id,activation_id,attached_at) VALUES(?,?,?)').run(recoveryRun,retry.activationId,stamp);
  const retryInjection=randomUUID();db.prepare("INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at,submitted_at,acknowledged_at) VALUES(?,?,'steer',1,'acknowledged',?,?,?,?,?,?)").run(retryInjection,recoveryRun,createHash('sha256').update('Owned retry').digest('hex'),JSON.stringify([retry.activationId]),stamp,stamp,stamp,stamp);
  db.prepare('INSERT INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(recoveryRun,recoveryRun,agent.id,chat.projectId,'Owned retry',createHash('sha256').update('Owned retry').digest('hex'),JSON.stringify({schemaVersion:3,conversationId:chat.id,memorySessionResetSeq:0,memoryScopes:[],sources:[],communicationEventIds:[retryMessage],activationIds:[retry.activationId]}),stamp,stamp);
  assert.equal(v3.deliveryReceiptsForCommunication(chat.projectId,retryMessage)[0].activationId,retry.activationId);
  const readRetry=async()=>f.ok(await f.api('GET',`/api/conversations/${chat.id}/reply-streams/${retryMessage}/${agent.id}`));
  assert.equal((await readRetry()).runId,recoveryRun,'Ordinary retry selects its exact current Run instead of original intake');
  for(const [run,source,event] of [[originalRun,retrySource.activationId,'prior-publication'],[recoveryRun,retry.activationId,'current-publication']])db.prepare("INSERT INTO required_reply_obligations(run_id,source_activation_id,project_id,agent_id,scope_key,reply_authority_json,attempt_count,state,satisfied_communication_id,created_at,updated_at,delivery_phase) VALUES(?,?,?,?,?,?,0,'satisfied',?,?,?,'final')").run(run,source,chat.projectId,agent.id,scope,JSON.stringify({intent:'direct_to_user'}),event,stamp,stamp);
  assert.equal((await readRetry()).canonicalReplyEventId,'current-publication','Canonical publication follows current source, never original attempt');
  db.prepare('INSERT INTO scheduler_run_activations(run_id,activation_id,attached_at) VALUES(?,?,?)').run(recoveryRun,retrySource.activationId,stamp);
  db.prepare("INSERT INTO required_reply_obligations(run_id,source_activation_id,project_id,agent_id,scope_key,reply_authority_json,attempt_count,state,satisfied_communication_id,created_at,updated_at,delivery_phase) VALUES(?,?,?,?,?,?,0,'satisfied',?,?,?,'final')").run(recoveryRun,retrySource.activationId,chat.projectId,agent.id,scope,JSON.stringify({intent:'direct_to_user'}),'earlier-same-run-publication',stamp,stamp);
  assert.equal((await readRetry()).canonicalReplyEventId,'current-publication','Two attempt obligations on one Run retain exact source identity');
  db.prepare('DELETE FROM scheduler_run_activations WHERE run_id=? AND activation_id=?').run(recoveryRun,retry.activationId);
  assert.equal((await readRetry()).runId,undefined,'Missing exact current attachment cannot fall back to an older attempt');assert.equal(f.turns.length,0);

 },{storeFactory:data=>(store=new AgentStore(data))});
});
