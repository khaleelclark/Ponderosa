#!/usr/bin/env node
// Disposable subscription-free CLI fixture. Only the test's loopback scoped
// capabilities are used; no real provider, profile, release or private file.
import { createInterface } from 'node:readline';
import { appendFile, access } from 'node:fs/promises';
import { watch } from 'node:fs';
const env = process.env;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
async function call(url, body, expectedStatus) {
  if (new URL(url).hostname !== '127.0.0.1') throw Error('fixture refuses non-loopback requests');
  const response = await fetch(url, { method: 'POST', headers: {
    authorization: `Bearer ${env.PONDEROSA_AGENT_MESSAGE_TOKEN}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
  if (expectedStatus !== undefined ? response.status !== expectedStatus : !response.ok) throw Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
async function awaitGate(path = env.CONTINUITY_GATE) {
  try { await access(path); return; } catch {}
  await new Promise((resolve, reject) => {
    const watcher = watch(env.CONTINUITY_DIRECTORY, async () => {
      try { await access(path); watcher.close(); resolve(); } catch {}
    });
    watcher.on('error', reject);
    access(path).then(() => { watcher.close(); resolve(); }, () => {});
  });
}
let turn = 0;
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
for (;;) {
  const next = await input.next(); if (next.done) break;
  const line = next.value;
  const frame = JSON.parse(line); if (frame.type !== 'user') continue; turn++;
  await appendFile(env.CONTINUITY_CAPTURE, JSON.stringify(frame) + '\n');
  send({ type: 'system', subtype: 'init', session_id: frame.session_id });
  send({ ...frame, parent_tool_use_id: null, isReplay: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  const role = env.CONTINUITY_ROLE;
  const text = JSON.stringify(frame.message);
  const fence = text.match(/Prompt injection fence: ([a-f0-9-]+)\./)?.[1];
  if (role === 'association-error') {
    let answered = false;
    try { await access(env.CONTINUITY_ERROR_SEEN); answered = true; } catch {}
    if (!answered) {
      await call(env.PONDEROSA_AGENT_DECISION_URL, { idempotencyKey: 'provider-error-permission',
        mode: 'approval', question: 'Approve after the disposable provider error?', blocking: true }, 500);
      await appendFile(env.CONTINUITY_ERROR_SEEN, 'failed');
      send({ type: 'result', subtype: 'error_during_execution', session_id: frame.session_id,
        is_error: true, result: 'Disposable provider error after canonical Decision association rollback' });
      continue;
    }
    const body = { intent: 'direct_to_user', idempotencyKey: 'post-error-final', steeringInjectionId: fence,
      text: 'Exact approved task delivered after the provider error.' };
    const first = await call(env.PONDEROSA_AGENT_MESSAGE_URL, body);
    const replay = await call(env.PONDEROSA_AGENT_MESSAGE_URL, body);
    if (first.eventId !== replay.eventId) throw Error('post-error final duplicated');
    send({ type: 'result', subtype: 'success', session_id: frame.session_id, is_error: false, result: 'Delivered' });
    continue;
  }
  if (text.includes('Unrelated active-work fixture')) {
    send({ type: 'assistant', session_id: frame.session_id, parent_tool_use_id: null,
      message: { id: 'unrelated-ready', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Unrelated public work remains active.' }],
        usage: { input_tokens: 8000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } });
    await appendFile(env.CONTINUITY_UNRELATED_READY, 'ready'); await awaitGate(env.CONTINUITY_UNRELATED_GATE);
    await call(env.PONDEROSA_AGENT_MESSAGE_URL, { intent: 'direct_to_user', steeringInjectionId: fence,
      text: 'Unrelated active-work fixture completed independently.' });
  } else if (role === 'lead' && turn === 1) {
    if (env.CONTINUITY_DECISION_BEFORE === '1') await call(env.PONDEROSA_AGENT_DECISION_URL,
      { idempotencyKey: 'controlled-task-permission', mode: 'approval',
        question: 'Approve the disposable final-delivery fixture?', blocking: true },
      env.CONTINUITY_ASSOCIATION_FAILURE === '1' ? 500 : undefined);
    if (env.CONTINUITY_DECISION_ONLY !== '1') await call(env.PONDEROSA_AGENT_COORDINATE_URL, { idempotencyKey: 'review', requests: [{ requestId: 'controlled-review',
      recipientAgentId: env.CONTINUITY_PEER, text: 'Read-only reviewer: validate only; report to lead.', lifetime: { kind: 'indefinite' } }],
      join: { id: 'controlled-join', mode: 'all' } });
    await call(env.PONDEROSA_AGENT_MESSAGE_URL, { text: 'Implementation underway; review and delivery remain.', steeringInjectionId: fence });
  } else if (role === 'reviewer') {
    await awaitGate();
    await call(env.PONDEROSA_AGENT_MESSAGE_URL, { intent: 'collaboration', recipientAgentIds: [env.CONTINUITY_LEAD],
      idempotencyKey: 'peer-report', text: 'Read-only reviewer report: no blockers. I do not own implementation or release delivery.' });
    await call(env.PONDEROSA_AGENT_UPDATE_REQUEST_URL, { requestId: 'controlled-review', updateId: 'controlled-result', kind: 'completed', text: 'Read-only review passed; lead still owns final integration and delivery.' });
  } else if (role === 'replacement') {
    if (env.CONTINUITY_DECISION_STEER === '1') send({ type: 'assistant', session_id: frame.session_id, parent_tool_use_id: null,
      message: { id: 'verified-replacement', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'Public replacement verification; final work remains active.' }],
        usage: { input_tokens: 8000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } });
    // Verify the real route permits an interim update then a different final
    // receipt on the same exact Run, without confusing replay authority.
    await call(env.PONDEROSA_AGENT_MESSAGE_URL, { intent: 'direct_to_user', steeringInjectionId: fence,
      text: 'Review received; final validation still in progress.' });
    let needsDecisionOnlyDelegation = false;
    if (env.CONTINUITY_DECISION_ONLY === '1') {
      try { await access(env.CONTINUITY_DELEGATED_GATE); } catch { needsDecisionOnlyDelegation = true; }
    }
    if (needsDecisionOnlyDelegation) {
      await call(env.PONDEROSA_AGENT_COORDINATE_URL, { idempotencyKey: 'review', requests: [{ requestId: 'controlled-review',
        recipientAgentId: env.CONTINUITY_PEER, text: 'Read-only reviewer: validate only; report to lead.', lifetime: { kind: 'indefinite' } }],
        join: { id: 'controlled-join', mode: 'all' } });
      await appendFile(env.CONTINUITY_DELEGATED_GATE, 'delegated');
    } else if (env.CONTINUITY_DECISION_ONLY !== '1' && env.CONTINUITY_DECISION === '1' && !text.includes('Approve the disposable final-delivery fixture?')) {
      if (env.CONTINUITY_DECISION_BEFORE === '1') {
        // No final attempt, Decision replay or restart may repair this case:
        // the promoted task must already retain its exact pending approval.
      } else {
      const request = { idempotencyKey: 'controlled-task-permission', mode: 'approval',
        question: 'Approve the disposable final-delivery fixture?', blocking: true };
      if (env.CONTINUITY_ASSOCIATION_FAILURE === '1') {
        await call(env.PONDEROSA_AGENT_DECISION_URL, request, 500);
        // The canonical Decision exists, but its SQLite wait rolled back. A
        // rejected final attempt must repair the wait before this Run ends.
        const denied = await call(env.PONDEROSA_AGENT_MESSAGE_URL, { intent: 'direct_to_user',
          idempotencyKey: 'gap-final', taskDelivery: 'final', text: 'Must not publish through an association gap.' }, 409);
        if (!denied.error.startsWith('task_delivery_dependencies_pending')) throw Error('unexpected association-gap denial');
      }
      const first = await call(env.PONDEROSA_AGENT_DECISION_URL, request);
      const replay = await call(env.PONDEROSA_AGENT_DECISION_URL, request);
      if (first.id !== replay.id) throw Error('canonical Decision replay duplicated');
      const second = await call(env.PONDEROSA_AGENT_DECISION_URL, { ...request,
        idempotencyKey: 'different-task-permission', question: 'A second unanswered permission?' }, 409);
      if (!second.error.startsWith('task_decision_already_pending')) throw Error('unexpected second-Decision rejection');
      const premature = await call(env.PONDEROSA_AGENT_MESSAGE_URL, { intent: 'direct_to_user',
        idempotencyKey: 'premature-final', taskDelivery: 'final', text: 'Must not publish before approval.' }, 409);
      if (!premature.error.startsWith('task_delivery_dependencies_pending')) throw Error('unexpected premature-final rejection');
      if (env.CONTINUITY_DECISION_STEER === '1') {
        await appendFile(env.CONTINUITY_DECISION_READY, 'ready');
        const response = await input.next();
        if (response.done) throw Error('Decision steering input missing');
        const answer = JSON.parse(response.value);
        if (answer.type !== 'user') throw Error('Decision steering was not a user input');
        await appendFile(env.CONTINUITY_CAPTURE, JSON.stringify(answer) + '\n');
        send({ ...answer, parent_tool_use_id: null, isReplay: true });
        const answerFence = JSON.stringify(answer.message).match(/Prompt injection fence: ([a-f0-9-]+)\./)?.[1];
        if (!answerFence || answerFence === fence) throw Error('missing exact Decision steering fence');
        await awaitGate(env.CONTINUITY_FINAL_GATE);
        const body = { intent: 'direct_to_user', idempotencyKey: 'exact-final', steeringInjectionId: answerFence, taskDelivery: 'final',
          text: 'Disposable final delivery: review integrated; validation passed. No real release was signed, pushed or published.' };
        const first = await call(env.PONDEROSA_AGENT_MESSAGE_URL, body);
        const replay = await call(env.PONDEROSA_AGENT_MESSAGE_URL, body);
        if (first.eventId !== replay.eventId) throw Error('canonical steered final replay duplicated');
      }
      }
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
