import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withFixture, until, runtimeAttachmentPaths, fixtureTestOptions as options } from '../shared/fixture.mjs';

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

test('checks 78, 80, 81, 82: template scope, duplicate import replay and malformed package refusal', { timeout: process.platform === 'win32' ? 90000 : options.timeout }, t => withFixture(t, async f => {
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

test('Q01 lost shared-send acknowledgment, settled work, restart and same-key retry preserve one logical delivery', {timeout:30000},t=>withFixture(t,async f=>{
 const chat=await f.createChat('Owned lost acknowledgment'),agent=await f.createAgent(chat,'Owned reader');
 const before=(await f.detail(agent.id)).runs.map(r=>r.id),turnsBefore=f.turns.length;
 const key=randomUUID(),text='#'+agent.handle+' Owned lost acknowledgment '+randomUUID();
 const body={text,idempotencyKey:key,recipientAgentMentions:[{agentId:agent.id,projectId:chat.projectId,handle:agent.handle,currentHandle:agent.handle,currentTitle:agent.title}]};
 await assert.rejects(async()=>{f.ok(await f.api('POST',`/api/conversations/${chat.id}/messages`,body));throw Error('Owned response dropped after server acceptance');},/response dropped/);
 await f.settled(agent.id,before);
 assert.equal(f.turns.length-turnsBefore,1);
 await f.reopen();
 const retry=f.ok(await f.api('POST',`/api/conversations/${chat.id}/messages`,body));
 assert.ok(retry.communicationEventId);
 await new Promise(r=>setTimeout(r,100));
 assert.equal(f.turns.length-turnsBefore,1);
 const conversation=f.ok(await f.api('GET',`/api/conversations/${chat.id}`));
 assert.equal(conversation.messages.filter(m=>JSON.stringify(m).includes(text.split(' ').at(-1))).length,1);
 const mismatch=await f.api('POST',`/api/conversations/${chat.id}/messages`,{...body,text:'Mismatched retry'});
 assert.ok(mismatch.status>=400,'Changed same-key payload was accepted');
}));

test('Q01 lost queue-edit/cancel acknowledgments can be retried without duplicate remaining work',{timeout:30000},t=>withFixture(t,async f=>{
 const chat=await f.createChat('Owned queue retry'),agent=await f.createAgent(chat,'Owned queue reader');
 const session=await f.hold(agent.id),before=f.turns.filter(x=>x.agentId===agent.id).length;
 await f.send(agent.id,'Owned first queued',{activeRunDelivery:'queue'});
 await f.send(agent.id,'Owned second queued',{activeRunDelivery:'queue'});
 const list=f.ok(await f.api('GET',`/api/agents/${agent.id}/queued-messages`));
 const items=Array.isArray(list)?list:list.items??list.messages;
 const first=items.find(x=>x.text.includes('first')),second=items.find(x=>x.text.includes('second'));
 for(const [method,url,payload] of [
  ['PATCH',`/api/agents/${agent.id}/queued-messages/${first.deliveryId??first.id}`,{text:'Owned edited first',idempotencyKey:randomUUID()}],
  ['POST',`/api/agents/${agent.id}/queued-messages/${second.deliveryId??second.id}/cancel`,{idempotencyKey:randomUUID()}],
 ]){
  await assert.rejects(async()=>{f.ok(await f.api(method,url,payload));throw Error('Owned lost queue acknowledgment');},/lost queue/);
  f.ok(await f.api(method,url,payload));
 }
 session.finish();
 await until(async()=>{const detail=await f.detail(agent.id);return f.turns.filter(x=>x.agentId===agent.id).length>before&&!detail.runs.some(r=>['running','preparing'].includes(r.status));},'owned queue settles');
 const fresh=f.turns.filter(x=>x.agentId===agent.id).slice(before);
 assert.equal(fresh.length,1);assert.match(fresh[0].input.prompt,/Owned edited first/);assert.doesNotMatch(fresh[0].input.prompt,/Owned second queued/);
}));

test('Q01 accepted pending work and its durable draft identity survive restart without another logical send', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Pending restart'), blockers = [];
  for (let i = 0; i < 4; i++) { const agent = await f.createIdleAgent(chat, `Occupied ${i}`); await f.hold(agent.id); blockers.push(agent); }
  const agent = await f.createIdleAgent(chat, 'Pending reader'), key = randomUUID(), marker = `Pending restart ${randomUUID()}`;
  const url = `/api/conversations/${chat.id}/draft`, ownerId = 'pending-browser';
  const draft = f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`));
  const pending = { idempotencyKey: key, fingerprint: 'a'.repeat(64), text: marker, captureRevision: draft.revision, request: { conversationId: chat.id, recipientAgentIds: [agent.id], runtime: { activeRunDelivery: 'queue' } } };
  f.ok(await f.api('PUT', url, { ownerId, clientId: 'pending-tab', expectedRevision: draft.revision, text: 'Newer unsent draft', attachmentIds: [], pendingSubmissions: [pending] }));
  const body = { text: marker, idempotencyKey: key, activeRunDelivery: 'queue' };
  f.ok(await f.api('POST', `/api/agents/${agent.id}/messages`, body)); // Discard the accepted response.
  f.ok(await f.api('POST', '/api/deployment/drain', {})); // Pause leasing before the fixture releases occupied roots.
  assert.equal((await f.detail(agent.id)).runs.length, 0);
  assert.equal(f.turns.filter(turn => turn.agentId === agent.id).length, 0, 'Work must still be pending at restart');
  await f.reopen();
  const recovered = f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`));
  assert.equal(recovered.text, 'Newer unsent draft');
  const restored = recovered.pendingSubmissions.find(item => item.idempotencyKey === key); assert.ok(restored);
  for (const field of ['idempotencyKey', 'fingerprint', 'text', 'captureRevision', 'request']) assert.deepEqual(restored[field], pending[field]);
  f.ok(await f.api('POST', `/api/agents/${agent.id}/messages`, body));
  await f.settled(agent.id);
  assert.equal(f.turns.filter(turn => turn.agentId === agent.id).length, 1);
  assert.equal((await f.detail(agent.id)).messages.filter(message => message.role === 'user' && message.text.includes(marker)).length, 1);
  assert.equal((await f.api('POST', `/api/agents/${agent.id}/messages`, { ...body, text: 'Changed retry' })).status, 409);
  const latest = f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`));
  const retired = f.ok(await f.api('PUT', url, { ownerId, clientId: 'pending-tab', expectedRevision: latest.revision, text: latest.text, attachmentIds: [], retirePendingSubmissionIds: [key] }));
  assert.equal(retired.text, 'Newer unsent draft'); assert.ok(!retired.pendingSubmissions?.some(item => item.idempotencyKey === key));
}));

test('Q01 exhausted required-reply recovery stops automatically and same-key explicit retry has one lineage', { timeout: process.platform === 'win32' ? 90000 : options.timeout }, t => withFixture(t, async f => {
  const chat = await f.createChat('Reply exhaustion'), agent = await f.createIdleAgent(chat, 'Silent reader'), marker = `Unanswered ${randomUUID()}`;
  f.plans.set(agent.id, Array.from({ length: 12 }, () => ({ run: async () => {} })));
  await f.send(agent.id, marker);
  const message = (await f.detail(agent.id)).messages.find(item => item.role === 'user' && item.text.includes(marker)); assert.ok(message?.communicationEventId);
  const receipts = async () => f.ok(await f.api('POST', `/api/conversations/${chat.id}/message-delivery-receipts`, { communicationEventIds: [message.communicationEventId], activationIds: [] })).items.flatMap(item => item.deliveryReceipts);
  const exhausted = await until(async () => (await receipts()).find(item => item.state === 'retry_exhausted'), 'bounded reply recovery exhaustion', process.platform === 'win32' ? 30000 : 10000);
  assert.equal(exhausted.providerAcknowledged, true); assert.equal(exhausted.retryMayDuplicate, true); assert.equal(exhausted.canRetry, true);
  const count = f.turns.filter(turn => turn.agentId === agent.id).length; assert.equal(count, 6);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(f.turns.filter(turn => turn.agentId === agent.id).length, count);
  f.plans.set(agent.id, []);
  const url = `/api/projects/${chat.projectId}/message-deliveries/${exhausted.activationId}/retry`, body = { idempotencyKey: randomUUID() };
  const accepted = f.ok(await f.api('POST', url, body)), replay = f.ok(await f.api('POST', url, body));
  assert.equal(accepted.accepted, true); assert.equal(replay.replayed, true); assert.equal(replay.activationId, accepted.activationId);
  await until(async () => (await f.detail(agent.id)).messages.some(item => item.role === 'assistant'), 'explicit retry publishes one reply');
  assert.equal(f.turns.filter(turn => turn.agentId === agent.id).length, count + 1);
  assert.equal((await f.detail(agent.id)).messages.filter(item => item.role === 'user' && item.text.includes(marker)).length, 1);
  assert.match(f.turns.filter(turn => turn.agentId === agent.id).at(-1).input.prompt, /current state|already|repeat/iu);
}));

test('Q01 a stale stream cursor requests a canonical snapshot rather than replaying obsolete events', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Stream reset'), marker = `Canonical reset ${randomUUID()}`;
  f.ok(await f.api('POST', `/api/conversations/${chat.id}/messages`, { text: marker, idempotencyKey: randomUUID() }));
  const base = await f.listen(), controller = new AbortController();
  const response = await fetch(base + '/api/workspace/stream?lastEventId=1000000000', { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder(); let frame = '';
    while (!frame.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done, false); frame += decoder.decode(chunk.value, { stream: true }); }
    assert.match(frame, /event: workspace_status/u);
    const status = JSON.parse(frame.match(/data: (.+)\n/u)[1]);
    assert.equal(status.reset, true); assert.equal(status.snapshot, true); assert.ok(status.cursor < 1000000000);
    const snapshot = f.ok(await f.api('GET', `/api/conversations/${chat.id}`));
    assert.equal(snapshot.messages.filter(item => item.text.includes(marker)).length, 1);
  } finally { await reader.cancel(); controller.abort(); }
}));
