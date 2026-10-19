import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withFixture, until } from '../shared/fixture.mjs';

const options = { timeout: 30000 };

test('check 11: unavailable direct recipient is reported honestly while replay delivers to the available recipient once', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Partial delivery'), recipient = await f.createIdleAgent(chat, 'Available reader'), missing = randomUUID();
  const body = { text: `One real delivery ${randomUUID()}`, idempotencyKey: randomUUID(), recipients: [{ agentId: recipient.id }, { agentId: missing }] };
  const first = f.ok(await f.api('POST', `/api/conversations/${chat.id}/direct-messages`, body));
  assert.ok(first.messageId); assert.ok(first.unavailableRecipients.some(x => x.agentId === missing)); assert.deepEqual(first.recipients.map(x => x.agentId), [recipient.id]);
  const replay = f.ok(await f.api('POST', `/api/conversations/${chat.id}/direct-messages`, body)); assert.equal(replay.messageId, first.messageId);
  await f.settled(recipient.id); assert.equal(f.turns.filter(x => x.agentId === recipient.id).length, 1);
  const allMissing = await f.api('POST', `/api/conversations/${chat.id}/direct-messages`, { ...body, idempotencyKey: randomUUID(), recipients: [{ agentId: missing }] });
  assert.equal(allMissing.status, 409); assert.ok(allMissing.body.unavailableRecipients.some(x => x.agentId === missing));
}));

test('check 28: provider disabled state remains distinct from authenticated state and blocks new intake', options, t => withFixture(t, async f => {
  const engine = await until(async () => f.ok(await f.api('GET', '/api/engines')).find(x => x.id === 'codex' && x.authentication === 'authenticated'), 'controlled authentication observation');
  assert.equal(engine.enabled, true); assert.equal(engine.intakeReady, true);
  const disabled = f.ok(await f.api('PATCH', '/api/engines/codex', { enabled: false })); assert.equal(disabled.enabled, false); assert.equal(disabled.intakeReady, false);
  const chat = await f.createChat('Disabled provider');
  const created = await f.api('POST', `/api/projects/${chat.projectId}/agents`, { title: 'Refused reader', engine: 'codex', conversationId: chat.id, initialMessage: 'Do not run', idempotencyKey: randomUUID() });
  assert.equal(created.status, 409); assert.equal(f.turns.length, 0);
  const enabled = f.ok(await f.api('PATCH', '/api/engines/codex', { enabled: true })); assert.equal(enabled.enabled, true); assert.equal(enabled.authentication, engine.authentication);
}));

test('check 52: cancelling one delegated Request preserves its identity and leaves the other Request live', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Request cancellation'), manager = await f.createIdleAgent(chat, 'Manager'), a = await f.createIdleAgent(chat, 'Worker A'), b = await f.createIdleAgent(chat, 'Worker B');
  const session = await f.hold(manager.id);
  for (const w of [a, b]) f.plans.set(w.id, [{ hold: true }]);
  const args = { idempotencyKey: randomUUID(), requests: [a, b].map(w => ({ recipientAgentId: w.id, text: `Work for ${w.title}`, lifetime: { kind: 'indefinite' } })), join: { mode: 'all', wakePolicy: 'final_only', satisfyingOutcomes: ['completed', 'cancelled'] } };
  const coordinated = f.ok(await f.tool(session, 'ponderosa_coordinate', args)); await until(() => [a, b].every(w => f.turns.some(x => x.agentId === w.id)), 'two worker inputs');
  const before = await f.detail(manager.id), target = before.coordinationV3.requests.find(x => x.counterpartyAgentId === a.id && coordinated.requestIds.includes(x.id));
  const update = { requestId: target.id, updateId: randomUUID(), kind: 'cancelled', text: 'Cancel only A' };
  f.ok(await f.tool(session, 'ponderosa_update_request', update)); f.ok(await f.tool(session, 'ponderosa_update_request', update));
  const replay = f.ok(await f.tool(session, 'ponderosa_coordinate', args)); assert.deepEqual(replay.requestIds, coordinated.requestIds); assert.equal(replay.joinId, coordinated.joinId);
  const requests = (await f.detail(manager.id)).coordinationV3.requests.filter(x => coordinated.requestIds.includes(x.id));
  assert.equal(requests.find(x => x.id === target.id).state, 'cancelled');
  assert.ok(!['completed', 'cancelled', 'failed'].includes(requests.find(x => x.counterpartyAgentId === b.id).state));
  assert.ok((await f.tool(f.sessions.get(a.id), 'ponderosa_update_request', { requestId: target.id, kind: 'completed', text: 'Too late' })).status >= 400);
  f.ok(await f.tool(f.sessions.get(b.id), 'ponderosa_update_request', { kind: 'completed', text: 'B completed independently' }));
  assert.equal((await f.detail(manager.id)).coordinationV3.joins.find(x => x.id === coordinated.joinId).state, 'satisfied');
}));

test('checks 26, 27: structured command invokes only the selected idle runtime; unavailable commands and active work are refused', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Command scope'), a = await f.createAgent(chat, 'Idle command owner'), b = await f.createIdleAgent(chat, 'Busy unrelated owner');
  const command = { name: 'fixture-inspect', description: 'Harmless controlled command', source: 'provider-advertised', acceptsArguments: true, insertText: '/fixture-inspect', status: 'available', invocation: 'runtime' };
  f.capabilities.commands = [command, { ...command, name: 'unavailable-fixture', status: 'unavailable', unavailableReason: 'Declared unavailable' }];
  const session = await f.hold(b.id), active = (await f.detail(b.id)).runs.find(x => x.status === 'running');
  const before = (await f.detail(a.id)).runs.map(x => x.id);
  const invoked = f.ok(await f.api('POST', `/api/agents/${a.id}/provider-commands`, { name: command.name, argumentsText: 'Harmless exact argument' }));
  assert.equal(invoked.invoked, true); assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].agentId, a.id); assert.equal(f.commands[0].sessionId, f.sessions.get(a.id).engineAgentId); assert.equal(f.commands[0].argumentsText, 'Harmless exact argument');
  assert.equal((await f.api('POST', `/api/agents/${b.id}/provider-commands`, { name: command.name })).status, 409);
  assert.equal((await f.api('POST', `/api/agents/${a.id}/provider-commands`, { name: 'unavailable-fixture' })).status, 409);
  assert.equal(f.commands.length, 1); assert.deepEqual((await f.detail(a.id)).runs.map(x => x.id), before);
  assert.equal((await f.detail(b.id)).runs.find(x => x.status === 'running').id, active.id); assert.equal(session.isAlive(), true);
}));

test('check 34: replaying active steering injects once into the selected Run without starting duplicate work', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Exact steering'), a = await f.createIdleAgent(chat, 'Steered owner'), b = await f.createIdleAgent(chat, 'Unrelated active owner');
  await f.hold(a.id); await f.hold(b.id);
  const beforeA = (await f.detail(a.id)).runs.map(x => x.id), beforeB = (await f.detail(b.id)).runs.map(x => x.id);
  const marker = `Exact active steering ${randomUUID()}`, body = { text: marker, activeRunDelivery: 'steer', idempotencyKey: randomUUID() };
  f.ok(await f.api('POST', `/api/agents/${a.id}/messages`, body)); f.ok(await f.api('POST', `/api/agents/${a.id}/messages`, body));
  await until(() => f.steers.some(x => x.agentId === a.id && JSON.stringify(x.input).includes(marker)), 'accepted exact steering');
  assert.equal(f.steers.filter(x => JSON.stringify(x.input).includes(marker)).length, 1);
  assert.ok(!f.steers.some(x => x.agentId === b.id && JSON.stringify(x.input).includes(marker)));
  assert.deepEqual((await f.detail(a.id)).runs.map(x => x.id), beforeA); assert.deepEqual((await f.detail(b.id)).runs.map(x => x.id), beforeB);
  assert.equal(f.turns.length, 2);
  assert.equal((await f.detail(a.id)).messages.filter(x => x.role === 'user' && x.text.includes(marker)).length, 1);
}));

const { createRequire } = await import('node:module');
const EvidenceDatabase = createRequire(new URL('../../apps/server/package.json', import.meta.url))('better-sqlite3');
const { CoordinationV3ReadModel } = await import('../../packages/agents/dist/coordination-v3-read-model.js');
function workEvidence(t) {
  const db = new EvidenceDatabase(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE scheduler_runs(id,agent_id,started_at,heartbeat_at,provider_session_id,status,fencing_token,prompt_injection_state,context_disposition,lease_expires_at,terminal_at,provider_failure_json,project_id,scope_key);
    CREATE TABLE provider_inputs(scheduler_run_id,execution_id,prompt_hash); CREATE TABLE runs(id,agent_id,status,wake_cause,completed_at);
    CREATE TABLE events(agent_id,seq,type,created_at,payload_json); CREATE TABLE activity_projection(agent_id,seq,execution_id);
    CREATE TABLE runtime_communications(id,sender_json,intent,created_at,project_id); CREATE TABLE messages(agent_id,communication_event_id,role);
    INSERT INTO scheduler_runs(id,agent_id,started_at,heartbeat_at,status,fencing_token,project_id,scope_key) VALUES('run','agent','2026-10-19T00:00:00Z','2026-10-19T01:00:00Z','running',1,'project','conversation:chat');
    INSERT INTO provider_inputs VALUES('run','execution','hash');`);
  const model = new CoordinationV3ReadModel(db);
  let seq = 0;
  return { db, details: (extra = {}) => model.agentWorkItemDetails({ projectId: 'project', conversationId: 'chat', kind: 'run', recordId: 'run', ...extra }),
    event(type, payload = {}, execution = 'execution') {
      const n = ++seq, time = `2026-10-19T00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z`;
      db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('agent', n, type, time, JSON.stringify(payload));
      db.prepare('INSERT INTO activity_projection VALUES(?,?,?)').run('agent', n, execution);
      return `${time} (${type})`;
    } };
}
const technical = details => Object.fromEntries(details.map(item => [item.label, item.value]));
test('work inspector separates provider output from operator/autonomous browser activity and heartbeat', t => {
  const f = workEvidence(t);
  for (const [type, payload] of [['browser_action', { actor: 'operator' }], ['browser_action', { actor: 'agent' }], ['browser_console', { text: 'PRIVATE_BROWSER_OUTPUT' }], ['browser_screenshot', {}]]) {
    f.event(type, payload);
    assert.equal(technical(f.details())['Last recorded provider progress'], 'Not found in this bounded evidence window');
  }
  const text = f.event('text', { text: 'PRIVATE_PROVIDER_OUTPUT' });
  f.event('browser_console');
  assert.equal(technical(f.details())['Last recorded provider progress'], text);
  const tool = f.event('tool_result', { text: 'PRIVATE_TOOL_OUTPUT' });
  f.event('browser_action', { actor: 'operator' }); f.event('text', {}, 'other-execution');
  const details = technical(f.details());
  assert.equal(details['Last recorded provider progress'], tool);
  assert.equal(details['Scheduler heartbeat (not provider progress)'], '2026-10-19T01:00:00Z');
  assert.match(details['Recent Run event metadata'], /browser_action/);
  assert.doesNotMatch(JSON.stringify(details), /PRIVATE_/);
  assert.deepEqual(f.details({ recordId: 'execution' }), f.details());
  assert.equal(f.details({ projectId: 'foreign' }), undefined);
  assert.equal(f.details({ conversationId: 'foreign' }), undefined);
});
test('work inspector keeps provider-progress absence bounded and user-facing publication scoped to its exact sender Run', t => {
  const f = workEvidence(t); f.event('text');
  for (let i = 0; i < 129; i++) f.event('browser_console');
  assert.equal(technical(f.details())['Last recorded provider progress'], 'Not found in this bounded evidence window');
  assert.match(technical(f.details())['Evidence window'], /absence is not proof/);
  const insert = f.db.prepare('INSERT INTO runtime_communications VALUES(?,?,?,?,?)');
  for (const [id, intent, execution] of [['handoff-copy', 'collaboration', 'execution'], ['foreign-reply', 'user_dm', 'other-execution']]) {
    insert.run(id, JSON.stringify({ agentId: 'agent', executionId: execution }), intent, '2026-10-19T00:01:00Z', 'project');
    f.db.prepare('INSERT INTO messages VALUES(?,?,?)').run('agent', id, 'assistant');
  }
  assert.equal(technical(f.details())['User-facing reply publication'], 'Not found in this bounded evidence window');
  assert.match(technical(f.details())['User-facing reply scope'], /Request lifecycle/);
  insert.run('reply', JSON.stringify({ agentId: 'agent', executionId: 'execution' }), 'user_dm', '2026-10-19T00:02:00Z', 'project');
  f.db.prepare('INSERT INTO messages VALUES(?,?,?)').run('agent', 'reply', 'assistant');
  assert.equal(technical(f.details())['User-facing reply publication'], '2026-10-19T00:02:00Z');
  assert.match(technical(f.details())['User-facing reply and Run state'], /Run is still active/);
});
test('canonical Request handoff remains visible while its worker Run truthfully has no user-facing reply', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Handoff evidence'), manager = await f.createIdleAgent(chat, 'Manager'), worker = await f.createIdleAgent(chat, 'Worker');
  const managerSession = await f.hold(manager.id); f.plans.set(worker.id, [{ hold: true }]);
  const assigned = f.ok(await f.tool(managerSession, 'ponderosa_coordinate', { idempotencyKey: randomUUID(), requests: [
    { recipientAgentId: worker.id, text: 'Return the canonical handoff', lifetime: { kind: 'indefinite' } },
  ] }));
  const session = await until(() => f.sessions.get(worker.id), 'worker runtime');
  const run = (await f.detail(worker.id)).runs.find(item => item.status === 'running'); assert.ok(run);
  const marker = 'CANONICAL_HANDOFF_' + randomUUID();
  f.ok(await f.tool(session, 'ponderosa_update_request', { requestId: assigned.requestIds[0], kind: 'completed', text: marker }));
  const base = `/api/projects/${chat.projectId}/agent-work/items/`;
  const request = f.ok(await f.api('GET', base + 'request/' + assigned.requestIds[0] + '?conversationId=' + chat.id));
  assert.equal(request.requestLifecycle.request.state, 'completed');
  assert.ok(request.requestLifecycle.updates.some(item => item.kind === 'completed' && item.actorId === worker.id && item.text === marker));
  const details = technical(f.ok(await f.api('GET', base + 'run/' + run.id + '?conversationId=' + chat.id)).details);
  assert.equal(details['User-facing reply publication'], 'Not found in this bounded evidence window');
  assert.match(details['User-facing reply scope'], /Request lifecycle/);
  const foreign = await f.createChat('Foreign handoff scope');
  assert.equal((await f.api('GET', base + 'request/' + assigned.requestIds[0] + '?conversationId=' + foreign.id)).status, 404);
}));
