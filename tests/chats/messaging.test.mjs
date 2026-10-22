import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withFixture, until, runtimeAttachmentPaths, fixtureTestOptions as options } from '../shared/fixture.mjs';

const rendered = turn => [JSON.stringify(turn.history), JSON.stringify(turn.input)].join('\n');

test('checks 1, 12, 16: shared request replay emits one explicit reply and keeps execution output separate', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Shared request');
  const agent = await f.createAgent(chat, 'Responsible Agent');
  const previous = (await f.detail(agent.id)).runs.map(r => r.id);
  const reply = `Shared response ${randomUUID()}`;
  f.plans.set(agent.id, [{ run: async session => assert.equal((await session.tool('ponderosa_message', { text: reply })).success, true) }]);
  const body = { text: `#${agent.handle} Reply to this exact shared request`, idempotencyKey: randomUUID(), recipientAgentMentions: [{ agentId: agent.id, projectId: chat.projectId, handle: agent.handle, currentHandle: agent.handle, currentTitle: agent.title }] };
  const first = f.ok(await f.api('POST', `/api/conversations/${chat.id}/messages`, body));
  const replay = f.ok(await f.api('POST', `/api/conversations/${chat.id}/messages`, body));
  assert.equal(replay.communicationEventId, first.communicationEventId);
  const d = await f.settled(agent.id, previous);
  assert.equal(f.turns.filter(x => x.agentId === agent.id).length, 2);
  assert.equal(d.messages.filter(x => x.text.includes(reply)).length, 1);
  assert.ok(JSON.stringify(d.runOutput).includes('Ordinary fixture execution output'));
  const conversation = f.ok(await f.api('GET', `/api/conversations/${chat.id}`));
  assert.ok(JSON.stringify(conversation).includes(reply));
  assert.ok(!JSON.stringify(conversation).includes('Ordinary fixture execution output'));
}));

test('checks 6, 7, 9, 56: reply after rename reaches the stable recipient; fresh unrelated context excludes private text', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Private reply');
  const target = await f.createAgent(chat, 'Original name');
  const renamed = f.ok(await f.api('PATCH', `/api/agents/${target.id}`, { title: 'Renamed reader' }));
  assert.equal(renamed.id, target.id);
  const marker = `private-${randomUUID()}`, previous = (await f.detail(target.id)).runs.map(r => r.id);
  await f.send(target.id, marker);
  const d = await f.settled(target.id, previous);
  const turn = f.turns.filter(x => x.agentId === target.id).at(-1);
  assert.ok(rendered(turn).includes(marker));
  const run = d.runs.find(r => !previous.includes(r.id));
  const input = f.ok(await f.api('GET', `/api/runs/${run.id}/provider-input?exact=1`));
  assert.ok(JSON.stringify(input).includes(marker));
  const other = await f.createAgent(chat, 'Unrelated reader');
  assert.ok(!rendered(f.turns.find(x => x.agentId === other.id)).includes(marker));
  assert.ok(d.messages.some(x => x.role === 'assistant' && x.text === 'Explicit fixture reply'));
}));

for (const fresh of [false, true]) test(`checks 3, 17: explicitly attached text is read by the ${fresh ? 'fresh' : 'continued'} provider session`, options, t => withFixture(t, async f => {
  const chat = await f.createChat('Attachment reader'), otherChat = await f.createChat('Other owner');
  const agent = await f.createAgent(chat, 'Reader');
  const contents = `Only-in-file ${randomUUID()}`;
  const asset = f.ok(await f.api('POST', `/api/agents/${agent.id}/attachments`, Buffer.from(contents), { 'content-type': 'application/octet-stream', 'x-ponderosa-filename': 'fixture.txt', 'x-ponderosa-media-type': 'text/plain' }));
  const before = (await f.detail(agent.id)).runs.map(r => r.id), oldSession = f.sessions.get(agent.id).engineAgentId;
  if (fresh) f.ok(await f.api('PATCH', '/api/workspace/preferences', { globalInstructions: 'Fresh fixture policy' }));
  let bytes;
  f.plans.set(agent.id, [{ run: async (session, input, turn) => {
    const text = rendered(turn);
    assert.ok(!text.includes(contents), 'Expected file contents leaked into prompt');
    const candidates = runtimeAttachmentPaths(turn);
    assert.ok(candidates.length, 'No supplied runtime attachment path');
    bytes = await readFile(candidates[0], 'utf8');
    assert.equal((await session.tool('ponderosa_message', { text: `Read: ${bytes}` })).success, true);
  } }]);
  await f.send(agent.id, 'Read only the supplied fixture.txt and report its contents.', { attachmentIds: [asset.id] });
  const d = await f.settled(agent.id, before);
  assert.equal(bytes, contents);
  assert.ok(d.messages.some(x => x.text === `Read: ${contents}`));
  assert.equal(f.sessions.get(agent.id).engineAgentId === oldSession, !fresh);
  assert.equal((await f.api('GET', `/api/conversations/${otherChat.id}/assets/${asset.id}/download`)).status, 404);
}));

test('checks 69, 70, 79: captured text artifact bytes and full-copy instructions survive reopening', options, t => withFixture(t, async f => {
  const source = await f.createChat('Artifact source'), target = await f.createChat('Import target');
  const instructions = `Saved guidance ${randomUUID()}`;
  f.ok(await f.api('PATCH', `/api/conversations/${source.id}`, { instructions }));
  const agent = await f.createAgent(source, 'Publisher');
  const bytes = `Text artifact ${randomUUID()}`;
  await writeFile(path.join(source.workingDirectory, 'artifact.txt'), bytes);
  const session = await f.hold(agent.id);
  const published = f.ok(await f.tool(session, 'ponderosa_import_file', { path: 'artifact.txt' }));
  const download = await f.api('GET', published.artifact.downloadUrl);
  assert.equal(download.body, bytes);
  const reader = await f.createAgent(source, 'Text artifact reader');
  f.plans.set(reader.id, [{ run: async (s, input, turn) => {
    const references = turn.input.prompt.split('\n').filter(line => line.startsWith('{') && line.includes(published.artifact.id)).map(line => JSON.parse(line));
    const reference = references.find(x => x.artifactId === published.artifact.id);
    assert.ok(reference?.localPath, 'Explicit artifact has no readable provider reference');
    assert.ok(!JSON.stringify(turn.input).includes(bytes), 'File-derived answer was already in the question');
    const actual = await readFile(reference.localPath, 'utf8');
    assert.equal(actual, bytes);
    assert.equal((await s.tool('ponderosa_message', { text: `Artifact read: ${actual}` })).success, true);
  } }]);
  const readerPrevious = (await f.detail(reader.id)).runs.map(r => r.id);
  f.ok(await f.tool(session, 'ponderosa_message', { intent: 'collaboration', recipientAgentIds: [reader.id], text: `Read the text artifact ponderosa://artifact/${published.artifact.id}`, artifactIds: [published.artifact.id], urgency: 'urgent' }));
  const readerDetail = await f.settled(reader.id, readerPrevious);
  assert.ok(readerDetail.messages.some(x => x.text.includes(`Artifact read: ${bytes}`)));
  session.finish(); await until(async () => !(await f.detail(agent.id)).runs.some(r => ['running','preparing'].includes(r.status)), 'publisher finish');
  const pkg = f.ok(await f.api('GET', `/api/agents/${agent.id}/export?mode=full`));
  assert.equal(pkg.sourceProjectInstructions, instructions);
  const imported = f.ok(await f.api('POST', `/api/projects/${target.projectId}/import-agents`, { package: pkg, conversationId: target.id, engineMapping: { codex: 'codex' } }, { 'idempotency-key': randomUUID() }));
  await f.reopen();
  assert.equal(f.ok(await f.api('GET', `/api/conversations/${target.id}`)).conversation.instructions, instructions);
  assert.equal(f.ok(await f.api('GET', `/api/agents/${imported.rootAgentId}/export?mode=full`)).sourceProjectInstructions, instructions);
}));

test('checks 46, 47, 48, 50, 51: manager consumes blocked/failed children before final delivery', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Delegation');
  const manager = await f.createAgent(chat, 'Manager'), a = await f.createAgent(chat, 'Worker A'), b = await f.createAgent(chat, 'Worker B');
  f.plans.set(a.id, [{ hold: true }]); f.plans.set(b.id, [{ hold: true }]);
  const session = await f.hold(manager.id);
  const coordinated = f.ok(await f.tool(session, 'ponderosa_coordinate', { idempotencyKey: randomUUID(), requests: [a,b].map(w => ({ recipientAgentId: w.id, text: `Work for ${w.title}`, lifetime: { kind: 'indefinite' } })), join: { mode: 'all', satisfyingOutcomes: ['blocked','failed'], wakePolicy: 'final_only' } }));
  await until(() => [a,b].every(w => f.turns.filter(x => x.agentId === w.id).length === 2), 'worker inputs');
  assert.ok(rendered(f.turns.filter(x => x.agentId === a.id).at(-1)).includes('Work for Worker A'));
  assert.equal((await f.tool(session, 'ponderosa_message', { text: 'Premature report', taskDelivery: 'final' })).status, 409);
  f.ok(await f.tool(f.sessions.get(a.id), 'ponderosa_update_request', { kind: 'blocked', text: 'Missing prerequisite' })); f.sessions.get(a.id).finish();
  assert.equal((await f.tool(session, 'ponderosa_message', { text: 'Still premature', taskDelivery: 'final' })).status, 409);
  f.ok(await f.tool(f.sessions.get(b.id), 'ponderosa_update_request', { kind: 'failed', text: 'Validation failed' })); f.sessions.get(b.id).finish();
  let final;
  f.plans.set(manager.id, [{ run: async (s, input, turn) => {
    assert.ok(rendered(turn).includes('Missing prerequisite')); assert.ok(rendered(turn).includes('Validation failed'));
    final = await f.tool(s, 'ponderosa_message', { text: 'Worker A blocked; Worker B failed. Neither succeeded.', taskDelivery: 'final' });
    f.ok(final);
  } }]);
  session.finish(); await until(() => final, 'resumed manager');
  const d = await until(async () => { const detail = await f.detail(manager.id); return detail.messages.some(x => x.text === 'Worker A blocked; Worker B failed. Neither succeeded.') ? detail : false; }, 'canonical final');
  assert.equal(d.coordinationV3.joins.find(x => x.id === coordinated.joinId).state, 'satisfied');
  assert.deepEqual(d.coordinationV3.requests.filter(x => coordinated.requestIds.includes(x.id)).map(x => x.state).sort(), ['blocked','failed']);
}));
