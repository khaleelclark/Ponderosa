import {registerRequestSecurityHooks} from "../../apps/server/dist/server-request-hooks.js";
import {withAgentImportAdmission} from "../../apps/server/dist/agent-package-codec.js";
import {request as httpRequest} from "node:http";
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash, randomFillSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile, readFile, chmod, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { CapabilityPolicyStore, WorkspaceStore, AgentStore, publishManagedArtifactContentAsync, readManagedArtifactContent, importedAgentHistoryPath } from '@ponderosa/agents';
import { CAPABILITY_IDS, AGENT_PACKAGE_MAX_BYTES, deriveCommunicationBehavior } from '@ponderosa/core';
import { AssetStore } from '../../apps/server/dist/assets.js';
import {AgentWorkingCopyService} from '../../apps/server/dist/agent-working-copy-service.js';
import { registerAgentPackageRoutes } from '../../apps/server/dist/routes/agent-packages.js';

// Reconciled from the October 16 17-assertion review. Actual routes/SQLite and
// managed bytes, with no listener, scheduler, provider session or user profile.
async function withPortability(t, run, requestLimits={handlerDeadlineMs:20,packageHandlerDeadlineMs:10000}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ponderosa-portability-'));
  let store, assets, app, packageEngine,workspace, passed = false;
  const open = () => {
    store = new AgentStore(dataDir);workspace=new WorkspaceStore(dataDir); assets = new AssetStore(dataDir); app = Fastify();
    registerRequestSecurityHooks(app,{opts:{requestLimits:{maxRequestsPerMinute:100000,maxInflight:128,...requestLimits}},v3DispatchKey:'fixture',agentMessageCapabilities:new Map(),deletingAgentIds:new Set(),validLauncherSession:()=>false,artifactFilesystemError:()=>undefined,isArtifactDependentWorkIntake:()=>false,isPublicWebAssetRequest:()=>false});
    ({packageEngine}=registerAgentPackageRoutes(app, {
      dataDir, store, workspace, assets, workingCopies:new AgentWorkingCopyService(dataDir,store),
      coordination: { runtimeArtifact: () => undefined, handleAgentDeletion() {} },
      engines: new Map([['codex', { adapter: { id: 'codex', listModels: () => [], listEfforts: () => [] } }]]),
      deletingProjectIds: new Set(), deletingConversationIds: new Set(), deletingAgentIds: new Set(),
      agentCreationConversationLeases: new Map(), cachedModelOptions: () => [], appendWorkspace() {},
      agentMessages: id => store.getProjectedAgentMessages(id), createOperationalNotification() {},
    }));
  };
  const close = async () => { await app?.close(); assets?.close();workspace?.close(); store?.close(); };
  try {
    open();
    const project = store.createProject({ label: 'Portability fixture', hostPath: dataDir, defaultEngine: 'codex' });
    const chat = store.createConversation(project.id, { title: 'Source' });
    const destination = store.createConversation(project.id, { title: 'Destination' });
    const artifactId = randomUUID(), guidance = `INITIAL_GUIDANCE ponderosa://artifact/${artifactId}`;
    const a = store.createAgent(project.id, { title: 'Manager', engine: 'codex', conversationId: chat.id }, undefined, undefined,
      { id: randomUUID(), name: 'Fixture preset', description: 'Guidance', guidance, engine: 'codex' });
    const b = store.createAgent(project.id, { title: 'Worker', engine: 'codex', conversationId: chat.id, managerAgentId: a.id });
    const outside = store.createAgent(project.id, { title: 'Outside', engine: 'codex', conversationId: chat.id });
    let sequence = 0;
    function communication(sender, intent, audience, text, extra = {}) {
      const event = { schemaVersion: 2, eventId: randomUUID(), projectId: project.id, conversationId: chat.id,
        sender, intent, audience, text, createdAt: new Date().toISOString(), ...extra };
      store.appendCommunicationEvent(event);
      for (const target of deriveCommunicationBehavior(event).projectionTargets) {
        store.appendCommunicationProjection(project.id, { eventId: event.eventId, ...target,
          projectedAt: event.createdAt, message: { messageId: randomUUID(), role: sender.kind === 'user' ? 'user' : 'assistant',
            createdAt: event.createdAt, sequence: ++sequence, ...(extra.attachments ? { attachments: extra.attachments } : {}) } });
      }
      return event;
    }
    const collaboration = communication({ kind: 'agent', agentId: a.id, executionId: randomUUID() }, 'collaboration',
      { kind: 'agents', agentIds: [b.id] }, 'COLLABORATION_MARKER');
    const upload=await assets.stage({projectId:project.id,agentId:a.id,name:'upload.txt',declaredType:'text/plain',body:Buffer.from('hello')});
    await assets.associate(project.id,a.id,[upload.id]);
    communication({ kind: 'user', userId: 'operator' }, 'user_dm',
      { kind: 'user_agent', userId: 'operator', agentId: a.id }, 'PRIVATE_DM_MARKER', {attachments:[upload]});
    communication({ kind: 'user', userId: 'operator' }, 'user_dm',
      { kind: 'user_agent', userId: 'operator', agentId: outside.id }, 'UNRELATED_PRIVATE_MARKER');
    communication({ kind: 'user', userId: 'operator' }, 'broadcast',
      { kind: 'organization', organizationId: project.id }, 'BROADCAST_WITHOUT_AGENT_PROJECTION');
    store.setImportedHistory(a.id, 'Prior import', [{ role: 'assistant', text: 'PRIOR_HISTORY_MARKER' }]);
    const bytes = Buffer.from('managed bytes');
    await publishManagedArtifactContentAsync(dataDir, project.id, artifactId, bytes);
    store.recordProjectArtifact({ id: artifactId, projectId: project.id, agentId: a.id, originAgentId: a.id,
      kind: 'document', path: 'managed.txt', summary: 'Managed fixture document', createdAt: new Date().toISOString(), size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'text/plain' });
    await writeFile(path.join(dataDir, 'unmanaged-working-file.txt'), 'UNMANAGED_FILE_MARKER');
    const request = input => app.inject(input);
    const ok = response => { assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body); return response.json(); };
    const exportAgent = async (id, mode = 'full') => ok(await request({ method: 'GET', url: `/api/agents/${id}/export?mode=${mode}&organization=true` }));
    const copyRequest = (id, key, mode = 'full') => ({ method: 'POST', url: `/api/projects/${project.id}/copy-agent`,
      headers: { 'idempotency-key': key }, payload: { sourceAgentId: id, conversationId: destination.id, organization: true, mode } });
    const copy = async (id, key = randomUUID(), mode = 'full') => ok(await request(copyRequest(id, key, mode)));
    const importRequest = (pkg, key = randomUUID(), extra = {}) => ({ method: 'POST', url: `/api/projects/${project.id}/import-agents`,
      headers: { 'idempotency-key': key }, payload: { package: pkg, conversationId: destination.id, engineMapping: { codex: 'codex' }, ...extra } });
    const projection = id => store.sqlite.prepare('SELECT role, text, source_kind AS sourceKind, created_at AS createdAt FROM imported_history_messages WHERE agent_id = ? ORDER BY sequence').all(id);
    await run({ dataDir, project, chat, destination, a, b, outside, artifactId, guidance, bytes, collaboration, request, ok,
      exportAgent, copy, copyRequest, importRequest, projection, get workspace(){return workspace;}, get packageEngine() { return packageEngine; }, get assets() { return assets; }, get store() { return store; }, get app(){return app;},
      async restart() { await close(); open(); await app.ready(); } });
    passed = true;
  } finally {
    await close();
    if (passed) await rm(dataDir, { recursive: true, force: true });
    else t.diagnostic(`Failed disposable fixture retained: ${dataDir}`);
  }
}
const options = { timeout: 30_000 };
const synthetic = rows => rows.filter(x => x.sourceKind === 'guidance');

test('full organization round trips retain the reviewed contracts and one guidance projection across three generations', options, t => withPortability(t, async f => {
  const pkg = await f.exportAgent(f.a.id);
  assert.equal(pkg.schema, 'ponderosa.agent-package.v1');
  assert.deepEqual(pkg.agents.map(x => x.ref).sort(), [f.a.id, f.b.id].sort());
  assert.equal(pkg.agents.find(x => x.ref === f.b.id).managerRef, f.a.id);
  assert.deepEqual(pkg.agents.map(x => x.history.some(m => m.text === f.collaboration.text)), [true, true]);
  assert.deepEqual(pkg.agents[0].history.find(x => x.text === f.collaboration.text).communication, f.collaboration);
  for (const excluded of ['UNRELATED_PRIVATE_MARKER', 'UNMANAGED_FILE_MARKER']) assert.equal(JSON.stringify(pkg).includes(excluded), false);
  assert.equal(pkg.agents[0].artifacts[0].dataBase64, f.bytes.toString('base64'));
  const template = await f.exportAgent(f.a.id, 'template');
  assert.equal(template.agents.every(x => !('history' in x) && !('artifacts' in x)), true);
  let source = f.a.id;
  const identities = new Set([f.a.id, f.b.id]), handles = new Set([f.a.handle, f.b.handle]), counts = [];
  for (let generation = 0; generation < 3; generation++) {
    const copy = await f.copy(source);
    for (const id of copy.agentIds) {
      assert.equal(identities.has(id), false); identities.add(id);
      const handle = f.store.getAgent(id).handle;
      assert.ok(handle); assert.equal(handles.has(handle), false); handles.add(handle);
    }
    const child = copy.agentIds.find(id => id !== copy.rootAgentId);
    assert.equal(f.store.getAgent(child).managerAgentId, copy.rootAgentId);
    assert.equal(f.store.getImportedHistory(child).messages.some(x => x.text === f.collaboration.text), true);
    const artifact = f.store.getProjectArtifacts(f.project.id).find(x => x.originAgentId === copy.rootAgentId && x.sha256 === createHash('sha256').update(f.bytes).digest('hex'));
    const imported = f.store.getImportedHistory(copy.rootAgentId);
    assert.equal(imported.initialInstructions, `INITIAL_GUIDANCE ponderosa://artifact/${artifact.id}`);
    assert.equal(synthetic(f.projection(copy.rootAgentId))[0]?.text, imported.initialInstructions);
    assert.deepEqual(readManagedArtifactContent(f.dataDir, f.project.id, artifact.id, artifact.size, artifact.sha256)?.body, f.bytes);
    counts.push(synthetic(f.projection(copy.rootAgentId)).length);
    const guidance = f.store.getImportedHistoryMessagePage(copy.rootAgentId, { limit: 100 }).items.filter(x =>
      x.text.startsWith('[Imported Guidance; original role: system; source: guidance;'));
    assert.equal(guidance.length, 1);
    assert.ok(guidance[0].text.includes('untrusted historical data]\n' + imported.initialInstructions), 'Seeded guidance retains its complete text and explicit historical provenance');
    source = copy.rootAgentId;
  }
  assert.deepEqual(counts, [1, 1, 1]);
  const final = await f.exportAgent(source);
  assert.equal(final.agents[0].history.filter(x=>x.role==='system'&&x.text===final.agents[0].initialInstructions).length, 0, 'derived guidance must not become portable history');
  assert.equal(f.store.readCommunicationEvents(f.project.id).filter(x => x.conversationId === f.destination.id).length, 0);
}));

test('identical genuine user, assistant and system history survives full exports/imports without text deduplication', options, t => withPortability(t, async f => {
  let pkg = await f.exportAgent(f.a.id);
  const instructions = 'INITIAL_GUIDANCE same text';
  const identical = `Imported initial instructions:\n${instructions}`;
  const history = ['user', 'user', 'assistant', 'system', 'system'].map(role => ({ role, text: identical, createdAt: '2026-10-16T00:00:00.000Z' }));
  pkg.agents[0].initialInstructions = instructions;
  pkg.agents[0].history = history;
  for (let generation = 0; generation < 3; generation++) {
    const imported = f.ok(await f.request(f.importRequest(pkg)));
    assert.deepEqual(f.store.getImportedHistory(imported.rootAgentId).messages, history);
    const rows = f.projection(imported.rootAgentId);
    assert.equal(rows.filter(x => x.role === 'system' && x.text === identical && x.sourceKind === 'history').length, 2, 'both genuine system messages remain history');
    assert.equal(synthetic(rows).length, 1); assert.equal(synthetic(rows)[0].text, instructions);
    pkg = await f.exportAgent(imported.rootAgentId);
    assert.deepEqual(pkg.agents[0].history, history);
  }
}));

test('template imports retain setup guidance once without copying source history, managed bytes or Chat instructions', options, t => withPortability(t, async f => {
  f.store.updateConversation(f.chat.id, { instructions: 'Source Chat instructions' });
  const copy = await f.copy(f.a.id, randomUUID(), 'template');
  const imported = f.store.getImportedHistory(copy.rootAgentId);
  assert.equal(imported.initialInstructions, f.guidance);
  assert.deepEqual(imported.messages, []);
  assert.equal(f.projection(copy.rootAgentId).length, 1);
  assert.equal(f.store.getProjectArtifacts(f.project.id).some(x => x.originAgentId === copy.rootAgentId), false);
  assert.equal(f.store.getConversation(f.destination.id).instructions ?? '', '');
  const pkg = await f.exportAgent(copy.rootAgentId, 'template');
  assert.equal(pkg.agents[0].initialInstructions, f.guidance);
  assert.equal(pkg.agents.every(x => !x.history && !x.artifacts), true);
  assert.equal(pkg.sourceProjectInstructions, undefined);
}));

test('mapped imports and completed copy/import retries preserve identities and guidance after restart and projection rebuild', options, t => withPortability(t, async f => {
  const pkg = await f.exportAgent(f.a.id);
  for (const node of pkg.agents) node.engine = 'external';
  const input = f.importRequest(pkg, randomUUID(), { engineMapping: { external: 'codex' } });
  const imported = f.ok(await f.request(input));
  assert.ok(imported.agentIds.every(id => f.store.getAgent(id).activeEngine === 'codex'));
  const copyInput = f.copyRequest(imported.rootAgentId, randomUUID());
  const copied = f.ok(await f.request(copyInput));
  const before = f.projection(copied.rootAgentId);
  await f.restart();
  assert.deepEqual(f.ok(await f.request(input)), imported);
  assert.deepEqual(f.ok(await f.request(copyInput)), copied);
  assert.deepEqual(f.projection(copied.rootAgentId), before);
  f.store.rebuildProjections(); f.store.rebuildProjections();
  assert.deepEqual(f.projection(copied.rootAgentId), before);
  assert.equal(synthetic(before).length, 1);
  const changed = { ...input, payload: { ...input.payload, package: { ...pkg, sourceLabel: 'Different request' } } };
  assert.equal((await f.request(changed)).statusCode, 409);
  assert.deepEqual(f.projection(copied.rootAgentId), before);
}));

test('Chat-instruction conflicts still require a current explicit choice and do not mutate imported guidance', options, t => withPortability(t, async f => {
  f.store.updateConversation(f.chat.id, { instructions: 'Source instructions' });
  f.store.updateConversation(f.destination.id, { instructions: 'Destination instructions' });
  const pkg = await f.exportAgent(f.a.id);
  assert.equal(pkg.sourceProjectInstructions, 'Source instructions');
  assert.equal((await f.request(f.importRequest(pkg))).statusCode, 409);
  const resolution = { action: 'keep_destination', expectedDestinationSha256: createHash('sha256').update('Destination instructions').digest('hex') };
  const kept = f.ok(await f.request(f.importRequest(pkg, randomUUID(), { chatInstructionsResolution: resolution })));
  assert.equal(f.store.getConversation(f.destination.id).instructions, 'Destination instructions');
  assert.equal(synthetic(f.projection(kept.rootAgentId)).length, 1);
  const applied = f.ok(await f.request(f.importRequest(pkg, randomUUID(), { chatInstructionsResolution: { ...resolution, action: 'use_source' } })));
  assert.equal(f.store.getConversation(f.destination.id).instructions, 'Source instructions');
  assert.equal(synthetic(f.projection(applied.rootAgentId)).length, 1);
  assert.equal((await f.request(f.importRequest(pkg, randomUUID(), { chatInstructionsResolution: resolution }))).statusCode, 409);
}));

test('background import replays a lost completion acknowledgment after restart without importing guidance again', options, t => withPortability(t, async f => {
  const pkg = await f.exportAgent(f.a.id), key = randomUUID();
  const payload = JSON.stringify({ conversationId: f.destination.id, engineMapping: { codex: 'codex' } }) + '\n' + JSON.stringify(pkg);
  const input = { method: 'POST', url: `/api/projects/${f.project.id}/agent-import-operations`,
    headers: { 'idempotency-key': key, 'content-type': 'application/vnd.ponderosa.agent-import' }, payload };
  const queued = f.ok(await f.request(input));
  const statusUrl = `/api/projects/${f.project.id}/agent-import-operations/${queued.id}`;
  const settled = async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const operation = f.ok(await f.request({ method: 'GET', url: statusUrl }));
      if (operation.status !== 'pending') { assert.equal(operation.status, 'completed', JSON.stringify(operation)); return operation; }
      await delay(10);
    }
    assert.fail('background import did not settle');
  };
  const completed = await settled();
  const before = f.projection(completed.result.rootAgentId);
  // Model the durable boundary: canonical creation completed, acknowledgment
  // journal still pending with its original payload. Only this fixture is edited.
  const journal = path.join(f.dataDir, 'agent-import-operations', `${queued.id}.json`);
  const record = JSON.parse(await readFile(journal, 'utf8'));
  await writeFile(journal, JSON.stringify({ ...record, status: 'pending', phase: 'finalizing' }));
  await writeFile(path.join(f.dataDir, 'agent-import-operations', `${queued.id}.payload`), payload);
  await f.restart();
  const recovered = await settled();
  assert.deepEqual(recovered.result, completed.result);
  assert.equal(f.ok(await f.request(input)).id, queued.id);
  assert.deepEqual(f.projection(completed.result.rootAgentId), before);
  assert.equal(synthetic(before).length, 1);
}));


test('rebuilding existing current-format unmarked history preserves its exact entries without guessing their provenance', options, t => withPortability(t, async f => {
  const initialInstructions = 'INITIAL_GUIDANCE existing record';
  const file = importedAgentHistoryPath(f.dataDir, f.project.id, f.a.id);
  const imported = { source: 'Existing current-format import', importedAt: '2026-10-16T00:00:00.000Z', initialInstructions,
    messages: [{ role: 'system', text: `Imported initial instructions:\n${initialInstructions}` }] };
  const original = JSON.stringify(imported);
  await writeFile(file, original);
  f.store.rebuildProjections();
  assert.equal(f.projection(f.a.id).length, 1);
  assert.equal(await readFile(file, 'utf8'), original);
  await f.restart();
  f.store.rebuildProjections();
  assert.equal(f.projection(f.a.id).length, 1);
  assert.equal(await readFile(file, 'utf8'), original);
}));

test('complete separated guidance survives empty-history imports through both store writers', options, t => withPortability(t, async f => {
  const guidance = 'INITIAL_GUIDANCE ' + '雪\r\n🌲'.repeat(30_000) + 'TRAILING_GUIDANCE';
  f.store.setImportedHistory(f.b.id, 'Synchronous fixture', [], guidance);
  assert.ok(f.store.getImportedHistory(f.b.id).initialInstructions===guidance,'synchronous writer retains complete guidance');
  assert.equal(f.projection(f.b.id).length, 1);
  assert.ok(f.projection(f.b.id)[0].text===guidance,'derived guidance retains complete text');
  let pkg = await f.exportAgent(f.b.id, 'template');
  let imported = f.ok(await f.request(f.importRequest(pkg)));
  assert.deepEqual(f.store.getImportedHistory(imported.rootAgentId).messages, []);
  assert.ok(f.store.getImportedHistory(imported.rootAgentId).initialInstructions===guidance,'asynchronous writer retains complete guidance');
  assert.ok(f.projection(imported.rootAgentId)[0].text===guidance,'asynchronous projection retains complete guidance');
  pkg.agents[0].initialInstructions = '';
  imported = f.ok(await f.request(f.importRequest(pkg)));
  assert.equal(f.store.getImportedHistory(imported.rootAgentId).initialInstructions, '');
  assert.deepEqual(f.projection(imported.rootAgentId), []);
  pkg = await f.exportAgent(imported.rootAgentId, 'template');
  assert.equal(pkg.agents[0].initialInstructions, '');
}));

test('long history and guidance retain exact text through remapping and three full-copy generations', options, t => withPortability(t, async f => {
 const historyHash=history=>createHash('sha256').update(JSON.stringify(history)).digest('hex');
 const pkg=await f.exportAgent(f.a.id),node=pkg.agents[0],text='雪\r\n🌲'.repeat(25_000)+` [File](ponderosa://artifact/${f.artifactId}) TRAILING_HISTORY`;
 assert.ok(text.length>100000);node.initialInstructions=text;
 node.history=[{role:'user',text,createdAt:'2026-10-27T02:00:00+02:00'},{role:'user',text},{role:'system',text}];
 const imported=f.ok(await f.request(f.importRequest(pkg))),archive=f.store.getImportedHistory(imported.rootAgentId);
 const exactArtifact=agentId=>{const rows=f.store.getProjectArtifacts(f.project.id).filter(a=>a.originAgentId===agentId&&a.summary==='Managed fixture document'&&a.sha256===createHash('sha256').update(f.bytes).digest('hex'));assert.equal(rows.length,1,'The managed source document must map to exactly one destination artifact');return rows[0];};
 const artifact=exactArtifact(imported.rootAgentId),rewritten=text.replaceAll(f.artifactId,artifact.id);
 assert.ok(archive.initialInstructions===rewritten,'complete guidance rewrites only the artifact reference');
 assert.equal(historyHash(archive.messages),historyHash(node.history.map(message=>({...message,text:rewritten}))));
 const again=await f.exportAgent(imported.rootAgentId);
 assert.ok(again.agents[0].initialInstructions===rewritten);assert.equal(historyHash(again.agents[0].history),historyHash(archive.messages));
 await f.restart();assert.equal(historyHash(f.store.getImportedHistory(imported.rootAgentId).messages),historyHash(archive.messages));
 let source=imported.rootAgentId,currentArtifact=artifact.id,expected=rewritten;
 for(let generation=0;generation<3;generation++){
  const copied=await f.copy(source),mapped=exactArtifact(copied.rootAgentId);
  assert.ok(mapped,'Every full copy retains its managed artifact');
  expected=expected.replaceAll(currentArtifact,mapped.id);currentArtifact=mapped.id;
  const retained=f.store.getImportedHistory(copied.rootAgentId),history=node.history.map(message=>({...message,text:expected}));
  assert.ok(retained.initialInstructions===expected,'Each generation retains the complete >100k guidance, including its suffix');
  assert.equal(historyHash(retained.messages),historyHash(history),'Each generation preserves all long messages, duplicates, roles and optional timestamps');
  const guidance=synthetic(f.projection(copied.rootAgentId));assert.equal(guidance.length,1);assert.ok(guidance[0].text===expected,'Derived guidance remains complete and unique');
  const exported=await f.exportAgent(copied.rootAgentId);assert.ok(exported.agents[0].initialInstructions===expected);
  assert.equal(historyHash(exported.agents[0].history),historyHash(history));
  source=copied.rootAgentId;
  if(generation===1){await f.restart();f.store.rebuildProjections();assert.ok(f.store.getImportedHistory(source).initialInstructions===expected,'Restart and rebuild retain the copied guidance');}
 }
}));

test('organization import and copy preserve each member’s private history and retrieval identity after restart',options,t=>withPortability(t,async f=>{
 const markers=['LEADPRIVATESUNRISE','WORKERPRIVATEHARVEST','SIBLINGPRIVATERIVER'],roles=['user','assistant','system'];
 const members=markers.map((marker,index)=>({ref:`private${index}`,title:`Private member ${index}`,engine:'codex',
  managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},
  ...(index?{managerRef:'private0'}:{}),history:[{role:roles[index],text:`${marker} retained private transcript ${index}`}]}));
 const pkg={schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Separate private histories',rootRef:'private0',agents:members};
 const check=async result=>{
  const owners=new Map(result.agentIds.map(id=>[f.store.getAgent(id).title,id])),archives=new Map(),hits=new Map();
  assert.equal(owners.size,members.length);
  for(const member of members){
   const id=owners.get(member.title);assert.ok(id);const archived=f.store.getImportedHistory(id);assert.deepEqual(archived.messages,member.history);
   assert.equal(f.store.getAgent(id).managerAgentId,member.ref===pkg.rootRef?undefined:result.rootAgentId);
   const deadline=Date.now()+10000;let availability;
   do{availability=f.store.getImportedHistoryAvailability(id);if(availability.status==='ready')break;assert.notEqual(availability.status,'unavailable');await delay(10)}while(Date.now()<deadline);
   assert.equal(availability.status,'ready','Each complete private archive must become searchable');archives.set(id,availability.archiveVersion);
   const found=f.store.searchImportedHistory({agentId:id,archiveVersion:availability.archiveVersion,query:markers[members.indexOf(member)]}).response;
   assert.equal(found.hits.length,1);assert.equal(found.hits[0].role,member.history[0].role);assert.equal(found.hits[0].sourceLabel,'Imported History');hits.set(id,found.hits[0]);
  }
  for(const [title,id] of owners){
   const archiveVersion=archives.get(id),own=members.find(member=>member.title===title);
   const exact=f.store.readImportedHistory({agentId:id,archiveVersion,reference:hits.get(id).reference}).response;
   assert.equal(exact.messages[exact.requestedMessageIndex].text,own.history[0].text);
   for(const member of members.filter(member=>member.title!==title)){
    const foreignId=owners.get(member.title),foreign=hits.get(foreignId);
    assert.equal(f.store.searchImportedHistory({agentId:id,archiveVersion,query:markers[members.indexOf(member)]}).response.noMatch,true,'Managers, organization roots and siblings do not inherit member archives');
    assert.throws(()=>f.store.readImportedHistory({agentId:id,archiveVersion,reference:foreign.reference}),/reference|archive/);
   }
  }
 };
 const imported=f.ok(await f.request(f.importRequest(pkg)));await check(imported);
 const copied=await f.copy(imported.rootAgentId);await f.restart();f.store.rebuildProjections();await check(copied);
 assert.equal(f.store.readCommunicationEvents(f.project.id).filter(event=>event.conversationId===f.destination.id).length,0);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
}));

test('101-Agent organizations import, copy and export whole after restart with bounded bottom-up assignment', options, t => withPortability(t, async f => {
 const pkg={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Readable organization',rootRef:'a0',agents:Array.from({length:101},(_,i)=>({ref:`a${i}`,title:`Portable Agent ${i}`,engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},...(i?{managerRef:`a${i-1}`}:{})})).reverse()};
 const assign=f.store.updateAgentOrganization.bind(f.store);let assignments=0;
 f.store.updateAgentOrganization=(id,input)=>{if(input.managerAgentId){assert.equal(f.store.getAgent(input.managerAgentId).managerAgentId,undefined,'new managers remain detached while descendants are attached');assignments++}return assign(id,input)};
 const imported=f.ok(await f.request(f.importRequest(pkg)));
 assert.equal(imported.agentIds.length,101);assert.equal(assignments,100);
 const exported=await f.exportAgent(imported.rootAgentId,'template');assert.equal(exported.agents.length,101);
 const copied=await f.copy(imported.rootAgentId,randomUUID(),'template');assert.equal(copied.agentIds.length,101);assert.equal(assignments,200);
 await f.restart();assert.equal((await f.exportAgent(copied.rootAgentId,'template')).agents.length,101);
 const live=f.store.listAgentSubtree(copied.rootAgentId);assert.equal(live.length,101);
 for(let index=1;index<live.length;index++)assert.equal(live[index].managerAgentId,live[index-1].id);
}));

test('oversized organizations are refused whole before export preparation or destination mutations', options, t => withPortability(t, async f => {
 const pkg={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Too many Agents',rootRef:'a0',agents:Array.from({length:10001},(_,i)=>({ref:`a${i}`,title:`Agent ${i}`,engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},...(i?{managerRef:'a0'}:{})}))};
 const before=f.store.listAgents(f.project.id).length,response=await f.request(f.importRequest(pkg));
 assert.equal(response.statusCode,413,response.body);assert.match(response.json().error,/10001.*10000/u);assert.equal(f.store.listAgents(f.project.id).length,before);
 const subtree=f.store.listAgentSubtree.bind(f.store);f.store.listAgentSubtree=()=>Array(10001).fill(f.a);
 try{const rejected=await f.request({method:'GET',url:`/api/agents/${f.a.id}/export?mode=template&organization=true`});assert.equal(rejected.statusCode,413,rejected.body);assert.match(rejected.json().message??rejected.json().error,/10001.*10000/u)}finally{f.store.listAgentSubtree=subtree}
}));

test('10000-Agent package admission, assignment, durable receipt, restart and complete export qualification',{
 skip:process.env.PONDEROSA_TEST_AGENT_PACKAGE_SCALE!=='1',timeout:15*60_000,
},t=>withPortability(t,async f=>{
 const count=10000,key=randomUUID(),pkg={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Complete scale qualification',rootRef:'a0',agents:Array.from({length:count},(_,i)=>({ref:`a${i}`,title:'Portable Worker',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},...(i?{managerRef:`a${i-1}`}:{})})).reverse()};
 const started=performance.now(),result=f.ok(await f.request(f.importRequest(pkg,key)));
 assert.equal(result.agentIds.length,count);assert.equal(new Set(result.agentIds).size,count);
 const receipt=f.store.findAgentCreationOperation({projectId:f.project.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:key});
 assert.equal(receipt.status,'completed');assert.equal(receipt.agentIds.length,count);assert.deepEqual(receipt.result,result);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM agent_creation_operation_members WHERE operation_id=?').get(receipt.id).n,count);
 await f.restart();
 const replay=f.ok(await f.request(f.importRequest(pkg,key)));assert.deepEqual(replay,result);
 const exported=await f.exportAgent(result.rootAgentId,'template');assert.equal(exported.agents.length,count);
 const byId=new Map(exported.agents.map(node=>[node.ref,node]));assert.equal(byId.size,count);
 for(const id of result.agentIds){const agent=f.store.getAgent(id);assert.equal(agent.conversationId,f.destination.id);assert.equal(f.store.agentCreationPending(id),false);assert.equal(byId.has(id),true)}
 assert.equal(new Set(result.agentIds.map(id=>f.store.getAgent(id).handle)).size,count);
 const ordered=f.store.listAgentSubtree(result.rootAgentId);assert.equal(ordered.length,count);
 for(let index=1;index<ordered.length;index++)assert.equal(ordered[index].managerAgentId,ordered[index-1].id);
 t.diagnostic(`Complete10000-Agent import/restart/export: ${Math.round(performance.now()-started)}ms`);
}));


test('portable setup retains standing role, processing tier and preset provenance after reopen', options, t => withPortability(t, async f => {
 f.store.updateAgent(f.a.id,{role:'Standing role distinct from preset',speed:'standard'});
 const pkg=await f.exportAgent(f.a.id,'full'),node=pkg.agents.find(a=>a.ref===f.a.id);
 assert.equal(node.role,'Standing role distinct from preset');assert.equal(node.speed,'standard');assert.equal(node.presetSnapshot.name,'Fixture preset');
 const response=await f.request({method:'GET',url:`/api/agents/${f.a.id}/export?mode=full`});
 assert.match(response.headers['x-ponderosa-export-warning'],/sensitive information/);
 const template=await f.request({method:'GET',url:`/api/agents/${f.a.id}/export?mode=template`});assert.equal(template.headers['x-ponderosa-export-warning'],undefined);
 const imported=f.ok(await f.request(f.importRequest(pkg)));await f.restart();
 const restored=f.store.getAgent(imported.rootAgentId);assert.equal(restored.role,node.role);assert.equal(restored.speed,node.speed);assert.equal(restored.presetSnapshot.name,node.presetSnapshot.name);
 const next=await f.exportAgent(restored.id,'full');assert.equal(next.agents.find(a=>a.ref===restored.id).presetSnapshot.name,node.presetSnapshot.name);
 const before=f.store.listAgents(f.project.id).length;
 for(const patch of [{speed:'unavailable-tier'},{role:'x'.repeat(8001)},{presetSnapshot:{...node.presetSnapshot,apiKey:'SYNTHETIC_SECRET'}}]){
  const bad=structuredClone(pkg);Object.assign(bad.agents.find(a=>a.ref===pkg.rootRef),patch);
  const refused=await f.request(f.importRequest(bad));assert.ok(refused.statusCode>=400,refused.body);assert.equal(f.store.listAgents(f.project.id).length,before);
 }
}));


test('full Communication preserves private scope and uploaded originals across repeated imports',options,t=>withPortability(t,async f=>{
  const source=await f.exportAgent(f.a.id);
  const message=source.agents[0].history.find(m=>m.text==='PRIVATE_DM_MARKER');
  assert.equal(message.communication.intent,'user_dm');
  assert.equal(message.communication.audience.agentId,f.a.id);
  assert.equal(message.attachmentRefs.length,1);
  assert.equal(source.agents[0].artifacts.find(a=>a.ref===message.attachmentRefs[0]).dataBase64,Buffer.from('hello').toString('base64'));
  assert.equal(source.agents[1].history.some(m=>m.text==='PRIVATE_DM_MARKER'),false);
  let pkg=source;
  for(let i=0;i<2;i++){
    const result=f.ok(await f.request(f.importRequest(pkg)));
    const history=f.store.getImportedHistory(result.rootAgentId).messages;
    const restored=history.find(m=>m.text==='PRIVATE_DM_MARKER');
    assert.deepEqual(restored.communication,message.communication);
    const artifact=f.store.getProjectArtifact(f.project.id,restored.attachmentRefs[0]);
    assert.ok(artifact);assert.equal(readManagedArtifactContent(f.dataDir,f.project.id,artifact.id,artifact.size,artifact.sha256)?.body.toString(),'hello');
    pkg=await f.exportAgent(result.rootAgentId);
  }
}));


test('source capability restrictions require explicit hash-bound human review and survive restart',options,t=>withPortability(t,async f=>{
  const policies=new CapabilityPolicyStore(f.store.sqlite);
  policies.put({scopeKind:'agent',scopeId:f.a.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite],actor:'operator'});
  const pkg=await f.exportAgent(f.a.id);
  const review=await f.request(f.importRequest(pkg));assert.equal(review.statusCode,409);
  const {reviewSha256}=review.json();assert.match(reviewSha256,/^[a-f0-9]{64}$/);
  const imported=f.ok(await f.request(f.importRequest(pkg,randomUUID(),{accessSettingsResolution:{action:'use_source',reviewSha256}})));
  assert.deepEqual(policies.get('agent',imported.rootAgentId).restrictedCapabilityIds,[CAPABILITY_IDS.memoryWrite]);
  assert.equal(policies.history('agent',imported.rootAgentId).changes[0].actor,'operator');
  await f.restart();assert.deepEqual(new CapabilityPolicyStore(f.store.sqlite).get('agent',imported.rootAgentId).restrictedCapabilityIds,[CAPABILITY_IDS.memoryWrite]);
}));

test('selected working files copy to a new folder and never overwrite an existing destination',options,t=>withPortability(t,async f=>{
  const response=await f.request({method:'GET',url:`/api/agents/${f.a.id}/export?mode=full&workingFiles=${encodeURIComponent(JSON.stringify(['unmanaged-working-file.txt']))}`});
  const pkg=f.ok(response);assert.equal(pkg.agents[0].workingFiles[0].path,'unmanaged-working-file.txt');
  const destination=path.join(f.dataDir,'selected-copy');
  const imported=f.ok(await f.request(f.importRequest(pkg,randomUUID(),{workingFilesDestination:destination})));
  assert.equal(imported.workingFilesDestination,destination);
  assert.equal(await readFile(path.join(destination,'unmanaged-working-file.txt'),'utf8'),'UNMANAGED_FILE_MARKER');
  const again=await f.exportAgent(imported.rootAgentId);
  assert.equal(again.agents[0].workingFiles[0].path,'unmanaged-working-file.txt');
  const collision=await f.request(f.importRequest(pkg,randomUUID(),{workingFilesDestination:destination}));assert.ok(collision.statusCode>=400);
  assert.equal(await readFile(path.join(destination,'unmanaged-working-file.txt'),'utf8'),'UNMANAGED_FILE_MARKER');
}));

test('large working original survives Agent import, retained export, fresh recapture and tamper refusal',{timeout:180_000},t=>withPortability(t,async f=>{
  const bytes=Buffer.alloc(64*1024*1024+8193,0x61);
  bytes[0]=0x62;bytes[bytes.length-1]=0x63;
  const expected=createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(f.dataDir,'large-original.bin'),bytes);
  const capture=async id=>f.ok(await f.request({method:'GET',url:`/api/agents/${id}/export?mode=full&workingFiles=${encodeURIComponent(JSON.stringify(['large-original.bin']))}`}));
  const pkg=await capture(f.a.id);
  const original=pkg.agents[0].workingFiles.find(file=>file.path==='large-original.bin');
  assert.ok(original.parts&&original.parts.refs.length>=2);
  assert.equal(original.parts.byteLength,bytes.length);
  assert.equal(original.parts.sha256,expected);
  const altered=structuredClone(pkg);
  const tamperedPart=altered.agents[0].artifacts.find(artifact=>artifact.ref===original.parts.refs[0]);
  assert.equal(tamperedPart.dataEncoding,'gzip');
  const alteredBytes=gunzipSync(Buffer.from(tamperedPart.dataBase64,'base64'));
  alteredBytes[0]^=1;tamperedPart.dataBase64=gzipSync(alteredBytes).toString('base64');
  const before=f.store.getProjectArtifacts(f.project.id).length;
  const rejected=await f.request(f.importRequest(altered,randomUUID(),{workingFilesDestination:path.join(f.dataDir,'tampered-output')}));
  assert.ok(rejected.statusCode>=400,rejected.body);
  assert.equal(f.store.getProjectArtifacts(f.project.id).length,before,'tampered part is rejected before publishing artifacts');
  const destination=path.join(f.dataDir,'large-output');
  const imported=f.ok(await f.request(f.importRequest(pkg,randomUUID(),{workingFilesDestination:destination})));
  assert.equal(createHash('sha256').update(await readFile(path.join(destination,'large-original.bin'))).digest('hex'),expected);
  const retained=await f.exportAgent(imported.rootAgentId);
  const retainedFile=retained.agents[0].workingFiles.find(file=>file.path==='large-original.bin');
  assert.equal(retainedFile.parts.sha256,expected);
  assert.ok(retainedFile.parts.refs.every(ref=>retained.agents[0].artifacts.some(artifact=>artifact.ref===ref)));
  const destination2=path.join(f.dataDir,'large-output-again');
  f.ok(await f.request(f.importRequest(retained,randomUUID(),{workingFilesDestination:destination2})));
  assert.equal(createHash('sha256').update(await readFile(path.join(destination2,'large-original.bin'))).digest('hex'),expected);
  const fresh=await capture(imported.rootAgentId);
  const freshFile=fresh.agents[0].workingFiles.find(file=>file.path==='large-original.bin');
  assert.equal(freshFile.parts.sha256,expected);
  const partArtifacts=fresh.agents[0].artifacts.filter(artifact=>artifact.mediaType==='application/vnd.ponderosa.working-file-part.v1');
  assert.deepEqual(new Set(partArtifacts.map(artifact=>artifact.ref)),new Set(freshFile.parts.refs),'fresh capture omits stale transport parts');
  const destination3=path.join(f.dataDir,'large-output-fresh');
  f.ok(await f.request(f.importRequest(fresh,randomUUID(),{workingFilesDestination:destination3})));
  assert.equal(createHash('sha256').update(await readFile(path.join(destination3,'large-original.bin'))).digest('hex'),expected);
}));

test('foreign source Chat bindings are refused before an organization is silently collapsed',options,t=>withPortability(t,async f=>{
  const pkg=await f.exportAgent(f.a.id);pkg.agents[1].sourceChat.ref=randomUUID();
  const response=await f.request(f.importRequest(pkg));assert.equal(response.statusCode,400);assert.match(response.body,/source Chat bindings/i);
}));

test('empty-history staged import retains its exact actor and operation provenance after restart',options,t=>withPortability(t,async f=>{
  const pkg=await f.exportAgent(f.a.id,'template');
  assert.ok(pkg.agents.every(agent=>!agent.history?.length),'actual template export has no authored history');
  const metadata={conversationId:f.destination.id,engineMapping:{codex:'codex'}};
  const preview=f.ok(await f.request({method:'POST',url:`/api/projects/${f.project.id}/agent-access-preview`,headers:{'content-type':'application/vnd.ponderosa.agent-import'},payload:Buffer.from(JSON.stringify(metadata)+'\n'+JSON.stringify(pkg))}));
  const requestId=randomUUID(),upload={...metadata,accessSettingsResolution:{action:'keep_destination',reviewSha256:preview.reviewSha256}};
  const admitted=f.ok(await f.request({method:'POST',url:`/api/projects/${f.project.id}/agent-import-operations`,headers:{'idempotency-key':requestId,'content-type':'application/vnd.ponderosa.agent-import'},payload:Buffer.from(JSON.stringify(upload)+'\n'+JSON.stringify(pkg))}));
  let operation=admitted;
  const deadline=Date.now()+10000;
  while(Date.now()<deadline&&operation.status==='pending'){await delay(10);operation=f.ok(await f.request({method:'GET',url:`/api/projects/${f.project.id}/agent-import-operations/${admitted.id}`}));}
  assert.equal(operation.status,'completed',JSON.stringify(operation));
  const agentId=operation.result.rootAgentId,url=`/api/agents/${agentId}/imported-communications`;
  const before=f.ok(await f.request({method:'GET',url})),record=before.importProvenance;
  assert.deepEqual(before.messages,[]);assert.ok(record,'an empty archive still has a canonical local import record');
  assert.equal(record.actorScope,'user:local-operator');assert.equal(record.operationId,operation.id);assert.equal(record.requestId,requestId);
  assert.equal(record.sourceLabel,operation.sourceLabel);assert.equal(record.destinationChatId,f.destination.id);assert.equal(record.destinationChatTitle,f.destination.title);
  const canonical=f.store.getAgentCreationOperation(record.creationOperationId);assert.equal(canonical.actorScope,record.actorScope);assert.ok(canonical.agentIds.includes(agentId));
  assert.ok(!/payloadHash|requestFingerprint|dataBase64|restrictedCapabilityIds|snapshot/.test(JSON.stringify(record)),'selected provenance omits portable data and authorization records');
  await f.restart();
  assert.deepEqual(f.ok(await f.request({method:'GET',url})).importProvenance,record,'canonical provenance survives restart');
  assert.equal((await f.request({method:'GET',url:`/api/agents/${randomUUID()}/imported-communications`})).statusCode,404);
  // A completed owner in another Chat must not be used for this Agent.
  const foreign=f.store.beginAgentCreationOperation({projectId:f.project.id,conversationId:f.chat.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:randomUUID(),payloadHash:'f'.repeat(64)}).operation;
  f.store.addAgentCreationOperationMember(foreign.id,agentId,0);f.store.updateAgentCreationOperation(foreign.id,{status:'completed'});
  assert.deepEqual(f.ok(await f.request({method:'GET',url})).importProvenance,record,'foreign owner cannot shadow the exact destination');
  const ambiguous=f.store.beginAgentCreationOperation({projectId:f.project.id,conversationId:f.destination.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:randomUUID(),payloadHash:'e'.repeat(64)}).operation;
  f.store.addAgentCreationOperationMember(ambiguous.id,agentId,0);f.store.updateAgentCreationOperation(ambiguous.id,{status:'completed'});
  assert.equal(f.ok(await f.request({method:'GET',url})).importProvenance,undefined,'ambiguous local ownership is not arbitrarily attributed');
},{handlerDeadlineMs:5000,packageHandlerDeadlineMs:10000}));

test('staged access preview is mutation-free and imported provenance exposes only authorized remapped originals',options,t=>withPortability(t,async f=>{
  const pkg=await f.exportAgent(f.a.id);
  Object.assign(pkg.agents[0].accessSettings,{readGlobalMemory:true,savedBrowserAllowed:true,browserMode:'trusted',sourceProfileName:'Historical label only'});
  const before=f.store.listAgents(f.project.id).map(a=>a.id).sort();
  const preview=f.ok(await f.request({method:'POST',url:`/api/projects/${f.project.id}/agent-access-preview`,headers:{'content-type':'application/vnd.ponderosa.agent-import'},payload:Buffer.from(JSON.stringify({conversationId:f.destination.id,engineMapping:{codex:'codex'}})+'\n'+JSON.stringify(pkg))}));
  assert.match(preview.reviewSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(f.store.listAgents(f.project.id).map(a=>a.id).sort(),before);
  const result=f.ok(await f.request(f.importRequest(pkg,randomUUID(),{accessSettingsResolution:{action:'keep_destination',reviewSha256:preview.reviewSha256}})));
  assert.equal(result.accessSettingsToReview[0].agentId,result.rootAgentId);
  assert.equal(result.accessSettingsToReview[0].source.savedBrowserAllowed,true);
  const page=f.ok(await f.request({method:'GET',url:`/api/agents/${result.rootAgentId}/imported-communications?limit=20`}));
  assert.ok(page.messages.some(m=>m.communication?.eventId===f.collaboration.eventId));
  for(const artifact of page.artifacts){assert.match(artifact.downloadUrl,/^\/api\/projects\//);assert.equal(f.store.agentCanReadProjectArtifact(f.project.id,artifact.id,result.rootAgentId),true);}
  assert.equal((await f.request({method:'GET',url:`/api/agents/${result.rootAgentId}/imported-communications?archiveVersion=stale`})).statusCode,409);
  assert.equal((await f.request({method:'GET',url:`/api/agents/${randomUUID()}/imported-communications`})).statusCode,404);
},{handlerDeadlineMs:5000,packageHandlerDeadlineMs:10000}));

 test('recorded audio keeps canonical media type and immutable bytes across reload',options,t=>withPortability(t,async f=>{
  const page=Buffer.alloc(28);page.write('OggS');page[26]=1;page[27]=19;
  const packet=Buffer.alloc(19);packet.write('OpusHead');packet[8]=1;packet[9]=1;
  const body=Buffer.concat([page,packet]);
  const asset=await f.assets.stage({projectId:f.project.id,agentId:f.a.id,name:'recording.ogg',declaredType:'audio/ogg;codecs=opus',body});
  await f.assets.associate(f.project.id,f.a.id,[asset.id]);
  await f.restart();
  const reloaded=await f.assets.content(f.project.id,f.a.id,asset.id,false);
  assert.equal(reloaded.asset.mediaType,'audio/ogg');assert.deepEqual(reloaded.body,body);
}));


test('shared engine preserves access review refusal and forwards an explicit human choice',options,t=>withPortability(t,async f=>{
  const pkg=await f.exportAgent(f.a.id);
  pkg.agents[0].accessSettings.restrictedCapabilityIds=[CAPABILITY_IDS.memoryRead];
  const before=f.store.listAgents(f.project.id).map(agent=>agent.id).sort();
  const review=await f.packageEngine.reviewAccess(pkg,f.destination.id);
  assert.match(review.reviewSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(f.store.listAgents(f.project.id).map(agent=>agent.id).sort(),before);
  await assert.rejects(f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID()),error=>{
    assert.equal(error.statusCode,409);
    assert.deepEqual(error.accessSettingsReview,review);
    return true;
  });
  assert.deepEqual(f.store.listAgents(f.project.id).map(agent=>agent.id).sort(),before);
  const result=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{accessSettingsResolution:{action:'use_source',reviewSha256:review.reviewSha256}});
  assert.ok(new CapabilityPolicyStore(f.store.sqlite).resolveForAgent(result.rootAgentId).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead));
  const changed=structuredClone(pkg);changed.sourceLabel+=' changed';
  await assert.rejects(f.packageEngine.importAgent(f.project.id,f.destination.id,changed,{codex:'codex'},randomUUID(),{accessSettingsResolution:{action:'keep_destination',reviewSha256:review.reviewSha256}}),error=>{
    assert.equal(error.statusCode,409);assert.notEqual(error.accessSettingsReview.reviewSha256,review.reviewSha256);return true;
  });
}));

test('shared engine forwards selected folder intent, result mappings and retained-location failures',options,t=>withPortability(t,async f=>{
  const pkg=await f.packageEngine.exportAgent(f.a.id,'full',{selectedWorkingFiles:['unmanaged-working-file.txt']});
  assert.equal(pkg.agents.length,1);
  assert.equal(pkg.agents[0].workingFiles[0].path,'unmanaged-working-file.txt');
  Object.assign(pkg.agents[0].accessSettings,{readGlobalMemory:true});
  const destination=path.join(f.dataDir,'branch-retained-working-files');
  const result=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{workingFilesDestination:destination});
  assert.equal(result.workingFilesDestination,destination);
  assert.equal(result.accessSettingsToReview[0].agentId,result.rootAgentId);
  assert.equal(await readFile(path.join(destination,'unmanaged-working-file.txt'),'utf8'),'UNMANAGED_FILE_MARKER');
  await assert.rejects(f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{workingFilesDestination:destination}),error=>{
    assert.match(error.message,/retained at/);assert.ok(error.message.includes(destination));return true;
  });
  const bundle=await f.packageEngine.exportAgent(f.a.id,'full',{organization:true,organizationWorkingFolders:true});
  assert.equal(bundle.agents.length,2);
  const refs=[...new Set(bundle.agents.map(agent=>agent.workingRootRef))];
  assert.equal(refs.length,1);
  const roots=Object.fromEntries(refs.map((ref,index)=>[ref,path.join(f.dataDir,`branch-root-${index}`)]));
  const imported=await f.packageEngine.importAgent(f.project.id,f.destination.id,bundle,{codex:'codex'},randomUUID(),{workingRootDestinations:roots});
  assert.deepEqual(imported.workingRoots,[{ref:refs[0],destination:roots[refs[0]],agentIds:imported.agentIds}]);
}));

test('empty ordinary working originals retain exact metadata through import, reopen and re-export',{...options,skip:process.platform==='win32'},t=>withPortability(t,async f=>{
  const filename='empty-working-file.txt',source=path.join(f.dataDir,filename),timestamp=new Date('2026-11-02T01:02:03.000Z');
  await writeFile(source,Buffer.alloc(0));await chmod(source,0o640);await utimes(source,timestamp,timestamp);
  const pkg=await f.packageEngine.exportAgent(f.a.id,'full',{selectedWorkingFiles:[filename]});
  const file=pkg.agents[0].workingFiles.find(file=>file.path===filename),original=pkg.agents[0].artifacts.find(artifact=>artifact.ref===file.artifactRef);
  assert.equal(original.dataBase64,'');assert.equal(file.mode,0o640);assert.equal(file.mtime,timestamp.toISOString());
  // The ordinary managed-blob contract remains positive, including its batch API.
  const {publishManagedArtifactContentsAsync}=await import('@ponderosa/agents');
  await assert.rejects(async()=>publishManagedArtifactContentAsync(f.dataDir,f.project.id,randomUUID(),Buffer.alloc(0)),/1 to 64 MiB/);
  await assert.rejects(publishManagedArtifactContentsAsync(f.dataDir,f.project.id,[{artifactId:randomUUID(),input:Buffer.alloc(0)}]),/1 to 64 MiB/);
  const reject=async(value,pattern)=>{
    const before=f.store.listAgents(f.project.id).map(agent=>agent.id);
    await assert.rejects(f.packageEngine.importAgent(f.project.id,f.destination.id,value,{codex:'codex'},randomUUID()),pattern);
    assert.deepEqual(f.store.listAgents(f.project.id).map(agent=>agent.id),before,'invalid empty use creates no Agent');
  };
  const standalone=structuredClone(pkg);delete standalone.agents[0].workingFiles;
  await reject(standalone,/same-owner ordinary working-file/);
  const attached=structuredClone(pkg);attached.agents[0].history.push({role:'assistant',text:'Invalid standalone empty attachment',attachmentRefs:[file.artifactRef]});
  await reject(attached,/Empty working-file originals cannot be used as standalone/);
  const foreign=structuredClone(pkg),otherRef=randomUUID(),empty=foreign.agents[0].artifacts.find(artifact=>artifact.ref===file.artifactRef);
  foreign.kind='organization';
  foreign.agents[0].artifacts=foreign.agents[0].artifacts.filter(artifact=>artifact.ref!==file.artifactRef);
  foreign.agents.push({ref:otherRef,managerRef:foreign.rootRef,title:'Other owner',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},artifacts:[empty]});
  await reject(foreign,/included originals|same-owner ordinary working-file/);
  const parts=structuredClone(pkg),secondRef=randomUUID();
  parts.agents[0].artifacts.find(artifact=>artifact.ref===file.artifactRef).mediaType='application/vnd.ponderosa.working-file-part.v1';
  parts.agents[0].artifacts.push({...original,ref:secondRef,mediaType:'application/vnd.ponderosa.working-file-part.v1'});
  parts.agents[0].workingFiles[0].parts={schema:'ponderosa.working-file-parts.v1',refs:[file.artifactRef,secondRef],byteLength:64*1024*1024+1,sha256:'a'.repeat(64)};
  await reject(parts,/Working-file parts cannot be empty/);
  const destination=path.join(f.dataDir,'empty-original-recovery');
  const importKey=randomUUID();
  const imported=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},importKey,{workingFilesDestination:destination});
  const recovered=path.join(destination,filename),before=await stat(recovered);
  assert.equal((await readFile(recovered)).length,0);assert.equal(before.mode&0o777,0o640);assert.equal(before.mtime.toISOString(),timestamp.toISOString());
  await f.restart();
  const next=await f.packageEngine.exportAgent(imported.rootAgentId,'full'),retained=next.agents[0].workingFiles.find(value=>value.path===filename);
  assert.deepEqual({...retained,artifactRef:file.artifactRef},file,'the exact ordinary-file metadata survives reopen');
  const importOperation=f.store.getAgentCreationOperation(f.store.sqlite.prepare('SELECT id FROM agent_creation_operations WHERE idempotency_key=?').get(importKey).id);
  assert.ok(importOperation.artifactIds.includes(retained.artifactRef),'re-export retains the exact canonical import reservation identity');
  assert.notEqual(retained.artifactRef,file.artifactRef,'zero originals use locally reserved references without a catalog collision record');
  const retainedOriginal=next.agents[0].artifacts.find(artifact=>artifact.ref===retained.artifactRef);
  for(const key of ['kind','summary','createdAt','mediaType','dataBase64'])assert.equal(retainedOriginal[key],original[key],key);
  assert.equal(f.store.getProjectArtifacts(f.project.id).some(artifact=>artifact.id===retained.artifactRef),false,'zero originals never become ordinary managed blobs');
  assert.equal((await readFile(recovered)).length,0);assert.equal((await stat(recovered)).mtime.toISOString(),timestamp.toISOString());
  const secondDestination=path.join(f.dataDir,'empty-original-second-recovery');
  const second=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{workingFilesDestination:secondDestination});
  const secondPackage=await f.packageEngine.exportAgent(second.rootAgentId,'full'),secondFile=secondPackage.agents[0].workingFiles.find(value=>value.path===filename);
  assert.notEqual(secondFile.artifactRef,retained.artifactRef,'separate imports reserve distinct zero-original identities');
  assert.equal((await readFile(path.join(secondDestination,filename))).length,0);
  f.store.updateAgentOrganization(second.rootAgentId,{managerAgentId:imported.rootAgentId});
  const combined=await f.packageEngine.exportAgent(imported.rootAgentId,'full',{organization:true});
  const {validatePortableAgentPackage}=await import('../../apps/server/dist/portable-agent-package-validation.js');
  assert.doesNotThrow(()=>validatePortableAgentPackage(combined));
  const combinedRefs=combined.agents.flatMap(node=>node.artifacts??[]).map(artifact=>artifact.ref);
  assert.equal(new Set(combinedRefs).size,combinedRefs.length,'the actual combined organization package has no duplicate artifact refs');
  for(const id of [imported.rootAgentId,second.rootAgentId]){
    const node=combined.agents.find(node=>node.ref===id),binding=node.workingFiles.find(value=>value.path===filename);
    assert.equal(node.artifacts.find(artifact=>artifact.ref===binding.artifactRef).dataBase64,'','each original remains bound to its own Agent');
  }
  // Fail after physical originals are published and recovery files are written.
  // Rollback must clean positive blobs while retaining the user's recovery data.
  const rollbackKey=randomUUID(),failedDestination=path.join(f.dataDir,'empty-original-failed-recovery'),store=f.store,writeHistory=store.setImportedHistoryAsync;
  const agentsBefore=store.listAgents(f.project.id).map(agent=>agent.id);
  store.setImportedHistoryAsync=async()=>{throw Error('Injected empty-original archive failure');};
  try{await assert.rejects(f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},rollbackKey,{workingFilesDestination:failedDestination}),/Injected empty-original archive failure/);}
  finally{store.setImportedHistoryAsync=writeHistory;}
  assert.deepEqual(store.listAgents(f.project.id).map(agent=>agent.id),agentsBefore);
  const operation=store.getAgentCreationOperation(store.sqlite.prepare('SELECT id FROM agent_creation_operations WHERE idempotency_key=?').get(rollbackKey).id);
  assert.equal(operation.status,'rolled_back','never-published zeros do not leave rollback pending');
  assert.ok(operation.artifactIdentities.some(identity=>identity.byteLength===0),'the original reservation still includes zero identities');
  assert.ok(operation.artifactIdentities.some(identity=>identity.byteLength>0),'rollback exercises real positive publications too');
  for(const identity of operation.artifactIdentities){
    assert.equal(store.getProjectArtifact(f.project.id,identity.id),undefined);
    if(identity.byteLength>0)assert.equal(readManagedArtifactContent(f.dataDir,f.project.id,identity.id,identity.byteLength,identity.sha256),undefined);
  }
  assert.equal((await readFile(path.join(failedDestination,filename))).length,0,'failed recovery data remains available');
}));

test('explicit live Shared activation uses a NEW managed Chat root and refuses existing Shared roots',options,t=>withPortability(t,async f=>{
  const {mkdir}=await import('node:fs/promises');
  const pkg=await f.packageEngine.exportAgent(f.a.id,'full',{selectedWorkingFiles:['unmanaged-working-file.txt']});
  const singlePkg=structuredClone(pkg),workingRootRef=randomUUID(),childRef=randomUUID();
  pkg.kind='organization';pkg.agents[0].workingRootRef=workingRootRef;pkg.agents[0].workingFolder={directories:[],excludedPaths:[]};
  pkg.agents.push({ref:childRef,title:'Grouped Shared child',engine:'codex',managerRef:pkg.rootRef,workingRootRef,workingCopyMode:'shared',sourceChat:pkg.agents[0].sourceChat,managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},accessSettings:{restrictedCapabilityIds:[]}});
  const root=path.join(f.dataDir,'fresh-live-chat');await mkdir(root);
  const project=f.store.createProject({label:'Fresh live destination',hostPath:root,creationHostPath:root,managedWorkspaceName:'fresh-live-chat',chatOwned:true,defaultEngine:'codex'},{idempotencyKey:randomUUID(),payloadHash:'a'.repeat(64)});
  const result=await f.packageEngine.importAgent(project.id,project.lastConversationId,pkg,{codex:'codex'},randomUUID(),{
    workingRootDestinations:{[workingRootRef]:path.join(f.dataDir,'fresh-live-recovery')},workingFilesActivation:{sharedRoot:root},
  });
  const agent=f.store.getAgent(result.rootAgentId);
  assert.equal(agent.workingCopy.rootPath,root);
  assert.equal(await readFile(path.join(agent.workingCopy.rootPath,'unmanaged-working-file.txt'),'utf8'),'UNMANAGED_FILE_MARKER');
  assert.equal(result.liveWorkingRoots[0].path,root);
  assert.equal(result.liveWorkingRoots[0].agentIds.length,2);
  for(const id of result.agentIds)assert.equal(f.store.getAgent(id).workingCopy.rootPath,root);
  assert.equal(f.store.getAgent(result.agentIds.find(id=>id!==result.rootAgentId)).managerAgentId,result.rootAgentId);
  const separate=await f.packageEngine.importAgent(project.id,project.lastConversationId,singlePkg,{codex:'codex'},randomUUID(),{workingCopyMode:'separate_git',workingFilesDestination:path.join(f.dataDir,'separate-live-recovery'),workingFilesActivation:{}});
  const separateAgent=f.store.getAgent(separate.rootAgentId);
  assert.notEqual(separateAgent.workingCopy.rootPath,root);
  assert.equal(separateAgent.workingCopy.branchOwned,true);
  assert.equal(await readFile(path.join(separateAgent.workingCopy.rootPath,'unmanaged-working-file.txt'),'utf8'),'UNMANAGED_FILE_MARKER');
  assert.equal(separate.liveWorkingRoots[0].path,separateAgent.workingCopy.rootPath);
  await assert.rejects(f.packageEngine.importAgent(f.project.id,f.destination.id,singlePkg,{codex:'codex'},randomUUID(),{
    workingFilesDestination:path.join(f.dataDir,'must-not-create'),workingFilesActivation:{sharedRoot:f.project.hostPath},
  }),/unused NEW managed Chat/);
}));

test('grouped organization import keeps explicit per-Agent access choices under one current review',options,t=>withPortability(t,async f=>{
  const pkg=await f.exportAgent(f.a.id);
  for(const node of pkg.agents)node.accessSettings.restrictedCapabilityIds=[CAPABILITY_IDS.memoryRead];
  const review=await f.packageEngine.reviewAccess(pkg,f.destination.id);
  const agentActions=Object.fromEntries(pkg.agents.map(node=>[node.ref,node.ref===pkg.rootRef?'use_source':'keep_destination']));
  await assert.rejects(f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{accessSettingsResolution:{action:'keep_destination',reviewSha256:review.reviewSha256,agentActions:{[pkg.rootRef]:'use_source'}}}),/cover exactly/);
  const result=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{accessSettingsResolution:{action:'keep_destination',reviewSha256:review.reviewSha256,agentActions}});
  const policies=new CapabilityPolicyStore(f.store.sqlite);
  assert.ok(policies.resolveForAgent(result.rootAgentId).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead));
  const child=result.agentIds.find(id=>id!==result.rootAgentId);
  assert.ok(!policies.resolveForAgent(child).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead));
}));


test('real global hooks retain slow owned intake and queued package processing beyond the ordinary deadline',{timeout:30000},t=>withPortability(t,async f=>{
 const pkg=await f.exportAgent(f.a.id),key=randomUUID(),wire=Buffer.from(JSON.stringify({conversationId:f.destination.id,engineMapping:{codex:'codex'}})+'\n'+JSON.stringify(pkg));
 const address=await f.app.listen({host:'127.0.0.1',port:0});
 const intake=new Promise((resolve,reject)=>{const req=httpRequest(address+`/api/projects/${f.project.id}/import-agent-package`,{method:'POST',headers:{'content-type':'application/vnd.ponderosa.agent-import','content-length':wire.length,'idempotency-key':key}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.write(wire.subarray(0,32));setTimeout(()=>req.end(wire.subarray(32)),100);});
 const response=await intake;assert.equal(response.status,201,response.body);
 let release;const holding=withAgentImportAdmission(()=>new Promise(resolve=>{release=resolve;}));await delay(0);
 f.app.server.requestTimeout=25;
 const copyInput=f.copyRequest(f.a.id,randomUUID());
 const pending=fetch(address+copyInput.url,{method:'POST',headers:{'content-type':'application/json',...copyInput.headers},body:JSON.stringify(copyInput.payload)});
 await delay(100);release();await holding;
 const copiedResponse=await pending;assert.equal(copiedResponse.status,201);
 const copied=await copiedResponse.json();assert.ok(f.store.getAgent(copied.rootAgentId));
}));

test('bounded package deadline reports unknown outcome and resolves the exact durable key without duplicating copy',{timeout:30000},t=>withPortability(t,async f=>{
 let release;const holding=withAgentImportAdmission(()=>new Promise(resolve=>{release=resolve;}));await delay(0);
 const key=randomUUID(),input=f.copyRequest(f.a.id,key),pending=f.request(input);
 const timed=await pending;assert.equal(timed.statusCode,504,timed.body);assert.equal(timed.json().outcome,'unknown');assert.equal(timed.json().idempotencyKey,key);
 release();await holding;
 let operation;for(let i=0;i<200;i++){operation=f.store.sqlite.prepare('SELECT status,result_json FROM agent_creation_operations WHERE idempotency_key=?').get(key);if(operation?.status==='completed')break;await delay(20);}
 assert.equal(operation?.status,'completed');
 const replay=f.ok(await f.request(input));assert.deepEqual(replay,JSON.parse(operation.result_json));
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM agent_creation_operations WHERE idempotency_key=?').get(key).n,1);
},{handlerDeadlineMs:10,packageHandlerDeadlineMs:30}));

test('oversized clipboard packages are cancelled and require the complete download path',async()=>{
 const {readAgentPackageClipboard,AgentPackageDownloadRequired}=await import('../../apps/web/src/agent-package-clipboard.ts');
 const prepared={downloadUrl:'/api/agent-exports/test',expiresAt:'2030-01-01T00:00:00.000Z',byteLength:64},cause=new Error('network interrupted');
 const preparedError=new AgentPackageDownloadRequired(prepared,{cause});
 assert.equal(preparedError.preparedExport,prepared);assert.equal(preparedError.cause,cause);
 const original='雪🌲 exact package',bytes=new TextEncoder().encode(original);
 assert.equal(await readAgentPackageClipboard(new Response(bytes),bytes.length),original);
 let cancelled=false;const response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(64));},cancel(){cancelled=true;}}));
 await assert.rejects(readAgentPackageClipboard(response,32),AgentPackageDownloadRequired);assert.equal(cancelled,true);
 await assert.rejects(readAgentPackageClipboard(new Response('too large',{headers:{'Content-Length':'100'}}),32),AgentPackageDownloadRequired);
});

test('native live receipts include Git A only while metadata-only B remains inert',options,t=>withPortability(t,async f=>{
 const {mkdir}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const {exportReviewedUserData}=await import('../../apps/server/dist/portable-reviewed-user-data.js'),run=promisify(execFile);
 const gitOptions={env:{...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}};
 const source=path.join(f.dataDir,'workspaces','git-source'),other=path.join(f.dataDir,'workspaces','metadata-source');await mkdir(source,{recursive:true});await mkdir(other);
 await run('git',['init','--template=','--initial-branch=main'],{...gitOptions,cwd:source});await writeFile(path.join(source,'file.txt'),'original');
 await run('git',['-c','core.hooksPath=/dev/null','add','file.txt'],{...gitOptions,cwd:source});await run('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-m','Original'],{...gitOptions,cwd:source});
 const manifests=[await exportReviewedUserData(source,{git:true,harness:false}),await exportReviewedUserData(other,{git:false,harness:false,persistentNodes:{fifo:false,evidenceOnly:true}})],refs=[randomUUID(),randomUUID()];
 const agents=manifests.map((manifest,i)=>({ref:'node-'+i,title:'Root '+i,engine:'codex',...(i?{managerRef:'node-0'}:{}),managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingCopyMode:'separate_git',workingRootRef:refs[i],workingFolder:{directories:[],excludedPaths:['.git']},workingFiles:[{path:'.ponderosa-portable-review/user-data.json',artifactRef:'manifest-'+i}],artifacts:[{ref:'manifest-'+i,kind:'document',path:'manifest.json',createdAt:new Date().toISOString(),dataBase64:Buffer.from(JSON.stringify(manifest)).toString('base64')}]}));
 const pkg={schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',sourceLabel:'Per-root native receipts',exportedAt:new Date().toISOString(),rootRef:'node-0',agents};
 const choices={workingRootDestinations:{[refs[0]]:path.join(f.dataDir,'workspaces','recover-a'),[refs[1]]:path.join(f.dataDir,'workspaces','recover-b')},workingFilesActivation:{},workingCopyMode:'separate_git',reviewedUserDataActivation:{git:true,harness:false}};
 const review=await f.packageEngine.reviewAccess(pkg,f.destination.id,choices);
 const result=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{...choices,accessSettingsResolution:{action:'keep_destination',reviewSha256:review.reviewSha256}});
 assert.equal(result.reviewedUserDataApplications.length,1);
 const receipt=result.reviewedUserDataApplications[0],active=result.liveWorkingRoots.find(root=>root.ref===refs[0]);
 assert.equal(receipt.ref,refs[0]);assert.equal(receipt.state,'completed');assert.equal(receipt.selection.git,true);assert.equal(receipt.selection.harness,false);assert.ok(active);
 const mappings=receipt.selection.gitPathMappings;assert.ok(Array.isArray(mappings));
 assert.deepEqual(mappings.map(mapping=>mapping.source).sort(),[source,path.join(source,'.git'),path.join(source,'.git','hooks')].sort());
 assert.equal(mappings.find(mapping=>mapping.source===source).destination,active.path);
 assert.equal(mappings.find(mapping=>mapping.source===path.join(source,'.git')).destination,path.join(active.path,'.git'));
 assert.ok(mappings.find(mapping=>mapping.source===path.join(source,'.git','hooks')).destination.startsWith(path.join(active.path,'.git')+path.sep));
 const inert=result.liveWorkingRoots.find(root=>root.ref===refs[1]);assert.ok(inert);assert.ok(!result.reviewedUserDataApplications.some(receipt=>receipt.path===inert.path));
}));
test('nested recovery metadata finalizes child before restrictive parent permissions',{...options,skip:process.platform==='win32'||process.getuid?.()===0},t=>withPortability(t,async f=>{
 const {chmod,lstat}=await import('node:fs/promises'),parent=randomUUID(),child=randomUUID(),stamp='2026-11-03T00:00:00.000Z';
 const node=(ref,root,folder,files=[])=>({ref,title:ref,engine:'codex',...(ref==='child'?{managerRef:'parent'}:{}),managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingCopyMode:'shared',workingRootRef:root,workingFolder:folder,workingFiles:files.map((file,i)=>({path:file.path,artifactRef:ref+'-'+i,mode:0o640,mtime:stamp})),artifacts:files.map((file,i)=>({ref:ref+'-'+i,kind:'document',path:file.path,createdAt:stamp,dataBase64:Buffer.from(file.data).toString('base64')}))});
 const pkg={schema:'ponderosa.agent-package.v1',mode:'full',kind:'organization',sourceLabel:'Restrictive nested metadata',exportedAt:stamp,rootRef:'parent',workingRootNesting:[{parentRootRef:parent,childRootRef:child,path:'child'}],agents:[node('parent',parent,{directories:[],excludedPaths:['child'],mode:0,mtime:stamp}),node('child',child,{directories:[],excludedPaths:[],mode:0o750,mtime:stamp},[{path:'original',data:'exact original'}])]};
 const destination=path.join(f.dataDir,'workspaces','restricted-parent'),nested=path.join(destination,'child');
 await (await import('node:fs/promises')).mkdir(path.dirname(destination),{recursive:true});
 try{
  const result=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{workingRootDestinations:{[parent]:destination,[child]:nested}});
  assert.equal(result.agentIds.length,2);assert.equal((await lstat(destination)).mode&0o777,0);
  await chmod(destination,0o700);assert.equal((await lstat(nested)).mode&0o777,0o750);assert.equal(await readFile(path.join(nested,'original'),'utf8'),'exact original');
 }finally{await chmod(destination,0o700).catch(()=>undefined);}
}));


test('Agent package route carries edited retained Git review evidence through two inert generations',options,t=>withPortability(t,async f=>{
 const {mkdir,readdir,lstat,rename,unlink}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const {exportReviewedUserData}=await import('../../apps/server/dist/portable-reviewed-user-data.js'),run=promisify(execFile);
 const source=path.join(f.dataDir,'workspaces','review-source');await mkdir(source,{recursive:true});
 const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
 await run('git',['init','--template=','--initial-branch=main'],{cwd:source,env});
 await writeFile(path.join(source,'file.txt'),'synthetic original');
 await run('git',['-c','core.hooksPath=/dev/null','add','file.txt'],{cwd:source,env});
 await run('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-m','Original'],{cwd:source,env});
 await mkdir(path.join(source,'hooks'));await writeFile(path.join(source,'hooks','pre-commit'),'#!/bin/sh\nexit 0\n');
 await run('git',['config','core.hooksPath','hooks'],{cwd:source,env});
 const original=Buffer.from(JSON.stringify(await exportReviewedUserData(source,{git:true,harness:false}))),ref='manifest';
 const pkg={schema:'ponderosa.agent-package.v1',mode:'full',kind:'agent',sourceLabel:'Synthetic reviewed Git',exportedAt:new Date().toISOString(),rootRef:'agent',agents:[{ref:'agent',title:'Imported',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingCopyMode:'separate_git',workingFolder:{directories:[],excludedPaths:[]},workingFiles:[{path:'.ponderosa-portable-review/user-data.json',artifactRef:ref}],artifacts:[{ref,kind:'document',path:'manifest.json',createdAt:new Date().toISOString(),dataBase64:original.toString('base64')}]}]};
 const initial=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{workingCopyMode:'separate_git',workingFilesDestination:path.join(f.dataDir,'recovery-one'),workingFilesActivation:{}});
 const root=f.store.getAgent(initial.rootAgentId).workingCopy.rootPath,review=path.join(root,'.ponderosa-portable-review');
 assert.deepEqual(await readFile(path.join(review,'user-data.json')),original);
 const ext=path.join(review,'external-git');assert.ok((await readdir(ext)).includes('manifest.json'));
 const selection=encodeURIComponent(JSON.stringify({git:true,harness:false,source:'retained_originals'}));
 // No current-evidence namespace: changed generated files must still block export.
 const movedExternal=path.join(f.dataDir,'held-external');await rename(ext,movedExternal);
 const generatedEdit=path.join(review,'git-repository','edited-generated');await writeFile(generatedEdit,'retained generated edit');
 const held=await f.request({method:'GET',url:`/api/agents/${initial.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${selection}`});
 assert.notEqual(held.statusCode,200);assert.equal(await readFile(generatedEdit,'utf8'),'retained generated edit');
 await unlink(generatedEdit);
 const generatedOnly=await f.request({method:'GET',url:`/api/agents/${initial.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${selection}`});
 assert.equal(generatedOnly.statusCode,200,generatedOnly.body);
 const observedPackage=generatedOnly.json().agents[0],observedFile=observedPackage.workingFiles.find(file=>file.path==='.ponderosa-portable-review/current-git-evidence/manifest.json');
 assert.ok(observedFile);const observedArtifact=observedPackage.artifacts.find(item=>item.ref===observedFile.artifactRef);
 const {decodePortableArtifactData}=await import('../../apps/server/dist/agent-package-codec.js');
 const observations=JSON.parse((await decodePortableArtifactData(observedArtifact)).data).generatedObservations;
 const gitObservation=observations.find(item=>item.name==='git-repository');assert.equal(gitObservation.state,'matches-original');
 const gitRootNode=gitObservation.nodes.find(item=>item.path===''),gitRootStat=await lstat(path.join(review,'git-repository'),{bigint:true});
 assert.equal(gitRootNode.mode,Number(gitRootStat.mode&0o7777n));assert.equal(gitRootNode.mtimeNs,gitRootStat.mtimeNs.toString());
 await rename(movedExternal,ext);
 await writeFile(path.join(ext,'edited.review'),'product route current edit\n');
 await mkdir(path.join(review,'native-git-common'));await writeFile(path.join(review,'native-git-common','table'),'current reference evidence\n');
 const response=await f.request({method:'GET',url:`/api/agents/${initial.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${selection}`});
 assert.equal(response.statusCode,200,response.body);const exported=response.json(),node=exported.agents[0];
 assert.ok(node.workingFiles.some(file=>file.path==='.ponderosa-portable-review/current-git-evidence/manifest.json'));
 const second=await f.packageEngine.importAgent(f.project.id,f.destination.id,exported,{codex:'codex'},randomUUID(),{workingCopyMode:'separate_git',workingFilesDestination:path.join(f.dataDir,'recovery-two'),workingFilesActivation:{}});
 const secondRoot=f.store.getAgent(second.rootAgentId).workingCopy.rootPath,secondReview=path.join(secondRoot,'.ponderosa-portable-review');
 assert.deepEqual(await readFile(path.join(secondReview,'user-data.json')),original);
 assert.equal(await readFile(path.join(secondReview,'current-git-evidence','external-git','edited.review'),'utf8'),'product route current edit\n');
 assert.equal(await readFile(path.join(secondReview,'current-git-evidence','native-git-common','table'),'utf8'),'current reference evidence\n');
 assert.equal((await lstat(path.join(secondReview,'current-git-evidence','external-git','edited.review'))).mode&0o777,0o600);
 const again=await f.request({method:'GET',url:`/api/agents/${second.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${selection}`});
 assert.equal(again.statusCode,200,again.body);const secondPackage=again.json();
 const third=await f.packageEngine.importAgent(f.project.id,f.destination.id,secondPackage,{codex:'codex'},randomUUID(),{workingCopyMode:'separate_git',workingFilesDestination:path.join(f.dataDir,'recovery-three'),workingFilesActivation:{}});
 const thirdReview=path.join(f.store.getAgent(third.rootAgentId).workingCopy.rootPath,'.ponderosa-portable-review');
 assert.deepEqual(await readFile(path.join(thirdReview,'user-data.json')),original);
 assert.equal(await readFile(path.join(thirdReview,'current-git-evidence','current-git-evidence','external-git','edited.review'),'utf8'),'product route current edit\n');
 const prior=path.join(secondReview,'current-git-evidence','manifest.json'),priorData=JSON.parse(await readFile(prior,'utf8'));priorData.originalSha256='0'.repeat(64);
 const alteredPrior=JSON.stringify(priorData);await writeFile(prior,alteredPrior);
 const refused=await f.request({method:'GET',url:`/api/agents/${second.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${selection}`});
 assert.notEqual(refused.statusCode,200);assert.equal(await readFile(prior,'utf8'),alteredPrior,'inconsistent prior text evidence remains intact');
}));

for(const objectFormat of ['sha1','sha256'])test('Agent package route carries associated native reftable binary through two inert generations ('+objectFormat+')',options,t=>withPortability(t,async f=>{
 const {mkdir,readdir}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const {exportReviewedUserData}=await import('../../apps/server/dist/portable-reviewed-user-data.js'),run=promisify(execFile);
 const main=path.join(f.dataDir,'workspaces','binary-main'),selected=path.join(f.dataDir,'workspaces','binary-selected');await mkdir(main,{recursive:true});
 const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
 const git=async(cwd,...args)=>(await run('git',['--no-optional-locks','-c','core.hooksPath=/dev/null',...args],{cwd,env})).stdout.trim();
 await git(main,'init','--template=','--initial-branch=main','--ref-format=reftable','--object-format='+objectFormat);await git(main,'config','user.name','Fixture');await git(main,'config','user.email','fixture@example.invalid');
 await writeFile(path.join(main,'file.txt'),'base\n');await git(main,'add','file.txt');await git(main,'commit','--no-gpg-sign','-m','base');
 await git(main,'worktree','add','-b','selected',selected);await writeFile(path.join(selected,'file.txt'),'edited\n');await git(selected,'add','file.txt');await git(selected,'commit','--no-gpg-sign','-m','edited');
 const original=Buffer.from(JSON.stringify(await exportReviewedUserData(selected,{git:true,harness:false}))),workingRef='work',manifestRef='manifest',fileRef='file';
 const pkg={schema:'ponderosa.agent-package.v1',mode:'full',kind:'agent',sourceLabel:'Synthetic native reftable',exportedAt:new Date().toISOString(),rootRef:'agent',agents:[{ref:'agent',title:'Imported',engine:'codex',workingRootRef:workingRef,managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingCopyMode:'separate_git',workingFolder:{directories:[],excludedPaths:['.git']},workingFiles:[{path:'.ponderosa-portable-review/user-data.json',artifactRef:manifestRef},{path:'file.txt',artifactRef:fileRef}],artifacts:[{ref:manifestRef,kind:'document',path:'manifest.json',createdAt:new Date().toISOString(),dataBase64:original.toString('base64')},{ref:fileRef,kind:'document',path:'file.txt',createdAt:new Date().toISOString(),dataBase64:Buffer.from('edited\n').toString('base64')}]}]};
 const choices={workingRootDestinations:{[workingRef]:path.join(f.dataDir,'reftable-choice')},workingCopyMode:'separate_git',workingFilesActivation:{},reviewedUserDataActivation:{git:true,harness:false}};
 const review=await f.packageEngine.reviewAccess(pkg,f.destination.id,choices);
 const initial=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{...choices,accessSettingsResolution:{action:'keep_destination',reviewSha256:review.reviewSha256}});
 const sourceRoot=f.store.getAgent(initial.rootAgentId).workingCopy.rootPath,common=path.join(sourceRoot,'.ponderosa-portable-review','native-git-common');
 await git(sourceRoot,'repack','-a','-d');
 const table=(await readdir(path.join(common,'reftable'))).find(name=>name.endsWith('.ref'));assert.ok(table);
 const reverse=(await readdir(path.join(common,'objects','pack'))).find(name=>name.endsWith('.rev'));assert.ok(reverse,'real Git generated a reverse index');
 const originalTable=await readFile(path.join(common,'reftable',table)),originalReverse=await readFile(path.join(common,'objects','pack',reverse));
 const choice=encodeURIComponent(JSON.stringify({git:true,harness:false,source:'retained_originals'}));
 const first=await f.request({method:'GET',url:`/api/agents/${initial.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${choice}`});assert.equal(first.statusCode,200,first.body);
 const second=await f.packageEngine.importAgent(f.project.id,f.destination.id,first.json(),{codex:'codex'},randomUUID(),{workingCopyMode:'separate_git',workingFilesDestination:path.join(f.dataDir,'reftable-inert-one'),workingFilesActivation:{}});
 const secondRoot=f.store.getAgent(second.rootAgentId).workingCopy.rootPath,firstEvidence=path.join(secondRoot,'.ponderosa-portable-review','current-git-evidence','native-git-common','reftable',table);
 assert.deepEqual(await readFile(firstEvidence),originalTable);
 assert.deepEqual(await readFile(path.join(secondRoot,'.ponderosa-portable-review','current-git-evidence','native-git-common','objects','pack',reverse)),originalReverse);
 const next=await f.request({method:'GET',url:`/api/agents/${second.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${choice}`});assert.equal(next.statusCode,200,next.body);
 const third=await f.packageEngine.importAgent(f.project.id,f.destination.id,next.json(),{codex:'codex'},randomUUID(),{workingCopyMode:'separate_git',workingFilesDestination:path.join(f.dataDir,'reftable-inert-two'),workingFilesActivation:{}});
 const thirdRoot=f.store.getAgent(third.rootAgentId).workingCopy.rootPath;
 assert.deepEqual(await readFile(path.join(thirdRoot,'.ponderosa-portable-review','current-git-evidence','current-git-evidence','native-git-common','reftable',table)),originalTable);
 assert.deepEqual(await readFile(path.join(thirdRoot,'.ponderosa-portable-review','current-git-evidence','current-git-evidence','native-git-common','objects','pack',reverse)),originalReverse);
 assert.deepEqual(await readFile(path.join(sourceRoot,'.ponderosa-portable-review','user-data.json')),original);
 const changedTable=Buffer.from(originalTable);changedTable[20]^=1;await writeFile(firstEvidence,changedTable);
 const tampered=await f.request({method:'GET',url:`/api/agents/${second.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${choice}`});
 assert.notEqual(tampered.statusCode,200);assert.deepEqual(await readFile(firstEvidence),changedTable,'inconsistent prior evidence remains untouched');
 const secret=Buffer.from('A\0P\0I\0_\0K\0E\0Y\0=\0S\0Y\0N\0T\0H\0E\0T\0I\0C');await writeFile(path.join(sourceRoot,'file.txt'),secret);
 await git(sourceRoot,'add','file.txt');await git(sourceRoot,'commit','--no-gpg-sign','-m','synthetic credential');
 const denied=await f.request({method:'GET',url:`/api/agents/${initial.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${choice}`});
 assert.notEqual(denied.statusCode,200);assert.doesNotMatch(denied.body,/SYNTHETIC/);assert.deepEqual(await readFile(path.join(sourceRoot,'file.txt')),secret);
}));

test('Agent package route carries associated external Git binary through two inert generations',options,t=>withPortability(t,async f=>{
 const {mkdir}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const {exportReviewedUserData,exportReviewedGit}=await import('../../apps/server/dist/portable-reviewed-user-data.js'),run=promisify(execFile);
 const source=path.join(f.dataDir,'workspaces','external-owner'),external=path.join(f.dataDir,'workspaces','external-repository');await mkdir(source,{recursive:true});await mkdir(external,{recursive:true});
 const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
 const git=async(cwd,...args)=>(await run('git',['--no-optional-locks','-c','core.hooksPath=/dev/null',...args],{cwd,env})).stdout.trim();
 for(const root of [source,external]){await git(root,'init','--template=','--initial-branch=main');await git(root,'config','user.name','Fixture');await git(root,'config','user.email','fixture@example.invalid');}
 const originalBinary=Buffer.from([0,1,2,255,3]);await writeFile(path.join(external,'asset.bin'),originalBinary);await git(external,'add','asset.bin');await git(external,'commit','--no-gpg-sign','-m','original binary');
 await writeFile(path.join(source,'file.txt'),'owner\n');await git(source,'add','file.txt');await git(source,'commit','--no-gpg-sign','-m','owner');await git(source,'config','core.hooksPath',external);
 const originalValue=await exportReviewedUserData(source,{git:true,harness:false,externalGitDependencies:true}),deps=originalValue.gitExternalDependencies;
 assert.ok(deps.repositories.some(repo=>repo.sourcePath===external),'real external repository association');
 assert.ok(deps.files.some(file=>file.sourcePath===path.join(external,'asset.bin')),'real captured binary dependency');
 const original=Buffer.from(JSON.stringify(originalValue)),ref='manifest';
 const pkg={schema:'ponderosa.agent-package.v1',mode:'full',kind:'agent',sourceLabel:'Synthetic external binary',exportedAt:new Date().toISOString(),rootRef:'agent',agents:[{ref:'agent',title:'Imported',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingCopyMode:'separate_git',workingFolder:{directories:[],excludedPaths:[]},workingFiles:[{path:'.ponderosa-portable-review/user-data.json',artifactRef:ref}],artifacts:[{ref,kind:'document',path:'manifest.json',createdAt:new Date().toISOString(),dataBase64:original.toString('base64')}]}]};
 const initial=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{workingCopyMode:'separate_git',workingFilesDestination:path.join(f.dataDir,'external-recovery-one'),workingFilesActivation:{}});
 const root=f.store.getAgent(initial.rootAgentId).workingCopy.rootPath,review=path.join(root,'.ponderosa-portable-review','external-git'),mapping=JSON.parse(await readFile(path.join(review,'manifest.json'),'utf8'));
 const file=mapping.files.find(item=>item.sourcePath===path.join(external,'asset.bin')),repo=mapping.repositories.find(item=>item.sourcePath===external);assert.ok(file&&repo);
 const reviewed=path.join(review,file.reviewFile),metadata=path.join(review,repo.metadataFile);
 assert.deepEqual(await readFile(reviewed),originalBinary);
 const edited=Buffer.from([0,7,8,255,9]);await writeFile(reviewed,edited);
 const selection=encodeURIComponent(JSON.stringify({git:true,harness:false,source:'retained_originals',externalGitDependencies:true}));
 const request=()=>f.request({method:'GET',url:`/api/agents/${initial.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${selection}`});
 const missingGraph=await request();assert.notEqual(missingGraph.statusCode,200);assert.deepEqual(await readFile(reviewed),edited,'unassociated edit remains intact');
 await writeFile(path.join(external,'asset.bin'),edited);await git(external,'add','asset.bin');await git(external,'commit','--no-gpg-sign','-m','edited binary');
 const graph=await exportReviewedGit(external);await writeFile(metadata,JSON.stringify(graph.git,null,2));
 const first=await request();assert.equal(first.statusCode,200,first.body);
 const {decodePortableArtifactData}=await import('../../apps/server/dist/agent-package-codec.js'),{importWorkingFiles}=await import('../../apps/server/dist/portable-working-files.js'),{lstat}=await import('node:fs/promises');
 const firstNode=first.json().agents[0],artifacts=new Map(firstNode.artifacts.map(item=>[item.ref,item]));
 const entries=await Promise.all(firstNode.workingFiles.map(async item=>{const decoded=await decodePortableArtifactData(artifacts.get(item.artifactRef));return {...item,data:decoded.data,sha256:decoded.sha256};}));
 const actualStat=await lstat(reviewed,{bigint:true}),outerData=JSON.parse(entries.find(item=>item.path==='.ponderosa-portable-review/current-git-evidence/manifest.json').data);
 const observed=outerData.namespaces.find(item=>item.name==='external-git').files.find(item=>item.path===file.reviewFile);
 assert.equal(observed.mode,Number(actualStat.mode&0o777n));assert.equal(observed.mtime,new Date(Number(actualStat.mtimeMs)).toISOString());
 const evidenceRelative='.ponderosa-portable-review/current-git-evidence/external-git/'+file.reviewFile;
 const forged=entries.map(item=>({...item,data:Buffer.from(item.data)})),forgedBlob=forged.find(item=>item.path===evidenceRelative),outer=forged.find(item=>item.path==='.ponderosa-portable-review/current-git-evidence/manifest.json');
 forgedBlob.data[1]^=1;forgedBlob.sha256=createHash('sha256').update(forgedBlob.data).digest('hex');const changed=JSON.parse(outer.data);
 changed.namespaces.find(item=>item.name==='external-git').files.find(item=>item.path===file.reviewFile).sha256=forgedBlob.sha256;
 outer.data=Buffer.from(JSON.stringify(changed));outer.sha256=createHash('sha256').update(outer.data).digest('hex');
 const forgedRoot=path.join(f.dataDir,'external-forged');await assert.rejects(importWorkingFiles(forgedRoot,forged),/external Git|blob/i);await assert.rejects(lstat(forgedRoot),{code:'ENOENT'});
 const second=await f.packageEngine.importAgent(f.project.id,f.destination.id,first.json(),{codex:'codex'},randomUUID(),{workingCopyMode:'separate_git',workingFilesDestination:path.join(f.dataDir,'external-recovery-two'),workingFilesActivation:{}});
 const secondRoot=f.store.getAgent(second.rootAgentId).workingCopy.rootPath,evidence=path.join(secondRoot,'.ponderosa-portable-review','current-git-evidence','external-git',file.reviewFile);
 assert.deepEqual(await readFile(evidence),edited);assert.deepEqual(await readFile(path.join(secondRoot,'.ponderosa-portable-review','user-data.json')),original);
 const again=await f.request({method:'GET',url:`/api/agents/${second.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${selection}`});assert.equal(again.statusCode,200,again.body);
 const third=await f.packageEngine.importAgent(f.project.id,f.destination.id,again.json(),{codex:'codex'},randomUUID(),{workingCopyMode:'separate_git',workingFilesDestination:path.join(f.dataDir,'external-recovery-three'),workingFilesActivation:{}});
 const thirdRoot=f.store.getAgent(third.rootAgentId).workingCopy.rootPath;
 assert.deepEqual(await readFile(path.join(thirdRoot,'.ponderosa-portable-review','current-git-evidence','current-git-evidence','external-git',file.reviewFile)),edited);
 const editedEvidence=Buffer.from(edited);editedEvidence[1]^=1;await writeFile(evidence,editedEvidence);
 const badPrior=await f.request({method:'GET',url:`/api/agents/${second.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${selection}`});
 assert.notEqual(badPrior.statusCode,200);assert.deepEqual(await readFile(evidence),editedEvidence);await writeFile(evidence,edited);
 const differentSource=structuredClone(graph.git);differentSource.configurationSourceDirectories.common='/tmp/not-the-original-repository';await writeFile(metadata,JSON.stringify(differentSource,null,2));
 const badSource=await request();assert.notEqual(badSource.statusCode,200);
 delete differentSource.configurationSourceDirectories;await writeFile(metadata,JSON.stringify(differentSource,null,2));
 const missingSource=await request();assert.notEqual(missingSource.statusCode,200);await writeFile(metadata,JSON.stringify(graph.git,null,2));
 const secret=Buffer.from('A\0P\0I\0_\0K\0E\0Y\0=\0S\0Y\0N\0T\0H\0E\0T\0I\0C');
 await writeFile(path.join(external,'asset.bin'),secret);await git(external,'add','asset.bin');await git(external,'commit','--no-gpg-sign','-m','synthetic credential');
 const secretGraph=await exportReviewedGit(external);await writeFile(reviewed,secret);await writeFile(metadata,JSON.stringify(secretGraph.git,null,2));
 const denied=await request();assert.notEqual(denied.statusCode,200);assert.doesNotMatch(denied.body,/SYNTHETIC/);assert.deepEqual(await readFile(reviewed),secret);
 await writeFile(reviewed,edited);await writeFile(metadata,JSON.stringify(graph.git,null,2));
 const manifestPath=path.join(review,'manifest.json'),manifestBytes=await readFile(manifestPath),changedManifest=JSON.parse(manifestBytes);changedManifest.repositories[0].sourcePath='/tmp/different-repository';await writeFile(manifestPath,JSON.stringify(changedManifest,null,2));
 const badManifest=await request();assert.notEqual(badManifest.statusCode,200);assert.equal(JSON.parse(await readFile(manifestPath,'utf8')).repositories[0].sourcePath,'/tmp/different-repository');await writeFile(manifestPath,manifestBytes);
 const unknown=path.join(review,'user-unassociated.review'),unknownBytes=Buffer.from([0,9,8,255]);await writeFile(unknown,unknownBytes);
 const refused=await request();assert.notEqual(refused.statusCode,200);assert.deepEqual(await readFile(unknown),unknownBytes);
 assert.deepEqual(await readFile(path.join(root,'.ponderosa-portable-review','user-data.json')),original);
}));

test('incompressible large working original survives Agent HTTP export and import',{timeout:180_000},t=>withPortability(t,async f=>{
  const bytes=randomFillSync(Buffer.allocUnsafe(64*1024*1024+8193));
  const expected=createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(f.dataDir,'large-random.bin'),bytes);
  const pkg=f.ok(await f.request({method:'GET',url:`/api/agents/${f.a.id}/export?mode=full&workingFiles=${encodeURIComponent(JSON.stringify(['large-random.bin']))}`}));
  const file=pkg.agents[0].workingFiles.find(item=>item.path==='large-random.bin');
  assert.equal(file.parts.byteLength,bytes.length);
  assert.equal(file.parts.sha256,expected);
  assert.ok(file.parts.refs.some(ref=>!pkg.agents[0].artifacts.find(item=>item.ref===ref).dataEncoding),'at least one full transport part is not compressed');
  const destination=path.join(f.dataDir,'large-random-output');
  f.ok(await f.request(f.importRequest(pkg,randomUUID(),{workingFilesDestination:destination})));
  assert.equal(createHash('sha256').update(await readFile(path.join(destination,'large-random.bin'))).digest('hex'),expected);
}));

test('large retained Git evidence crosses Agent package HTTP export and import safely',{timeout:240_000},t=>withPortability(t,async f=>{
 const {mkdir}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const {exportReviewedUserData}=await import('../../apps/server/dist/portable-reviewed-user-data.js'),run=promisify(execFile);
 const source=path.join(f.dataDir,'workspaces','large-retained-source');await mkdir(source,{recursive:true});
 const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
 await run('git',['init','--template=','--initial-branch=main'],{cwd:source,env});
 await writeFile(path.join(source,'file.txt'),'synthetic original');
 await run('git',['-c','core.hooksPath=/dev/null','add','file.txt'],{cwd:source,env});
 await run('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-m','Original'],{cwd:source,env});
 const original=Buffer.from(JSON.stringify(await exportReviewedUserData(source,{git:true,harness:false}))),ref='manifest';
 const pkg={schema:'ponderosa.agent-package.v1',mode:'full',kind:'agent',sourceLabel:'Synthetic reviewed Git',exportedAt:new Date().toISOString(),rootRef:'agent',agents:[{ref:'agent',title:'Imported',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false},workingCopyMode:'separate_git',workingFolder:{directories:[],excludedPaths:[]},workingFiles:[{path:'.ponderosa-portable-review/user-data.json',artifactRef:ref}],artifacts:[{ref,kind:'document',path:'manifest.json',createdAt:new Date().toISOString(),dataBase64:original.toString('base64')}]}]};
 const initial=await f.packageEngine.importAgent(f.project.id,f.destination.id,pkg,{codex:'codex'},randomUUID(),{workingCopyMode:'separate_git',workingFilesDestination:path.join(f.dataDir,'large-recovery-one'),workingFilesActivation:{}});
 const root=f.store.getAgent(initial.rootAgentId).workingCopy.rootPath,review=path.join(root,'.ponderosa-portable-review'),external=path.join(review,'external-git'),file=path.join(external,'large.review');
 const bytes=Buffer.alloc(65*1024*1024+37,0x61),expected=createHash('sha256').update(bytes).digest('hex');
 new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'agent',scopeId:initial.rootAgentId,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite],actor:'operator'});
 await mkdir(external,{recursive:true});await writeFile(file,bytes);
 const selection=encodeURIComponent(JSON.stringify({git:true,harness:false,source:'retained_originals'}));
 const capture=()=>f.request({method:'GET',url:`/api/agents/${initial.rootAgentId}/export?mode=full&wholeWorkingFolder=true&reviewedUserData=${selection}`});
 const response=await capture();assert.equal(response.statusCode,200,response.body);const exported=response.json(),node=exported.agents[0];
 const item=node.workingFiles.find(value=>value.path==='.ponderosa-portable-review/current-git-evidence/external-git/large.review');
 assert.ok(item?.parts);assert.equal(item.parts.sha256,expected);assert.equal(item.parts.byteLength,bytes.length);
 const destination=path.join(f.dataDir,'large-recovery-two'),roots=[...new Set(exported.agents.flatMap(value=>value.workingRootRef?[value.workingRootRef]:[]))];
 assert.ok(roots.length<=1,'fixture retains a single root');
 const choices={workingCopyMode:'separate_git',workingFilesActivation:{},...(roots.length?{workingRootDestinations:{[roots[0]]:destination}}:{workingFilesDestination:destination})};
 const beforeReview=f.store.listAgents(f.project.id).length;
 const missingReview=await f.request(f.importRequest(exported,randomUUID(),choices));assert.equal(missingReview.statusCode,409,missingReview.body);assert.match(missingReview.json().error,/review source restrictions/i);assert.equal(f.store.listAgents(f.project.id).length,beforeReview);
 const reviewAccess=await f.packageEngine.reviewAccess(exported,f.destination.id,choices);
 const imported=f.ok(await f.request(f.importRequest(exported,randomUUID(),{...choices,accessSettingsResolution:{action:'keep_destination',reviewSha256:reviewAccess.reviewSha256}})));
 assert.ok(imported.rootAgentId);assert.equal(createHash('sha256').update(await readFile(path.join(destination,item.path))).digest('hex'),expected);
 assert.deepEqual(await readFile(path.join(destination,'.ponderosa-portable-review/user-data.json')),original);
 const oversized=structuredClone(exported),oversizedFile=oversized.agents[0].workingFiles.find(value=>value.path===item.path);oversizedFile.parts.byteLength=4*1024*1024*1024+1;
 const before=f.store.getProjectArtifacts(f.project.id).length,badDestination=path.join(f.dataDir,'oversized-recovery');
 const badChoices={workingCopyMode:'separate_git',workingFilesActivation:{},...(roots.length?{workingRootDestinations:{[roots[0]]:badDestination}}:{workingFilesDestination:badDestination})};
 const bad=await f.request(f.importRequest(oversized,randomUUID(),badChoices));assert.ok(bad.statusCode>=400);assert.match(bad.body,/parts manifest|decoded|limit/i);
 assert.equal(f.store.getProjectArtifacts(f.project.id).length,before,'oversized manifest publishes no artifacts');
 const unsafe=Buffer.from(bytes);unsafe.write('\nAPI_KEY=SYNTHETIC_BOUNDARY_SECRET\n',32*1024*1024-4);await writeFile(file,unsafe);
 const refused=await capture();assert.equal(refused.statusCode,400);assert.match(refused.json().error,/current retained Git evidence contains unsupported or recognizable credential data/i);assert.doesNotMatch(refused.body,/SYNTHETIC_BOUNDARY_SECRET/);assert.deepEqual(await readFile(file),unsafe);
},{handlerDeadlineMs:5000,packageHandlerDeadlineMs:120000}));

test('explicit operator full exports retain complete passive Chat title history through import restart and re-export',options,t=>withPortability(t,async f=>{
 for(let i=0;i<110;i++){
  const previousTitle=f.store.getConversation(f.chat.id).title,title=`Selected title ${i}`;f.store.updateConversation(f.chat.id,{title});
  f.workspace.append({type:'conversation_changed',projectId:f.project.id,conversationId:f.chat.id,action:'updated',titleChange:{previousTitle,title,actor:{kind:'operator_api'},origin:'operator_request',requestId:`original-request-${i}`}});
 }
 f.workspace.append({type:'conversation_changed',projectId:f.project.id,conversationId:f.destination.id,action:'updated',titleChange:{previousTitle:'Foreign',title:'FOREIGN_CHAT_PRIVATE_HISTORY',actor:{kind:'system'},origin:'automatic_title'}});
 const pkg=await f.exportAgent(f.a.id);assert.ok(Array.isArray(pkg.chatTitleHistory),'actual explicit full operator export must carry selected Chat title history');
 const selected=f.workspace.exportChatTitleHistory({projectId:f.project.id,conversationId:f.chat.id,maximumBytes:AGENT_PACKAGE_MAX_BYTES});
 assert.equal(selected.length,110);assert.equal(f.workspace.listConversationChanges({projectId:f.project.id,conversationId:f.chat.id,limit:100}).items.length,100,'export must not substitute the UI tail');
 assert.deepEqual(pkg.chatTitleHistory,selected);assert.equal(JSON.stringify(pkg.chatTitleHistory).includes('FOREIGN_CHAT_PRIVATE_HISTORY'),false);
 // This is an ordinary synthetic Agent export helper, not a temporary-copy
 // snapshot or readCheckpointBytes operation; its shared default stays private.
 const internal=await f.packageEngine.exportAgent(f.a.id,'full',{organization:true});assert.equal(internal.chatTitleHistory,undefined);
 assert.equal((await f.exportAgent(f.a.id,'template')).chatTitleHistory,undefined);
 const destinationTitle=f.store.getConversation(f.destination.id).title,imported=f.ok(await f.request(f.importRequest(pkg)));
 const rows=async id=>{const result=[];let offset=0,version;for(let i=0;i<20;i++){
  const page=f.ok(await f.request({method:'GET',url:`/api/agents/${id}/imported-communications?offset=${offset}&limit=10${version?`&archiveVersion=${version}`:''}`}));
  result.push(...(page.chatTitleHistory??[]));if(!page.hasMore)return result;assert.ok(page.nextOffset>offset);offset=page.nextOffset;version=page.archiveVersion;
 }throw Error('Unbounded history paging');};
 assert.deepEqual(await rows(imported.rootAgentId),selected);assert.equal(f.store.getConversation(f.destination.id).title,destinationTitle,'passive source history never renames the destination');
 assert.equal(f.workspace.listConversationChanges({projectId:f.project.id,conversationId:f.destination.id}).items.some(row=>row.titleChange?.title.startsWith('Selected title')),false,'source changes are not live destination Renames');
 await f.restart();assert.deepEqual(await rows(imported.rootAgentId),selected);
 const again=await f.exportAgent(imported.rootAgentId);assert.deepEqual(again.chatTitleHistory.filter(row=>row.conversationId===f.chat.id),selected,'re-export preserves original source IDs, actor, request and time');
 const legacy=structuredClone(pkg);delete legacy.chatTitleHistory;const old=f.ok(await f.request(f.importRequest(legacy)));
 assert.equal((f.ok(await f.request({method:'GET',url:`/api/agents/${old.rootAgentId}/imported-communications`}))).chatTitleHistory,undefined,'old packages remain compatible without fabricated history');
},{}));

test('selected Chat title history budget refuses oversize without clipping or changing canonical events',options,t=>withPortability(t,async f=>{
 for(let i=0;i<5;i++)f.workspace.append({type:'conversation_changed',projectId:f.project.id,conversationId:f.chat.id,action:'updated',titleChange:{previousTitle:'Before '+i,title:'After '+i,actor:{kind:'operator_api'},origin:'operator_request',requestId:'source-'+i}});
 const cursor=f.workspace.cursor();assert.throws(()=>f.workspace.exportChatTitleHistory({projectId:f.project.id,conversationId:f.chat.id,maximumBytes:128}),error=>error.statusCode===413&&/no records were omitted/u.test(error.message));
 assert.equal(f.workspace.cursor(),cursor);assert.equal(f.workspace.exportChatTitleHistory({projectId:f.project.id,conversationId:f.chat.id,maximumBytes:AGENT_PACKAGE_MAX_BYTES}).length,5);
 const pkg=await f.exportAgent(f.a.id),invalid=structuredClone(pkg);invalid.chatTitleHistory[0].change.actor={kind:'authenticated_admin'};
 const before=f.store.listAgents(f.project.id).length,response=await f.request(f.importRequest(invalid));assert.equal(response.statusCode,400);assert.equal(f.store.listAgents(f.project.id).length,before);
}));
