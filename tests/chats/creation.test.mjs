import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {AgentStore, CoordinationV3Store} from '@ponderosa/agents';
import {until, withFixture} from '../shared/fixture.mjs';
import {normalizeExternalCitations} from '../../apps/server/dist/external-content.js';

async function chatStorage(f, refresh=false) {
  const url='/api/chat-storage';
  const started=await f.api('GET',url+(refresh?'?refresh=1':''));
  assert.equal(started.status,202);
  assert.equal(started.body.measuring,true);
  let storage;
  await until(async()=>{storage=f.ok(await f.api('GET',url));return !storage.measuring;},'Chat Storage measurement');
  return storage;
}

test('human file browsing shows ordinary token-named files and public links use literal address checks', async t=>withFixture(t,async f=>{
  const chat=await f.createChat('File browsing');
  await writeFile(path.join(chat.workingDirectory,'design-tokens.css'), ':root { --space: 8px; }');
  const base=`/api/conversations/${chat.id}/files`;
  assert.ok(f.ok(await f.api('GET',base)).entries.some(file=>file.name==='design-tokens.css'));
  assert.match(f.ok(await f.api('GET',base+'?path=design-tokens.css')).content,/--space/);
  assert.equal(normalizeExternalCitations([{url:'https://fda.gov/',title:'FDA'}])[0].url,'https://fda.gov/');
  assert.throws(()=>normalizeExternalCitations([{url:'http://localhost/',title:'Local machine'}]),/external HTTP/);
}));

test('Chat attachment usage includes staged uploads and clears after scoped removal', async t=>withFixture(t,async f=>{
  const chat=await f.createChat('Attachment usage');
  const base=`/api/conversations/${chat.id}/attachments`, bytes=Buffer.from('A normal attachment');
  const asset=f.ok(await f.api('POST',base,bytes,{'content-type':'application/octet-stream','x-ponderosa-filename':'notes.txt','x-ponderosa-media-type':'text/plain'}));
  const usage=f.ok(await f.api('GET',base+'/usage'));
  assert.equal(usage.committed,bytes.length);
  assert.deepEqual(usage.unsent,[{id:asset.id,name:'notes.txt',size:bytes.length}]);
  assert.equal((await f.api('DELETE',base+'/'+asset.id)).status,204);
  assert.equal(f.ok(await f.api('GET',base+'/usage')).committed,0);
}));

test('recovered abandoned uploads can release space only after exact confirmed selection', async t=>withFixture(t,async f=>{
  const folder=path.join(f.dataDir,'agent-import-operations');
  await writeFile(path.join(folder,`.incoming-${randomUUID()}`),'unclaimed upload');
  await f.reopen();
  const base='/api/lifecycle/agent-imports/orphan-evidence';
  const item=f.ok(await f.api('GET',base)).items.find(row=>row.discardIdentity);
  assert.ok(item);
  const discard=(identity,confirmed)=>f.api('POST',base+'/discard',{name:item.name,identity,confirmed});
  assert.equal((await discard(item.discardIdentity,false)).status,400);
  assert.equal((await discard('stale',true)).status,409);
  assert.equal(f.ok(await discard(item.discardIdentity,true)).releasedBytes,item.byteLength);
  assert.ok(!f.ok(await f.api('GET',base)).items.some(row=>row.name===item.name));
}));

test('shared Chat creation validates folders, replays concurrent retries once and never takes Branch ownership from HTTP payload', {timeout:30000},t=>withFixture(t,async f=>{
 const body={label:'Creation boundary',defaultEngine:'codex'},key=randomUUID();
 const create=(value=body,id=key)=>f.api('POST','/api/chats',value,{'idempotency-key':id});
 assert.equal((await create(body,'invalid')).status,400);
 assert.equal((await create({...body,defaultEngine:''},randomUUID())).status,400);
 assert.equal((await create({...body,hostPath:path.join(f.root,'missing')},randomUUID())).status,400);
 const file=path.join(f.root,'file.txt');await writeFile(file,'fixture');
 const invalid=await create({...body,hostPath:file},randomUUID());assert.equal(invalid.status,400);assert.match(invalid.body.error,/must be a directory/);
 const responses=await Promise.all([create(),create()]),a=f.ok(responses[0]),b=f.ok(responses[1]);assert.equal(a.id,b.id);
 assert.equal((await create({...body,label:'Changed'})).status,409);
 const plain=f.ok(await create({...body,branchId:randomUUID(),executionId:randomUUID()},randomUUID()));
 assert.equal(plain.branchId,undefined);assert.equal(plain.executionId,undefined);
 await f.reopen();assert.equal(f.ok(await create()).id,a.id);
 const deletion=f.ok(await f.api('DELETE',`/api/conversations/${a.id}`,{expectedAgentIds:[]}));assert.equal(deletion.deleted,true);
 const retry=await create();assert.equal(retry.status,409);assert.match(retry.body.error,/no longer belongs to a live Chat/);
}));

test('archive fences active work, survives restart, and requires explicit release of unfinished queued inputs', { timeout: 30_000 }, t => withFixture(t, async f => {
  const chat = await f.createChat('Reversible archive');
  const agent = await f.createIdleAgent(chat, 'Running Agent');
  const queuedAgent = await f.createIdleAgent(chat, 'Queued Agent');
  const session = await f.hold(agent.id);
  const chatPath = `/api/conversations/${chat.id}`;
  const preview = f.ok(await f.api('GET', `${chatPath}/archive-preview`));
  assert.equal(preview.workingDirectory, chat.workingDirectory);
  assert.equal(preview.pending, false);
  assert.deepEqual(preview.activeRuns.map(run => run.title), ['Running Agent']);
  assert.equal((await f.api('POST', `${chatPath}/archive`, { stopRunIds: [] })).status, 409);
  assert.equal(session.isAlive(), true);
  f.ok(await f.api('POST', '/api/deployment/drain'));
  await f.send(queuedAgent.id, 'Hold this queued message', { activeRunDelivery: 'queue' });

  const stopRunIds = preview.activeRuns.map(run => run.runId);
  assert.deepEqual(f.ok(await f.api('POST', `${chatPath}/archive`, { stopRunIds })), { archived: true });
  assert.equal(session.isAlive(), false);
  assert.equal((await f.api('POST', `/api/agents/${agent.id}/messages`, {
    text: 'Do not run until restored', idempotencyKey: randomUUID(),
  })).status, 409);
  assert.ok(f.ok(await f.api('GET', chatPath)).conversation.archivedAt);

  await f.reopen();
  const archived = f.ok(await f.api('GET', '/api/chat-archives'));
  assert.deepEqual(archived.chats.map(item => item.id), [chat.id]);
  assert.equal(archived.chats[0].workingDirectory, chat.workingDirectory);
  assert.deepEqual(f.ok(await f.api('GET', `/api/projects/${chat.projectId}/conversations`)), []);
  f.ok(await f.api('POST', `${chatPath}/restore`));
  const restored = f.ok(await f.api('GET', '/api/chat-archives'));
  assert.deepEqual(restored.chats, []);
  const queued = restored.heldWork.find(item => item.preview === 'Hold this queued message');
  assert.ok(queued, JSON.stringify(restored.heldWork));

  await f.send(queuedAgent.id, 'New work after restore');
  await until(() => f.turns.some(turn => turn.input.prompt.includes('New work after restore')), 'new work after restore');
  assert.ok(!f.turns.some(turn => turn.input.prompt.includes('Hold this queued message')), 'Restore admitted held work');
  f.ok(await f.api('POST', `${chatPath}/release-archived-work`, { activationId: queued.id }));
  await until(() => f.turns.some(turn => turn.input.prompt.includes('Hold this queued message')), 'explicitly released work');
}));

test('archive retains working-folder custody and only an unreferenced managed folder can be removed', { timeout: 30_000 }, t => withFixture(t, async f => {
  const outside = path.join(f.root, 'external');
  await mkdir(outside);
  const external = f.ok(await f.api('POST', '/api/chats', {
    label: 'Selected working folder', hostPath: outside, defaultEngine: 'codex',
  }, { 'idempotency-key': randomUUID() }));
  assert.equal(external.workingDirectory, outside);

  const chat = await f.createChat('Managed folder');
  const chatPath = `/api/conversations/${chat.id}`;
  const file = path.join(chat.workingDirectory, 'report.txt');
  await writeFile(file, 'keep this');
  const folderPath = `/api/chat-storage/folders/${encodeURIComponent(path.basename(chat.workingDirectory))}`;
  f.ok(await f.api('POST', `${chatPath}/archive`));
  const storage = await chatStorage(f);
  const managed = storage.folders.find(folder => folder.path === chat.workingDirectory);
  assert.deepEqual([managed.bytes, managed.referenced], [9, true]);
  assert.equal(storage.projects.find(project => project.id === chat.projectId).artifactBytes, 0);
  assert.equal((await f.api('DELETE', folderPath, { confirmed: true, identity: managed.identity })).status, 409);
  assert.equal((await readFile(file, 'utf8')), 'keep this');
  f.ok(await f.api('DELETE', chatPath, { expectedAgentIds: [] }));
  assert.equal((await readFile(file, 'utf8')), 'keep this');

  const descendant = path.join(chat.workingDirectory, '..nested');
  await mkdir(descendant);
  const nestedChat = f.ok(await f.api('POST', '/api/chats', {
    label: 'Nested folder', hostPath: descendant, defaultEngine: 'codex',
  }, { 'idempotency-key': randomUUID() }));
  f.ok(await f.api('POST', `/api/conversations/${nestedChat.id}/archive`));
  assert.equal((await chatStorage(f,true)).folders.find(folder => folder.path === chat.workingDirectory).referenced, true);
  assert.equal((await f.api('DELETE', folderPath, { confirmed: true, identity: managed.identity })).status, 409);
  f.ok(await f.api('DELETE', `/api/conversations/${nestedChat.id}`, { expectedAgentIds: [] }));

  assert.equal((await f.api('DELETE', folderPath, { confirmed: false })).status, 400);
  assert.equal((await f.api('DELETE', folderPath, { confirmed: true, identity: '0'.repeat(64) })).status, 409);
  const externalFile = path.join(outside, 'outside.txt');
  await writeFile(externalFile, 'outside');
  if (process.platform === 'linux') await symlink(outside, path.join(chat.workingDirectory, 'external-link'));
  f.ok(await f.api('DELETE', folderPath, { confirmed: true, identity: managed.identity }));
  assert.equal(await readFile(externalFile, 'utf8'), 'outside');
  await assert.rejects(readFile(file), { code: 'ENOENT' });
}));

test('an interrupted archive is visible after restart and only resumes by explicit action', { timeout: 30_000 }, async t => {
  let store;
  await withFixture(t, async f => {
    const chat = await f.createChat('Interrupted archive');
    const agent = await f.createIdleAgent(chat, 'Idle Agent');
    const chatPath = `/api/conversations/${chat.id}`;
    store.sqlite.prepare('INSERT INTO chat_archives(conversation_id) VALUES (?)').run(chat.id);
    await f.reopen();

    assert.equal(f.ok(await f.api('GET', chatPath)).conversation.archivePending, true);
    assert.deepEqual(f.ok(await f.api('GET', `${chatPath}/archive-preview`)), {
      pending: true, activeRuns: [], workingDirectory: chat.workingDirectory,
    });
    assert.deepEqual(f.ok(await f.api('GET', '/api/chat-archives')).pendingChats.map(item => item.id), [chat.id]);
    assert.equal((await f.api('POST', `${chatPath}/restore`)).status, 409);
    assert.equal((await f.api('POST', `/api/agents/${agent.id}/messages`, {
      text: 'Keep work paused', idempotencyKey: randomUUID(),
    })).status, 409);

    assert.deepEqual(f.ok(await f.api('POST', `${chatPath}/archive`, { stopRunIds: [] })), { archived: true });
    const archive = f.ok(await f.api('GET', '/api/chat-archives'));
    assert.deepEqual(archive.pendingChats, []);
    assert.deepEqual(archive.chats.map(item => item.id), [chat.id]);
    f.ok(await f.api('POST', `${chatPath}/restore`));
    assert.equal(f.ok(await f.api('GET', chatPath)).conversation.archivePending, undefined);
    assert.equal(f.turns.length, 0);
  }, { storeFactory: dir => store = new AgentStore(dir) });
});

test('restore exposes the exact held handoff that blocks new work without dispatching it', { timeout: 30_000 }, async t => {
  let store;
  await withFixture(t, async f => {
    const chat = await f.createChat('Archived handoff');
    const agent = await f.createIdleAgent(chat, 'Transition Agent');
    const otherAgent = await f.createIdleAgent(chat, 'Independent Agent');
    const chatPath = `/api/conversations/${chat.id}`;
    await f.send(agent.id, 'Complete the prior task');
    const source = await until(() => store.sqlite.prepare(`
      SELECT id, provider_session_id FROM scheduler_runs WHERE agent_id=? AND status='completed'
    `).get(agent.id), 'prior completed Run');
    f.ok(await f.api('POST', '/api/deployment/drain'));
    await f.send(agent.id, 'Earlier held message', { activeRunDelivery: 'queue' });
    const scopeKey = `conversation:${chat.id}`;
    const bound = store.bindContextRolloverBoundary({
      agentId: agent.id, currentConversationId: chat.id, maxUtf8Bytes: 12000,
      submittedCommunicationEventIds: store.acceptedProviderSessionCommunicationEventIds(agent.id),
    });
    const coordination = new CoordinationV3Store(store.sqlite);
    const { rollover } = coordination.requestContextRollover({
      projectId: chat.projectId, agentId: agent.id, oldProviderSessionId: source.provider_session_id,
      providerSessionGeneration: source.provider_session_id, detectedOccupancy: 160000, threshold: 150000, lowWaterMark: 90000,
      sourceRunId: source.id, compactionCutoffOrdinal: bound.canonicalOrdinal,
      compactionCutoffEventId: bound.communicationEventId, recentTail: bound.recentTail,
      sourceActivationIds: coordination.activationIdsAttachedToRun(source.id, agent.id), scopeKey, conversationId: chat.id,
    });
    const handoff = store.sqlite.prepare(`
      SELECT activation_id AS id FROM activation_sources WHERE source_kind='context_rollover' AND source_id=?
    `).get(rollover.id);
    f.ok(await f.api('POST', `${chatPath}/archive`));
    f.ok(await f.api('POST', `${chatPath}/restore`));
    const archive = f.ok(await f.api('GET', '/api/chat-archives'));
    assert.deepEqual(archive.heldWork.filter(item => item.blocksNewWork).map(item => item.id), [handoff.id]);
    assert.deepEqual(f.ok(await f.api('GET', chatPath)).conversation.archivedWorkBlockingAgents, [agent.title]);
    f.ok(await f.api('POST', '/api/deployment/resume'));
    await f.send(agent.id, 'New work waiting for the handoff');
    await f.send(otherAgent.id, 'Independent new work');
    await until(() => f.turns.some(turn => turn.input.prompt.includes('Independent new work')), 'independent new work');
    assert.equal(f.turns.filter(turn => turn.agentId === agent.id).length, 1);
    f.ok(await f.api('POST', '/api/deployment/drain'));
    f.ok(await f.api('POST', `${chatPath}/release-archived-work`, { activationId: handoff.id }));
    assert.equal(f.ok(await f.api('GET', chatPath)).conversation.archivedWorkBlockingAgents, undefined);
    const remaining = f.ok(await f.api('GET', '/api/chat-archives')).heldWork;
    assert.ok(remaining.some(item => item.preview === 'Earlier held message'));
  }, { storeFactory: dir => store = new AgentStore(dir) });
});

test('archive leaves a Chat available if idle provider cleanup fails and preserves the saved session on retry', { timeout: 30_000 }, async t => {
  let store;
  let refuseClose = false;
  const previous = process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
  process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
    else process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = previous;
  });
  await withFixture(t, async f => {
    const chat = await f.createChat('Retry archive cleanup');
    const agent = await f.createIdleAgent(chat, 'Retained Agent');
    const chatPath = `/api/conversations/${chat.id}`;
    await f.send(agent.id, 'Complete work before archiving');
    await f.settled(agent.id, []);
    const session = f.sessions.get(agent.id);
    const savedSession = store.resumeSessionId(agent.id);
    assert.equal(session.isAlive(), true);
    assert.equal(savedSession, session.engineAgentId);
    try {
      refuseClose = true;
      const blocked = await f.api('POST', `${chatPath}/archive`, { stopRunIds: [] });
      assert.equal(blocked.status, 409);
      assert.match(blocked.body.error, /runtime authority drain/i);
      assert.equal(f.ok(await f.api('GET', chatPath)).conversation.archivePending, undefined);
      assert.equal(f.ok(await f.api('GET', chatPath)).conversation.archivedAt, undefined);
      assert.equal(session.isAlive(), true);
    } finally { refuseClose = false; }
    f.ok(await f.api('POST', `${chatPath}/archive`, { stopRunIds: [] }));
    assert.equal(session.isAlive(), false);
    assert.equal(store.resumeSessionId(agent.id), savedSession);
  }, {
    storeFactory: dir => store = new AgentStore(dir),
    beforeRuntimeClose: () => { if (refuseClose) throw Error('Controlled idle provider close refusal'); },
  });
});
