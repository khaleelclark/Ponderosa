import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {AgentStore, CoordinationV3Store} from '@ponderosa/agents';
import {createAgentEventService} from '../../apps/server/dist/agent-event-service.js';
import {createCommunicationProjectionReconciler} from '../../apps/server/dist/communication-projection-reconciler.js';
import {materializeRequestUpdateCommunication, requestUpdateCommunicationEventId} from '../../apps/server/dist/request-update-communication.js';
import {withFixture, until, fixtureTestOptions as options} from '../shared/fixture.mjs';

const quiet = detail => !detail.coordinationV3.activeRun &&
  !detail.runs.some(run => ['running','preparing'].includes(run.status)) &&
  !detail.coordinationV3.activations.some(a => ['pending','retry_pending','leased','attached'].includes(a.state));
const reconciliation = (f, chat) => f.api('GET', `/api/projects/${chat.projectId}/communication-reconciliation`);

const recoveryCases=['replay','restart'].flatMap(recover=>[0,1,2,3,'team-metadata','author-metadata','peer-metadata'].map(after=>[recover,after,'codex']));
recoveryCases.push(['replay','author-metadata','claude']);
for (const [recover,after,engine] of recoveryCases) {
  test(`${engine} passive Request metadata recovers by ${recover} after durable write ${after}`, options, t => withFixture(t, async f => {
    const chat = await f.createChat('Interrupted passive handoff');
    const manager = await f.createIdleAgent(chat,'Manager');
    const worker=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/agents`,{
      title:'Worker',engine,conversationId:chat.id,idempotencyKey:randomUUID(),
    }));
    const unrelated = await f.createIdleAgent(chat,'Unrelated');
    const managerSession = await f.hold(manager.id);
    f.plans.set(worker.id,[{hold:true}]);
    const coordinated = f.ok(await f.tool(managerSession,'ponderosa_coordinate',{
      idempotencyKey:randomUUID(),requests:[{recipientAgentId:worker.id,text:'One controlled assignment',lifetime:{kind:'indefinite'}}],
    }));
    await until(()=>f.sessions.has(worker.id),'worker received its Request');
    const requestId = coordinated.requestIds[0], updateId = randomUUID(), text = `Canonical result ${randomUUID()}`;
    const eventId = requestUpdateCommunicationEventId(chat.projectId,requestId,updateId);
    let written = 0, injected = false;
    const methods = ['appendCommunicationEvent','appendConversationMessage','appendEvent','appendCommunicationProjection'];
    const originals = new Map(methods.map(name=>[name,AgentStore.prototype[name]]));
    for (const name of methods) AgentStore.prototype[name] = function(...args) {
      const projection=args[1];
      if(name==='appendCommunicationProjection' && !injected && projection.eventId===eventId && projection.message && (
        (after==='team-metadata'&&projection.surface==='collaboration_view') ||
        (after==='author-metadata'&&projection.surface==='direct_agent_audit'&&projection.projectionKey===worker.id) ||
        (after==='peer-metadata'&&projection.surface==='direct_agent_audit'&&projection.projectionKey===manager.id)
      )) {injected=true;throw Error('Controlled metadata failure after raw dispatch/audit append');}
      const result = originals.get(name).apply(this,args);
      const matching = name === 'appendCommunicationEvent' ? args[0].eventId === eventId
        : name === 'appendConversationMessage' ? args[6] === eventId
          : args[1]?.type === 'communication_projection' && args[1].communicationEventId === eventId;
      if (matching && !injected && written++ === after) {injected=true;throw Error('Controlled failure after durable passive projection write');}
      return result;
    };
    const update = {requestId,updateId,kind:'completed',text};
    let accepted;
    try {accepted=f.ok(await f.tool(f.sessions.get(worker.id),'ponderosa_update_request',update));}
    finally {for(const [name,method] of originals)AgentStore.prototype[name]=method;}
    assert.equal(injected,true);
    // These fields are the actual route's202 committed/recovering branch.
    assert.equal(accepted.committed,true);assert.equal(accepted.recovering,true);
    assert.equal((await f.detail(worker.id)).coordinationV3.requests.find(r=>r.id===requestId).state,'completed');
    const beforeReport = await reconciliation(f,chat);
    assert.equal(beforeReport.body.missingProjectionMetadataEventIds.includes(eventId),after!==3);
    if(recover==='replay') {
      const before = [await f.detail(manager.id),await f.detail(worker.id)];
      const replay=f.ok(await f.tool(f.sessions.get(worker.id),'ponderosa_update_request',update));
      assert.equal(replay.replayed,true);assert.equal(replay.recovering,undefined);
      const originalLedger=AgentStore.prototype.ensureCommunicationProjectionLedger;
      AgentStore.prototype.ensureCommunicationProjectionLedger=()=>{throw Error('Complete replay unnecessarily rebuilt history');};
      let again;try{again=f.ok(await f.tool(f.sessions.get(worker.id),'ponderosa_update_request',update));}
      finally{AgentStore.prototype.ensureCommunicationProjectionLedger=originalLedger;}
      assert.equal(again.replayed,true);
      assert.equal(again.recovering,undefined);
      // Readiness reads the cached diagnostic. Do not mask stale drift by
      // calling the explicit reconciliation GET before this assertion.
      await until(async()=>(await f.api('GET','/api/ready')).body.checks.communicationMigration.ok,'replay refreshes cached projection readiness');
      const afterReplay=[await f.detail(manager.id),await f.detail(worker.id)];
      for(let i=0;i<2;i++) {
        assert.deepEqual(afterReplay[i].runs.map(r=>r.id),before[i].runs.map(r=>r.id));
        assert.deepEqual(afterReplay[i].coordinationV3.requests,before[i].coordinationV3.requests);
        assert.deepEqual(afterReplay[i].coordinationV3.activations,before[i].coordinationV3.activations);
      }
    } else {
      f.plans.set(manager.id,[{output:false,run:async()=>{}}]);
      f.sessions.get(worker.id).finish();managerSession.finish();
      await until(async()=>quiet(await f.detail(manager.id))&&quiet(await f.detail(worker.id)),'owned work settled before restart');
      const before=[await f.detail(manager.id),await f.detail(worker.id)];
      await f.reopen();
      await until(async()=>(await reconciliation(f,chat)).body.ok,'startup completed passive metadata repair');
      const afterRestart=[await f.detail(manager.id),await f.detail(worker.id)];
      for(let i=0;i<2;i++) {
        assert.deepEqual(afterRestart[i].runs.map(r=>r.id),before[i].runs.map(r=>r.id));
        assert.deepEqual(afterRestart[i].coordinationV3.requests,before[i].coordinationV3.requests);
        assert.deepEqual(afterRestart[i].coordinationV3.activations,before[i].coordinationV3.activations);
      }
      await f.reopen();
    }
    const report=await reconciliation(f,chat);assert.equal(report.status,200);assert.equal(report.body.ok,true);
    for(const agent of [manager,worker]) {
      const messages=(await f.detail(agent.id)).messages.filter(m=>m.communicationEventId===eventId);
      assert.equal(messages.length,1);assert.equal(messages[0].text,text);
    }
    assert.equal((await f.detail(unrelated.id)).messages.some(m=>m.communicationEventId===eventId),false);
    const team=f.ok(await f.api('GET',`/api/conversations/${chat.id}/collaboration`));
    assert.equal(team.messages.filter(m=>m.communicationEventId===eventId||m.id===eventId).length,1);
    const main=f.ok(await f.api('GET',`/api/conversations/${chat.id}`));
    assert.equal(main.messages.some(m=>m.communicationEventId===eventId||m.text===text),false);
    const records=async file=>(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const projectDir=path.join(f.dataDir,'projects',chat.projectId);
    assert.equal((await records(path.join(projectDir,'message-dispatches.jsonl'))).filter(row=>row.eventId===eventId).length,1);
    for(const agent of [manager,worker])assert.equal((await records(path.join(projectDir,'agents',agent.id,'events.jsonl')))
      .filter(row=>row.event.type==='communication_projection'&&row.event.communicationEventId===eventId).length,1,'Recovery duplicated durable Agent audit history');
  },{diagnosticProvider:engine==='claude'}));
}

test('an exact route replay repairs an answer older than the100-update inspector window',options,t=>withFixture(t,async f=>{
  const chat=await f.createChat('Historical handoff replay');
  const manager=await f.createIdleAgent(chat,'Manager'),worker=await f.createIdleAgent(chat,'Worker');
  const managerSession=await f.hold(manager.id);f.plans.set(worker.id,[{hold:true}]);
  const requestId=f.ok(await f.tool(managerSession,'ponderosa_coordinate',{
    idempotencyKey:randomUUID(),requests:[{recipientAgentId:worker.id,text:'Controlled question',lifetime:{kind:'indefinite'}}],
  })).requestIds[0];
  await until(()=>f.sessions.has(worker.id),'worker Request');
  const managerRunId=(await f.detail(manager.id)).coordinationV3.activeRun.id;
  const questionId=randomUUID();
  f.ok(await f.tool(f.sessions.get(worker.id),'ponderosa_update_request',{requestId,updateId:questionId,kind:'question',text:'Exact question'}));
  const sqlite=new Database(path.join(f.dataDir,'ponderosa.db'),{readonly:true});
  try {
    const attached=sqlite.prepare(`
      SELECT 1 FROM scheduler_run_activations attachment
      JOIN scheduler_runs run ON run.id=attachment.run_id
      JOIN agent_activations activation ON activation.id=attachment.activation_id
      JOIN activation_sources source ON source.activation_id=activation.id
      JOIN coordination_request_updates request_update ON request_update.id=source.source_id
      WHERE run.id=? AND run.agent_id=? AND run.status='running'
        AND activation.agent_id=run.agent_id AND source.source_kind='request_update'
        AND request_update.id=? AND request_update.request_id=?
    `);
    await until(()=>attached.get(managerRunId,manager.id,questionId,requestId),
      'exact question Activation attached to the held manager Run');
  } finally {sqlite.close();}
  const updateId=randomUUID(),eventId=requestUpdateCommunicationEventId(chat.projectId,requestId,updateId);
  const update={requestId,updateId,kind:'answer',text:'Exact historical answer',inReplyToUpdateId:questionId};
  const original=AgentStore.prototype.appendCommunicationEvent;let injected=false;
  AgentStore.prototype.appendCommunicationEvent=function(event){
    const result=original.call(this,event);
    if(event.eventId===eventId&&!injected){
      injected=true;const v3=new CoordinationV3Store(this.sqlite);
      // Canonical later updates advance the real bounded read model. They
      // deliberately do not create any additional passive Communication.
      for(let i=0;i<105;i++)v3.updateRequest({requestId,updateId:randomUUID(),kind:'progress',actor:{kind:'agent',id:worker.id},
        payload:{text:'Later controlled progress'},now:new Date(Date.now()+1000+i).toISOString()});
      assert.equal(v3.requestLifecycleDetails({projectId:chat.projectId,conversationId:chat.id,recordId:requestId}).updates.some(u=>u.id===updateId),false);
      throw Error('Controlled interruption after canonical answer');
    }
    return result;
  };
  let accepted;try{accepted=f.ok(await f.tool(managerSession,'ponderosa_update_request',update));}
  finally{AgentStore.prototype.appendCommunicationEvent=original;}
  assert.equal(injected,true);assert.equal(accepted.recovering,true);
  assert.equal((await reconciliation(f,chat)).body.missingProjectionMetadataEventIds.includes(eventId),true);
  const replay=f.ok(await f.tool(managerSession,'ponderosa_update_request',update));
  assert.equal(replay.replayed,true);assert.equal(replay.recovering,undefined);
  assert.equal((await reconciliation(f,chat)).body.ok,true);
  for(const agent of [manager,worker])assert.equal((await f.detail(agent.id)).messages.filter(m=>m.communicationEventId===eventId).length,1);
}));

async function withCanonicalHandoff(run) {
  const root=await mkdtemp(path.join(tmpdir(),'ponderosa-passive-recovery-'));
  const hostPath=path.join(root,'work');await mkdir(hostPath);
  const store=new AgentStore(path.join(root,'data'));
  try {
    const coordinationV3=new CoordinationV3Store(store.sqlite);
    const project=store.createProject({label:'Canonical passive fixture',hostPath,defaultEngine:'codex'});
    const chat=store.createConversation(project.id,{title:'Exact Request scope'});
    const manager=store.createAgent(project.id,{title:'Manager',engine:'codex',conversationId:chat.id});
    const worker=store.createAgent(project.id,{title:'Worker',engine:'codex',conversationId:chat.id});
    const outsider=store.createAgent(project.id,{title:'Unrelated',engine:'codex',conversationId:chat.id});
    const requestId=randomUUID(),questionId=randomUUID(),updateId=randomUUID();
    coordinationV3.coordinate({projectId:project.id,conversationId:chat.id,requesterAgentId:manager.id,
      actorScope:'user:local-operator',idempotencyKey:randomUUID(),requests:[{requestId,recipientAgentId:worker.id,lifetime:{kind:'indefinite'},payload:{text:'Question fixture'}}]});
    coordinationV3.updateRequest({requestId,updateId:questionId,kind:'question',actor:{kind:'agent',id:worker.id},payload:{text:'Exact question'},now:'2026-10-01T00:00:00.000Z'});
    const at='2026-10-01T00:00:01.000Z',text='Exact canonical answer';
    coordinationV3.updateRequest({requestId,updateId,kind:'answer',inReplyToUpdateId:questionId,actor:{kind:'agent',id:manager.id},payload:{text},now:at});
    const event={schemaVersion:2,eventId:requestUpdateCommunicationEventId(project.id,requestId,updateId),projectId:project.id,
      conversationId:chat.id,sender:{kind:'agent',agentId:manager.id},intent:'collaboration',audience:{kind:'agents',agentIds:[worker.id]},
      text,createdAt:at,correlationId:requestId,idempotencyKey:`request-update:${requestId}:${updateId}`};
    const fences={project:false,chat:false,agents:new Set()};
    const service=createAgentEventService({store,coordinationV3,subscribers:new Map(),recordCommunication:()=>{throw Error('Recovery created Communication');},
      refreshProviderUsageAfterRun(){},appendWorkspace(){},notifyScheduler(){throw Error('Recovery woke scheduler');},isClosed:()=>false,publishCoordinationV3Changed(){}});
    const context={store,coordinationV3,projectDeletionInProgress:()=>fences.project,conversationDeletionInProgress:()=>fences.chat,
      agentDeletionInProgress:id=>fences.agents.has(id),projectCommunicationToAgentAudit:service.projectCommunicationToAgentAudit};
    const counts=()=>['coordination_requests','coordination_request_updates','agent_activations','scheduler_runs','runtime_communications']
      .map(table=>store.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n);
    await run({store,coordinationV3,project,chat,manager,worker,outsider,requestId,updateId,event,context,fences,counts});
  } finally {store.close();await rm(root,{recursive:true,force:true});}
}

test('old passive handoff recovery uses its exact canonical update outside the100-update UI window',options,()=>withCanonicalHandoff(async x=>{
  x.store.appendCommunicationEvent(x.event);
  for(let i=0;i<105;i++)x.coordinationV3.updateRequest({requestId:x.requestId,updateId:randomUUID(),kind:'progress',actor:{kind:'agent',id:x.worker.id},payload:{text:'Later progress'},now:new Date(Date.UTC(2026,9,1,0,1,i)).toISOString()});
  assert.equal(x.coordinationV3.requestLifecycleDetails({projectId:x.project.id,conversationId:x.chat.id,recordId:x.requestId}).updates.some(u=>u.id===x.updateId),false);
  const before=x.counts();assert.equal(materializeRequestUpdateCommunication(x.context,x.event),3);
  assert.equal(materializeRequestUpdateCommunication(x.context,x.event),0);
  assert.deepEqual(x.counts(),before);assert.equal(x.store.readCommunicationEvents(x.project.id).length,1);
  assert.equal(x.store.reconcileCommunicationEvents(x.project.id).ok,true);
}));

for(const field of ['text','sender','audience','createdAt','idempotencyKey','causationId','conversationId','projectId']) {
  test(`ambiguous passive ${field} cannot create projection metadata`,options,()=>withCanonicalHandoff(async x=>{
    const otherProject=field==='projectId'?x.store.createProject({label:'Different Project',hostPath:x.project.hostPath,defaultEngine:'codex'}):undefined;
    const otherChat=['conversationId','projectId'].includes(field)?x.store.createConversation(otherProject?.id??x.project.id,{title:'Different scope'}):undefined;
    const otherAgents=otherChat?['Sender','Recipient'].map(title=>x.store.createAgent(otherChat.projectId,{title,engine:'codex',conversationId:otherChat.id})):undefined;
    const scope=otherChat?{projectId:otherChat.projectId,conversationId:otherChat.id,
      sender:{kind:'agent',agentId:otherAgents[0].id},audience:{kind:'agents',agentIds:[otherAgents[1].id]},
      eventId:requestUpdateCommunicationEventId(otherChat.projectId,x.requestId,x.updateId)}:undefined;
    const event={...x.event,...({text:{text:'Not the canonical answer'},sender:{sender:{kind:'agent',agentId:x.outsider.id}},
      audience:{audience:{kind:'agents',agentIds:[x.outsider.id]}},createdAt:{createdAt:'2026-10-02T00:00:00.000Z'},
      idempotencyKey:{idempotencyKey:'not-a-request-update'},causationId:{causationId:'unrelated-source'},
      conversationId:scope,projectId:scope}[field])};
    x.store.appendCommunicationEvent(event);const before=x.counts();
    assert.equal(materializeRequestUpdateCommunication(x.context,event),0);assert.deepEqual(x.counts(),before);
    assert.ok(x.store.readCommunicationProjections(event.projectId).every(p=>!p.message));
  }));
}

test('deletion fences keep passive history out of blocked Projects, Chats and Agent audit targets',options,()=>withCanonicalHandoff(async x=>{
  x.store.appendCommunicationEvent(x.event);
  x.fences.project=true;assert.equal(materializeRequestUpdateCommunication(x.context,x.event),0);
  x.fences.project=false;x.fences.chat=true;assert.equal(materializeRequestUpdateCommunication(x.context,x.event),0);
  x.fences.chat=false;x.fences.agents.add(x.worker.id);
  assert.equal(materializeRequestUpdateCommunication(x.context,x.event),2);
  assert.equal(x.store.getCommunicationProjection(x.project.id,x.event.eventId,'direct_agent_audit',x.worker.id).message,undefined);
  assert.equal(x.store.getProjectedAgentMessages(x.outsider.id).length,0);
}));

test('filtered recovery cannot restore a durable audit into a newly fenced Agent',options,()=>withCanonicalHandoff(async x=>{
  x.store.appendCommunicationEvent(x.event);
  const original=x.store.appendCommunicationProjection.bind(x.store);let injected=false;
  x.store.appendCommunicationProjection=(projectId,projection)=>{
    if(!injected&&projection.surface==='direct_agent_audit'&&projection.projectionKey===x.manager.id&&projection.message){
      injected=true;throw Error('Controlled audit metadata failure');
    }
    return original(projectId,projection);
  };
  assert.throws(()=>materializeRequestUpdateCommunication(x.context,x.event),/Controlled audit metadata/);
  x.store.appendCommunicationProjection=original;x.fences.agents.add(x.manager.id);
  let rebuilds=0;
  const recover=(event,agentIds)=>{
    rebuilds++;assert.equal(agentIds.includes(x.manager.id),false);
    x.store.ensureCommunicationProjectionLedger(event.projectId,{eventIds:new Set([event.eventId]),agentIds:new Set(agentIds)});
  };
  assert.equal(materializeRequestUpdateCommunication(x.context,x.event,recover),1);
  assert.equal(rebuilds,1);
  assert.equal(x.store.getCommunicationProjection(x.project.id,x.event.eventId,'direct_agent_audit',x.manager.id).message,undefined);
  assert.equal(x.store.getProjectedAgentMessages(x.worker.id).filter(m=>m.communicationEventId===x.event.eventId).length,1);
  assert.equal(materializeRequestUpdateCommunication(x.context,x.event,()=>{throw Error('No-op recovery rebuilt history');}),0);
}));

test('deleted Agents are never recreated by passive handoff recovery',options,()=>withCanonicalHandoff(async x=>{
  x.store.appendCommunicationEvent(x.event);assert.equal(x.store.deleteAgent(x.worker.id),true);
  assert.equal(materializeRequestUpdateCommunication(x.context,x.event),2);
  assert.equal(x.store.getAgent(x.worker.id),undefined);
  assert.equal(x.store.getCommunicationProjection(x.project.id,x.event.eventId,'direct_agent_audit',x.worker.id)?.message,undefined);
}));


test('partial Chat metadata rebuild is retried before another passive handoff can append an audit',options,()=>withCanonicalHandoff(async x=>{
  const nextQuestionId=randomUUID(),nextUpdateId=randomUUID();
  x.coordinationV3.updateRequest({requestId:x.requestId,updateId:nextQuestionId,kind:'question',
    actor:{kind:'agent',id:x.worker.id},payload:{text:'Second canonical question'},now:'2026-10-01T00:00:02.000Z'});
  x.coordinationV3.updateRequest({requestId:x.requestId,updateId:nextUpdateId,kind:'answer',inReplyToUpdateId:nextQuestionId,
    actor:{kind:'agent',id:x.manager.id},payload:{text:'Second canonical answer'},now:'2026-10-01T00:00:03.000Z'});
  const second={...x.event,eventId:requestUpdateCommunicationEventId(x.project.id,x.requestId,nextUpdateId),
    text:'Second canonical answer',createdAt:'2026-10-01T00:00:03.000Z',idempotencyKey:`request-update:${x.requestId}:${nextUpdateId}`};
  const events=[x.event,second],originalProjection=x.store.appendCommunicationProjection.bind(x.store);
  for(const event of events){
    x.store.appendCommunicationEvent(event);
    x.store.appendCommunicationProjection=(projectId,projection)=>{
      if(projection.eventId===event.eventId&&projection.surface==='direct_agent_audit'&&projection.projectionKey===x.manager.id&&projection.message)
        throw Error('Controlled missing metadata after durable author audit');
      return originalProjection(projectId,projection);
    };
    assert.throws(()=>materializeRequestUpdateCommunication(x.context,event),/Controlled missing metadata/);
  }
  x.store.appendCommunicationProjection=originalProjection;
  const rawCounts=()=>events.map(event=>x.store.readEvents(x.manager.id)
    .filter(row=>row.event.type==='communication_projection'&&row.event.communicationEventId===event.eventId).length);
  assert.deepEqual(rawCounts(),[1,1]);
  const originalLedger=x.store.ensureCommunicationProjectionLedger.bind(x.store);let rebuilds=0;
  x.store.ensureCommunicationProjectionLedger=(projectId,filter)=>{
    rebuilds++;
    if(rebuilds===1){
      // One event's durable metadata is restored, then the Project pass fails.
      originalLedger(projectId,{...filter,eventIds:new Set([x.event.eventId])});
      throw Error('Controlled partial Project metadata rebuild');
    }
    return originalLedger(projectId,filter);
  };
  const unexpected=()=>{throw Error('Passive recovery invoked unrelated authority');};
  const reconciler=createCommunicationProjectionReconciler({...x.context,assets:{},
    attachmentDeletionInProgress:()=>false,assetReconciliationInProgress:()=>false,
    conversationDeliveryLeases:new Map(),agentDeliveryLeases:new Map(),recordCommunication:unexpected,
    projectCommunicationArtifact:unexpected,communicationArtifactAccess:unexpected,
    scheduleCommunicationReconciliation(){},logError(){},logInfo(){}});
  const filter={projectId:x.project.id,conversationId:x.chat.id},before=x.counts();
  await assert.rejects(reconciler.reconcileRuntimeCommunicationProjections(filter),/recovery is incomplete/);
  assert.equal(rebuilds,2,'A failed Project rebuild must not suppress the next event recovery');
  assert.deepEqual(rawCounts(),[1,1],'A later event duplicated an already durable author audit');
  await reconciler.reconcileRuntimeCommunicationProjections(filter);
  await reconciler.reconcileRuntimeCommunicationProjections(filter);
  assert.deepEqual(rawCounts(),[1,1]);assert.deepEqual(x.counts(),before);
  assert.equal(x.store.reconcileCommunicationEvents(x.project.id).ok,true);
  for(const event of events){
    for(const agent of [x.manager,x.worker])assert.equal(x.store.getProjectedAgentMessages(agent.id).filter(row=>row.communicationEventId===event.eventId).length,1);
    assert.ok(x.store.getProjectedConversationMessageById(x.chat.id,'collaboration',event.eventId));
    assert.equal(x.store.getProjectedConversationMessageById(x.chat.id,'main',event.eventId),undefined);
  }
}));


test('a no-op passive replay refreshes cached drift after a completed metadata write loses its acknowledgement',options,t=>withFixture(t,async f=>{
  const chat=await f.createChat('Post-write recovery cache');
  const manager=await f.createIdleAgent(chat,'Manager'),worker=await f.createIdleAgent(chat,'Worker');
  const managerSession=await f.hold(manager.id);f.plans.set(worker.id,[{hold:true}]);
  const requestId=f.ok(await f.tool(managerSession,'ponderosa_coordinate',{
    idempotencyKey:randomUUID(),requests:[{recipientAgentId:worker.id,text:'Controlled cached recovery',lifetime:{kind:'indefinite'}}],
  })).requestIds[0];
  await until(()=>f.sessions.has(worker.id),'worker Request');
  const updateId=randomUUID(),eventId=requestUpdateCommunicationEventId(chat.projectId,requestId,updateId);
  const update={requestId,updateId,kind:'completed',text:'Exact cached recovery result'};
  const originalPlacement=AgentStore.prototype.appendConversationMessage;
  let ownedStore,canonicalFailure=false;
  AgentStore.prototype.appendConversationMessage=function(...args){
    if(args[6]===eventId&&!canonicalFailure){ownedStore=this;canonicalFailure=true;throw Error('Controlled interruption before Team placement');}
    return originalPlacement.apply(this,args);
  };
  let initial;try{initial=f.ok(await f.tool(f.sessions.get(worker.id),'ponderosa_update_request',update));}
  finally{AgentStore.prototype.appendConversationMessage=originalPlacement;}
  assert.equal(canonicalFailure,true);assert.equal(initial.recovering,true);
  const cachedMigration=async()=>(await f.api('GET','/api/ready')).body.checks.communicationMigration;
  // Observe the existing scheduled verifier's red result, rather than using
  // the diagnostic GET that would itself mutate the cached evidence.
  await until(async()=>/projections=drift/.test((await cachedMigration()).detail),'initial cached drift is verified');
  const originalProjection=AgentStore.prototype.appendCommunicationProjection;
  let postwriteFailure=false;
  AgentStore.prototype.appendCommunicationProjection=function(projectId,projection){
    const result=originalProjection.call(this,projectId,projection);
    if(!postwriteFailure&&projection.eventId===eventId&&projection.surface==='direct_agent_audit'&&
      projection.projectionKey===manager.id&&projection.message){
      postwriteFailure=true;throw Error('Controlled lost acknowledgement after last metadata write');
    }
    return result;
  };
  let restored;try{restored=f.ok(await f.tool(f.sessions.get(worker.id),'ponderosa_update_request',update));}
  finally{AgentStore.prototype.appendCommunicationProjection=originalProjection;}
  assert.equal(postwriteFailure,true);assert.equal(restored.recovering,true);
  assert.ok(ownedStore.getProjectedConversationMessageById(chat.id,'collaboration',eventId));
  for(const agent of [manager,worker])assert.notEqual(ownedStore.getCommunicationProjection(chat.projectId,eventId,'direct_agent_audit',agent.id)?.message?.sequence,undefined);
  assert.match((await cachedMigration()).detail,/projections=drift/,'The post-write failure left verified-red cached evidence');
  const originalLedger=AgentStore.prototype.ensureCommunicationProjectionLedger;
  AgentStore.prototype.ensureCommunicationProjectionLedger=()=>{throw Error('A complete metadata replay rebuilt history');};
  let replay;try{replay=f.ok(await f.tool(f.sessions.get(worker.id),'ponderosa_update_request',update));}
  finally{AgentStore.prototype.ensureCommunicationProjectionLedger=originalLedger;}
  assert.equal(replay.replayed,true);assert.equal(replay.recovering,undefined);
  await until(async()=>(await cachedMigration()).ok,'a true no-op replay refreshes cached drift without a diagnostic GET');
}));
