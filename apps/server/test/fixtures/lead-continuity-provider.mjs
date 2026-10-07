#!/usr/bin/env node
// Disposable subscription-free CLI fixture. Only the test's loopback scoped
// capabilities are used; no real provider, profile, release or private file.
import { createInterface } from 'node:readline';
import { appendFile, access } from 'node:fs/promises';
import { watch } from 'node:fs';
const env = process.env;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
async function call(url, body) {
  if (new URL(url).hostname !== '127.0.0.1') throw Error('fixture refuses non-loopback requests');
  const response = await fetch(url, { method: 'POST', headers: {
    authorization: `Bearer ${env.PONDEROSA_AGENT_MESSAGE_TOKEN}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
  if (!response.ok) throw Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
async function awaitGate() {
  try { await access(env.CONTINUITY_GATE); return; } catch {}
  await new Promise((resolve, reject) => {
    const watcher = watch(env.CONTINUITY_DIRECTORY, async () => {
      try { await access(env.CONTINUITY_GATE); watcher.close(); resolve(); } catch {}
    });
    watcher.on('error', reject);
    access(env.CONTINUITY_GATE).then(() => { watcher.close(); resolve(); }, () => {});
  });
}
let turn = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line); if (frame.type !== 'user') continue; turn++;
  await appendFile(env.CONTINUITY_CAPTURE, JSON.stringify(frame) + '\n');
  send({ type: 'system', subtype: 'init', session_id: frame.session_id });
  send({ ...frame, parent_tool_use_id: null, isReplay: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  const role = env.CONTINUITY_ROLE;
  const text = JSON.stringify(frame.message);
  const fence = text.match(/Prompt injection fence: ([a-f0-9-]+)\./)?.[1];
  if (role === 'lead' && turn === 1) {
    await call(env.PONDEROSA_AGENT_COORDINATE_URL, { idempotencyKey: 'review', requests: [{ requestId: 'controlled-review',
      recipientAgentId: env.CONTINUITY_PEER, text: 'Read-only reviewer: validate only; report to lead.', lifetime: { kind: 'indefinite' } }],
      join: { id: 'controlled-join', mode: 'all' } });
    await call(env.PONDEROSA_AGENT_MESSAGE_URL, { text: 'Implementation underway; review and delivery remain.', steeringInjectionId: fence });
  } else if (role === 'reviewer') {
    await awaitGate();
    await call(env.PONDEROSA_AGENT_MESSAGE_URL, { intent: 'collaboration', recipientAgentIds: [env.CONTINUITY_LEAD],
      idempotencyKey: 'peer-report', text: 'Read-only reviewer report: no blockers. I do not own implementation or release delivery.' });
    await call(env.PONDEROSA_AGENT_UPDATE_REQUEST_URL, { requestId: 'controlled-review', updateId: 'controlled-result', kind: 'completed', text: 'Read-only review passed; lead still owns final integration and delivery.' });
  } else if (role === 'replacement') {
    // Verify the real route permits an interim update then a different final
    // receipt on the same exact Run, without confusing replay authority.
    await call(env.PONDEROSA_AGENT_MESSAGE_URL, { intent: 'direct_to_user', steeringInjectionId: fence,
      text: 'Review received; final validation still in progress.' });
    if (env.CONTINUITY_DECISION === '1' && !text.includes('Approve the disposable final-delivery fixture?')) {
      await call(env.PONDEROSA_AGENT_DECISION_URL, { idempotencyKey: 'controlled-task-permission', mode: 'approval',
        question: 'Approve the disposable final-delivery fixture?', blocking: true });
    } else {
    const body = { intent: 'direct_to_user', idempotencyKey: 'exact-final', steeringInjectionId: fence, taskDelivery: 'final',
      text: 'Disposable final delivery: review integrated; validation passed. No real release was signed, pushed or published.' };
    const first = await call(env.PONDEROSA_AGENT_MESSAGE_URL, body);
    const replay = await call(env.PONDEROSA_AGENT_MESSAGE_URL, body);
    if (first.eventId !== replay.eventId) throw Error('canonical final replay duplicated');
    }
  }
  const handoff = role === 'lead' && turn > 1;
  send({ type: 'assistant', session_id: frame.session_id, parent_tool_use_id: null, message: {
    id: `current-${turn}`, role: 'assistant', model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: handoff
      ? 'Lead task continuity: I own integration and operator delivery. The controlled review remains pending; integrate it and deliver once. Reviewer restrictions apply only to the reviewer. No real signing/pushing authority was requested.'
      : 'Disposable provider output, not canonical final delivery.' }],
    usage: { input_tokens: role === 'lead' ? 150001 : 8000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20 },
  } });
  send({ type: 'result', subtype: 'success', session_id: frame.session_id, is_error: false, result: 'Disposable result' });
}
