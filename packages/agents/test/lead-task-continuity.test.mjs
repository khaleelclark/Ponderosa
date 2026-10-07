import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentStore, CoordinationV3Store } from '../dist/index.js';
import { delegationOriginsForActivation } from '../dist/coordination-v3-task-lineage.js';

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
