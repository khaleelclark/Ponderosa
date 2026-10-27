import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { AgentStore, publishManagedArtifactContentAsync, readManagedArtifactContent, importedAgentHistoryPath } from '@ponderosa/agents';
import { deriveCommunicationBehavior } from '@ponderosa/core';
import { AssetStore } from '../../apps/server/dist/assets.js';
import { registerAgentPackageRoutes } from '../../apps/server/dist/routes/agent-packages.js';

// Reconciled from the October 16 17-assertion review. Actual routes/SQLite and
// managed bytes, with no listener, scheduler, provider session or user profile.
async function withPortability(t, run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ponderosa-portability-'));
  let store, assets, app, passed = false;
  const open = () => {
    store = new AgentStore(dataDir); assets = new AssetStore(dataDir); app = Fastify();
    registerAgentPackageRoutes(app, {
      dataDir, store, assets,
      coordination: { runtimeArtifact: () => undefined, handleAgentDeletion() {} },
      engines: new Map([['codex', { adapter: { id: 'codex', listModels: () => [], listEfforts: () => [] } }]]),
      deletingProjectIds: new Set(), deletingConversationIds: new Set(), deletingAgentIds: new Set(),
      agentCreationConversationLeases: new Map(), cachedModelOptions: () => [], appendWorkspace() {},
      agentMessages: id => store.getProjectedAgentMessages(id), createOperationalNotification() {},
    });
  };
  const close = async () => { await app?.close(); assets?.close(); store?.close(); };
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
    communication({ kind: 'user', userId: 'operator' }, 'user_dm',
      { kind: 'user_agent', userId: 'operator', agentId: a.id }, 'PRIVATE_DM_MARKER', {
        attachments: [{ id: randomUUID(), agentId: a.id, name: 'upload.txt', mediaType: 'text/plain', size: 5, url: '/fixture-upload' }],
      });
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
      exportAgent, copy, copyRequest, importRequest, projection, get store() { return store; },
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
  assert.deepEqual(Object.keys(pkg.agents[0].history.find(x => x.text === f.collaboration.text)).sort(), ['createdAt', 'role', 'text']);
  for (const excluded of ['upload.txt', 'UNRELATED_PRIVATE_MARKER', 'BROADCAST_WITHOUT_AGENT_PROJECTION', 'UNMANAGED_FILE_MARKER']) assert.equal(JSON.stringify(pkg).includes(excluded), false);
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
    const artifact = f.store.getProjectArtifacts(f.project.id).find(x => x.originAgentId === copy.rootAgentId);
    const imported = f.store.getImportedHistory(copy.rootAgentId);
    assert.equal(imported.initialInstructions, `INITIAL_GUIDANCE ponderosa://artifact/${artifact.id}`);
    assert.equal(synthetic(f.projection(copy.rootAgentId))[0]?.text, imported.initialInstructions);
    assert.deepEqual(readManagedArtifactContent(f.dataDir, f.project.id, artifact.id, artifact.size, artifact.sha256)?.body, f.bytes);
    counts.push(synthetic(f.projection(copy.rootAgentId)).length);
    assert.equal(f.store.getImportedHistoryMessagePage(copy.rootAgentId, { limit: 100 }).items.filter(x =>
      x.text.startsWith('[Imported private context]\nImported initial instructions:\nINITIAL_GUIDANCE')).length, 1);
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
 const artifact=f.store.getProjectArtifacts(f.project.id).find(a=>a.originAgentId===imported.rootAgentId),rewritten=text.replaceAll(f.artifactId,artifact.id);
 assert.ok(archive.initialInstructions===rewritten,'complete guidance rewrites only the artifact reference');
 assert.equal(historyHash(archive.messages),historyHash(node.history.map(message=>({...message,text:rewritten}))));
 const again=await f.exportAgent(imported.rootAgentId);
 assert.ok(again.agents[0].initialInstructions===rewritten);assert.equal(historyHash(again.agents[0].history),historyHash(archive.messages));
 await f.restart();assert.equal(historyHash(f.store.getImportedHistory(imported.rootAgentId).messages),historyHash(archive.messages));
 let source=imported.rootAgentId,currentArtifact=artifact.id,expected=rewritten;
 for(let generation=0;generation<3;generation++){
  const copied=await f.copy(source),mapped=f.store.getProjectArtifacts(f.project.id).find(item=>item.originAgentId===copied.rootAgentId);
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
