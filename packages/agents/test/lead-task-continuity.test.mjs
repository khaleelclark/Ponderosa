import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentStore, CoordinationV3Store } from '../dist/index.js';
import { delegationOriginsForActivation, pendingTaskWakeIds } from '../dist/coordination-v3-task-lineage.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ponderosa-lead-continuity-'));
  let store = new AgentStore(dir), c = new CoordinationV3Store(store.sqlite);
  const project = store.createProject({ label: 'Disposable', hostPath: dir, defaultEngine: 'codex' });
  const chat = store.createConversation(project.id, { title: 'Delivery task' });
  const lead = store.createAgent(project.id, { title: 'Lead', engine: 'codex', conversationId: chat.id });
  const peer = store.createAgent(project.id, { title: 'Reviewer', engine: 'codex', conversationId: chat.id });
  const auth = l => ({ runId: l.runId, agentId: l.agentId, fencingToken: l.fencingToken });
  function finish(l) {
    const injection = { injectionId: l.injectionId, runId: l.runId, fencingToken: l.fencingToken };
    c.preparePromptInjection({ ...injection, prompt: 'Disposable exact input' });
    c.markPromptSubmitted(injection); c.acknowledgePromptInjection(injection);
    c.completeRun(l.runId, l.fencingToken);
  }
  function human(id = 'operator-task') {
    const communication = { schemaVersion: 2, eventId: id, projectId: project.id,
      conversationId: chat.id, sender: { kind: 'user', userId: 'local-operator' }, intent: 'user_dm',
      audience: { kind: 'user_agent', userId: 'local-operator', agentId: lead.id },
      text: 'Implement, validate and deliver the release.', createdAt: new Date().toISOString() };
    c.recordRuntimeCommunication({ id: communication.eventId, projectId: project.id,
      sender: communication.sender, intent: communication.intent, audience: communication.audience,
      payload: { communication }, activation: { agentId: lead.id, kind: 'human_message', priority: 100,
        dispatchPolicy: 'next_run', promptClass: 'human' } });
    return c.leaseNextRun({ workerId: 'lead' });
  }
  function delegate(l, n = 1, options = {}) {
    return c.coordinate({ projectId: project.id, conversationId: chat.id, requesterAgentId: lead.id,
      actorScope: `agent:${lead.id}:run:${l.runId}`, runAuthorization: auth(l), idempotencyKey: `delegate-${n}`,
      requests: [{ requestId: `review-${n}`, recipientAgentId: peer.id, lifetime: { kind: 'indefinite' },
        payload: { text: 'Read-only review, report to the lead.', ...(options.record ? { completionMode: 'record' } : {}) },
        ...(options.noRoute ? {} : { replyAuthority: { intent: 'collaboration', recipientAgentIds: [peer.id] } }) }],
      ...(options.noJoin ? {} : { join: { id: `join-${n}`, mode: 'all' } }) });
  }
  function reply(l, id, intent = 'user_dm', taskDelivery) {
    const audience = intent === 'collaboration' ? { kind: 'agents', agentIds: [peer.id] } : { kind: 'user_agent', userId: 'local-operator', agentId: lead.id };
    const communication = { schemaVersion: 2, eventId: id, projectId: project.id, conversationId: chat.id,
      sender: { kind: 'agent', agentId: lead.id }, intent, audience, text: id, createdAt: '2026-10-06T00:00:00.000Z' };
    return c.recordRuntimeCommunication({ id, projectId: project.id, sender: communication.sender, intent, audience,
      payload: { communication, ...(taskDelivery ? { taskDelivery } : {}) },
      ...(taskDelivery ? { taskDelivery } : {}), runAuthorization: auth(l), scopeKey: `conversation:${chat.id}`, satisfiesRequiredReply: true });
  }
  function rollover(l) {
    return c.requestContextRollover({ projectId: project.id, agentId: lead.id,
      sourceRunId: l.runId, sourceActivationIds: l.activationIds, oldProviderSessionId: 'old-session',
      providerSessionGeneration: 'old-session', detectedOccupancy: 150001, threshold: 150000, lowWaterMark: 90000,
      scopeKey: `conversation:${chat.id}`, conversationId: chat.id,
      compactionCutoffOrdinal: 1, compactionCutoffEventId: 'operator-task',
      recentTail: [{ communicationEventId: 'operator-task', contentSha256: 'a'.repeat(64) }],
      replyAuthority: { intent: 'direct_to_user' } }).rollover;
  }
  function retire(r, gate) {
    const handoffRun = c.leaseNextRun({ workerId: 'handoff', excludedAgentIds: [peer.id] });
    assert.equal(handoffRun.activations[0].kind, 'context_rollover_handoff');
    gate?.('before');
    finish(handoffRun);
    c.commitContextRolloverHandoff(r.id, 'bounded-handoff'); c.beginContextRolloverRetirement(r.id);
    gate?.('during');
    return c.prepareContextRolloverContinuation({ id: r.id });
  }
  function review(n = 1) {
    const l = c.leaseNextRun({ workerId: 'reviewer', excludedAgentIds: [lead.id], coalesceLimit: 1 });
    c.updateRequest({ requestId: `review-${n}`, updateId: `review-result-${n}`, kind: 'completed',
      actor: { kind: 'agent', id: peer.id }, runAuthorization: auth(l), payload: { text: 'Read-only reviewer: no blockers.' } });
    finish(l); return l;
  }
  return { get store() { return store; }, get c() { return c; }, project, chat, lead, peer, auth, human, delegate, reply,
    final(l, id) { return reply(l, id, 'user_dm', 'final'); }, finish, rollover, retire, review,
    reopen() { store.close(); store = new AgentStore(dir); c = new CoordinationV3Store(store.sqlite); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('lead waiting on its own delegation retains continuity without starting a replacement Run', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead); f.reply(lead, 'interim');
    const r = f.rollover(lead); f.c.markContextRolloverVisibleResponseCommitted(f.lead.id, lead.runId);
    f.finish(lead);
    const waiting = f.retire(r);
    assert.equal(waiting.continuityWaiting, true);
    assert.equal(f.c.leaseNextRun({ workerId: 'waiting-lead', excludedAgentIds: [f.peer.id] }), undefined);
    f.reopen(); f.review();
    const replacement = f.c.leaseNextRun({ workerId: 'replacement', excludedAgentIds: [f.peer.id] });
    assert.ok(replacement);
    assert.equal(f.c.contextRolloverForContinuationRun(replacement.runId, f.lead.id)?.handoffEventId, 'bounded-handoff');
    assert.ok(f.c.requiredReplyAuthoritiesForRun(replacement.runId).some(a => a.intent === 'direct_to_user'));
  } finally { f.close(); }
});

test('specialist replies do not replace or satisfy the original operator final-delivery responsibility', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead); f.reply(lead, 'interim'); f.finish(lead);
    assert.equal(f.c.leaseNextRun({ workerId: 'waiting', excludedAgentIds: [f.peer.id] }), undefined);
    f.review();
    const continuation = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    assert.ok(f.c.requiredReplyAuthoritiesForRun(continuation.runId).some(a => a.intent === 'direct_to_user'));
    f.reply(continuation, 'specialist-report', 'collaboration');
    assert.ok(f.c.requiredReplyAuthoritiesForRun(continuation.runId).some(a => a.intent === 'direct_to_user'));
    f.final(continuation, 'final-delivery'); f.finish(continuation); f.reopen();
    assert.equal(f.c.leaseNextRun({ workerId: 'no-duplicate', excludedAgentIds: [f.peer.id] }), undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) AS n FROM runtime_communications WHERE id='final-delivery'").get().n, 1);
  } finally { f.close(); }
});

for (const timing of ['before', 'during', 'after']) test(`one exact continuation when review completes ${timing} retirement`, () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead); f.reply(lead, 'interim');
    const r = f.rollover(lead); f.finish(lead);
    f.retire(r, gate => { if (gate === timing) f.review(); });
    if (timing === 'after') f.review();
    f.reopen();
    const replacement = f.c.leaseNextRun({ workerId: 'replacement', excludedAgentIds: [f.peer.id] });
    assert.equal(replacement.activations.length, 1);
    assert.equal(f.c.contextRolloverForContinuationRun(replacement.runId, f.lead.id)?.id, r.id);
    assert.ok(f.c.requiredReplyAuthoritiesForRun(replacement.runId).some(a => a.intent === 'direct_to_user'));
    f.reply(replacement, 'specialist', 'collaboration'); f.final(replacement, 'final'); f.finish(replacement);
    assert.equal(f.c.leaseNextRun({ workerId: 'duplicate', excludedAgentIds: [f.peer.id] }), undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?").get(f.lead.id).n, 3);
  } finally { f.close(); }
});

test('a retirement callback is selected by lineage before a burst of unrelated inbox rows', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'interim'); const r = f.rollover(lead); f.finish(lead);
    const ready = f.retire(r, phase => {
      if (phase !== 'during') return;
      for (let i = 0; i < 64; i++) f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
        scopeKey: `conversation:${f.chat.id}`, messageId: `unrelated-${i}`, kind: 'human', payload: { text: `Unrelated request ${i}` } });
      f.review();
    });
    assert.equal(ready.state, 'continuation_ready');
    // Keep normal inbox priorities: unrelated human input may run first, but
    // cannot consume the exact callback's retained handoff.
    const unrelated = f.c.leaseNextRun({ workerId: 'unrelated', excludedAgentIds: [f.peer.id], coalesceLimit: 64 });
    assert.equal(unrelated.activations.length, 64);
    assert.equal(f.c.contextRolloverForContinuationRun(unrelated.runId, f.lead.id), undefined);
    f.finish(unrelated);
    const exact = f.c.leaseNextRun({ workerId: 'exact', excludedAgentIds: [f.peer.id], coalesceLimit: 64 });
    assert.equal(exact.activations.length, 1);
    assert.equal(exact.activations[0].kind, 'coordination_join_satisfied');
    assert.equal(f.c.contextRolloverForContinuationRun(exact.runId, f.lead.id).id, r.id);
    f.final(exact, 'one-final'); f.finish(exact);
    assert.equal(f.c.leaseNextRun({ workerId: 'done', excludedAgentIds: [f.peer.id] }), undefined);
  } finally { f.close(); }
});

test('task wake selection searches scoped source identities instead of global historical sources', () => {
  const f = fixture();
  const prepare = f.store.sqlite.prepare.bind(f.store.sqlite), plans = [], bytecodes = [];
  try {
    const lead = f.human(); f.delegate(lead); f.reply(lead, 'interim'); f.finish(lead); f.review();
    const wake = prepare("SELECT id FROM agent_activations WHERE kind='coordination_join_satisfied'").get();
    f.store.sqlite.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.startsWith('WITH task_wake_candidates')) return statement;
      return { all(...args) {
        plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args));
        bytecodes.push(prepare(`EXPLAIN ${sql}`).all(...args));
        return statement.all(...args);
      } };
    };
    assert.deepEqual(delegationOriginsForActivation(f.store.sqlite, wake.id), [lead.runId]);
    assert.deepEqual(pendingTaskWakeIds(f.store.sqlite, { projectId: f.project.id, agentId: f.lead.id,
      scopeKey: `conversation:${f.chat.id}`, originRunIds: [lead.runId] }), [wake.id]);
    assert.equal(plans.length, 2);
    for (const plan of plans) {
      const sourceSearches = plan.map(row => row.detail).filter(detail => /(?:SEARCH|SCAN) canonical_source\b/.test(detail));
      assert.ok(sourceSearches.length);
      assert.ok(sourceSearches.every(detail => detail.includes('activation_id=?')), sourceSearches.join('\n'));
      assert.ok(plan.some(row => row.detail.includes('idx_reply_recovery_activation')),
        'recovery lineage must use its narrow identity index');
    }
    assert.ok(plans[1].some(row => row.detail.includes('agent_activations_agent_scope_runnable')),
      'pending candidates must use the existing runnable-state index');
    const rootpage = prepare("SELECT rootpage FROM sqlite_schema WHERE name='agent_activations'").get().rootpage;
    const payloadColumn = prepare('PRAGMA table_info(agent_activations)').all().find(column => column.name === 'payload_json').cid;
    for (const bytecode of bytecodes) {
      const cursors = new Map();
      for (const operation of bytecode) {
        if (operation.opcode === 'OpenRead') cursors.set(operation.p1, operation.p2 === rootpage);
        else if (operation.opcode.startsWith('Open')) cursors.set(operation.p1, false);
        assert.ok(!(operation.opcode === 'Column' && cursors.get(operation.p1) && operation.p2 === payloadColumn),
          'task wake lineage must not read or materialize queued payload_json');
      }
    }
  } finally { f.store.sqlite.prepare = prepare; f.close(); }
});

for (const timing of ['pending-initial', 'satisfied-initial', 'answer-before-promotion']) test(`Decision ownership survives delegation from ${timing}`, () => {
  const f = fixture();
  try {
    const lead = f.human();
    if (timing === 'satisfied-initial') f.reply(lead, 'initial-reply');
    f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'before-delegation', scopeKey: `conversation:${f.chat.id}` });
    assert.throws(() => f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'another',
      scopeKey: `conversation:${f.chat.id}` }), /task_decision_already_pending/);
    const answer = () => {
      const id = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
        scopeKey: `conversation:${f.chat.id}`, messageId: 'decision:before-delegation:response', kind: 'human',
        payload: { decision: { id: 'before-delegation' } } });
      f.c.attachTaskDecisionWake('before-delegation', id);
    };
    if (timing === 'answer-before-promotion') answer();
    f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'interim'); f.finish(lead); f.review();
    let result = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    if (timing !== 'answer-before-promotion') {
      assert.equal(f.c.requiredReplyObligationsForRun(result.runId)[0].blockingDecisionId, 'before-delegation');
      f.finish(result); f.reopen();
      assert.equal(f.c.leaseNextRun({ workerId: 'no-recovery', excludedAgentIds: [f.peer.id] }), undefined);
      answer(); result = f.c.leaseNextRun({ workerId: 'answer', excludedAgentIds: [f.peer.id] });
    }
    assert.equal(f.c.requiredReplyObligationsForRun(result.runId)[0].blockingDecisionId, undefined);
    f.final(result, 'after-exact-answer'); f.finish(result);
    assert.equal(f.c.leaseNextRun({ workerId: 'done', excludedAgentIds: [f.peer.id] }), undefined);
  } finally { f.close(); }
});

test('an exact next-Run Decision answer carries a satisfied initial task origin for later delegation', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.reply(lead, 'initial-acknowledgement');
    f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'approve-before-work', scopeKey: `conversation:${f.chat.id}` });
    f.finish(lead); f.reopen();
    assert.equal(f.c.leaseNextRun({ workerId: 'no-extra-reply', excludedAgentIds: [f.peer.id] }), undefined);
    const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
      scopeKey: `conversation:${f.chat.id}`, messageId: 'decision:approve-before-work:response', kind: 'human',
      payload: { decision: { id: 'approve-before-work' } } });
    f.c.attachTaskDecisionWake('approve-before-work', answer);
    const resumed = f.c.leaseNextRun({ workerId: 'approval', excludedAgentIds: [f.peer.id] });
    const root = f.c.requiredReplyObligationsForRun(resumed.runId)[0];
    assert.equal(root.sourceActivationId, lead.activations[0].id);
    assert.equal(root.state, 'satisfied'); assert.equal(root.deliveryPhase, 'initial');
    assert.equal(root.satisfiedCommunicationId, 'initial-acknowledgement');
    assert.equal(root.blockingDecisionId, undefined);
    f.delegate(resumed, 1, { noRoute: true });
    assert.equal(f.c.requiredReplyObligationsForRun(resumed.runId)[0].interimCommunicationId, 'initial-acknowledgement');
    f.finish(resumed); f.review();
    const integrated = f.c.leaseNextRun({ workerId: 'integration', excludedAgentIds: [f.peer.id] });
    assert.ok(f.c.requiredReplyAuthoritiesForRun(integrated.runId).some(route => route.intent === 'direct_to_user'));
    f.final(integrated, 'one-final-after-approval'); f.finish(integrated); f.reopen();
    assert.equal(f.c.leaseNextRun({ workerId: 'done', excludedAgentIds: [f.peer.id] }), undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM runtime_communications WHERE id='initial-acknowledgement'").get().n, 1);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM runtime_communications WHERE id='one-final-after-approval'").get().n, 1);
    const lateAnswer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
      scopeKey: `conversation:${f.chat.id}`, messageId: 'late-answer-alias', kind: 'human',
      payload: { decision: { id: 'approve-before-work' } } });
    f.c.attachTaskDecisionWake('approve-before-work', lateAnswer);
    const late = f.c.leaseNextRun({ workerId: 'late-answer', excludedAgentIds: [f.peer.id] });
    assert.equal(f.c.requiredReplyObligationsForRun(late.runId).some(o => o.sourceActivationId === lead.activations[0].id), false,
      'an already completed final task must not be revived by a late answer alias');
  } finally { f.close(); }
});

test('an exact acknowledged same-Run Decision answer releases final delivery atomically', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'interim'); f.finish(lead); f.review();
    const integration = f.c.leaseNextRun({ workerId: 'integration', excludedAgentIds: [f.peer.id] });
    const turn = { injectionId: integration.injectionId, runId: integration.runId, fencingToken: integration.fencingToken };
    f.c.preparePromptInjection({ ...turn, prompt: 'Exact integration input' }); f.c.markPromptSubmitted(turn); f.c.acknowledgePromptInjection(turn);
    f.c.waitForTaskDecision({ runAuthorization: f.auth(integration), decisionId: 'same-run-approval', scopeKey: `conversation:${f.chat.id}` });
    const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
      scopeKey: `conversation:${f.chat.id}`, messageId: 'decision:same-run-approval:response', kind: 'human',
      payload: { decision: { id: 'same-run-approval' } } });
    f.c.attachTaskDecisionWake('same-run-approval', answer);
    const steering = f.c.leaseNextSteering({ workerId: 'steering' });
    assert.equal(steering.runId, integration.runId); assert.deepEqual(steering.activationIds, [answer]);
    const injection = { injectionId: steering.injectionId, runId: steering.runId, fencingToken: steering.fencingToken };
    f.c.preparePromptInjection({ ...injection, prompt: 'Exact Decision response input' }); f.c.markPromptSubmitted(injection);
    assert.throws(() => f.final(integration, 'before-ack'), /task_delivery_dependencies_pending/);
    f.store.sqlite.exec(`CREATE TEMP TRIGGER fail_decision_ack BEFORE UPDATE OF blocking_decision_id ON required_reply_obligations
      WHEN OLD.blocking_decision_id IS NOT NULL AND NEW.blocking_decision_id IS NULL
      BEGIN SELECT RAISE(ABORT, 'controlled Decision acknowledgement rollback'); END`);
    assert.throws(() => f.c.acknowledgePromptInjection(injection), /controlled Decision acknowledgement rollback/);
    assert.equal(f.c.promptInjectionForActivation(integration.runId, answer).state, 'submitted');
    assert.equal(f.c.requiredReplyObligationsForRun(integration.runId)[0].blockingDecisionId, 'same-run-approval');
    f.store.sqlite.exec('DROP TRIGGER fail_decision_ack');
    f.c.acknowledgePromptInjection(injection); f.c.acknowledgePromptInjection(injection);
    assert.equal(f.c.requiredReplyObligationsForRun(integration.runId)[0].blockingDecisionId, undefined);
    f.final(integration, 'same-run-final'); f.final(integration, 'same-run-final');
    f.c.completeRun(integration.runId, integration.fencingToken); f.reopen();
    assert.equal(f.c.requiredReplyObligationsForRun(integration.runId)[0].satisfiedCommunicationId, 'same-run-final');
    assert.equal(f.c.requiredReplyObligationsForRun(integration.runId)[0].blockingDecisionId, undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM runtime_communications WHERE id='same-run-final'").get().n, 1);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
    assert.equal(f.c.leaseNextRun({ workerId: 'no-recovery', excludedAgentIds: [f.peer.id] }), undefined);
  } finally { f.close(); }
});

for (const initialReply of [false, true]) for (const timing of ['before', 'during', 'after']) test(`a Decision-only wait retains its handoff with an exact answer ${timing} retirement and later delegation (${initialReply ? 'satisfied' : 'pending'} initial receipt)`, () => {
  const f = fixture();
  try {
    const lead = f.human(); if (initialReply) f.reply(lead, 'initial-ack');
    f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'decision-only', scopeKey: `conversation:${f.chat.id}` });
    const rollover = f.rollover(lead); f.c.markContextRolloverVisibleResponseCommitted(f.lead.id, lead.runId); f.finish(lead);
    const answer = () => {
      const id = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
        scopeKey: `conversation:${f.chat.id}`, messageId: 'decision:decision-only:response', kind: 'human',
        payload: { decision: { id: 'decision-only' } } });
      f.c.attachTaskDecisionWake('decision-only', id);
    };
    const retired = f.retire(rollover, phase => { if (phase === timing) answer(); });
    if (timing === 'after') {
      assert.equal(retired.continuityWaiting, true); assert.equal(retired.completionReason, 'no_continuation_required');
      assert.equal(f.c.leaseNextRun({ workerId: 'no-polling', excludedAgentIds: [f.peer.id] }), undefined);
      f.reopen(); answer();
    } else assert.equal(retired.state, 'continuation_ready');
    const resumed = f.c.leaseNextRun({ workerId: 'approval', excludedAgentIds: [f.peer.id] });
    assert.equal(f.c.contextRolloverForContinuationRun(resumed.runId, f.lead.id)?.id, rollover.id);
    assert.equal(f.c.contextRolloverForContinuationRun(resumed.runId, f.lead.id)?.handoffEventId, 'bounded-handoff');
    const root = f.c.requiredReplyObligationsForRun(resumed.runId)[0];
    assert.equal(root.sourceActivationId, lead.activations[0].id); assert.equal(root.state, initialReply ? 'satisfied' : 'pending');
    assert.equal(root.blockingDecisionId, undefined); assert.equal(root.satisfiedCommunicationId, initialReply ? 'initial-ack' : undefined);
    f.delegate(resumed, 1, { noRoute: true }); f.finish(resumed); f.review();
    const final = f.c.leaseNextRun({ workerId: 'integration', excludedAgentIds: [f.peer.id] });
    f.final(final, 'decision-only-final'); f.finish(final); f.reopen();
    assert.equal(f.c.leaseNextRun({ workerId: 'done', excludedAgentIds: [f.peer.id] }), undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM runtime_communications WHERE id='decision-only-final'").get().n, 1);
  } finally { f.close(); }
});

for (const initialReply of [false, true]) test(`canonical repair preserves a Decision-only ${initialReply ? 'satisfied' : 'pending'} initial root`, () => {
  const f = fixture();
  try {
    const lead = f.human(); if (initialReply) f.reply(lead, 'initial-ack');
    assert.throws(() => f.store.sqlite.transaction(() => {
      f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'canonical-initial', scopeKey: `conversation:${f.chat.id}` });
      throw Error('injected rollback');
    })(), /injected rollback/);
    const source = { runId: lead.runId, agentId: f.lead.id, projectId: f.project.id, scopeKey: `conversation:${f.chat.id}` };
    f.c.reconcileTaskDecision({ ...source, decisionId: 'canonical-initial', agentId: f.peer.id });
    assert.equal(f.c.taskDecisionOwnsDelivery('canonical-initial'), false);
    f.c.reconcileTaskDecision({ ...source, decisionId: 'canonical-initial' });
    f.c.reconcileTaskDecision({ ...source, decisionId: 'canonical-initial' });
    const repaired = f.c.requiredReplyObligationsForRun(lead.runId)[0];
    assert.equal(repaired.state, initialReply ? 'satisfied' : 'pending');
    assert.equal(repaired.satisfiedCommunicationId, initialReply ? 'initial-ack' : undefined);
    assert.equal(repaired.blockingDecisionId, 'canonical-initial');
    assert.equal(f.c.taskDecisionOwnsDelivery('canonical-initial'), true);
    const rollover = f.rollover(lead); f.finish(lead); assert.equal(f.retire(rollover).continuityWaiting, true);
    f.reopen(); assert.equal(f.c.taskDecisionOwnsDelivery('canonical-initial'), true);
    assert.equal(f.c.leaseNextRun({ workerId: 'no-poll', excludedAgentIds: [f.peer.id] }), undefined);
    f.c.cancelAgentRun({ agentId: f.lead.id, idempotencyKey: 'cancel-task' });
    // Cancellation of an idle Agent does not invent a task terminal. A
    // genuinely cancelled source Run must not be revived by canonical repair.
    f.store.sqlite.prepare("UPDATE scheduler_runs SET status='cancelled' WHERE id=?").run(lead.runId);
    assert.equal(f.c.taskDecisionOwnsDelivery('canonical-initial'), false);
    f.c.reconcileTaskDecision({ ...source, decisionId: 'other' });
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].blockingDecisionId, 'canonical-initial');
  } finally { f.close(); }
});

for (const answerState of ['unsubmitted', 'submitted', 'acknowledged', 'different-response', 'unanchored']) test(`resolved Decision repair respects ${answerState} canonical answer evidence`, () => {
  const f = fixture();
  try {
    const lead = f.human(); f.reply(lead, 'initial-ack');
    const turn = { injectionId: lead.injectionId, runId: lead.runId, fencingToken: lead.fencingToken };
    f.c.preparePromptInjection({ ...turn, prompt: 'Original task' }); f.c.markPromptSubmitted(turn); f.c.acknowledgePromptInjection(turn);
    const response = { optionId: 'approve', respondedAt: '2026-10-07T00:00:00.000Z' };
    const id = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
      scopeKey: `conversation:${f.chat.id}`, messageId: answerState === 'unanchored' ? 'unrelated' : 'decision:approval:response',
      kind: 'human', payload: { decision: { id: 'approval', response: answerState === 'different-response' ? { ...response, optionId: 'deny' } : response } } });
    const run = f.c.leaseNextSteering({ workerId: 'answer' });
    const injection = { injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken };
    if (answerState !== 'unsubmitted') {
      f.c.preparePromptInjection({ ...injection, prompt: 'Exact canonical answer' }); f.c.markPromptSubmitted(injection);
      if (answerState !== 'submitted') f.c.acknowledgePromptInjection(injection);
    }
    f.c.reconcileTaskDecision({ decisionId: 'approval', runId: lead.runId, agentId: f.lead.id,
      projectId: f.project.id, scopeKey: `conversation:${f.chat.id}`, response });
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].blockingDecisionId,
      answerState === 'acknowledged' ? undefined : 'approval');
    assert.equal(f.c.taskDecisionOwnsDelivery('approval'), answerState !== 'acknowledged');
    assert.equal(JSON.parse(f.store.sqlite.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(id).payload_json).decision.response.optionId,
      answerState === 'different-response' ? 'deny' : 'approve');
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].satisfiedCommunicationId, 'initial-ack');
  } finally { f.close(); }
});

test('resolved historical Decisions cannot revive a completed initial receipt without an exact live wait', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.reply(lead, 'initial-done'); f.finish(lead); f.reopen();
    f.c.reconcileTaskDecision({ decisionId: 'historical-answer', runId: lead.runId, agentId: f.lead.id,
      projectId: f.project.id, scopeKey: `conversation:${f.chat.id}`,
      response: { optionId: 'approve', respondedAt: '2026-10-07T00:00:00.000Z' } });
    assert.equal(f.c.taskDecisionOwnsDelivery('historical-answer'), false);
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].blockingDecisionId, undefined);
    assert.equal(f.c.leaseNextRun({ workerId: 'no-revival', excludedAgentIds: [f.peer.id] }), undefined);
  } finally { f.close(); }
});

test('a historical answer acknowledged by unrelated work cannot clear the original task root', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.reply(lead, 'initial-ack');
    f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'approval', scopeKey: `conversation:${f.chat.id}` }); f.finish(lead);
    const unrelated = f.human('unrelated');
    const turn = { injectionId: unrelated.injectionId, runId: unrelated.runId, fencingToken: unrelated.fencingToken };
    f.c.preparePromptInjection({ ...turn, prompt: 'Unrelated' }); f.c.markPromptSubmitted(turn); f.c.acknowledgePromptInjection(turn);
    const response = { optionId: 'approve', respondedAt: '2026-10-07T00:00:00.000Z' };
    f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
      messageId: 'decision:approval:response', kind: 'human', payload: { decision: { id: 'approval', response } } });
    // Simulate the old acceptance ordering before the exact task tag existed.
    const answer = f.c.leaseNextSteering({ workerId: 'historical-ordering' });
    const injection = { injectionId: answer.injectionId, runId: answer.runId, fencingToken: answer.fencingToken };
    f.c.preparePromptInjection({ ...injection, prompt: 'Historical exact answer' }); f.c.markPromptSubmitted(injection); f.c.acknowledgePromptInjection(injection);
    f.c.reconcileTaskDecision({ decisionId: 'approval', runId: lead.runId, agentId: f.lead.id,
      projectId: f.project.id, scopeKey: `conversation:${f.chat.id}`, response });
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].blockingDecisionId, 'approval');
    assert.notEqual(f.c.requiredReplyObligationsForRun(unrelated.runId)[0].sourceActivationId, lead.activations[0].id);
  } finally { f.close(); }
});

for (const boundary of ['untagged', 'mismatched', 'stale-fence', 'cancelled', 'side-effects-fenced', 'newer-blocker']) test(`Decision steering cannot release delivery through ${boundary}`, () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'interim'); f.finish(lead); f.review();
    const run = f.c.leaseNextRun({ workerId: 'integration', excludedAgentIds: [f.peer.id] });
    const turn = { injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken };
    f.c.preparePromptInjection({ ...turn, prompt: 'Integration' }); f.c.markPromptSubmitted(turn); f.c.acknowledgePromptInjection(turn);
    f.c.waitForTaskDecision({ runAuthorization: f.auth(run), decisionId: 'approval', scopeKey: `conversation:${f.chat.id}` });
    const id = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
      messageId: `answer-${boundary}`, kind: 'human', payload: { decision: { id: boundary === 'mismatched' ? 'other' : 'approval' } } });
    if (boundary !== 'untagged') f.c.attachTaskDecisionWake('approval', id);
    const steer = f.c.leaseNextSteering({ workerId: 'steer' });
    const injection = { injectionId: steer.injectionId, runId: steer.runId, fencingToken: steer.fencingToken };
    f.c.preparePromptInjection({ ...injection, prompt: 'Decision response' }); f.c.markPromptSubmitted(injection);
    if (boundary === 'stale-fence') {
      assert.throws(() => f.c.acknowledgePromptInjection({ ...injection, fencingToken: injection.fencingToken - 1 }));
      assert.equal(f.c.promptInjectionForActivation(run.runId, id).state, 'submitted');
    } else if (boundary === 'cancelled') {
      f.c.cancelAgentRun({ agentId: f.lead.id, expectedRunId: run.runId, idempotencyKey: 'cancel-before-ack' });
      assert.throws(() => f.c.acknowledgePromptInjection(injection));
    } else {
      if (boundary === 'side-effects-fenced') f.store.sqlite.prepare('UPDATE scheduler_runs SET side_effects_fenced_at=? WHERE id=?').run(new Date().toISOString(), run.runId);
      f.c.acknowledgePromptInjection(injection);
      if (boundary === 'newer-blocker') {
        f.c.waitForTaskDecision({ runAuthorization: f.auth(run), decisionId: 'next-approval', scopeKey: `conversation:${f.chat.id}` });
        f.c.acknowledgePromptInjection(injection);
      }
    }
    assert.equal(f.c.requiredReplyObligationsForRun(run.runId)[0].blockingDecisionId, boundary === 'newer-blocker' ? 'next-approval' : 'approval');
    assert.throws(() => f.final(run, 'must-not-publish'));
    assert.equal(f.c.runtimeCommunication('must-not-publish'), undefined);
  } finally { f.close(); }
});

for (const phase of ['initial', 'final']) for (const timing of ['before-owner-finishes', 'during-unrelated-run']) test(`an exact ${phase}-phase Decision answer attached ${timing} waits instead of steering unrelated same-Chat work`, () => {
  const f = fixture();
  try {
    const lead = f.human(); let owner = lead;
    if (phase === 'final') {
      f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'interim'); f.finish(lead); f.review();
      owner = f.c.leaseNextRun({ workerId: 'integration', excludedAgentIds: [f.peer.id] });
    } else f.reply(owner, 'initial-ack');
    f.c.waitForTaskDecision({ runAuthorization: f.auth(owner), decisionId: 'original-approval', scopeKey: `conversation:${f.chat.id}` });
    const enqueueAnswer = () => {
      const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
        messageId: 'decision:original-approval:response', kind: 'human', payload: { decision: { id: 'original-approval' } } });
      f.c.attachTaskDecisionWake('original-approval', answer); return answer;
    };
    let answer, unrelated;
    if (timing === 'before-owner-finishes') {
      const communication = { schemaVersion: 2, eventId: 'unrelated', projectId: f.project.id, conversationId: f.chat.id,
        sender: { kind: 'user', userId: 'local-operator' }, intent: 'user_dm',
        audience: { kind: 'user_agent', userId: 'local-operator', agentId: f.lead.id }, text: 'Unrelated request', createdAt: new Date().toISOString() };
      f.c.recordRuntimeCommunication({ id: 'unrelated', projectId: f.project.id, sender: communication.sender,
        intent: communication.intent, audience: communication.audience, payload: { communication },
        activation: { agentId: f.lead.id, kind: 'human_message', priority: 100, dispatchPolicy: 'next_run', promptClass: 'human' } });
      answer = enqueueAnswer(); f.finish(owner);
      unrelated = f.c.leaseNextRun({ workerId: 'unrelated', coalesceLimit: 1, excludedAgentIds: [f.peer.id] });
    } else { f.finish(owner); unrelated = f.human('unrelated'); }
    const turn = { injectionId: unrelated.injectionId, runId: unrelated.runId, fencingToken: unrelated.fencingToken };
    f.c.preparePromptInjection({ ...turn, prompt: 'Unrelated exact input' }); f.c.markPromptSubmitted(turn); f.c.acknowledgePromptInjection(turn);
    if (!answer) answer = enqueueAnswer();
    assert.equal(f.c.leaseNextSteering({ workerId: 'must-not-steer-unrelated' }), undefined);
    const generic = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
      messageId: 'generic-steering', kind: 'human', payload: { text: 'Unrelated task steering' } });
    const coalesced = f.c.leaseNextSteering({ workerId: 'coalesced-steering', coalesceLimit: 16 });
    assert.deepEqual(coalesced.activationIds, [generic], 'an unrelated Decision must be excluded from every coalesced injection');
    const steer = { injectionId: coalesced.injectionId, runId: coalesced.runId, fencingToken: coalesced.fencingToken };
    f.c.preparePromptInjection({ ...steer, prompt: 'Generic steering' }); f.c.markPromptSubmitted(steer); f.c.acknowledgePromptInjection(steer);
    assert.equal(f.c.requiredReplyObligationsForRun(owner.runId)[0].blockingDecisionId, 'original-approval');
    assert.equal(f.c.requiredReplyObligationsForRun(unrelated.runId).length, 1);
    assert.notEqual(f.c.requiredReplyObligationsForRun(unrelated.runId)[0].sourceActivationId, lead.activations[0].id);
    f.reply(unrelated, 'unrelated-done'); f.c.completeRun(unrelated.runId, unrelated.fencingToken);
    const resumed = f.c.leaseNextRun({ workerId: 'exact-answer', excludedAgentIds: [f.peer.id] });
    assert.deepEqual(resumed.activationIds, [answer]);
    assert.equal(f.c.requiredReplyObligationsForRun(resumed.runId)[0].sourceActivationId, lead.activations[0].id);
    assert.equal(f.c.requiredReplyObligationsForRun(resumed.runId)[0].blockingDecisionId, undefined);
    let delivery = resumed;
    if (phase === 'initial') {
      f.delegate(resumed, 1, { noRoute: true }); f.finish(resumed); f.review();
      delivery = f.c.leaseNextRun({ workerId: 'integration', excludedAgentIds: [f.peer.id] });
    }
    f.final(delivery, 'original-task-final'); f.finish(delivery); f.reopen();
    assert.equal(f.c.leaseNextRun({ workerId: 'no-duplicate', excludedAgentIds: [f.peer.id] }), undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM runtime_communications WHERE id='original-task-final'").get().n, 1);
  } finally { f.close(); }
});

for (const boundary of ['untagged', 'forged-tag', 'foreign-scope', 'foreign-agent', 'cancelled-source', 'latest-cancelled', 'latest-final']) test(`Decision-only continuity rejects ${boundary}`, () => {
  const f = fixture();
  try {
    const lead = f.human(); f.reply(lead, 'initial');
    f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'exact', scopeKey: `conversation:${f.chat.id}` });
    const r = f.rollover(lead); f.finish(lead); f.retire(r);
    if (boundary === 'cancelled-source') f.store.sqlite.prepare("UPDATE scheduler_runs SET status='cancelled' WHERE id=?").run(lead.runId);
    const id = f.c.enqueueMessageActivation({ projectId: f.project.id,
      agentId: boundary === 'foreign-agent' ? f.peer.id : f.lead.id,
      scopeKey: boundary === 'foreign-scope' ? `agent:${f.lead.id}` : `conversation:${f.chat.id}`,
      messageId: `decision-${boundary}`, kind: 'human', payload: { decision: { id: boundary === 'forged-tag' ? 'other' : 'exact' } } });
    if (boundary !== 'untagged') f.c.attachTaskDecisionWake('exact', id);
    if (boundary === 'forged-tag') f.store.sqlite.prepare("INSERT INTO activation_sources VALUES (?, 'task_decision', 'exact')").run(id);
    if (boundary.startsWith('latest-')) {
      const first = f.c.leaseNextRun({ workerId: 'exact', excludedAgentIds: [f.peer.id] });
      assert.equal(f.c.contextRolloverForContinuationRun(first.runId, f.lead.id)?.id, r.id);
      if (boundary === 'latest-cancelled') f.c.cancelAgentRun({ agentId: f.lead.id, expectedRunId: first.runId, idempotencyKey: 'cancel-latest' });
      else { f.delegate(first, 1, { noRoute: true }); f.finish(first); f.review();
        const final = f.c.leaseNextRun({ workerId: 'final', excludedAgentIds: [f.peer.id] }); f.final(final, 'completed'); f.finish(final); }
      // Exercise old retained audit state with the actual newer terminal root.
      f.store.sqlite.prepare("UPDATE context_rollovers SET state='completed', continuity_waiting=1 WHERE id=?").run(r.id);
      f.reopen();
      const alias = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
        messageId: `late-${boundary}`, kind: 'human', payload: { decision: { id: 'exact' } } });
      f.c.attachTaskDecisionWake('exact', alias);
    }
    const run = f.c.leaseNextRun({ workerId: 'boundary' });
    assert.equal(run && f.c.contextRolloverForContinuationRun(run.runId, run.agentId), undefined);
    if (boundary === 'cancelled-source' || boundary.startsWith('latest-')) assert.equal(f.c.contextRollover(r.id).continuityWaiting, false);
    else assert.equal(f.c.contextRollover(r.id).continuityWaiting, true);
  } finally { f.close(); }
});

for (const boundary of ['untagged-answer', 'cancelled-origin']) test(`satisfied initial task origin is not revived through ${boundary}`, () => {
  const f = fixture();
  try {
    const lead = f.human(); f.reply(lead, 'initial-acknowledgement');
    f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'approval', scopeKey: `conversation:${f.chat.id}` });
    if (boundary === 'cancelled-origin') {
      f.c.cancelAgentRun({ agentId: f.lead.id, expectedRunId: lead.runId, idempotencyKey: 'cancel-origin' });
    } else f.finish(lead);
    f.reopen();
    const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
      scopeKey: `conversation:${f.chat.id}`, messageId: `answer-${boundary}`, kind: 'human',
      payload: { decision: { id: 'approval' } } });
    if (boundary === 'cancelled-origin') f.c.attachTaskDecisionWake('approval', answer);
    const resumed = f.c.leaseNextRun({ workerId: 'answer', excludedAgentIds: [f.peer.id] });
    assert.ok(resumed, 'the new input remains independently runnable');
    assert.equal(f.c.requiredReplyObligationsForRun(resumed.runId).some(o => o.sourceActivationId === lead.activations[0].id), false);
  } finally { f.close(); }
});

test('an initial reply before delegation becomes interim, and two terminal wakes must both be integrated', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.reply(lead, 'initial'); f.delegate(lead, 1); f.delegate(lead, 2); f.finish(lead);
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].interimCommunicationId, 'initial');
    f.review(1); f.review(2);
    const first = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id], coalesceLimit: 1 });
    f.reply(first, 'first-result', 'collaboration'); f.reply(first, 'still-integrating'); f.finish(first);
    assert.equal(f.c.requiredReplyObligationsForRun(first.runId).find(o => o.deliveryPhase === 'final').state, 'pending');
    const last = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    assert.ok(f.c.requiredReplyAuthoritiesForRun(last.runId).some(a => a.intent === 'direct_to_user'));
    f.reply(last, 'second-result', 'collaboration'); f.final(last, 'final'); f.finish(last); f.reopen();
    assert.equal(f.c.leaseNextRun({ workerId: 'duplicate', excludedAgentIds: [f.peer.id] }), undefined);
  } finally { f.close(); }
});

test('final delivery recovery has one durable root and an increasing bounded generation', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'interim'); f.finish(lead); f.review();
    let current = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    for (let attempt = 0; attempt <= 5; attempt++) {
      const obligations = f.c.requiredReplyObligationsForRun(current.runId);
      assert.equal(obligations.length, 1);
      assert.equal(obligations[0].sourceActivationId, lead.activations[0].id);
      assert.equal(obligations[0].deliveryPhase, 'final');
      assert.equal(obligations[0].attemptCount, attempt);
      f.finish(current); f.reopen();
      current = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    }
    assert.equal(current, undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 5);
    assert.equal(f.store.sqlite.prepare("SELECT state FROM agent_activations WHERE id=?").get(lead.activations[0].id).state, 'outcome_unknown');
  } finally { f.close(); }
});

test('passive record-only work without a Join does not establish a callback wait', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { record: true, noJoin: true }); f.reply(lead, 'record-started'); f.finish(lead);
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].deliveryPhase, 'initial');
    f.review();
    assert.equal(f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] }), undefined);
  } finally { f.close(); }
});

test('a blocking Decision pauses delivery recovery durably and only its exact response resumes the task', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'interim'); f.finish(lead); f.review();
    const last = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    f.c.waitForTaskDecision({ runAuthorization: f.auth(last), decisionId: 'exact-decision', scopeKey: `conversation:${f.chat.id}` });
    f.reply(last, 'permission-is-needed', 'user_dm', 'blocked');
    assert.equal(f.c.requiredReplyObligationsForRun(last.runId)[0].state, 'pending');
    assert.throws(() => f.c.waitForTaskDecision({ runAuthorization: { ...f.auth(last), fencingToken: last.fencingToken - 1 }, decisionId: 'forged', scopeKey: `conversation:${f.chat.id}` }));
    f.finish(last); f.reopen();
    assert.equal(f.c.leaseNextRun({ workerId: 'waiting', excludedAgentIds: [f.peer.id] }), undefined);
    const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
      scopeKey: `conversation:${f.chat.id}`, messageId: 'decision:exact-decision:response', kind: 'human', payload: { decision: { id: 'exact-decision' } } });
    f.c.attachTaskDecisionWake('wrong-decision', answer);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE activation_id=? AND source_kind='task_decision'").get(answer).n, 0);
    f.c.attachTaskDecisionWake('exact-decision', answer);
    const resumed = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    assert.equal(f.c.requiredReplyObligationsForRun(resumed.runId)[0].blockingDecisionId, undefined);
    f.final(resumed, 'completed-after-permission'); f.finish(resumed);
    assert.equal(f.c.leaseNextRun({ workerId: 'duplicate', excludedAgentIds: [f.peer.id] }), undefined);
  } finally { f.close(); }
});

test('after the final Join, ordinary updates remain interim and explicit final delivery is exactly-once', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'work-underway'); f.finish(lead); f.review();
    const integration = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    f.reply(integration, 'all-reviews-received-but-release-not-ready');
    assert.equal(f.c.requiredReplyObligationsForRun(integration.runId)[0].state, 'pending');
    f.final(integration, 'exact-completion'); f.final(integration, 'exact-completion'); f.finish(integration); f.reopen();
    assert.equal(f.c.requiredReplyObligationsForRun(integration.runId)[0].satisfiedCommunicationId, 'exact-completion');
    assert.equal(f.c.leaseNextRun({ workerId: 'duplicate', excludedAgentIds: [f.peer.id] }), undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM runtime_communications WHERE id='exact-completion'").get().n, 1);
  } finally { f.close(); }
});

test('a Join result preserves an unanswered Decision until its exact answer arrives', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true });
    f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'still-unanswered', scopeKey: `conversation:${f.chat.id}` });
    assert.throws(() => f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'second-blocker',
      scopeKey: `conversation:${f.chat.id}` }), /task_decision_already_pending/);
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].blockingDecisionId, 'still-unanswered');
    f.reply(lead, 'permission-wait', 'user_dm', 'blocked'); f.finish(lead); f.review();
    const result = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    assert.equal(f.c.requiredReplyObligationsForRun(result.runId)[0].blockingDecisionId, 'still-unanswered');
    assert.throws(() => f.final(result, 'cannot-bypass-permission'), /task_delivery_dependencies_pending/);
    f.finish(result); f.reopen();
    assert.equal(f.c.leaseNextRun({ workerId: 'no-permission-recovery', excludedAgentIds: [f.peer.id] }), undefined);
    const wrong = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
      scopeKey: `conversation:${f.chat.id}`, messageId: 'wrong-answer', kind: 'human', payload: { decision: { id: 'other' } } });
    f.c.attachTaskDecisionWake('still-unanswered', wrong);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE activation_id=? AND source_kind='task_decision'").get(wrong).n, 0);
    const unrelated = f.c.leaseNextRun({ workerId: 'unrelated', excludedAgentIds: [f.peer.id] }); f.finish(unrelated);
    const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
      scopeKey: `conversation:${f.chat.id}`, messageId: 'exact-answer', kind: 'human', payload: { decision: { id: 'still-unanswered', response: { optionId: 'approve' } } } });
    f.c.attachTaskDecisionWake('still-unanswered', answer);
    const resumed = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    assert.equal(f.c.requiredReplyObligationsForRun(resumed.runId)[0].blockingDecisionId, undefined);
    f.final(resumed, 'final-with-exact-answer'); f.finish(resumed);
    assert.equal(f.c.leaseNextRun({ workerId: 'duplicate', excludedAgentIds: [f.peer.id] }), undefined);
  } finally { f.close(); }
});

test('an unrelated coalesced human input keeps its own obligation on the same reply route', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'interim'); f.finish(lead); f.review();
    const combined = f.human('unrelated-new-input');
    assert.ok(combined.activations.some(a => a.kind === 'coordination_join_satisfied'));
    const obligations = f.c.requiredReplyObligationsForRun(combined.runId);
    assert.equal(obligations.length, 2);
    assert.equal(obligations.find(o => o.sourceActivationId === lead.activations[0].id).deliveryPhase, 'final');
    assert.equal(obligations.find(o => o.sourceActivationId !== lead.activations[0].id).deliveryPhase, 'initial');
    f.reply(combined, 'new-input-response');
    assert.equal(f.c.requiredReplyObligationsForRun(combined.runId).find(o => o.deliveryPhase === 'initial').state, 'satisfied');
    assert.equal(f.c.requiredReplyObligationsForRun(combined.runId).find(o => o.deliveryPhase === 'final').state, 'pending');
    f.final(combined, 'old-task-final'); f.finish(combined); f.reopen();
    assert.equal(f.c.leaseNextRun({ workerId: 'duplicate', excludedAgentIds: [f.peer.id] }), undefined);
  } finally { f.close(); }
});

test('an explicit final outcome cannot bypass pending results, and blocked is not a success claim', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true });
    assert.throws(() => f.final(lead, 'premature-completion'), /task_delivery_dependencies_pending/);
    assert.equal(f.c.runtimeCommunication('premature-completion'), undefined);
    assert.throws(() => f.reply(lead, 'forged-peer-outcome', 'collaboration', 'final'), /operator-facing outcome/);
    assert.throws(() => f.reply(lead, 'invalid-outcome', 'user_dm', 'done'), /operator-facing outcome/);
    f.reply(lead, 'blocked-missing-deliverable', 'user_dm', 'blocked'); f.finish(lead); f.reopen();
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].state, 'satisfied');
    assert.equal(f.c.runtimeCommunication('blocked-missing-deliverable').payload.taskDelivery, 'blocked');
    assert.equal(f.c.getRequest('review-1').state, 'open');
    f.review();
    const late = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    assert.ok(late, 'the existing specialist result can still be handled');
    assert.equal(f.c.requiredReplyObligationsForRun(late.runId).length, 0, 'a blocked delivery is not revived by a late report');
  } finally { f.close(); }
});

test('a reviewer question is an exact task wake and receives the retained handoff', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead); f.reply(lead, 'interim'); const r = f.rollover(lead); f.finish(lead); f.retire(r);
    const reviewer = f.c.leaseNextRun({ workerId: 'reviewer', excludedAgentIds: [f.lead.id] });
    f.c.updateRequest({ requestId: 'review-1', updateId: 'review-question', kind: 'question',
      actor: { kind: 'agent', id: f.peer.id }, runAuthorization: f.auth(reviewer), payload: { text: 'Which release should I review?' } });
    f.finish(reviewer);
    const question = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    assert.ok(question.activations.some(a => a.kind === 'coordination_question'));
    assert.equal(f.c.contextRolloverForContinuationRun(question.runId, f.lead.id)?.id, r.id);
    assert.ok(f.c.requiredReplyAuthoritiesForRun(question.runId).some(a => a.intent === 'direct_to_user'));
  } finally { f.close(); }
});

test('equivalent Join definitions cannot erase a distinct operator task origin', () => {
  const f = fixture();
  try {
    const original = f.human(); const first = f.delegate(original, 1, { noRoute: true }); f.reply(original, 'interim'); f.finish(original);
    const other = f.human('another-operator-task');
    const second = f.c.coordinate({ projectId: f.project.id, conversationId: f.chat.id, requesterAgentId: f.lead.id,
      actorScope: `agent:${f.lead.id}:run:${other.runId}`, runAuthorization: f.auth(other), idempotencyKey: 'other-join', requests: [],
      join: { id: 'different-origin-join', requestIds: ['review-1'], mode: 'all' } });
    assert.notEqual(second.joinId, first.joinId);
    f.reply(other, 'other-interim'); f.finish(other); f.review();
    const integrated = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    const roots = f.c.requiredReplyObligationsForRun(integrated.runId).filter(o => o.deliveryPhase === 'final');
    assert.equal(roots.length, 2);
    f.final(integrated, 'both-tasks-complete'); f.finish(integrated);
    assert.equal(f.c.leaseNextRun({ workerId: 'duplicate', excludedAgentIds: [f.peer.id] }), undefined);
  } finally { f.close(); }
});

test('unrelated inputs cannot claim waiting continuity, and cancelled delivery cannot revive', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true }); f.delegate(lead, 2, { noRoute: true }); f.reply(lead, 'interim');
    const r = f.rollover(lead); f.finish(lead); f.retire(r);
    const other = f.human('unrelated-new-task');
    assert.equal(f.c.contextRolloverForContinuationRun(other.runId, f.lead.id), undefined);
    f.reply(other, 'unrelated-complete'); f.finish(other);
    f.review(1);
    const resumed = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    f.c.cancelAgentRun({ agentId: f.lead.id, expectedRunId: resumed.runId, idempotencyKey: 'cancel-task' });
    assert.throws(() => f.reply(resumed, 'late-stale-final'));
    f.review(2);
    const late = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    if (late) assert.equal(f.c.requiredReplyObligationsForRun(late.runId).some(o => o.deliveryPhase === 'final'), false);
    assert.notEqual(f.c.contextRollover(r.id).continuityWaiting, true);
  } finally { f.close(); }
});

test('cross-Chat forged source tags do not claim a task origin or retained handoff', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead); f.reply(lead, 'interim'); const r = f.rollover(lead); f.finish(lead); f.retire(r);
    const foreign = f.store.createConversation(f.project.id, { title: 'Other Chat' });
    const wake = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${foreign.id}`,
      messageId: 'foreign-wake', kind: 'human', payload: {} });
    // Disposable hostile-metadata probe, not an authorized runtime mutation.
    f.store.sqlite.prepare("INSERT INTO activation_sources VALUES (?,'join','join-1')").run(wake);
    assert.deepEqual(delegationOriginsForActivation(f.store.sqlite, wake), []);
    f.c.attachTaskDecisionWake('nonexistent', wake);
    assert.equal(f.c.contextRollover(r.id).continuityWaiting, true);
    assert.equal(f.c.contextRollover(r.id).continuationActivationId, undefined);
  } finally { f.close(); }
});

test('two specialist routes remain distinct while one coalesced Run carries the operator final route', () => {
  const f = fixture();
  try {
    const third = f.store.createAgent(f.project.id, { title: 'Other specialist', engine: 'codex', conversationId: f.chat.id });
    const lead = f.human(); f.delegate(lead);
    f.c.coordinate({ projectId: f.project.id, conversationId: f.chat.id, requesterAgentId: f.lead.id,
      actorScope: `agent:${f.lead.id}:run:${lead.runId}`, runAuthorization: f.auth(lead), idempotencyKey: 'third-review',
      requests: [{ requestId: 'third-review', recipientAgentId: third.id, lifetime: { kind: 'indefinite' }, payload: { text: 'Review' },
        replyAuthority: { intent: 'collaboration', recipientAgentIds: [third.id] } }], join: { id: 'third-join', mode: 'all' } });
    f.reply(lead, 'interim'); f.finish(lead); f.review();
    const worker = f.c.leaseNextRun({ workerId: 'other', excludedAgentIds: [f.lead.id, f.peer.id] });
    f.c.updateRequest({ requestId: 'third-review', updateId: 'third-result', kind: 'completed', actor: { kind: 'agent', id: third.id },
      runAuthorization: f.auth(worker), payload: { text: 'Reviewed' } }); f.finish(worker);
    const combined = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id, third.id], coalesceLimit: 8 });
    const routes = f.c.requiredReplyAuthoritiesForRun(combined.runId);
    assert.equal(routes.length, 3);
    f.reply(combined, 'specialist-result', 'collaboration');
    assert.ok(f.c.requiredReplyAuthoritiesForRun(combined.runId).some(a => a.intent === 'direct_to_user'));
    f.final(combined, 'final');
    assert.equal(f.c.requiredReplyObligationsForRun(combined.runId).find(o => o.deliveryPhase === 'final').state, 'satisfied');
  } finally { f.close(); }
});

test('owner deletion retires retained continuity instead of making a late review reopen it', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead); f.reply(lead, 'interim'); const r = f.rollover(lead); f.finish(lead); f.retire(r);
    f.c.handleAgentDeletion(f.lead.id);
    assert.equal(f.c.contextRollover(r.id).continuityWaiting, false);
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].state, 'cancelled');
  } finally { f.close(); }
});

test('replaying an interim receipt after dependencies settle does not turn it into final delivery', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'interim');
    f.review();
    const interim = f.c.runtimeCommunication('interim');
    f.c.recordRuntimeCommunication({ id: interim.id, projectId: f.project.id, sender: interim.payload.communication.sender,
      intent: interim.payload.communication.intent, audience: interim.payload.communication.audience, payload: interim.payload,
      runAuthorization: f.auth(lead), scopeKey: `conversation:${f.chat.id}`, satisfiesRequiredReply: true });
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].state, 'pending');
    // The terminal wake remains unhandled, so another source-Run message
    // cannot settle the final delivery before its result is integrated.
    f.reply(lead, 'still-underway'); f.finish(lead);
    const integration = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    f.final(integration, 'final'); f.finish(integration);
    assert.equal(f.c.requiredReplyObligationsForRun(integration.runId)[0].state, 'satisfied');
  } finally { f.close(); }
});

test('injected Decision-association failure is repaired from exact canonical ownership without duplicate recovery', () => {
  const f = fixture();
  try {
    const lead = f.human(); f.delegate(lead, 1, { noRoute: true }); f.reply(lead, 'interim'); f.finish(lead); f.review();
    const integration = f.c.leaseNextRun({ workerId: 'lead', excludedAgentIds: [f.peer.id] });
    // Simulates the durable Decision having committed, but association write
    // having rolled back. This is not a power-loss/crash qualification.
    assert.throws(() => f.store.sqlite.transaction(() => {
      f.c.waitForTaskDecision({ runAuthorization: f.auth(integration), decisionId: 'canonical-decision', scopeKey: `conversation:${f.chat.id}` });
      throw Error('injected rollback');
    })(), /injected rollback/);
    f.finish(integration); f.reopen();
    f.c.reconcileTaskDecision({ decisionId: 'foreign', runId: integration.runId, agentId: f.peer.id, projectId: f.project.id, scopeKey: `conversation:${f.chat.id}` });
    assert.equal(f.c.requiredReplyObligationsForRun(integration.runId)[0].blockingDecisionId, undefined);
    f.c.reconcileTaskDecision({ decisionId: 'canonical-decision', runId: integration.runId, agentId: f.lead.id, projectId: f.project.id, scopeKey: `conversation:${f.chat.id}` });
    assert.equal(f.c.leaseNextRun({ workerId: 'no-poll', excludedAgentIds: [f.peer.id] }), undefined);
    assert.equal(f.c.requiredReplyObligationsForRun(integration.runId)[0].blockingDecisionId, 'canonical-decision');
  } finally { f.close(); }
});
