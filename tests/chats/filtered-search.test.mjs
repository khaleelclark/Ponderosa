import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../shared/fixture.mjs';

// Reconciled from the October 16 proposal: real handlers/SQLite via Fastify
// injection, no listener. Add empty/Unicode coverage and retain failed fixtures.
test('collection searches preserve literal text and scope through real HTTP routes', async t => {
  const f = await fixture();
  const observations = [];
  let failed = false, complete = false;
  const check = (name, run) => t.test(name, async () => {
    try { await run(); } catch (error) { failed = true; throw error; }
  });
  try {
    const chat = await f.createChat('Orchard plain 100% under_score slash\\path mixed%_\\ literal café 東京 🌲');
    const titles = ['Orchard plain', 'Orchard 100% literal', 'Orchard 100X literal',
      'Orchard under_score literal', 'Orchard underXscore literal',
      'Orchard slash\\path literal', 'Orchard slashpath literal', 'Orchard mixed%_\\ literal', 'Orchard café 東京 🌲'];
    const conversations = [chat], members = [];
    for (const title of titles) members.push(await f.createIdleAgent(chat, title));
    // A current Chat owns one namespace: use separate Chats rather than nesting them.
    // The other Project supplies matching titles that none of these routes may include.
    const outside = await f.createChat('Orchard plain outsider');
    await f.createIdleAgent(outside, 'Orchard plain outsider%_\\');
    const worker = await f.createIdleAgent(chat, 'Authored control');
    members.push(worker);
    const marker = `filtered-search-authored-${randomUUID()}`;
    f.plans.set(worker.id, [{ run: async session => {
      const result = await session.tool('ponderosa_message', { text: marker });
      assert.equal(result.success, true, result.text);
    } }]);
    await f.send(worker.id, 'Produce the isolated authored-search control.');
    await f.settled(worker.id);
    const endpoints = [
      { name: 'team directory', path: `/api/projects/${chat.projectId}/team-directory`,
        expected: members, items: body => body.agents.map(agent => ({ id: agent.agentId })) },
      { name: 'project conversations', path: `/api/projects/${chat.projectId}/conversations`,
        expected: conversations, items: body => body },
      { name: 'conversation members', path: `/api/conversations/${chat.id}/members`,
        expected: members, items: body => body },
    ];
    const terms = [undefined, '', '   ', 'café 東京 🌲', 'Orchard plain', '  ORCHARD PLAIN  ', '%', '_', '\\',
      '100%', 'under_score', 'slash\\path', 'mixed%_\\', 'no-such-collection-entry'];
    for (const endpoint of endpoints) for (const term of terms) {
      await check(`${endpoint.name}: ${term === undefined ? 'unfiltered' : JSON.stringify(term)}`, async () => {
        const query = new URLSearchParams({ limit: '100', ...(term === undefined ? {} : { search: term }) });
        const url = `${endpoint.path}?${query}`;
        const response = await f.api('GET', url);
        const body = response.body;
        const normalized = term?.trim().toLocaleLowerCase() ?? '';
        const expectedIds = endpoint.expected.filter(item => item.title.toLocaleLowerCase().includes(normalized))
          .map(item => item.id).sort();
        const observation = { endpoint: endpoint.name, term: term ?? null, url, status: response.status,
          expectedIds, ...(response.status === 200 ? { actualIds: endpoint.items(body).map(item => item.id).sort() } : { error: body }) };
        observations.push(observation);
        assert.equal(response.status, 200, JSON.stringify(observation));
        assert.deepEqual(observation.actualIds, expectedIds, 'matching entries included; wildcard decoys and out-of-scope entries excluded');
        if (endpoint.name === 'team directory') {
          assert.equal(body.totalAgents, expectedIds.length);
          assert.equal(body.hasMoreAgents, false);
        }
      });
    }
    // Project-conversation namespaces currently contain one Chat. Rename only this
    // owned Chat to wildcard decoys to prove literal filters exclude nonmatches.
    for (const term of ['%', '_', '\\']) {
      await check(`project conversations: literal ${JSON.stringify(term)} excludes wildcard decoy`, async () => {
        const decoy = 'Orchard 100X underXscore slashpath mixedXYZ literal';
        f.ok(await f.api('PATCH', `/api/conversations/${chat.id}`, { title: decoy }));
        const response = await f.api('GET', endpoints[1].path + '?' + new URLSearchParams({ search: term }));
        const body = response.body;
        observations.push({ endpoint: 'project conversations decoy', term, status: response.status,
          expectedIds: [], ...(response.status === 200 ? { actualIds: body.map(item => item.id) } : { error: body }) });
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.deepEqual(body, [], 'literal special character must not match its ordinary-text decoy');
        const control = await f.api('GET', endpoints[1].path);
        assert.equal(control.status, 200);
        assert.deepEqual(control.body.map(item => item.id), [chat.id]);
      });
    }
    f.ok(await f.api('PATCH', `/api/conversations/${chat.id}`, { title: chat.title }));
    for (const [name, term, shouldMatch] of [['authored hit', marker, true], ['authored miss', 'nonexistent-authored-control', false]]) {
      await check(`global authored search: ${name}`, async () => {
        const response = await f.api('GET', '/api/search?' + new URLSearchParams({ q: term, limit: '25' }));
        const body = response.body;
        observations.push({ endpoint: 'global authored search', term, status: response.status,
          results: body.results?.map(item => ({ author: item.author, snippet: item.snippet })) });
        assert.equal(response.status, 200, JSON.stringify(body));
        if (shouldMatch) {
          assert.equal(body.results.length, 1);
          assert.equal(body.results[0].author.agentId, worker.id);
          assert.ok(body.results[0].snippet.includes(marker));
        } else assert.deepEqual(body.results, []);
      });
    }
    await check('empty global Agent search excludes recent Chats', async () => {
      const agents = f.ok(await f.api('GET', '/api/search?kind=agent'));
      assert.ok(agents.recentChats.every(item => item.chat.kind === 'agent'));
      const chats = f.ok(await f.api('GET', '/api/search?kind=conversation'));
      assert.ok(chats.recentChats.length > 0);
      assert.ok(chats.recentChats.every(item => item.chat.kind === 'conversation'));
    });
    complete = true;
  } finally {
    const identities = [...f.sessions.values()].map(session => session.processIdentity).filter(Boolean);
    const passed = complete && !failed;
    await f.dispose(passed);
    if (!passed) t.diagnostic(`Failed disposable fixture retained: ${f.root}`);
    const custody = { fixtureRoot: f.root, fixtureRootRemoved: !existsSync(f.root),
      providerRootsExited: [...f.sessions.values()].every(session => !session.isAlive()),
      providerRoots: identities, listenerStarted: false, browserStarted: false, realProviderRequests: 0 };
    if (process.env.PONDEROSA_SEARCH_EVIDENCE) {
      await writeFile(process.env.PONDEROSA_SEARCH_EVIDENCE, JSON.stringify({ observations, custody }, null, 2));
    }
    assert.equal(custody.fixtureRootRemoved, passed);
    assert.equal(custody.providerRootsExited, true);
  }
});

test('F10: committed operator Agent creation and rename publish live directory invalidation', { timeout: 10_000 }, async t => {
  const f = await fixture(); let passed = false, reader;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const chat = await f.createChat('Owned live directory');
    const response = await fetch(await f.listen() + '/api/workspace/stream', { signal: controller.signal });
    assert.equal(response.status, 200); reader = response.body.getReader();
    await reader.read(); // Initial status/heartbeat confirms the subscriber is attached.
    let buffer = ''; const decoder = new TextDecoder();
    const change = async () => {
      for (;;) {
        const next = await reader.read(); assert.equal(next.done, false);
        buffer += decoder.decode(next.value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          const envelope = JSON.parse(data.slice(6));
          if (envelope.event?.type === 'project_changed' && envelope.event.projectId === chat.projectId) return envelope;
        }
      }
    };
    const agent = await f.createIdleAgent(chat, 'Original directory needle');
    const created = await change(); assert.equal(created.event.action, 'updated'); assert.ok(!created.replayed);
    f.ok(await f.api('PATCH', `/api/agents/${agent.id}`, { title: 'Renamed directory needle' }));
    const renamed = await change(); assert.equal(renamed.event.action, 'updated'); assert.ok(renamed.id > created.id);
    const directory = f.ok(await f.api('GET', '/api/workspace/directory/agent?search=Renamed%20directory%20needle'));
    assert.equal(directory.items[0].agent.id, agent.id);
    assert.equal(directory.items[0].ownerConversation.id, chat.id);
    passed = true;
  } finally {
    clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {});
    if (!passed) t.diagnostic(`Live event fixture retained: ${f.root}`);
    await f.dispose(passed);
  }
});

const { reconcileCommittedAgentCreation } = await import('../../apps/server/dist/agent-creation-recovery.js');
const { recoverCanonicalAgentCreations } = await import('../../apps/server/dist/server-lifecycle.js');
for (const background of [false, true]) for (const failure of ['none', 'projection', 'publication']) {
  test(`F10: ${background ? 'background' : 'retry'} creation recovery publishes only visible completion: ${failure}`, async () => {
    const operation = { id: 'owned-operation', projectId: 'owned-project', agentIds: ['owned-agent'], communicationEventId: 'owned-opening', status: 'canonical_committed' };
    const quarantine = new Set(operation.agentIds), observations = [];
    const store = { listRecoverableAgentCreationOperations: () => [operation], updateAgentCreationOperation(_id, patch) { Object.assign(operation, patch); } };
    const appendWorkspace = event => {
      observations.push({ event, status: operation.status, quarantined: quarantine.has('owned-agent') });
      if (failure === 'publication') throw new Error('Owned publication failure');
    };
    const reconcile = async () => { if (failure === 'projection') throw new Error('Owned projection failure'); };
    const result = background
      ? (await recoverCanonicalAgentCreations({ store, deletingAgentIds: quarantine, appendWorkspace, reconcileRuntimeCommunicationProjections: reconcile })).recovered === 1
      : await reconcileCommittedAgentCreation({ store, deletingAgentIds: quarantine, appendWorkspace, operationId: operation.id, projectId: operation.projectId,
        communicationEventId: operation.communicationEventId, agentIds: operation.agentIds, reconcile });
    assert.equal(result, failure !== 'projection');
    if (failure === 'projection') { assert.deepEqual(observations, []); assert.equal(quarantine.has('owned-agent'), true); }
    else {
      assert.deepEqual(observations, [{ event: { type: 'project_changed', projectId: 'owned-project', action: 'updated' }, status: 'completed', quarantined: false }]);
      assert.equal(operation.status, 'completed'); assert.equal(quarantine.size, 0);
    }
  });
}

test('first filtered collection requests work before any provider turn in Dev and Branches',async t=>{
 const f=await fixture();let passed=false;
 try{
  const title='Cold 100%_\\literal 🌲',dev=await f.createChat(title),first=await f.createIdleAgent(dev,title);
  const branchResponse=await f.api('POST','/api/branches',{name:'Cold Branch',idempotencyKey:'cold-filter-branch'});assert.equal(branchResponse.status,200,JSON.stringify(branchResponse.body));
  const chatResponse=await f.api('POST','/api/branches/'+branchResponse.body.id+'/chats',{label:title,defaultEngine:'codex'},{'idempotency-key':randomUUID()});assert.equal(chatResponse.status,200,JSON.stringify(chatResponse.body));
  const branchChat=chatResponse.body,agentResponse=await f.api('POST','/api/branches/engine/projects/'+branchChat.projectId+'/agents',{title,engine:'codex',conversationId:branchChat.id,idempotencyKey:'cold-filter-agent'});assert.equal(agentResponse.status,200,JSON.stringify(agentResponse.body));
  const query='?'+new URLSearchParams({search:'100%_\\literal',limit:'100'});
  for(const [scope,chat,agent,prefix] of [['Dev',dev,first,'/api'],['Branches',branchChat,agentResponse.body,'/api/branches/engine']]){
   for(const [label,path,items] of [
    ['directory',prefix+'/projects/'+chat.projectId+'/team-directory',body=>body.agents.map(a=>a.agentId)],
    ['Chats',prefix+'/projects/'+chat.projectId+'/conversations',body=>body.map(c=>c.id)],
    ['members',prefix+'/conversations/'+chat.id+'/members',body=>body.map(a=>a.id)],
   ])await t.test(scope+' first filtered '+label,async()=>{const response=await f.api('GET',path+query);assert.equal(response.status,200,JSON.stringify(response.body));assert.deepEqual(items(response.body),[label==='Chats'?chat.id:agent.id])});
  }
  assert.equal(f.sessions.size,0,'filter readiness must not depend on provider priming');
  passed=true;
 }finally{await f.dispose(passed)}
});
