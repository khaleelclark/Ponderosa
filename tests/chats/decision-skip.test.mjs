import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkspaceStore } from '@ponderosa/agents';
import { withFixture, until } from '../shared/fixture.mjs';

test('cleared historical notifications cannot hide pending questions; ordinary alerts still clear', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ponderosa-decision-visibility-'));
  let workspace;
  t.after(() => {
    workspace?.close();
    rmSync(root, { recursive: true, force: true });
  });
  workspace = new WorkspaceStore(root);
  const decision = workspace.createDecision({ projectId: 'p', agentId: 'a', runId: 'r', mode: 'choice',
    question: 'Which palette?', options: [{ id: 'forest', label: 'Forest' }], allowOther: true,
    blocking: true, idempotencyKey: randomUUID() });
  const notification = workspace.createNotification({ projectId: 'p', agentId: 'a', kind: 'decision',
    title: 'Question', body: decision.question, status: 'open', decision });
  workspace.createNotification({ projectId: 'p', kind: 'operational', title: 'Other alert', body: 'Disposable alert' });
  assert.equal(workspace.dismissNotifications('attention'), 1);
  assert.equal(workspace.setNotificationStatus(notification.id, 'dismissed').status, 'open');
  // Exact historical clearing format, retained from the reproduced pre-repair behavior.
  const at = new Date().toISOString();
  appendFileSync(path.join(root, 'workspace-events.jsonl'), JSON.stringify({ id: randomUUID(), ts: at,
    event: { type: 'notification_changed', action: 'cleared' },
    mutation: { kind: 'notifications_dismissed', notificationIds: [notification.id], at } }) + '\n');
  workspace.close();
  workspace = new WorkspaceStore(root);
  assert.equal(workspace.getDecision(decision.id).status, 'pending');
  assert.equal(workspace.listNotificationPage({ limit: 100 }).items[0].decision.id, decision.id);
  assert.equal(workspace.listNotificationPage({ limit: 100 }).openActionCount, 1);
  const skipped = workspace.cancelDecision(decision.id, at, true);
  assert.equal(skipped.status, 'cancelled'); assert.equal(skipped.response.skipped, true);
  assert.equal(skipped.response.optionId, undefined);
  assert.equal(workspace.listNotificationPage({ limit: 100 }).openActionCount, 0);
  const cancelled = workspace.createDecision({ projectId: 'p', agentId: 'a', runId: 'r2', mode: 'text',
    question: 'Other question', options: [], allowOther: true, blocking: true, idempotencyKey: randomUUID() });
  assert.equal(workspace.cancelDecision(cancelled.id).response, undefined, 'Deletion cancellation must not fabricate an operator Skip');
  workspace.close();
  workspace = new WorkspaceStore(root);
  assert.deepEqual(workspace.getDecision(decision.id), skipped);
  assert.equal(workspace.listNotificationPage({ limit: 100 }).openActionCount, 0);
});

const nativeOptions = { skip: process.platform === 'win32', timeout: 30000 };
const question = { mode: 'approval', question: 'May I change the disposable file?', blocking: true,
  options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Do not approve' }] };

test('Skip cancels a blocking question, resumes its exact task without approval and replays once across reopen', nativeOptions, async t => {
  await withFixture(t, async f => {
    const chat = await f.createChat('Skip waiting question'), agent = await f.createIdleAgent(chat, 'Question owner');
    let decision;
    f.plans.set(agent.id, [{ output: false, run: async session => {
      decision = f.ok(await f.tool(session, 'ponderosa_decision', { ...question, idempotencyKey: randomUUID() }));
    } }]);
    await f.send(agent.id, 'Ask before changing anything.');
    await f.settled(agent.id);
    const turnsBefore = f.turns.length;
    const notifications = f.ok(await f.api('GET', '/api/notifications'));
    assert.equal(notifications.items.some(n => n.decision?.id === decision.id), true);
    f.ok(await f.api('POST', '/api/notifications/dismiss-all', { kind: 'attention' }));
    assert.equal(f.ok(await f.api('GET', '/api/notifications')).items.some(n => n.decision?.id === decision.id), true);
    assert.equal((await f.api('POST', `/api/decisions/${decision.id}/respond`, { skip: true, optionId: 'approve' })).status, 400);
    f.plans.set(agent.id, [{ run: async (session, input) => {
      assert.ok(input.prompt.includes('"skipped":true')); assert.ok(input.prompt.includes('No answer or approval was supplied'));
      assert.ok(input.prompt.includes(decision.id));
      f.ok(await f.tool(session, 'ponderosa_message', { intent: 'direct_to_user', text: 'Continued without approval' }));
    } }]);
    const skipped = f.ok(await f.api('POST', `/api/decisions/${decision.id}/respond`, { skip: true }));
    assert.equal(skipped.status, 'cancelled'); assert.equal(skipped.response.skipped, true);
    assert.equal(skipped.response.optionId, undefined);
    assert.deepEqual(f.ok(await f.api('POST', `/api/decisions/${decision.id}/respond`, { skip: true })), skipped);
    await until(async () => (await f.detail(agent.id)).messages.some(m => m.text === 'Continued without approval'), 'canonical continuation reply');
    await until(async () => (await f.detail(agent.id)).runs.every(r => r.status !== 'running'), 'continuation finishes');
    assert.equal(f.turns.length - turnsBefore, 1);
    await f.reopen();
    assert.deepEqual(f.ok(await f.api('POST', `/api/decisions/${decision.id}/respond`, { skip: true })), skipped);
    assert.equal((await f.detail(agent.id)).messages.filter(m => m.text === 'Continued without approval').length, 1);
    assert.equal(f.turns.length - turnsBefore, 1);
    assert.equal(f.ok(await f.api('GET', `/api/decisions?agentId=${agent.id}&status=pending`)).length, 0);
  });
});

test('Skip steers an already active Run without replacing or stopping it', nativeOptions, async t => {
  await withFixture(t, async f => {
    const chat = await f.createChat('Skip active question'), agent = await f.createAgent(chat, 'Active owner');
    const session = await f.hold(agent.id), before = await f.detail(agent.id);
    const run = before.runs.find(r => r.status === 'running');
    const decision = f.ok(await f.tool(session, 'ponderosa_decision', { ...question, idempotencyKey: randomUUID() }));
    const db = new Database(path.join(f.dataDir, 'ponderosa.db'), { readonly: true });
    try {
      f.ok(await f.api('POST', `/api/decisions/${decision.id}/respond`, { skip: true }));
      const steer = await until(() => f.steers.find(s => s.agentId === agent.id && s.input.prompt.includes(decision.id)), 'skip steering');
      await until(() => db.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(steer.input.clientMessageId)?.state === 'acknowledged', 'skip acknowledgement');
      f.ok(await f.api('POST', `/api/decisions/${decision.id}/respond`, { skip: true }));
      assert.equal(f.steers.filter(s => s.input.prompt.includes(decision.id)).length, 1);
      assert.equal((await f.detail(agent.id)).runs.find(r => r.id === run.id).status, 'running');
      assert.equal(session.isAlive(), true);
      f.ok(await f.tool(session, 'ponderosa_message', { intent: 'direct_to_user', text: 'Active task continued without approval', steeringInjectionId: steer.input.clientMessageId }));
      session.finish();
      await until(async () => (await f.detail(agent.id)).runs.find(r => r.id === run.id).status === 'completed', 'same Run completed');
      assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_activations WHERE dedupe_key=?").get(`message:decision:${decision.id}:response`).n, 1);
    } finally { db.close(); }
  });
});

test('Skip after an answered question preserves its answer and does not resume the Agent again', { timeout: 30000 }, async t => {
  await withFixture(t, async f => {
    const chat = await f.createChat('Answered question guard'), agent = await f.createIdleAgent(chat, 'Answer owner');
    let decision;
    f.plans.set(agent.id, [{ output: false, run: async session => {
      decision = f.ok(await f.tool(session, 'ponderosa_decision', { ...question, idempotencyKey: randomUUID() }));
    } }]);
    await f.send(agent.id, 'Ask before changing anything.');
    await f.settled(agent.id);
    const beforeAnswer = await f.detail(agent.id);
    f.plans.set(agent.id, [{ run: async session => {
      f.ok(await f.tool(session, 'ponderosa_message', { intent: 'direct_to_user', text: 'Answer handled once' }));
    } }]);
    const answered = f.ok(await f.api('POST', `/api/decisions/${decision.id}/respond`, { optionId: 'approve' }));
    assert.equal(answered.status, 'resolved');
    assert.equal(answered.response.optionId, 'approve');
    const completed = await f.settled(agent.id, beforeAnswer.runs.map(run => run.id));
    assert.equal(completed.messages.filter(message => message.text === 'Answer handled once').length, 1);
    const turns = f.turns.length, steers = f.steers.length;
    const db = new Database(path.join(f.dataDir, 'ponderosa.db'), { readonly: true });
    try {
      const activations = db.prepare('SELECT COUNT(*) n FROM agent_activations WHERE dedupe_key=?');
      const key = `message:decision:${decision.id}:response`, before = activations.get(key).n;
      assert.equal(before, 1, 'The valid answer must have one response activation');
      assert.equal((await f.api('POST', `/api/decisions/${decision.id}/respond`, { skip: true })).status, 409);
      const decisions = f.ok(await f.api('GET', `/api/decisions?agentId=${agent.id}`));
      assert.deepEqual(decisions.find(item => item.id === decision.id), answered);
      assert.equal(activations.get(key).n, before, 'Rejected Skip must not create another activation');
      const after = await f.detail(agent.id);
      assert.deepEqual(after.runs.map(({ id, status }) => ({ id, status })), completed.runs.map(({ id, status }) => ({ id, status })));
      assert.equal(f.turns.length, turns); assert.equal(f.steers.length, steers);
      assert.equal(after.messages.filter(message => message.text === 'Answer handled once').length, 1);
    } finally { db.close(); }
  });
});

test('Skip mixed with empty answer fields leaves the pending question and Agent unchanged', { timeout: 30000 }, async t => {
  await withFixture(t, async f => {
    const chat = await f.createChat('Empty answer fields guard'), agent = await f.createIdleAgent(chat, 'Pending question owner');
    let decision;
    f.plans.set(agent.id, [{ output: false, run: async session => {
      decision = f.ok(await f.tool(session, 'ponderosa_decision', { ...question, idempotencyKey: randomUUID() }));
    } }]);
    await f.send(agent.id, 'Ask before changing anything.');
    const before = await f.settled(agent.id), turns = f.turns.length, steers = f.steers.length;
    const db = new Database(path.join(f.dataDir, 'ponderosa.db'), { readonly: true });
    try {
      const activations = db.prepare('SELECT COUNT(*) n FROM agent_activations WHERE dedupe_key=?');
      const key = `message:decision:${decision.id}:response`;
      assert.equal(activations.get(key).n, 0);
      for (const fields of [{ optionId: '' }, { optionId: '   ' }, { text: '' }, { text: '   ' },
        { content: '' }, { content: {} }, { optionId: '', text: '', content: {} }]) {
        assert.equal((await f.api('POST', `/api/decisions/${decision.id}/respond`, { skip: true, ...fields })).status, 400,
          `Skip must refuse supplied answer fields: ${JSON.stringify(fields)}`);
        const pending = f.ok(await f.api('GET', `/api/decisions?agentId=${agent.id}&status=pending`));
        assert.deepEqual(pending.find(item => item.id === decision.id), decision);
        assert.equal(activations.get(key).n, 0, 'Rejected input must not activate a response');
        const after = await f.detail(agent.id);
        assert.deepEqual(after.runs.map(({ id, status }) => ({ id, status })), before.runs.map(({ id, status }) => ({ id, status })));
        assert.equal(f.turns.length, turns); assert.equal(f.steers.length, steers);
      }
    } finally { db.close(); }
  });
});
