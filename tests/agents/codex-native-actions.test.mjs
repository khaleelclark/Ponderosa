// Deferred source: do not execute until the whole-implementation test phase.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNativeTurnCommand } from '../../packages/core/dist/native-turn.js';
import { codexNativeObservation, invokeCodexGoal, setCodexPlanMode, startCodexReview } from '../../packages/engines/dist/codex-native-actions.js';
import { projectAgentEvent } from '../../packages/engines/dist/agent-event-projection.js';

const goal = { threadId: 'thread', objective: 'Explicit human objective', status: 'paused', tokenBudget: 500,
  tokensUsed: 20, timeUsedSeconds: 1, createdAt: 100, updatedAt: 101 };

test('goal editing uses user provenance and explicit paused creation; null clears only the requested budget', async () => {
  const calls = [];
  const rpc = { async request(method, params) { calls.push({ method, params }); return { goal }; } };
  const result = await invokeCodexGoal(rpc, 'thread', 'goal-edit', '{"objective":"Explicit human objective","tokenBudget":null}');
  assert.deepEqual(calls, [{ method: 'thread/goal/set', params: { threadId: 'thread', origin: 'user', objective: 'Explicit human objective', tokenBudget: null, status: 'paused' } }]);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.goal.tokensUsed, 20);
  await assert.rejects(invokeCodexGoal(rpc, 'thread', 'goal-edit', '{"status":"active"}'));
  await assert.rejects(invokeCodexGoal(rpc, 'thread', 'goal-resume'));
  await assert.rejects(invokeCodexGoal(rpc, 'thread', 'goal-edit', '{"tokenBudget":0}'));
  assert.equal(calls.length, 1);
});

test('unknown mutation acknowledgement is never retried or certified', async () => {
  let calls = 0;
  const result = await invokeCodexGoal({ async request() { calls++; throw Error('connection lost'); } }, 'thread', 'goal-pause');
  assert.equal(calls, 1);
  assert.equal(result.outcome, 'outcome_unknown');
});

test('human native syntax is closed and retains exact schema/target; ordinary prose does not select native work', () => {
  assert.equal(parseNativeTurnCommand('Please review the code'), undefined);
  assert.deepEqual(parseNativeTurnCommand('/review {"type":"commit","sha":"1234567"}'), { kind: 'review', target: { type: 'commit', sha: '1234567', title: null } });
  assert.deepEqual(parseNativeTurnCommand('/plan {"prompt":"Inspect the design","mode":"default"}'), { kind: 'plan', prompt: 'Inspect the design', mode: 'default' });
  const action = parseNativeTurnCommand('/structured {"prompt":"Return data","schema":{"type":"object","required":["answer"]}}');
  assert.deepEqual(action.outputSchema, { type: 'object', required: ['answer'] });
  assert.throws(() => parseNativeTurnCommand('/review {"type":"uncommittedChanges","threadId":"foreign"}'));
  assert.throws(() => parseNativeTurnCommand('/plan {"prompt":"work","mode":"unsafe"}'));
  assert.throws(() => parseNativeTurnCommand('/structured {"prompt":"work","schema":[]}'));
});

test('review dispatch is inline and validates provider thread rather than accepting another native session', async () => {
  const action = parseNativeTurnCommand('/review {"type":"uncommittedChanges"}');
  let called;
  const id = await startCodexReview({ async request(method, params) { called = { method, params }; return { reviewThreadId: 'thread', turn: { id: 'review-turn' } }; } }, 'thread', action);
  assert.equal(id, 'review-turn');
  assert.deepEqual(called, { method: 'review/start', params: { threadId: 'thread', target: { type: 'uncommittedChanges' }, delivery: 'inline' } });
  await assert.rejects(startCodexReview({ async request() { return { reviewThreadId: 'other', turn: { id: 'turn' } }; } }, 'thread', action));
});

test('native projections retain structure only for the exact thread/current turn', () => {
  const params = { threadId: 'thread', turnId: 'turn', explanation: null, plan: [{ step: 'Inspect', status: 'inProgress' }] };
  const events = codexNativeObservation('turn/plan/updated', params, 'thread', 'turn');
  assert.deepEqual(projectAgentEvent(events[0]), { type: 'native_plan', providerTurnId: 'turn', steps: params.plan });
  assert.deepEqual(codexNativeObservation('turn/plan/updated', params, 'other', 'turn'), []);
  assert.deepEqual(codexNativeObservation('turn/plan/updated', params, 'thread', 'stale'), []);
  assert.deepEqual(codexNativeObservation('turn/diff/updated', { ...params, diff: '+change' }, 'thread', 'turn'), [{ type: 'native_diff', providerTurnId: 'turn', diff: '+change' }]);
  assert.throws(() => projectAgentEvent({ type: 'native_plan', providerTurnId: 'turn', steps: [{ step: 'Inspect', status: 'guessed' }] }));
});

test('plan settings use the retrieved experimental contract with built-in instructions and no access overrides', async () => {
  let called;
  await setCodexPlanMode({ async request(method, params) { called = { method, params }; return {}; } }, 'thread', {kind:'plan',mode:'plan',prompt:'Inspect'}, 'selected-model', 'high');
  assert.deepEqual(called, { method: 'thread/settings/update', params: { threadId: 'thread', collaborationMode: {
    mode: 'plan', settings: { model: 'selected-model', reasoning_effort: 'high', developer_instructions: null }
  } } });
  await assert.rejects(setCodexPlanMode({ async request() { return { guessed: true }; } }, 'thread', {kind:'plan',mode:'plan',prompt:'Inspect'}, 'selected-model'));
});

test('review mode exit is a completed-item receipt, never an item-start completion', () => {
  const params = {threadId:'thread',turnId:'turn',item:{type:'exitedReviewMode',id:'item',review:'findings'}};
  assert.deepEqual(codexNativeObservation('item/started', params, 'thread', 'turn'), []);
  assert.deepEqual(codexNativeObservation('item/completed', params, 'thread', 'turn'), [{type:'native_review',providerTurnId:'turn',phase:'completed',text:'findings'}]);
});
