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
