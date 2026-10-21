import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';

const ended = (f, id) => until(async () => !(await f.detail(id)).runs.some(x => ['preparing', 'running'].includes(x.status)), 'Run ended');

test('check 41: preset creation preserves its selected setup and a frozen guidance snapshot', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Preset selection'), guidance = `Preset instructions ${randomUUID()}`;
  const preset = f.ok(await f.api('POST', `/api/projects/${chat.projectId}/agent-presets`, { name: 'Fixture preset', description: 'Harmless reader', guidance, engine: 'codex', model: 'fixture', effort: 'medium' }, { 'idempotency-key': randomUUID() }));
  const created = f.ok(await f.api('POST', `/api/projects/${chat.projectId}/agents`, { title: 'Preset reader', engine: 'codex', conversationId: chat.id, presetId: preset.id, initialMessage: 'Use the selected guidance', idempotencyKey: randomUUID() }));
  const d = await f.settled(created.id);
  assert.equal(d.agent.activeEngine, 'codex'); assert.equal(d.agent.model, 'fixture'); assert.equal(d.agent.effort, 'medium');
  assert.equal(d.agent.presetSnapshot.guidance, guidance);
  assert.ok(JSON.stringify(f.turns.find(x => x.agentId === created.id)).includes(guidance));
  f.ok(await f.api('PATCH', `/api/agent-presets/${preset.id}`, { guidance: 'Updated preset guidance only for future readers' }));
  assert.equal((await f.detail(created.id)).agent.presetSnapshot.guidance, guidance);
  assert.equal(f.ok(await f.api('GET', `/api/projects/${chat.projectId}/agent-presets`)).find(x => x.id === preset.id).guidance, 'Updated preset guidance only for future readers');
}));

test('check 42: rename and reporting-line change preserve identity/history and refuse cycles or another Chat', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Reporting lines'), other = await f.createChat('Other owner');
  const a = await f.createIdleAgent(chat, 'First manager'), b = await f.createIdleAgent(chat, 'Second manager'), child = await f.createAgent(chat, 'History keeper');
  const foreign = await f.createIdleAgent(other, 'Foreign manager');
  const before = await f.detail(child.id);
  f.ok(await f.api('PATCH', `/api/agents/${child.id}`, { title: 'Renamed keeper' }));
  f.ok(await f.api('PUT', `/api/agents/${child.id}/manager`, { managerAgentId: a.id }));
  f.ok(await f.api('PUT', `/api/agents/${child.id}/manager`, { managerAgentId: b.id }));
  const after = await f.detail(child.id);
  assert.equal(after.agent.id, child.id); assert.equal(after.agent.managerAgentId, b.id);
  assert.deepEqual(after.messages.map(x => x.id), before.messages.map(x => x.id)); assert.deepEqual(after.runs.map(x => x.id), before.runs.map(x => x.id));
  assert.equal((await f.api('PUT', `/api/agents/${b.id}/manager`, { managerAgentId: child.id })).status, 400);
  assert.equal((await f.api('PUT', `/api/agents/${child.id}/manager`, { managerAgentId: foreign.id })).status, 400);
  assert.equal((await f.detail(child.id)).agent.managerAgentId, b.id);
}));

test('checks 43, 44, 65: organization pages, child scope and search expose the exact Agent identities', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Directory'), root = await f.createIdleAgent(chat, 'Root owner');
  const children = await Promise.all(['Needle Alpha', 'Needle Beta', 'Needle Gamma'].map(x => f.createIdleAgent(chat, x, root.id)));
  const base = `/api/projects/${chat.projectId}/agent-organization?scope=children&parentAgentId=${root.id}&limit=1`;
  const ids = []; let cursor;
  do {
    const page = f.ok(await f.api('GET', base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')));
    assert.equal(page.total, 3); ids.push(...page.items.map(x => x.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(ids).size, 3); assert.deepEqual(ids.sort(), children.map(x => x.id).sort());
  const matches = f.ok(await f.api('GET', `/api/projects/${chat.projectId}/agent-organization?scope=children&parentAgentId=${root.id}&search=Beta`));
  assert.deepEqual(matches.items.map(x => x.id), [children[1].id]);
  assert.equal(f.ok(await f.api('GET', `/api/projects/${chat.projectId}/agent-organization?scope=children&parentAgentId=${root.id}&search=Absent`)).total, 0);
  assert.equal((await f.api('GET', `/api/projects/${chat.projectId}/agent-organization?scope=children&parentAgentId=${randomUUID()}`)).status, 404);
  assert.equal((await f.api('GET', base + '&cursor=invalid')).status, 409);
  const first = f.ok(await f.api('GET', base));
  await f.createIdleAgent(chat, 'New child', root.id);
  assert.equal((await f.api('GET', base + `&cursor=${encodeURIComponent(first.nextCursor)}`)).status, 409, 'Changed membership must not silently continue an old page');
}));

for (const answer of ['approve', 'deny']) test(`checks 45, 55: scoped reorganization ${answer} cannot affect unrelated Agents or replay another owner's plan`, options, t => withFixture(t, async f => {
  const chat = await f.createChat('Scoped management'), owner = await f.createIdleAgent(chat, 'Owner'), outside = await f.createIdleAgent(chat, 'Unrelated');
  const a = await f.createIdleAgent(chat, 'Descendant A', owner.id), b = await f.createIdleAgent(chat, 'Descendant B', owner.id);
  const session = await f.hold(owner.id), otherSession = await f.hold(outside.id);
  const described = f.ok(await f.tool(session, 'ponderosa_manage', { action: 'describe' }));
  assert.deepEqual(described.descendants.map(x => x.agentId).sort(), [a.id, b.id].sort());
  assert.ok(described.permissions.requiresApprovalDecision.includes('set_manager'));
  assert.equal((await f.tool(session, 'ponderosa_manage', { action: 'plan', idempotencyKey: randomUUID(), operations: [{ kind: 'rename_agent', targetAgentId: outside.id, title: 'Unauthorized rename' }] })).status, 403);
  const args = { action: 'plan', idempotencyKey: randomUUID(), operations: [{ kind: 'set_manager', targetAgentId: a.id, managerAgentId: b.id }] };
  const plan = f.ok(await f.tool(session, 'ponderosa_manage', args));
  assert.equal(f.ok(await f.tool(session, 'ponderosa_manage', args)).planId, plan.planId);
  const decision = f.ok(await f.api('GET', `/api/decisions?agentId=${owner.id}&status=pending`)).find(x => x.id === plan.approvalDecisionId);
  assert.equal(decision.approvalScope.planId, plan.planId); assert.deepEqual(decision.approvalScope.targetAgentIds, [a.id]);
  assert.equal((await f.tool(session, 'ponderosa_manage', { action: 'apply', planId: plan.planId })).status, 409);
  assert.equal((await f.tool(otherSession, 'ponderosa_manage', { action: 'apply', planId: plan.planId })).status, 404);
  f.ok(await f.api('POST', `/api/decisions/${decision.id}/respond`, { optionId: answer }));
  const applied = await f.tool(session, 'ponderosa_manage', { action: 'apply', planId: plan.planId });
  if (answer === 'approve') {
    f.ok(applied); assert.equal((await f.detail(a.id)).agent.managerAgentId, b.id);
    assert.equal(f.ok(await f.tool(session, 'ponderosa_manage', { action: 'apply', planId: plan.planId })).replayed, true);
  } else { assert.equal(applied.status, 409); assert.equal((await f.detail(a.id)).agent.managerAgentId, owner.id); }
  assert.equal((await f.detail(outside.id)).agent.title, outside.title);
}));

test('check 55: approved management cannot rearrange a target that left its descendant scope', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Stale management'), owner = await f.createIdleAgent(chat, 'Owner'), other = await f.createIdleAgent(chat, 'Other owner');
  const a = await f.createIdleAgent(chat, 'Child A', owner.id), b = await f.createIdleAgent(chat, 'Child B', owner.id);
  const session = await f.hold(owner.id);
  const plan = f.ok(await f.tool(session, 'ponderosa_manage', { action: 'plan', idempotencyKey: randomUUID(), operations: [{ kind: 'set_manager', targetAgentId: a.id, managerAgentId: b.id }] }));
  f.ok(await f.api('POST', `/api/decisions/${plan.approvalDecisionId}/respond`, { optionId: 'approve' }));
  f.ok(await f.api('PUT', `/api/agents/${a.id}/manager`, { managerAgentId: other.id }));
  assert.equal((await f.tool(session, 'ponderosa_manage', { action: 'apply', planId: plan.planId })).status, 409);
  assert.equal((await f.detail(a.id)).agent.managerAgentId, other.id);
}));

test('check 84: stale deletion preview refuses a changed subtree without deleting any Agent', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Stale deletion'), root = await f.createIdleAgent(chat, 'Root');
  const url = `/api/projects/${chat.projectId}/agent-deletions`;
  const preview = f.ok(await f.api('POST', `${url}/preview`, { rootAgentIds: [root.id] }));
  const added = await f.createIdleAgent(chat, 'New descendant', root.id);
  const refused = await f.api('POST', `${url}/commit`, { rootAgentIds: [root.id], previewHash: preview.previewHash });
  assert.equal(refused.status, 409); assert.ok(refused.body.currentPreview.affectedAgents.some(x => x.id === added.id));
  assert.equal((await f.detail(root.id)).agent.id, root.id); assert.equal((await f.detail(added.id)).agent.id, added.id);
}));

test('check 85: disposable Agent deletion observes runtime exit, removes private history and preserves shared evidence and user files', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Safe deletion'), victim = await f.createAgent(chat, 'Disposable victim'), survivor = await f.createAgent(chat, 'Survivor');
  const file = path.join(chat.workingDirectory, 'user-owned.txt'), bytes = `Preserve ${randomUUID()}`;
  await writeFile(file, bytes);
  const shared = `Shared evidence ${randomUUID()}`;
  const sharedReceipt = f.ok(await f.api('POST', `/api/conversations/${chat.id}/messages`, { text: shared, idempotencyKey: randomUUID() }));
  const privateText = `Victim private text ${randomUUID()}`, old = (await f.detail(victim.id)).runs.map(x => x.id);
  await f.send(victim.id, privateText); await f.settled(victim.id, old);
  const session = await f.hold(victim.id), survivorBefore = await f.detail(survivor.id);
  const preview = f.ok(await f.api('POST', `/api/projects/${chat.projectId}/agent-deletions/preview`, { rootAgentIds: [victim.id] }));
  const result = f.ok(await f.api('POST', `/api/projects/${chat.projectId}/agent-deletions/commit`, { rootAgentIds: [victim.id], previewHash: preview.previewHash }));
  assert.ok(result.deletedAgentIds.includes(victim.id)); assert.equal(session.isAlive(), false);
  assert.equal((await f.api('GET', `/api/agents/${victim.id}`)).status, 404);
  assert.deepEqual((await f.detail(survivor.id)).messages.map(x => x.id), survivorBefore.messages.map(x => x.id));
  const conversation = f.ok(await f.api('GET', `/api/conversations/${chat.id}`));
  assert.ok(conversation.messages.some(x => x.communicationEventId === sharedReceipt.communicationEventId && x.text.includes(shared)));
  assert.equal(result.cleanupPending, false);
  assert.equal((await f.api('GET', `/api/agents/${victim.id}/history/runOutput`)).status, 404);
  await assert.rejects(access(path.join(f.dataDir, 'projects', chat.projectId, 'agents', victim.id, 'events.jsonl')), { code: 'ENOENT' });
  assert.equal(await readFile(file, 'utf8'), bytes);
}));

test('checks 38, 58: concurrency limit queues work and Home activity follows actual capacity release', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Bounded scheduler');
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { maxConcurrentAgentRuns: 1 }));
  const workers = [];
  for (const title of ['First', 'Second', 'Third']) workers.push(await f.createIdleAgent(chat, title));
  const first = await f.hold(workers[0].id);
  for (const w of workers.slice(1)) { f.plans.set(w.id, [{ hold: true }]); await f.send(w.id, `Queued capacity work ${w.title}`); }
  assert.equal(f.turns.length, 1);
  let summary = f.ok(await f.api('GET', '/api/workspace/directory/agent?summary=true'));
  assert.equal(summary.total, 3); assert.equal(summary.runningCount, 1);
  for (let i = 0; i < workers.length; i++) {
    await until(() => f.turns.some(x => x.agentId === workers[i].id), 'next capacity slot');
    const states = await Promise.all(workers.map(w => f.detail(w.id)));
    assert.equal(states.flatMap(x => x.runs).filter(x => ['running', 'preparing'].includes(x.status)).length, 1);
    (i === 0 ? first : f.sessions.get(workers[i].id)).finish(); await ended(f, workers[i].id);
  }
  assert.equal(f.turns.length, 3); assert.equal(new Set(f.turns.map(x => x.agentId)).size, 3);
  summary = f.ok(await f.api('GET', '/api/workspace/directory/agent?summary=true')); assert.equal(summary.runningCount, 0);
}));

test('checks 86, 88: selected Chat deletion fences stale member lists and preserves other Chats, user files and published artifacts', options, t => withFixture(t, async f => {
  const a = await f.createChat('Selected A'), b = await f.createChat('Selected B'), survivor = await f.createChat('Unselected survivor');
  const author = await f.createIdleAgent(a, 'Published author'), second = await f.createIdleAgent(b, 'Second victim');
  const bytes = `Retained published bytes ${randomUUID()}`, file = path.join(a.workingDirectory, 'retained.txt'); await writeFile(file, bytes);
  const session = await f.hold(author.id), imported = f.ok(await f.tool(session, 'ponderosa_import_file', { path: 'retained.txt' }));
  f.ok(await f.api('PATCH', `/api/agents/${author.id}/artifacts/${imported.artifact.id}`, { visibility: 'published' }));
  const added = await f.createIdleAgent(a, 'Member added after preview');
  assert.equal((await f.api('DELETE', `/api/conversations/${a.id}`, { expectedAgentIds: [author.id] })).status, 409);
  assert.equal((await f.detail(added.id)).agent.id, added.id);
  assert.equal((await f.api('DELETE', `/api/conversations/${a.id}`, { expectedAgentIds: [author.id, added.id] })).status, 409, 'Active Chat deletion was accepted without an explicit stop');
  const active = (await f.detail(author.id)).runs.find(x => x.status === 'running');
  f.ok(await f.api('POST', `/api/agents/${author.id}/cancel`, { targetRunId: active.id, idempotencyKey: randomUUID() }));
  await until(async () => !(await f.detail(author.id)).coordinationV3.activeRun, 'cancelled Run authority retired');
  await until(async () => {
    const health = f.ok(await f.api('GET', `/api/conversations/${a.id}/agent-health`));
    const owner = health.agents.find(x => x.agentId === author.id);
    return owner && !owner.executionId && !owner.runtimeOwnership;
  }, 'cancelled execution drained from Chat health');
  for (const [chat, memberIds] of [[a, [author.id, added.id]], [b, [second.id]]]) {
    const deleted = f.ok(await f.api('DELETE', `/api/conversations/${chat.id}`, { expectedAgentIds: memberIds })); assert.equal(deleted.deleted, true); assert.equal(deleted.cleanupPending, false);
    assert.equal((await f.api('GET', `/api/conversations/${chat.id}`)).status, 404);
    for (const id of memberIds) assert.equal((await f.api('GET', `/api/agents/${id}`)).status, 404);
  }
  assert.equal(session.isAlive(), false); assert.equal(f.ok(await f.api('GET', `/api/conversations/${survivor.id}`)).conversation.id, survivor.id);
  assert.equal(await readFile(file, 'utf8'), bytes); assert.equal((await f.api('GET', imported.artifact.downloadUrl)).body, bytes);
  assert.equal(f.ok(await f.api('DELETE', `/api/conversations/${a.id}`)).replayed, true);
}));
