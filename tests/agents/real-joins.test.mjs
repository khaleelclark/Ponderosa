import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { TERMINAL_REQUEST_STATES } from '@ponderosa/core';
import { withRealCodex, options } from '../shared/real-codex-fixture.mjs';
import { until } from '../shared/fixture.mjs';

const noHost = 'No files, shell, browser, network, provider-native helpers, or Agent creation. Use only the specified Ponderosa communication/coordination/Decision tools.';
const joins = detail => detail.coordinationV3.activations.filter(item => item.kind.startsWith('coordination_join_'));
const matches = (actual, expected) => actual.trim() === expected;
function stageTurns() {
  const gates = new Map();
  return {
    arm(agentId, tag) {
      let release; const promise = new Promise(resolve => { release = resolve; });
      gates.set(agentId, { tag, promise, release, reached: false });
    },
    async beforeTurn({ agentId, input }) {
      const gate = gates.get(agentId);
      if (gate && input.prompt.includes(gate.tag)) { gate.reached = true; await gate.promise; }
    },
    reached(agentId) { return gates.get(agentId)?.reached; },
    release(agentId) { const gate = gates.get(agentId); gates.delete(agentId); gate?.release(); },
    releaseAll() { for (const gate of gates.values()) gate.release(); gates.clear(); },
  };
}
async function setup(f, staging, mode, wakePolicy, count) {
  const chat = await f.createChat(`Real ${mode} ${wakePolicy} collection`);
  const manager = await f.createAgent(chat, 'Collection manager'), workers = [], nonces = [], warm = [];
  for (let i = 0; i < count; i++) {
    const worker = await f.createAgent(chat, `Gated worker ${String.fromCharCode(65 + i)}`, manager.id), nonce = `worker-only-${randomUUID()}`;
    workers.push(worker); nonces.push(nonce);
    await f.send(worker.id, `Your private result token is ${nonce}. Preserve it in this private session. Reply now via ponderosa_message intent direct_to_user exactly PRIVATE_READY without quoting the token. On a later correlated Request, report ponderosa_update_request kind completed text \"RESULT:${String.fromCharCode(65 + i)}:<your-private-token>\". Do not replace that result with a standalone message. ${noHost}`);
    warm.push(await f.wait(worker.id));
    assert.ok(warm[i].messages.some(item => item.role === 'assistant' && item.text.trim() === 'PRIVATE_READY'));
  }
  const tag = `threshold-task-${randomUUID()}`;
  for (const worker of workers) staging.arm(worker.id, tag);
  const args = { idempotencyKey: randomUUID(), requests: workers.map((worker, i) => ({ recipientAgentId: worker.id, lifetime: { kind: 'indefinite' }, text: `${tag}: Report fixture result ${String.fromCharCode(65 + i)} using your privately supplied token through ponderosa_update_request kind completed. Do not invent another task, question or Decision. ${noHost}` })), join: { mode, ...(mode === 'quorum' ? { quorum: 2 } : {}), wakePolicy } };
  const instruction = wakePolicy === 'each_result'
    ? 'On the first progress activation, send exactly one ponderosa_message intent direct_to_user text \"PROGRESS:<actual RESULT:A:... text>\" without taskDelivery. End that turn: B remains unfinished. On the terminal Join activation, send exactly one ponderosa_message intent direct_to_user taskDelivery final text \"FINAL:<actual RESULT:A:... text>|<actual RESULT:B:... text>\" in A,B order. Do not guess either value or publish a final on progress.'
    : `On the satisfied ${mode} Join activation, send exactly one ponderosa_message intent direct_to_user text \"THRESHOLD:${mode}:<actual satisfying RESULT texts joined with | in A,B order>\" without taskDelivery. The other worker Requests are still unfinished: report only the threshold results as interim information. Do not complete/cancel remaining workers or publish a taskDelivery final.`;
  await f.send(manager.id, `Call ponderosa_coordinate once with ${JSON.stringify(args)}. End the turn and wait; do not poll or repeat delegation/Join creation. ${instruction} ${noHost}`);
  await until(() => workers.every(worker => staging.reached(worker.id)), 'all actual worker starts reach controlled ordering barriers', 150000);
  const before = await f.wait(manager.id);
  assert.equal(before.coordinationV3.joins.length, 1); assert.equal(before.coordinationV3.joins[0].state, 'open');
  assert.equal(before.coordinationV3.joins[0].mode, mode); assert.equal(before.coordinationV3.joins[0].wakePolicy, wakePolicy);
  assert.equal(before.coordinationV3.requests.filter(item => item.direction === 'outbound').length, count);
  assert.equal(joins(before).length, 0, 'Manager woke before any worker result');
  assert.ok(!before.messages.some(item => item.role === 'assistant' && /^(THRESHOLD:|PROGRESS:|FINAL:)/.test(item.text.trim())));
  assert.equal(f.toolCalls.filter(call => call.agentId === manager.id && call.name === 'ponderosa_coordinate' && call.result.success).length, 1);
  const managerInputs = f.submitted.filter(input => input.agentId === manager.id);
  assert.ok(managerInputs.length && managerInputs.every(input => nonces.every(nonce => !input.prompt.includes(nonce))), 'Worker-only answers leaked into initial manager input');
  return { chat, manager, workers, before, nonces, warm };
}
async function release(f, staging, state, index) {
  const result = `RESULT:${String.fromCharCode(65 + index)}:${state.nonces[index]}`;
  staging.release(state.workers[index].id);
  await until(async () => {
    const detail = await f.api('GET', `/api/agents/${state.manager.id}`);
    return detail.coordinationV3.requests.some(item => item.direction === 'outbound' && item.counterpartyAgentId === state.workers[index].id && item.state === 'completed');
  }, 'real correlated worker completion', 150000);
  const worker = await f.wait(state.workers[index].id, state.warm[index].runs.map(run => run.id));
  assert.equal(worker.agent.managerAgentId, state.manager.id);
  const request = worker.coordinationV3.requests.find(item => item.direction === 'inbound' && item.counterpartyAgentId === state.manager.id);
  assert.ok(request); assert.equal(request.state, 'completed');
  const events = (await f.events(state.chat)).filter(event => event.sender.agentId === state.workers[index].id && event.correlationId === request.id && event.text === result);
  assert.equal(events.length, 1); assert.equal(events[0].intent, 'collaboration'); assert.deepEqual(events[0].audience.agentIds, [state.manager.id]);
  assert.ok(f.toolCalls.some(call => call.agentId === state.workers[index].id && call.name === 'ponderosa_update_request' && call.result.success));
  return result;
}
async function waitMessage(f, state, expected) {
  await until(async () => (await f.api('GET', `/api/agents/${state.manager.id}`)).messages.some(item => item.role === 'assistant' && matches(item.text, expected)), 'real manager integrates exact results', 150000);
  const detail = await f.wait(state.manager.id);
  const events = (await f.events(state.chat)).filter(event => event.sender.agentId === state.manager.id && matches(event.text, expected));
  assert.equal(events.length, 1); assert.equal(events[0].intent, 'user_dm'); assert.equal(events[0].audience.kind, 'user_agent'); assert.equal(events[0].audience.agentId, state.manager.id);
  assert.equal(detail.coordinationV3.joins.length, 1);
  return detail;
}
for (const [mode, required] of [['any', 1], ['quorum', 2]]) test(`checks 47, 51, 56: real Codex ${mode} threshold integrates actual results while remaining workers stay unfinished`, options, async t => {
  const staging = stageTurns();
  await withRealCodex(t, async f => {
  try {
  const state = await setup(f, staging, mode, 'final_only', required + 1), results = [];
  for (let i = 0; i < required; i++) {
    results.push(await release(f, staging, state, i));
    if (i + 1 < required) {
      const partial = await f.api('GET', `/api/agents/${state.manager.id}`);
      assert.equal(partial.coordinationV3.joins[0].state, 'open'); assert.equal(joins(partial).length, 0);
    }
  }
  const detail = await waitMessage(f, state, `THRESHOLD:${mode}:${results.join('|')}`), join = detail.coordinationV3.joins[0];
  assert.equal(join.state, 'satisfied'); assert.equal(join.completed, required); assert.equal(join.total, required + 1);
  const outbound = detail.coordinationV3.requests.filter(item => item.direction === 'outbound');
  assert.equal(outbound.length, required + 1); assert.equal(outbound.filter(item => item.state === 'completed').length, required);
  assert.ok(outbound.filter(item => item.counterpartyAgentId === state.workers.at(-1).id).every(item => !TERMINAL_REQUEST_STATES.has(item.state)));
  assert.equal(staging.reached(state.workers.at(-1).id), true, 'Unfinished actual worker lost its held start');
  assert.equal(joins(detail).length, 1); assert.equal(joins(detail)[0].kind, 'coordination_join_satisfied'); assert.equal(joins(detail)[0].state, 'consumed');
  for (const result of results) assert.ok(f.submitted.some(input => input.agentId === state.manager.id && input.prompt.includes(result)), 'Exact result never accepted by actual manager');
  assert.ok(!(await f.events(state.chat)).some(event => event.intent === 'broadcast' && results.some(result => event.text.includes(result))));
  t.diagnostic(`One ${mode} Join consumed at ${required}/${required + 1}; unfinished worker preserved, exact actual result receipt, interim private report`);
  } finally { staging.releaseAll(); }
  }, { beforeTurn: staging.beforeTurn });
});

test('checks 48, 51, 56: real Codex each-result wake reports progress before one final integrated outcome', options, async t => {
  const staging = stageTurns();
  await withRealCodex(t, async f => {
  try {
  const state = await setup(f, staging, 'all', 'each_result', 2);
  const first = await release(f, staging, state, 0), partial = await waitMessage(f, state, `PROGRESS:${first}`);
  assert.equal(partial.coordinationV3.joins[0].state, 'open'); assert.equal(partial.coordinationV3.joins[0].completed, 1);
  assert.equal(joins(partial).length, 1); assert.equal(joins(partial)[0].kind, 'coordination_join_progress'); assert.equal(joins(partial)[0].state, 'consumed');
  assert.ok(!partial.messages.some(item => item.role === 'assistant' && item.text.trim().startsWith('FINAL:')));
  const outstanding = partial.coordinationV3.requests.find(item => item.direction === 'outbound' && item.counterpartyAgentId === state.workers[1].id);
  assert.ok(outstanding && !TERMINAL_REQUEST_STATES.has(outstanding.state));
  const second = await release(f, staging, state, 1), detail = await waitMessage(f, state, `FINAL:${first}|${second}`);
  assert.equal(detail.coordinationV3.joins[0].state, 'satisfied'); assert.equal(detail.coordinationV3.joins[0].completed, 2);
  assert.equal(joins(detail).filter(item => item.kind === 'coordination_join_progress' && item.state === 'consumed').length, 1);
  assert.equal(joins(detail).filter(item => item.kind === 'coordination_join_satisfied' && item.state === 'consumed').length, 1);
  assert.equal(detail.messages.filter(item => item.role === 'assistant' && item.text.trim() === `PROGRESS:${first}`).length, 1);
  for (const result of [first, second]) assert.ok(f.submitted.some(input => input.agentId === state.manager.id && input.prompt.includes(result)));
  assert.ok(!(await f.events(state.chat)).some(event => event.intent === 'broadcast' && [first, second].some(result => event.text.includes(result))));
  t.diagnostic('Actual first-result progress while second Request waits, followed by one consumed terminal activation and one exact private manager final');
  } finally { staging.releaseAll(); }
  }, { beforeTurn: staging.beforeTurn });
});
