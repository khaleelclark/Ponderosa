import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withFixture, until, runtimeAttachmentPaths } from '../shared/fixture.mjs';

const options = { timeout: 30000 };
test('checks 14, 15: server drafts use revision fencing, owner isolation and durable recovery', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Drafts'), ownerId = 'browser-a';
  const url = `/api/conversations/${chat.id}/draft`;
  const initial = f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`));
  const saved = f.ok(await f.api('PUT', url, { ownerId, clientId: 'tab-a', text: 'Saved draft', attachmentIds: [], expectedRevision: initial.revision }));
  assert.equal((await f.api('PUT', url, { ownerId, clientId: 'tab-b', text: 'Conflicting draft', attachmentIds: [], expectedRevision: initial.revision })).status, 409);
  assert.equal(f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`)).text, saved.text);
  assert.notEqual(f.ok(await f.api('GET', `${url}?ownerId=browser-b`)).text, saved.text);
  await f.reopen(); assert.equal(f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`)).text, saved.text);
}));

test('checks 29, 30, 91: settings persist and invalid settings do not overwrite valid values', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Settings');
  f.ok(await f.api('PATCH', `/api/conversations/${chat.id}`, { defaultModel: 'fixture', defaultEffort: 'medium', instructions: 'Saved Chat guidance' }));
  assert.equal((await f.api('PATCH', `/api/conversations/${chat.id}`, { defaultModel: 'unknown-model' })).status, 400);
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { fontFamily: 'system', globalInstructions: 'Saved global guidance', maxConcurrentAgentRuns: 2 }));
  assert.equal((await f.api('PATCH', '/api/workspace/preferences', { maxConcurrentAgentRuns: 'two' })).status, 400);
  await f.reopen();
  const c = f.ok(await f.api('GET', `/api/conversations/${chat.id}`)).conversation;
  assert.equal(c.defaultModel, 'fixture'); assert.equal(c.instructions, 'Saved Chat guidance');
  const prefs = f.ok(await f.api('GET', '/api/workspace/preferences'));
  assert.equal(prefs.maxConcurrentAgentRuns, 2); assert.equal(prefs.globalInstructions, 'Saved global guidance');
}));

test('checks 26, 35, 36: unknown commands and wrong Run cancellation fail; cancelled capabilities cannot publish', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Cancellation'), agent = await f.createAgent(chat, 'Worker');
  const session = await f.hold(agent.id), d = await f.detail(agent.id), run = d.runs.find(x => x.status === 'running');
  assert.ok(run);
  assert.ok((await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'unknown-command' })).status >= 400);
  assert.equal((await f.api('POST', `/api/agents/${agent.id}/cancel`, { targetRunId: randomUUID(), idempotencyKey: randomUUID() })).status, 409);
  f.ok(await f.api('POST', `/api/agents/${agent.id}/cancel`, { targetRunId: run.id, idempotencyKey: randomUUID() }));
  const late = await f.tool(session, 'ponderosa_message', { text: 'Late cancelled output' });
  assert.ok(late.status >= 400);
  const before = (await f.detail(agent.id)).runs.map(x => x.id);
  await f.send(agent.id, 'New work after cancellation');
  const next = await f.settled(agent.id, before);
  assert.ok(next.runs.some(x => !before.includes(x.id) && x.status === 'completed'));
  assert.ok(!next.messages.some(x => x.text.includes('Late cancelled output')));
}));

test('checks 32, 33: queued input edits and cancellation preserve exactly the remaining work', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Queue'), agent = await f.createAgent(chat, 'Queue worker');
  const session = await f.hold(agent.id), before = f.turns.filter(x => x.agentId === agent.id).length;
  await f.send(agent.id, 'First queued message', { activeRunDelivery: 'queue' });
  await f.send(agent.id, 'Second queued message', { activeRunDelivery: 'queue' });
  const list = f.ok(await f.api('GET', `/api/agents/${agent.id}/queued-messages`));
  const items = Array.isArray(list) ? list : list.items ?? list.messages;
  assert.equal(items.length, 2);
  const first = items.find(x => x.text.includes('First')), second = items.find(x => x.text.includes('Second'));
  const firstId = first.deliveryId ?? first.id, secondId = second.deliveryId ?? second.id;
  f.ok(await f.api('PATCH', `/api/agents/${agent.id}/queued-messages/${firstId}`, { text: 'Edited first queued message', idempotencyKey: randomUUID() }));
  f.ok(await f.api('POST', `/api/agents/${agent.id}/queued-messages/${secondId}/cancel`, { idempotencyKey: randomUUID() }));
  session.finish();
  await until(async () => { const d = await f.detail(agent.id); return f.turns.filter(x => x.agentId === agent.id).length > before && !d.runs.some(x => ['running','preparing'].includes(x.status)); }, 'remaining queue consumption');
  const fresh = f.turns.filter(x => x.agentId === agent.id).slice(before);
  assert.equal(fresh.length, 1); assert.ok(fresh[0].input.prompt.includes('Edited first queued message'));
  assert.ok(!fresh[0].input.prompt.includes('Second queued message'));
}));

test('check 53: passive information round trip uses the next Run without waking new work', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Collaboration'), a = await f.createAgent(chat, 'Sender'), b = await f.createAgent(chat, 'Recipient');
  const sender = await f.hold(a.id), count = f.turns.filter(x => x.agentId === b.id).length;
  const marker = `Passive fact ${randomUUID()}`;
  f.ok(await f.tool(sender, 'ponderosa_message', { delivery: 'next_run', recipientAgentIds: [b.id], text: marker, idempotencyKey: randomUUID() }));
  const recipient = await f.detail(b.id);
  assert.equal(recipient.runs.filter(x => ['running','preparing'].includes(x.status)).length, 0);
  assert.equal(f.turns.filter(x => x.agentId === b.id).length, count);
  const previous = recipient.runs.map(x => x.id);
  const response = `Collaborative answer ${randomUUID()}`;
  f.plans.set(b.id, [{ run: async (s, input) => {
    assert.ok(input.prompt.includes(marker));
    f.ok(await f.tool(s, 'ponderosa_message', { delivery: 'next_run', recipientAgentIds: [a.id], text: response, idempotencyKey: randomUUID() }));
    assert.equal((await s.tool('ponderosa_message', { text: 'Explicit response to the operator' })).success, true);
  } }]);
  await f.send(b.id, 'Use any delivered passive information'); await f.settled(b.id, previous);
  assert.ok(f.turns.filter(x => x.agentId === b.id).at(-1).input.prompt.includes(marker));
  const shared = f.ok(await f.api('GET', `/api/conversations/${chat.id}`));
  assert.ok(!JSON.stringify(shared.messages ?? shared.conversation.messages).includes(marker));
  sender.finish();
  await until(async () => !(await f.detail(a.id)).runs.some(x => ['running','preparing'].includes(x.status)), 'sender completion');
  const senderPrevious = (await f.detail(a.id)).runs.map(x => x.id);
  await f.send(a.id, 'Read the response from the other Agent'); await f.settled(a.id, senderPrevious);
  assert.ok(f.turns.filter(x => x.agentId === a.id).at(-1).input.prompt.includes(response));
}));

test('check 10: authored Agent collaboration appears in Team Chat, with correct recipients and no shared Chat leak', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Authored collaboration'), a = await f.createAgent(chat, 'Sender'), b = await f.createAgent(chat, 'Recipient');
  const sender = await f.hold(a.id), marker = `Collaborative request ${randomUUID()}`, response = `Collaborative response ${randomUUID()}`;
  const previous = (await f.detail(b.id)).runs.map(x => x.id);
  f.plans.set(b.id, [{ run: async (s, input) => {
    assert.ok(input.prompt.includes(marker));
    f.ok(await f.tool(s, 'ponderosa_message', { intent: 'collaboration', recipientAgentIds: [a.id], text: response, idempotencyKey: randomUUID() }));
  } }]);
  f.ok(await f.tool(sender, 'ponderosa_message', { intent: 'collaboration', recipientAgentIds: [b.id], text: marker, urgency: 'urgent', idempotencyKey: randomUUID() }));
  await f.settled(b.id, previous);
  const team = f.ok(await f.api('GET', `/api/conversations/${chat.id}/collaboration`));
  assert.ok(JSON.stringify(team).includes(marker)); assert.ok(JSON.stringify(team).includes(response));
  const shared = f.ok(await f.api('GET', `/api/conversations/${chat.id}`));
  assert.ok(!JSON.stringify(shared.messages).includes(marker)); assert.ok(!JSON.stringify(shared.messages).includes(response));
  sender.finish(); await until(async () => !(await f.detail(a.id)).runs.some(x => ['running','preparing'].includes(x.status)), 'sender finish');
}));

test('checks 18, 21: attachment references survive close/reopen; removed staged files cannot be sent', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Retained attachment'), agent = await f.createAgent(chat, 'Reader');
  const bytes = `Retained bytes ${randomUUID()}`;
  const upload = async name => f.ok(await f.api('POST', `/api/agents/${agent.id}/attachments`, Buffer.from(bytes), { 'content-type': 'application/octet-stream', 'x-ponderosa-filename': name, 'x-ponderosa-media-type': 'text/plain' }));
  const retained = await upload('retained.txt'), removed = await upload('removed.txt');
  f.ok(await f.api('DELETE', `/api/agents/${agent.id}/attachments/${removed.id}`));
  await f.reopen();
  const before = (await f.detail(agent.id)).runs.map(x => x.id);
  f.plans.set(agent.id, [{ run: async (s, input, turn) => {
    const suppliedPaths = runtimeAttachmentPaths(turn);
    const supplied = suppliedPaths.length ? suppliedPaths : null;
    assert.ok(supplied); assert.equal(await readFile(supplied[0], 'utf8'), bytes);
    assert.equal((await s.tool('ponderosa_message', { text: `Retained: ${bytes}` })).success, true);
  } }]);
  await f.send(agent.id, 'Read the explicitly attached retained file', { attachmentIds: [retained.id] });
  assert.ok((await f.settled(agent.id, before)).messages.some(x => x.text.includes(`Retained: ${bytes}`)));
  assert.equal((await f.api('POST', `/api/agents/${agent.id}/messages`, { text: 'Cannot read removed file', attachmentIds: [removed.id], idempotencyKey: randomUUID() })).status, 404);
}));

test('checks 78, 80, 81, 82: template scope, duplicate import replay and malformed package refusal', options, t => withFixture(t, async f => {
  const source = await f.createChat('Export source'), target = await f.createChat('Import destination');
  const root = await f.createAgent(source, 'Root'); await f.createAgent(source, 'Child', root.id);
  const pkg = f.ok(await f.api('GET', `/api/agents/${root.id}/export?mode=template&organization=true`));
  assert.equal(pkg.agents.length, 2); assert.ok(pkg.agents.every(x => !x.history && !x.artifacts));
  const key = randomUUID(), payload = { package: pkg, conversationId: target.id, engineMapping: { codex: 'codex' } };
  const first = f.ok(await f.api('POST', `/api/projects/${target.projectId}/import-agents`, payload, { 'idempotency-key': key }));
  const retry = f.ok(await f.api('POST', `/api/projects/${target.projectId}/import-agents`, payload, { 'idempotency-key': key }));
  assert.deepEqual(retry.agentIds, first.agentIds); assert.equal(retry.rootAgentId, first.rootAgentId);
  const before = f.ok(await f.api('GET', `/api/projects/${target.projectId}/agents`)).length;
  const malformed = { ...pkg, agents: pkg.agents.map((x,i) => i ? x : { ...x, history: [{ role: 'user', text: 'Forbidden template history', createdAt: new Date().toISOString() }] }) };
  assert.equal((await f.api('POST', `/api/projects/${target.projectId}/import-agents`, { ...payload, package: malformed }, { 'idempotency-key': randomUUID() })).status, 400);
  assert.equal(f.ok(await f.api('GET', `/api/projects/${target.projectId}/agents`)).length, before);
  const copied = f.ok(await f.api('POST', `/api/projects/${target.projectId}/copy-agent`, { sourceAgentId: root.id, conversationId: target.id, rootTitle: 'Renamed copy', mode: 'template', organization: true }, { 'idempotency-key': randomUUID() }));
  assert.equal((await f.detail(copied.rootAgentId)).agent.title, 'Renamed copy');
}));
