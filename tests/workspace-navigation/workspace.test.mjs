import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withFixture, fixtureTestOptions as options } from '../shared/fixture.mjs';


test('checks 61, 62, 63: folder membership, rename, order, stars and collapse persist with conflict fencing', options, t => withFixture(t, async f => {
  const a = await f.createChat('Chat A'), b = await f.createChat('Chat B'), c = await f.createChat('Chat C');
  const url = '/api/workspace/preferences', initial = f.ok(await f.api('GET', url));
  const folders = [{ id: randomUUID(), name: 'First folder', expanded: true, conversationIds: [a.id, b.id] }, { id: randomUUID(), name: 'Second folder', expanded: true, conversationIds: [c.id] }];
  const saved = f.ok(await f.api('PATCH', url, { chatFolders: folders, chatFoldersRevision: initial.revision }));
  const moved = [{ ...folders[1], name: 'Renamed folder', expanded: false, starred: true, conversationIds: [c.id, b.id] }, { ...folders[0], conversationIds: [a.id] }];
  const reordered = f.ok(await f.api('PATCH', url, { chatFolders: moved, chatFoldersRevision: saved.revision, chatSort: 'custom', chatOrder: [c.id, b.id, a.id], starredResourceIds: [`conversation:${b.id}`] }));
  assert.equal((await f.api('PATCH', url, { chatFolders: folders, chatFoldersRevision: saved.revision })).status, 409);
  assert.equal((await f.api('PATCH', url, { chatFolders: [...moved, { id: randomUUID(), name: 'Duplicate membership', expanded: true, conversationIds: [b.id] }], chatFoldersRevision: reordered.revision })).status, 400);
  await f.reopen();
  const reopened = f.ok(await f.api('GET', url)); assert.deepEqual(reopened.chatFolders, moved); assert.deepEqual(reopened.chatOrder, [c.id, b.id, a.id]); assert.deepEqual(reopened.starredResourceIds, [`conversation:${b.id}`]);
  f.ok(await f.api('PATCH', url, { chatFolders: [moved[1]], chatFoldersRevision: reopened.revision }));
  for (const chat of [a, b, c]) assert.equal(f.ok(await f.api('GET', `/api/conversations/${chat.id}`)).conversation.projectId, chat.projectId, 'Display grouping changed storage ownership');
}));

test('check 63: recent resources retain stable identities and unknown routes do not replace them', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Remembered resource'), agent = await f.createIdleAgent(chat, 'Remembered Agent');
  f.ok(await f.api('POST', '/api/workspace/recent-resources/use', { kind: 'conversation', resourceId: chat.id }));
  f.ok(await f.api('POST', '/api/workspace/recent-resources/use', { kind: 'agent', resourceId: agent.id }));
  assert.equal((await f.api('POST', '/api/workspace/recent-resources/use', { kind: 'agent', resourceId: randomUUID() })).status, 404);
  await f.reopen();
  const recent = f.ok(await f.api('GET', '/api/workspace/recent-resources'));
  assert.ok(recent.resources.some(x => x.kind === 'conversation' && x.resourceId === chat.id)); assert.ok(recent.resources.some(x => x.kind === 'agent' && x.resourceId === agent.id));
}));

test('checks 64, 66: search filters and focus lookups identify the exact source message and Chat', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Search source'), other = await f.createChat('Other source'), agent = await f.createIdleAgent(chat, 'Search Agent');
  const marker = `needle${randomUUID().replaceAll('-', '')}`;
  const receipt = f.ok(await f.api('POST', `/api/conversations/${chat.id}/messages`, { text: `Shared ${marker}`, idempotencyKey: randomUUID() }));
  await f.send(agent.id, `Private ${marker}`); await f.settled(agent.id);
  const peer = await f.createIdleAgent(chat, 'Search peer'), sender = await f.hold(agent.id);
  f.plans.set(peer.id, [{ hold: true }]);
  f.ok(await f.tool(sender, 'ponderosa_message', { intent: 'collaboration', recipientAgentIds: [peer.id], urgency: 'urgent', text: `Collaboration ${marker}` }));
  for (const kind of ['conversation', 'agent']) {
    const found = f.ok(await f.api('GET', `/api/search?q=${marker}&kind=${kind}`));
    assert.ok(found.results.length > 0); assert.ok(found.results.every(x => x.chat.kind === kind && x.project.id === chat.projectId));
    assert.ok(!found.results.some(x => x.project.id === other.projectId));
    if (kind === 'conversation') {
      const hit = found.results.find(x => x.communicationEventId === receipt.communicationEventId); assert.ok(hit);
      const focus = f.ok(await f.api('GET', `/api/conversations/${chat.id}?limit=1&focusId=${encodeURIComponent(hit.messageId)}`));
      assert.ok(focus.messages.some(x => x.communicationEventId === hit.communicationEventId));
    }
  }
  assert.equal(f.ok(await f.api('GET', '/api/search?q=nonexistentfixtureword&kind=agent')).results.length, 0);
  assert.equal((await f.api('GET', `/api/search?q=${marker}&kind=invalid`)).status, 400);
}));

test('checks 23, 65, 66, 68: working-file search pages stay bound to query and owner, and browsing can refresh', options, t => withFixture(t, async f => {
  const a = await f.createChat('Files A'), b = await f.createChat('Files B');
  await mkdir(path.join(a.workingDirectory, 'notes')); await mkdir(path.join(b.workingDirectory, 'notes'));
  for (const name of ['match-a.txt', 'match-b.txt', 'match-c.txt']) await writeFile(path.join(a.workingDirectory, 'notes', name), `A ${name}`);
  await writeFile(path.join(b.workingDirectory, 'notes', 'match-private.txt'), 'B private');
  const base = `/api/search/files?projectId=${a.projectId}&conversationId=${a.id}&q=match&limit=1`, ids = []; let cursor, first;
  do {
    const page = f.ok(await f.api('GET', base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''))); first ??= page;
    assert.ok(page.results.every(x => x.project.id === a.projectId && x.conversationId === a.id)); ids.push(...page.results.map(x => x.path)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids.sort(), ['notes/match-a.txt', 'notes/match-b.txt', 'notes/match-c.txt']);
  assert.equal(new Set(ids).size, 3);
  assert.equal((await f.api('GET', base.replace('q=match', 'q=changed') + `&cursor=${encodeURIComponent(first.nextCursor)}`)).status, 400);
  assert.equal((await f.api('GET', base.replace(a.id, b.id))).status, 404);
  const browse = () => f.api('GET', `/api/conversations/${a.id}/files?path=notes`).then(f.ok);
  assert.equal((await browse()).entries.length, 3);
  await writeFile(path.join(a.workingDirectory, 'notes', 'new.txt'), 'New file'); assert.equal((await browse()).entries.length, 4);
  assert.equal(f.ok(await f.api('GET', `/api/conversations/${a.id}/files`)).kind, 'dir');
  assert.equal((await f.api('GET', `/api/conversations/${a.id}/files?path=../outside.txt`)).status, 400);
}));

test('checks 13, 57: older message and work-log pages retain exact IDs without duplicates', options, t => withFixture(t, async f => {
  const chat = await f.createChat('History pages'), agent = await f.createIdleAgent(chat, 'History Agent');
  const runIds = [];
  for (const text of ['First message', 'Second message', 'Third message']) { await f.send(agent.id, text); const d = await f.settled(agent.id, runIds); runIds.splice(0, runIds.length, ...d.runs.map(x => x.id)); }
  const ids = []; let cursor;
  do {
    const page = f.ok(await f.api('GET', `/api/agents/${agent.id}/history/runOutput?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    ids.push(...page.items.map(x => x.id)); assert.ok(page.items.every(x => runIds.includes(x.executionId))); cursor = page.history.cursor;
  } while (cursor);
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
  const full = await f.detail(agent.id), target = full.messages.at(-1);
  const focused = f.ok(await f.api('GET', `/api/agents/${agent.id}?limit=1&focusId=${encodeURIComponent(target.id)}`));
  assert.ok(focused.messages.some(x => x.id === target.id));
  const input = f.ok(await f.api('GET', `/api/runs/${runIds[0]}/provider-input?exact=1`)); assert.ok(input.exactPrompt);
}));

test('check 90: usage ranges and owner filters report known totals and unavailable metrics honestly', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Usage source'), other = await f.createChat('Unused scope'), agent = await f.createAgent(chat, 'Counted Agent');
  const usage = f.ok(await f.api('GET', `/api/agents/${agent.id}/usage`));
  assert.equal(usage.finalizedRuns, 1); assert.equal(usage.reportedRuns, 1); assert.equal(usage.inputTokens, 20); assert.equal(usage.outputTokens, 8);
  assert.equal(usage.metricAvailability.inputTokens, 'available'); assert.equal(usage.metricAvailability.reasoningOutputTokens, 'unavailable');
  assert.equal(f.ok(await f.api('GET', `/api/conversations/${other.id}/usage`)).finalizedRuns, 0);
  assert.equal(f.ok(await f.api('GET', `/api/agents/${agent.id}/usage?from=2099-01-01T00:00:00.000Z`)).finalizedRuns, 0);
  assert.equal((await f.api('GET', `/api/agents/${agent.id}/usage?from=invalid`)).status, 400);
  assert.equal((await f.api('GET', `/api/agents/${agent.id}/usage?from=2026-01-02&to=2026-01-01`)).status, 400);
}));

test('checks 59, 89: acknowledgement does not answer a Decision; resolution and category clearing affect the intended notification', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Needs attention'), a = await f.createIdleAgent(chat, 'Question A'), b = await f.createIdleAgent(chat, 'Question B');
  const sA = await f.hold(a.id), sB = await f.hold(b.id);
  const dA = f.ok(await f.tool(sA, 'ponderosa_decision', { question: 'First pending question', mode: 'text', blocking: true }));
  const dB = f.ok(await f.tool(sB, 'ponderosa_decision', { question: 'Second pending question', mode: 'text', blocking: true }));
  const list = () => f.api('GET', '/api/notifications').then(f.ok), before = await list();
  const nA = before.items.find(x => x.decision?.id === dA.id), nB = before.items.find(x => x.decision?.id === dB.id);
  assert.ok(nA && nB); assert.equal(before.openActionCount, 2);
  assert.equal((await f.api('POST', `/api/notifications/${nA.id}/read`)).status, 409);
  f.ok(await f.api('POST', '/api/notifications/acknowledge-batch', { notificationIds: [nA.id, nA.id] }));
  const acknowledged = await list(); assert.equal(acknowledged.openActionCount, 2); assert.equal(acknowledged.unacknowledgedActionCount, 1);
  assert.equal(f.ok(await f.api('GET', `/api/decisions?agentId=${a.id}&status=pending`)).length, 1);
  f.ok(await f.api('POST', '/api/notifications/dismiss-all', { kind: 'updates' })); assert.equal((await list()).openActionCount, 2);
  f.ok(await f.api('POST', `/api/decisions/${dA.id}/respond`, { text: 'Exact first answer' }));
  const after = await list(); assert.equal(after.openActionCount, 1); assert.ok(after.items.some(x => x.id === nB.id && x.status === 'open'));
  assert.equal(f.ok(await f.api('GET', `/api/decisions?agentId=${b.id}&status=pending`))[0].id, dB.id);
}));

test('check 89: Agent notification override and inherited Chat mode persist without changing other scopes', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Notification inheritance'), other = await f.createChat('Other settings'), agent = await f.createIdleAgent(chat, 'Inheriting Agent');
  f.ok(await f.api('PUT', `/api/notification-settings/conversation/${chat.id}`, { mode: 'muted' }));
  f.ok(await f.api('PUT', `/api/notification-settings/agent/${agent.id}`, { mode: 'all' }));
  f.ok(await f.api('PUT', `/api/notification-settings/agent/${agent.id}`, { mode: 'inherit' }));
  await f.reopen(); const prefs = f.ok(await f.api('GET', '/api/workspace/preferences'));
  assert.equal(prefs.notificationScopes[`conversation:${chat.id}`], 'muted'); assert.equal(prefs.notificationScopes[`agent:${agent.id}`], undefined); assert.equal(prefs.notificationScopes[`conversation:${other.id}`], undefined);
  assert.equal((await f.api('PUT', `/api/notification-settings/conversation/${chat.id}`, { mode: 'inherit' })).status, 400);
}));


test('Chat roster and collection searches treat percent, underscore and backslash as literal text',options,t=>withFixture(t,async f=>{
 const marker='060 %_'+String.fromCharCode(92)+' literal';
 const chat=await f.createChat('Chat '+marker),target=await f.createIdleAgent(chat,'Agent '+marker);
 await f.createIdleAgent(chat,'Agent 060 anything literal');
 for(const url of [`/api/conversations/${chat.id}/members`,`/api/projects/${chat.projectId}/agents`,`/api/projects/${chat.projectId}/conversations`,`/api/projects/${chat.projectId}/team-directory`,'/api/projects']){
  const result=f.ok(await f.api('GET',`${url}?search=${encodeURIComponent(marker)}&limit=1`));
  if(url.endsWith('/team-directory'))assert.equal(result.totalAgents,1);
  else{assert.equal(result.length,1);if(url.endsWith('/agents')||url.endsWith('/members'))assert.equal(result[0].id,target.id);else if(url.endsWith('/conversations'))assert.equal(result[0].id,chat.id);else assert.equal(result[0].id,chat.projectId);}
 }
}));
