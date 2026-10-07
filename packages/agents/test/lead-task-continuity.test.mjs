import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentStore, CoordinationV3Store, WorkspaceStore } from '../dist/index.js';
import { delegationOriginsForActivation, pendingTaskWakeIds } from '../dist/coordination-v3-task-lineage.js';

function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ponderosa-lead-continuity-'));
  let store = new AgentStore(dir), c = new CoordinationV3Store(store.sqlite, options);
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
    reopen(newOptions = options) { store.close(); store = new AgentStore(dir); c = new CoordinationV3Store(store.sqlite, newOptions); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function accept(f, lease) {
  const input = { injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken };
  f.c.preparePromptInjection({ ...input, prompt: 'Exact disposable Decision answer' });
  f.c.markPromptSubmitted(input); f.c.acknowledgePromptInjection(input);
}

for (const receipt of [false, true]) for (const rollover of [false, true]) {
  for (const release of rollover ? ['defer', 'cancel'] : ['defer', 'retry', 'expiry', 'orphan', 'cancel']) {
    test(`exact Decision root survives ${release}, receipt=${receipt}, retained=${rollover}`, () => {
      const f = fixture();
      try {
        const source = f.human();
        if (receipt) f.reply(source, 'initial-receipt');
        f.c.waitForTaskDecision({ runAuthorization: f.auth(source), decisionId: 'exact', scopeKey: `conversation:${f.chat.id}` });
        const r = rollover && f.rollover(source); f.finish(source);
        if (r) assert.equal(f.retire(r).continuityWaiting, true);
        const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
          scopeKey: `conversation:${f.chat.id}`, messageId: 'decision:exact:response', kind: 'human', payload: { decision: { id: 'exact' } } });
        f.c.attachTaskDecisionWake('exact', answer);
        let now = Date.now(), lease = f.c.leaseNextRun({ workerId: 'answer', now: new Date(now).toISOString() });
        if (release === 'cancel') {
          f.c.cancelAgentRun({ agentId: f.lead.id, expectedRunId: lease.runId, idempotencyKey: 'operator-stop' });
          f.reopen(); assert.equal(f.c.taskDecisionOwnsDelivery('exact'), false);
          assert.equal(f.c.leaseNextRun({ workerId: 'no-revival' }), undefined); return;
        }
        for (let i = 0; i < 2; i++) {
          const before = f.c.requiredReplyObligationsForRun(lease.runId);
          assert.equal(before.length, 1); assert.equal(before[0].sourceActivationId, source.activationIds[0]);
          assert.equal(before[0].state, receipt ? 'satisfied' : 'pending');
          assert.equal(before[0].satisfiedCommunicationId, receipt ? 'initial-receipt' : undefined);
          if (release === 'defer') f.c.deferUninjectedRun(lease.runId, lease.fencingToken);
          if (release === 'retry') f.c.failRun({ runId: lease.runId, fencingToken: lease.fencingToken,
            workerId: 'answer', sameRunResumable: false, confirmedNotExecuted: true, retryDelayMs: 0 });
          if (release === 'expiry') { now = Date.parse(lease.leaseExpiresAt) + 1; f.c.recoverExpiredRuns(new Date(now).toISOString()); }
          if (release === 'orphan') f.c.recoverOrphanedRuns(`replacement-worker-${i}`);
          assert.equal(f.c.requiredReplyObligationsForRun(lease.runId).length, 0, 'only the unaccepted copy is retired');
          assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
          f.reopen();
          now = Math.max(now, Date.now()) + 1;
          lease = f.c.leaseNextRun({ workerId: 'retry', now: new Date(now).toISOString(), excludedAgentIds: [f.peer.id] });
          assert.deepEqual(lease.activationIds, [answer]);
          const root = f.c.requiredReplyObligationsForRun(lease.runId)[0];
          assert.equal(root.sourceActivationId, source.activationIds[0]); assert.equal(root.attemptCount, 0);
          assert.deepEqual(root.replyAuthority, { intent: 'direct_to_user' });
          if (r) assert.equal(f.c.contextRolloverForContinuationRun(lease.runId, f.lead.id)?.id, r.id);
        }
        accept(f, lease); f.delegate(lease, 1, { noRoute: true });
        assert.equal(f.c.requiredReplyObligationsForRun(lease.runId)[0].deliveryPhase, 'final');
        f.c.completeRun(lease.runId, lease.fencingToken); f.review();
        now = Math.max(now, Date.now()) + 1;
        const final = f.c.leaseNextRun({ workerId: 'final', excludedAgentIds: [f.peer.id], now: new Date(now).toISOString() });
        assert.equal(f.c.requiredReplyObligationsForRun(final.runId)[0].sourceActivationId, source.activationIds[0]);
        f.final(final, 'exact-final'); f.finish(final); f.reopen();
        assert.equal(f.c.leaseNextRun({ workerId: 'no-duplicate' }), undefined);
        assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM runtime_communications WHERE id='exact-final'").get().n, 1);
      } finally { f.close(); }
    });
  }
}

test('Decision-root restoration rolls back atomically and never releases a started or submitted claim', () => {
  const f = fixture();
  try {
    const source = f.human(); f.c.waitForTaskDecision({ runAuthorization: f.auth(source), decisionId: 'exact', scopeKey: `conversation:${f.chat.id}` }); f.finish(source);
    const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
      messageId: 'decision:exact:response', kind: 'human', payload: { decision: { id: 'exact' } } }); f.c.attachTaskDecisionWake('exact', answer);
    const claim = f.c.leaseNextRun({ workerId: 'answer' });
    f.store.sqlite.exec(`CREATE TEMP TRIGGER restoration_failure BEFORE DELETE ON required_reply_obligations
      BEGIN SELECT RAISE(ABORT, 'fixture restoration rollback'); END`);
    assert.throws(() => f.c.deferUninjectedRun(claim.runId, claim.fencingToken), /restoration rollback/);
    assert.equal(f.c.requiredReplyObligationsForRun(source.runId)[0].state, 'superseded');
    assert.equal(f.c.requiredReplyObligationsForRun(claim.runId).length, 1);
    assert.equal(f.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(claim.runId).status, 'leased');
    assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(answer).state, 'attached');
    f.store.sqlite.exec('DROP TRIGGER restoration_failure');
    assert.throws(() => f.c.deferUninjectedRun(claim.runId, claim.fencingToken - 1));
    const input = { injectionId: claim.injectionId, runId: claim.runId, fencingToken: claim.fencingToken };
    f.c.preparePromptInjection({ ...input, prompt: 'Exact accepted answer' }); f.c.markPromptSubmitted(input);
    assert.throws(() => f.c.deferUninjectedRun(claim.runId, claim.fencingToken), /uninjected/);
    f.c.acknowledgePromptInjection(input);
    assert.throws(() => f.c.deferUninjectedRun(claim.runId, claim.fencingToken), /uninjected/);
    assert.equal(f.c.requiredReplyObligationsForRun(claim.runId).length, 1);
  } finally { f.close(); }
});

for (const terminal of ['error', 'expiry', 'orphan']) for (const failure of ['none', 'read', 'association']) {
  test(`canonical Decision wait repair precedes ${terminal} recovery; repair failure=${failure}`, () => {
    let decisions = [], readFails = failure === 'read';
    const f = fixture({ canonicalTaskDecisions: () => { if (readFails) throw Error('fixture canonical index unavailable'); return decisions; } });
    try {
      const source = f.human(); accept(f, source);
      decisions = [{ id: 'canonical', blocking: true, status: 'pending', coordinationRunId: source.runId,
        agentId: f.lead.id, projectId: f.project.id, conversationId: f.chat.id }];
      if (failure === 'association') f.store.sqlite.exec(`CREATE TEMP TRIGGER wait_repair_failure
        BEFORE UPDATE OF blocking_decision_id ON required_reply_obligations
        WHEN NEW.blocking_decision_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture repair rollback'); END`);
      if (terminal === 'error') f.c.failRun({ runId: source.runId, fencingToken: source.fencingToken,
        workerId: 'lead', sameRunResumable: false, failureKind: 'unknown', error: 'Fixture provider failure' });
      if (terminal === 'expiry') f.c.recoverExpiredRuns(new Date(Date.parse(source.leaseExpiresAt) + 1).toISOString());
      if (terminal === 'orphan') f.c.recoverOrphanedRuns('new-worker');
      assert.equal(f.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(source.runId).status, 'outcome_unknown');
      assert.equal(f.c.activeRunCount(), 0);
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
      assert.equal(Boolean(f.c.requiredReplyObligationsForRun(source.runId)[0].decisionWaitRepairPending), failure !== 'none');
      if (failure !== 'none') {
        assert.equal(f.c.leaseNextRun({ workerId: 'still-held' }), undefined);
        readFails = false; if (failure === 'association') f.store.sqlite.exec('DROP TRIGGER wait_repair_failure');
        f.reopen(); assert.equal(f.c.leaseNextRun({ workerId: 'repair' }), undefined);
      }
      const root = f.c.requiredReplyObligationsForRun(source.runId)[0];
      assert.equal(root.blockingDecisionId, 'canonical'); assert.equal(root.decisionWaitRepairPending, undefined);
      assert.equal(f.c.taskDecisionOwnsDelivery('canonical'), true);
      assert.equal(f.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(source.runId).status, 'outcome_unknown');
    } finally { f.close(); }
  });
}

test('bounded repair visits a later healthy hold despite 64 persistently failing predecessors', () => {
  let healthyRun, setup = true, decision;
  const f = fixture({ canonicalTaskDecisions: ids => {
    if (!setup && ids.has(healthyRun)) return [decision];
    throw Error('fixture persistent canonical read failure');
  } });
  try {
    for (let i = 0; i < 65; i++) {
      const lease = f.human(`held-task-${i}`); accept(f, lease);
      f.c.failRun({ runId: lease.runId, fencingToken: lease.fencingToken, workerId: 'lead', sameRunResumable: false });
      healthyRun = lease.runId;
    }
    decision = { id: 'later-canonical', blocking: true, status: 'pending', coordinationRunId: healthyRun,
      agentId: f.lead.id, projectId: f.project.id, conversationId: f.chat.id };
    setup = false;
    const now = new Date(Date.now() + 1000).toISOString();
    assert.equal(f.c.leaseNextRun({ workerId: 'repair-first-batch', now }), undefined);
    assert.equal(f.c.leaseNextRun({ workerId: 'repair-next-batch', now: new Date(Date.parse(now) + 1).toISOString() }), undefined);
    assert.equal(f.c.requiredReplyObligationsForRun(healthyRun)[0].blockingDecisionId, 'later-canonical');
    assert.equal(f.c.requiredReplyObligationsForRun(healthyRun)[0].decisionWaitRepairPending, undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind='task_decision_repair'").get().n, 64);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
  } finally { f.close(); }
});

for (const terminal of ['error', 'expiry', 'orphan']) {
  test(`a satisfied initial receipt retains its exact early answer through ${terminal} association rollback`, () => {
    let decisions = [];
    const f = fixture({ canonicalTaskDecisions: () => decisions });
    try {
      const source = f.human(); accept(f, source); f.reply(source, 'initial-receipt');
      decisions = [{ id: 'exact-pending', blocking: true, status: 'pending', coordinationRunId: source.runId,
        agentId: f.lead.id, projectId: f.project.id, conversationId: f.chat.id }];
      f.store.sqlite.exec(`CREATE TRIGGER initial_wait_rollback BEFORE UPDATE OF blocking_decision_id ON required_reply_obligations
        WHEN NEW.blocking_decision_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture initial wait rollback'); END`);
      if (terminal === 'error') f.c.failRun({ runId: source.runId, fencingToken: source.fencingToken,
        workerId: 'lead', sameRunResumable: false, failureKind: 'unknown' });
      if (terminal === 'expiry') f.c.recoverExpiredRuns(new Date(Date.parse(source.leaseExpiresAt) + 1).toISOString());
      if (terminal === 'orphan') f.c.recoverOrphanedRuns('replacement-worker');
      const response = { optionId: 'approve', respondedAt: new Date().toISOString() };
      decisions = [{ ...decisions[0], status: 'resolved', response }];
      const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
        scopeKey: `conversation:${f.chat.id}`, messageId: 'decision:exact-pending:response', kind: 'human',
        payload: { decision: { id: 'exact-pending', response } } });
      f.c.attachTaskDecisionWake('exact-pending', answer, new Date().toISOString(), source.runId);
      f.reopen();
      assert.equal(f.c.leaseNextRun({ workerId: 'must-stay-held' }), undefined);
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind='task_decision_pending_repair'").get().n, 1);
      assert.equal(f.c.requiredReplyObligationsForRun(source.runId)[0].decisionWaitRepairPending, true);
      f.store.sqlite.exec('DROP TRIGGER initial_wait_rollback');
      const next = f.c.leaseNextRun({ workerId: 'exact-answer', now: new Date(Date.now() + 1000).toISOString() });
      assert.deepEqual(next.activationIds, [answer]);
      const root = f.c.requiredReplyObligationsForRun(next.runId)[0];
      assert.equal(root.sourceActivationId, source.activationIds[0]); assert.equal(root.state, 'satisfied');
      assert.deepEqual(root.replyAuthority, { intent: 'direct_to_user' });
      assert.equal(root.satisfiedCommunicationId, 'initial-receipt'); assert.equal(root.attemptCount, 0);
      assert.equal(root.blockingDecisionId, undefined);
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind IN ('task_decision_pending_repair','task_decision_repair','task_decision_repair_wait')").get().n, 0);
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
      assert.equal(f.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(source.runId).status, 'outcome_unknown');
    } finally { f.close(); }
  });
}

for (const failure of ['read', 'different-pending']) {
  test(`an uncertain initial receipt does not revive a historical resolved Decision; evidence=${failure}`, () => {
    let outage = failure === 'read', decisions = [];
    const f = fixture({ canonicalTaskDecisions: () => { if (outage) throw Error('fixture reader outage'); return decisions; } });
    try {
      const source = f.human(); accept(f, source); f.reply(source, 'historical-receipt');
      const old = { id: 'historical', blocking: true, status: 'resolved', coordinationRunId: source.runId,
        agentId: f.lead.id, projectId: f.project.id, conversationId: f.chat.id, response: { optionId: 'approve' } };
      decisions = failure === 'read' ? [old] : [{ ...old, id: 'different-pending', status: 'pending', response: undefined }];
      f.store.sqlite.exec(`CREATE TEMP TRIGGER historical_wait_rollback BEFORE UPDATE OF blocking_decision_id ON required_reply_obligations
        WHEN NEW.blocking_decision_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture historical rollback'); END`);
      f.c.failRun({ runId: source.runId, fencingToken: source.fencingToken, workerId: 'lead', sameRunResumable: false });
      assert.equal(f.c.requiredReplyObligationsForRun(source.runId)[0].decisionWaitRepairPending, true);
      outage = false; decisions = [old]; f.store.sqlite.exec('DROP TRIGGER historical_wait_rollback');
      assert.equal(f.c.repairCanonicalTaskDecisionWait(source.runId), true);
      const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
        messageId: 'decision:historical:response', kind: 'human', payload: { decision: { id: old.id, response: old.response } } });
      f.c.attachTaskDecisionWake(old.id, answer, new Date().toISOString(), source.runId);
      const generic = f.c.leaseNextRun({ workerId: 'historical-answer' });
      assert.deepEqual(generic.activationIds, [answer]); assert.deepEqual(f.c.requiredReplyObligationsForRun(generic.runId), []);
      assert.equal(f.c.requiredReplyObligationsForRun(source.runId)[0].blockingDecisionId, undefined);
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind='task_decision_pending_repair'").get().n, 0);
    } finally { f.close(); }
  });
}

test('reopening without a canonical reader cannot release an existing hold on completion', () => {
  let outage = true;
  const f = fixture({ canonicalTaskDecisions: () => { if (outage) throw Error('fixture reader outage'); return []; } });
  try {
    const source = f.human(); accept(f, source);
    assert.equal(f.c.repairCanonicalTaskDecisionWait(source.runId), false);
    f.reopen({}); assert.equal(f.c.repairCanonicalTaskDecisionWait(source.runId), false);
    f.c.completeRun(source.runId, source.fencingToken);
    assert.equal(f.c.requiredReplyObligationsForRun(source.runId)[0].decisionWaitRepairPending, true);
    assert.equal(f.c.leaseNextRun({ workerId: 'must-remain-held' }), undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
    outage = false; f.reopen();
    const recovery = f.c.leaseNextRun({ workerId: 'trusted-reader-restored', now: new Date(Date.now() + 1000).toISOString() });
    assert.equal(recovery.activations[0].kind, 'required_reply_recovery');
  } finally { f.close(); }
});

test('genuine cancellation retires exact pending proof and cannot revive its initial receipt', () => {
  let decisions = [];
  const f = fixture({ canonicalTaskDecisions: () => decisions });
  try {
    const source = f.human(); accept(f, source); f.reply(source, 'cancelled-initial-receipt');
    decisions = [{ id: 'cancelled-exact', blocking: true, status: 'pending', coordinationRunId: source.runId,
      agentId: f.lead.id, projectId: f.project.id, conversationId: f.chat.id }];
    f.store.sqlite.exec(`CREATE TEMP TRIGGER cancelled_wait_rollback BEFORE UPDATE OF blocking_decision_id ON required_reply_obligations
      WHEN NEW.blocking_decision_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture cancelled wait rollback'); END`);
    assert.equal(f.c.repairCanonicalTaskDecisionWait(source.runId), false);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind='task_decision_pending_repair'").get().n, 1);
    decisions = [{ ...decisions[0], status: 'resolved', response: { optionId: 'approve' } }];
    const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
      messageId: 'decision:cancelled-exact:response', kind: 'human', payload: { decision: { id: 'cancelled-exact', response: decisions[0].response } } });
    f.c.attachTaskDecisionWake('cancelled-exact', answer, new Date().toISOString(), source.runId);
    assert.equal(f.c.cancelAgentRun({ agentId: f.lead.id, expectedRunId: source.runId, idempotencyKey: 'cancel-exact-pending-proof' }).cancelled, true);
    assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(answer).state, 'cancelled');
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind IN ('task_decision_pending_repair','task_decision_repair','task_decision_repair_wait')").get().n, 0);
    f.reopen(); assert.equal(f.c.repairCanonicalTaskDecisionWait(source.runId), false);
    assert.equal(f.c.leaseNextRun({ workerId: 'no-cancelled-root-revival' }), undefined);
    assert.equal(f.c.taskDecisionOwnsDelivery('cancelled-exact'), false);
    assert.equal(f.c.requiredReplyObligationsForRun(source.runId)[0].satisfiedCommunicationId, 'cancelled-initial-receipt');
  } finally { f.close(); }
});

for (const decisionWait of [false, true]) {
  test(`an inherited task repair hold follows its completed owner until the reader is restored; Decision=${decisionWait}`, () => {
    let outage = true, decisions = [];
    const f = fixture({ canonicalTaskDecisions: () => { if (outage) throw Error('fixture inherited reader outage'); return decisions; } });
    try {
      const source = f.human(); f.delegate(source, 1, { noRoute: true }); f.reply(source, 'inherited-interim'); f.finish(source);
      assert.equal(f.c.requiredReplyObligationsForRun(source.runId)[0].decisionWaitRepairPending, true);
      f.reopen({}); f.review();
      const resumed = f.c.leaseNextRun({ workerId: 'inherited-owner', excludedAgentIds: [f.peer.id] });
      assert.equal(f.c.requiredReplyObligationsForRun(resumed.runId)[0].sourceActivationId, source.activationIds[0]);
      f.finish(resumed);
      assert.equal(f.c.requiredReplyObligationsForRun(resumed.runId)[0].decisionWaitRepairPending, true);
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
      outage = false;
      if (decisionWait) decisions = [{ id: 'inherited-exact', blocking: true, status: 'pending', coordinationRunId: source.runId,
        agentId: f.lead.id, projectId: f.project.id, conversationId: f.chat.id }];
      f.reopen();
      const next = f.c.leaseNextRun({ workerId: 'reader-restored', excludedAgentIds: [f.peer.id], now: new Date(Date.now() + 1000).toISOString() });
      if (decisionWait) {
        assert.equal(next, undefined);
        assert.equal(f.c.requiredReplyObligationsForRun(resumed.runId)[0].blockingDecisionId, 'inherited-exact');
        assert.equal(f.c.taskDecisionOwnsDelivery('inherited-exact'), true);
      } else {
        assert.equal(next.activations[0].kind, 'required_reply_recovery');
        const root = f.c.requiredReplyObligationsForRun(next.runId)[0];
        assert.equal(root.sourceActivationId, source.activationIds[0]); assert.equal(root.attemptCount, 1);
        assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 1);
      }
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind='task_decision_repair'").get().n, 0);
    } finally { f.close(); }
  });
}

for (const canonicalWait of [false, true]) {
  test(`an upgrade repair hold blocks an already queued exact recovery, not unrelated coalesced work; canonical wait=${canonicalWait}`, () => {
    const f = fixture();
    try {
      const source = f.human(); accept(f, source);
      f.c.failRun({ runId: source.runId, fencingToken: source.fencingToken, workerId: 'lead', sameRunResumable: false });
      const original = f.c.requiredReplyObligationsForRun(source.runId)[0];
      assert.equal(original.state, 'recovery_pending'); assert.ok(original.recoveryActivationId);
      const decision = { id: 'upgrade-exact', blocking: true, status: 'pending', coordinationRunId: source.runId,
        agentId: f.lead.id, projectId: f.project.id, conversationId: f.chat.id };
      let decisions = [decision]; const options = { canonicalTaskDecisions: () => decisions };
      f.reopen(options);
      f.store.sqlite.exec(`CREATE TRIGGER upgrade_wait_rollback BEFORE UPDATE OF blocking_decision_id ON required_reply_obligations
        WHEN NEW.blocking_decision_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture upgrade wait rollback'); END`);
      assert.equal(f.c.repairCanonicalTaskDecisionWait(source.runId), false);
      assert.equal(f.c.leaseNextRun({ workerId: 'must-hold-old-recovery' }), undefined);
      const unrelated = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
        messageId: 'unrelated-during-upgrade', kind: 'human', payload: { text: 'Independent work, not an old task recovery' } });
      const independent = f.c.leaseNextRun({ workerId: 'independent-work' });
      assert.deepEqual(independent.activationIds, [unrelated]); assert.deepEqual(f.c.requiredReplyObligationsForRun(independent.runId), []);
      assert.equal(f.c.leaseNextSteering({ workerId: 'must-not-coalesce-recovery' }), undefined); f.finish(independent);
      f.reopen(options); assert.equal(f.c.leaseNextRun({ workerId: 'still-held-after-reopen' }), undefined);
      assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(original.recoveryActivationId).state, 'pending');
      f.store.sqlite.exec('DROP TRIGGER upgrade_wait_rollback');
      if (!canonicalWait) decisions = [];
      const next = f.c.leaseNextRun({ workerId: 'upgrade-repaired', now: new Date(Date.now() + 1000).toISOString() });
      if (canonicalWait) {
        assert.equal(next, undefined); assert.equal(f.c.taskDecisionOwnsDelivery(decision.id), true);
        assert.equal(f.c.requiredReplyObligationsForRun(source.runId)[0].blockingDecisionId, decision.id);
        assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(original.recoveryActivationId).state, 'cancelled');
      } else {
        assert.deepEqual(next.activationIds, [original.recoveryActivationId]);
        assert.equal(next.activations[0].kind, 'required_reply_recovery');
        assert.equal(f.c.requiredReplyObligationsForRun(next.runId)[0].attemptCount, 1);
      }
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind='task_reply_repair_wait'").get().n, 0);
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 1,
        'repair must cancel or release the original recovery, not duplicate it');
      assert.equal(f.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(source.runId).status, 'outcome_unknown');
    } finally { f.close(); }
  });
}

for (const claimed of [false, true]) for (const outcome of claimed ? ['pending', 'empty', 'cancelled'] : ['pending', 'empty']) {
  test(`startup repair of a historical Decision holds its latest owner recovery; outcome=${outcome}, claimed=${claimed}`, () => {
    const f = fixture();
    try {
      const workspace = new WorkspaceStore(f.project.hostPath);
      const source = f.human(); f.delegate(source, 1, { noRoute: true });
      const decision = workspace.createDecision({ idempotencyKey: 'historical-owner-exact', projectId: f.project.id,
        agentId: f.lead.id, conversationId: f.chat.id, runId: source.runId, coordinationRunId: source.runId,
        mode: 'approval', question: 'Approve this exact task?', options: [{ id: 'approve', label: 'Approve' }], allowOther: true, blocking: true });
      f.store.sqlite.exec(`CREATE TRIGGER historical_owner_wait_rollback BEFORE UPDATE OF blocking_decision_id ON required_reply_obligations
        WHEN NEW.blocking_decision_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture historical owner wait rollback'); END`);
      assert.throws(() => f.c.waitForTaskDecision({ runAuthorization: f.auth(source), decisionId: decision.id,
        scopeKey: `conversation:${f.chat.id}` }));
      f.reply(source, 'historical-owner-interim'); f.finish(source); f.review();
      const current = f.c.leaseNextRun({ workerId: 'legacy-owner', excludedAgentIds: [f.peer.id] }); f.finish(current);
      const root = f.c.requiredReplyObligationsForRun(current.runId)[0];
      assert.equal(root.sourceActivationId, source.activationIds[0]); assert.equal(root.state, 'recovery_pending');
      assert.ok(root.recoveryActivationId);
      const claim = claimed && f.c.leaseNextRun({ workerId: 'legacy-uninjected-claim', excludedAgentIds: [f.peer.id] });
      if (claim) assert.deepEqual(claim.activationIds, [root.recoveryActivationId]);
      const options = { canonicalTaskDecisions: ids => workspace.decisionsForRuns(ids) };
      f.reopen(options);
      assert.equal(f.c.repairCanonicalTaskDecisionWait(source.runId), false, 'startup visits the canonical origin, not the newer owner');
      assert.equal(f.c.requiredReplyObligationsForRun(source.runId)[0].decisionWaitRepairPending, true);
      assert.equal(f.c.requiredReplyObligationsForRun(claim ? claim.runId : current.runId)[0].decisionWaitRepairPending, true);
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE activation_id=? AND source_kind='task_reply_repair_wait' AND source_id=?")
        .get(root.recoveryActivationId, claim ? claim.runId : current.runId).n, 1);
      if (outcome === 'cancelled') assert.equal(f.c.cancelAgentRun({ agentId: f.lead.id, expectedRunId: claim.runId,
        idempotencyKey: 'cancel-held-live-claim' }).cancelled, true, 'exercise a genuine live-Run cancellation');
      f.c.recoverOrphanedRuns('after-upgrade');
      if (claim && outcome !== 'cancelled') {
        assert.deepEqual(f.c.requiredReplyObligationsForRun(claim.runId), [], 'only the unaccepted copied recovery root is retired');
        const restored = f.c.requiredReplyObligationsForRun(current.runId)[0];
        assert.equal(restored.attemptCount, 0); assert.equal(restored.recoveryActivationId, root.recoveryActivationId);
        assert.equal(restored.decisionWaitRepairPending, true);
      }
      assert.equal(f.c.leaseNextRun({ workerId: 'must-not-recover' }), undefined);
      // Default-reader reopening must retain both markers; unrelated inputs
      // remain runnable without coalescing the held recovery or its root.
      f.reopen({});
      const unrelated = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
        scopeKey: `conversation:${f.chat.id}`, messageId: 'historical-owner-unrelated', kind: 'human', payload: { text: 'Independent input' } });
      const independent = f.c.leaseNextRun({ workerId: 'independent' });
      assert.deepEqual(independent.activationIds, [unrelated]); assert.deepEqual(f.c.requiredReplyObligationsForRun(independent.runId), []);
      assert.equal(f.c.leaseNextSteering({ workerId: 'no-held-coalescing' }), undefined); f.finish(independent);
      f.store.sqlite.exec('DROP TRIGGER historical_owner_wait_rollback');
      if (outcome === 'empty') workspace.cancelDecision(decision.id);
      f.reopen(options);
      const next = f.c.leaseNextRun({ workerId: 'canonical-restored', now: new Date(Date.now() + 1000).toISOString() });
      if (outcome === 'empty') {
        assert.deepEqual(next.activationIds, [root.recoveryActivationId]);
        const recovered = f.c.requiredReplyObligationsForRun(next.runId)[0];
        assert.equal(recovered.sourceActivationId, source.activationIds[0]); assert.equal(recovered.attemptCount, 1);
      } else {
        assert.equal(next, undefined);
        if (outcome === 'pending') assert.equal(f.c.requiredReplyObligationsForRun(current.runId)[0].blockingDecisionId, decision.id);
        assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(root.recoveryActivationId).state, 'cancelled');
      }
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind IN ('task_decision_repair','task_reply_repair_wait')").get().n, 0);
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 1);
    } finally { f.close(); }
  });
}

for (const release of ['defer', 'retry', 'expiry', 'orphan']) test(`an unsubmitted final recovery retains its exact activation and budget through ${release}`, () => {
  const f = fixture();
  try {
    const source = f.human(); f.delegate(source, 1, { noRoute: true }); f.reply(source, 'recovery-interim'); f.finish(source); f.review();
    const owner = f.c.leaseNextRun({ workerId: 'owner', excludedAgentIds: [f.peer.id] }); f.finish(owner);
    const root = f.c.requiredReplyObligationsForRun(owner.runId)[0];
    let now = Date.now(), claim = f.c.leaseNextRun({ workerId: 'recovery', now: new Date(now).toISOString() });
    for (let iteration = 0; iteration < 2; iteration++) {
      assert.deepEqual(claim.activationIds, [root.recoveryActivationId]);
      f.c.preparePromptInjection({ injectionId: claim.injectionId, runId: claim.runId, fencingToken: claim.fencingToken,
        prompt: 'Exact prepared but never submitted recovery' });
      if (release === 'defer') f.c.deferUninjectedRun(claim.runId, claim.fencingToken);
      if (release === 'retry') f.c.failRun({ runId: claim.runId, fencingToken: claim.fencingToken, workerId: 'recovery',
        sameRunResumable: false, confirmedNotExecuted: true, retryDelayMs: 0 });
      if (release === 'expiry') { now = Date.parse(claim.leaseExpiresAt) + 1; f.c.recoverExpiredRuns(new Date(now).toISOString()); }
      if (release === 'orphan') f.c.recoverOrphanedRuns(`replacement-${iteration}`);
      assert.deepEqual(f.c.requiredReplyObligationsForRun(claim.runId), []);
      const restored = f.c.requiredReplyObligationsForRun(owner.runId)[0];
      assert.equal(restored.state, 'recovery_pending'); assert.equal(restored.attemptCount, 0);
      assert.equal(restored.recoveryActivationId, root.recoveryActivationId); f.reopen();
      now = Math.max(now, Date.now()) + 1;
      claim = f.c.leaseNextRun({ workerId: 'recovery', now: new Date(now).toISOString() });
      const next = f.c.requiredReplyObligationsForRun(claim.runId)[0];
      assert.equal(next.sourceActivationId, source.activationIds[0]); assert.equal(next.attemptCount, 1);
      assert.equal(next.interimCommunicationId, 'recovery-interim');
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 1);
    }
  } finally { f.close(); }
});

for (const evidence of ['started', 'provider-input', 'submitted', 'acknowledged']) for (const failure of [false, true]) {
  test(`canonical recovery repair preserves ${evidence} evidence; association failure=${failure}`, () => {
    const f = fixture();
    try {
      const source = f.human(); f.delegate(source, 1, { noRoute: true }); f.finish(source); f.review();
      const owner = f.c.leaseNextRun({ workerId: 'owner', excludedAgentIds: [f.peer.id] }); f.finish(owner);
      const recoveryId = f.c.requiredReplyObligationsForRun(owner.runId)[0].recoveryActivationId;
      const claim = f.c.leaseNextRun({ workerId: 'protected-recovery' });
      if (evidence === 'started') f.c.markRunStarted(claim.runId, claim.fencingToken);
      if (evidence === 'provider-input') f.c.recordProviderInput({ executionId: 'exact-recovery-packet', schedulerRunId: claim.runId,
        fencingToken: claim.fencingToken, agentId: f.lead.id, projectId: f.project.id, prompt: 'Exact immutable recovery packet',
        sourceManifest: { schemaVersion: 1, historyMessageCount: 0, activationIds: claim.activationIds, communicationEventIds: [],
          artifactIds: [], conversationId: f.chat.id, providerSessionDisposition: 'fresh_task', sources: [] } });
      if (evidence === 'submitted' || evidence === 'acknowledged') {
        const input = { injectionId: claim.injectionId, runId: claim.runId, fencingToken: claim.fencingToken };
        f.c.preparePromptInjection({ ...input, prompt: 'Exact submitted recovery' }); f.c.markPromptSubmitted(input);
        if (evidence === 'acknowledged') f.c.acknowledgePromptInjection(input);
      }
      const snapshot = () => JSON.stringify({ run: f.store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(claim.runId),
        injections: f.store.sqlite.prepare('SELECT * FROM scheduler_prompt_injections WHERE run_id=?').all(claim.runId),
        packets: f.store.sqlite.prepare('SELECT * FROM provider_inputs WHERE scheduler_run_id=?').all(claim.runId) });
      const before = snapshot();
      f.reopen({ canonicalTaskDecisions: () => [{ id: 'protected-decision', blocking: true, status: 'pending', coordinationRunId: source.runId,
        agentId: f.lead.id, projectId: f.project.id, conversationId: f.chat.id }] });
      if (failure) f.store.sqlite.exec(`CREATE TRIGGER protected_wait_rollback BEFORE UPDATE OF blocking_decision_id ON required_reply_obligations
        WHEN NEW.blocking_decision_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture protected wait rollback'); END`);
      assert.equal(f.c.repairCanonicalTaskDecisionWait(source.runId), !failure);
      assert.equal(snapshot(), before);
      assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(recoveryId).state, 'attached');
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE activation_id=? AND source_kind='task_reply_repair_wait'").get(recoveryId).n, 0);
    } finally { f.close(); }
  });
}

for (const answerTiming of ['before-repair', 'after-repair', 'no-Decision']) {
  test(`rollover retirement retains its source handoff through canonical repair; answer=${answerTiming}`, () => {
    let outage = answerTiming === 'no-Decision', decisions = [];
    const f = fixture({ canonicalTaskDecisions: () => { if (outage) throw Error('fixture retirement reader outage'); return decisions; } });
    try {
      const source = f.human(); accept(f, source); f.reply(source, 'retirement-initial');
      const rollover = f.rollover(source); f.c.markContextRolloverVisibleResponseCommitted(f.lead.id, source.runId);
      if (answerTiming !== 'no-Decision') {
        decisions = [{ id: 'retirement-exact', blocking: true, status: 'pending', coordinationRunId: source.runId,
          agentId: f.lead.id, projectId: f.project.id, conversationId: f.chat.id }];
        f.store.sqlite.exec(`CREATE TRIGGER retirement_wait_rollback BEFORE UPDATE OF blocking_decision_id ON required_reply_obligations
          WHEN NEW.blocking_decision_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture retirement wait rollback'); END`);
      }
      f.c.completeRun(source.runId, source.fencingToken);
      const handoff = f.c.leaseNextRun({ workerId: 'handoff', excludedAgentIds: [f.peer.id] });
      assert.equal(handoff.activations[0].kind, 'context_rollover_handoff'); f.finish(handoff);
      f.store.appendEvent(f.lead.id, { type: 'continuation_handoff', handoffId: 'repair-retained-handoff', executionId: handoff.runId,
        text: 'Bounded original task state retained until its exact approval is known.' });
      f.c.commitContextRolloverHandoff(rollover.id, 'repair-retained-handoff'); f.c.beginContextRolloverRetirement(rollover.id);
      const held = f.c.prepareContextRolloverContinuation({ id: rollover.id });
      assert.equal(held.state, 'session_retiring'); assert.equal(held.completionReason, undefined);
      assert.equal(f.c.requiredReplyObligationsForRun(source.runId)[0].decisionWaitRepairPending, true);
      let answer;
      const respond = () => {
        const response = { optionId: 'approve', respondedAt: new Date().toISOString() };
        decisions = [{ ...decisions[0], status: 'resolved', response }];
        answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
          messageId: 'decision:retirement-exact:response', kind: 'human', payload: { decision: { id: 'retirement-exact', response } } });
        f.c.attachTaskDecisionWake('retirement-exact', answer, response.respondedAt, source.runId);
      };
      if (answerTiming === 'before-repair') respond();
      f.reopen(); assert.equal(f.c.contextRollover(rollover.id).state, 'session_retiring');
      outage = false;
      if (answerTiming !== 'no-Decision') f.store.sqlite.exec('DROP TRIGGER retirement_wait_rollback');
      let next = f.c.leaseNextRun({ workerId: 'autonomous-retirement-repair', excludedAgentIds: [f.peer.id], now: new Date(Date.now() + 1000).toISOString() });
      if (answerTiming === 'no-Decision') {
        assert.equal(next, undefined);
        const retired = f.c.contextRollover(rollover.id);
        assert.equal(retired.state, 'completed'); assert.equal(retired.completionReason, 'no_continuation_required');
        assert.equal(retired.continuityWaiting, false);
        assert.equal(f.store.consumeContinuationHandoff(f.lead.id, retired.handoffEventId, retired.sourceRunId), true);
      } else {
        if (answerTiming === 'after-repair') {
          assert.equal(next, undefined); assert.equal(f.c.contextRollover(rollover.id).continuityWaiting, true);
          respond(); next = f.c.leaseNextRun({ workerId: 'exact-retained-answer', excludedAgentIds: [f.peer.id] });
        }
        assert.deepEqual(next.activationIds, [answer]);
        const resumed = f.c.contextRolloverForContinuationRun(next.runId, f.lead.id);
        assert.equal(resumed.id, rollover.id); assert.equal(resumed.handoffEventId, 'repair-retained-handoff');
        const root = f.c.requiredReplyObligationsForRun(next.runId)[0];
        assert.equal(root.sourceActivationId, source.activationIds[0]); assert.equal(root.satisfiedCommunicationId, 'retirement-initial');
        assert.equal(root.state, 'satisfied'); assert.equal(root.attemptCount, 0);
      }
      assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
    } finally { f.close(); }
  });
}

test('bounded repair ages displaced siblings rather than starving healthy hold 65', () => {
  let setup = true, healthyRun, decision;
  const f = fixture({ canonicalTaskDecisions: ids => {
    if (!setup && ids.has(healthyRun)) return [decision];
    throw Error('fixture persistent mixed-root read failure');
  } });
  try {
    const predecessors = [];
    for (let i = 0; i < 65; i++) {
      if (i < 64) f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
        scopeKey: `conversation:${f.chat.id}`, messageId: `sibling-${i}`, kind: 'human',
        payload: { replyAuthority: { intent: 'direct_to_user' } } });
      const source = f.human(`mixed-held-${i}`); accept(f, source);
      f.c.failRun({ runId: source.runId, fencingToken: source.fencingToken, workerId: 'lead', sameRunResumable: false });
      if (i < 64) { assert.equal(f.c.requiredReplyObligationsForRun(source.runId).length, 2); predecessors.push(source.runId); }
      else healthyRun = source.runId;
    }
    // One historical sibling has become terminal while this same held Run
    // still owns another live root. Both markers belong to the retry cohort.
    for (const runId of predecessors) {
      const roots = f.c.requiredReplyObligationsForRun(runId);
      f.store.sqlite.prepare("UPDATE required_reply_obligations SET state='cancelled' WHERE run_id=? AND source_activation_id=?")
        .run(runId, roots[0].sourceActivationId);
      f.store.sqlite.prepare("UPDATE required_reply_obligations SET updated_at='2026-01-01T00:00:00.000Z' WHERE run_id=?").run(runId);
    }
    decision = { id: 'healthy-after-mixed', blocking: true, status: 'pending', coordinationRunId: healthyRun,
      agentId: f.lead.id, projectId: f.project.id, conversationId: f.chat.id };
    setup = false; const now = new Date(Date.now() + 1000).toISOString();
    assert.equal(f.c.leaseNextRun({ workerId: 'mixed-first-batch', now }), undefined);
    assert.equal(f.c.leaseNextRun({ workerId: 'mixed-next-batch', now: new Date(Date.parse(now) + 1).toISOString() }), undefined);
    assert.equal(f.c.requiredReplyObligationsForRun(healthyRun)[0].blockingDecisionId, decision.id);
    assert.equal(f.c.requiredReplyObligationsForRun(healthyRun)[0].decisionWaitRepairPending, undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
  } finally { f.close(); }
});

test('an unrelated coalesced input cannot borrow the deferred Decision root', () => {
  const f = fixture();
  try {
    const source = f.human(); f.reply(source, 'initial');
    f.c.waitForTaskDecision({ runAuthorization: f.auth(source), decisionId: 'exact', scopeKey: `conversation:${f.chat.id}` }); f.finish(source);
    const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
      messageId: 'decision:exact:response', kind: 'human', payload: { decision: { id: 'exact' } } }); f.c.attachTaskDecisionWake('exact', answer);
    const unrelated = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
      messageId: 'unrelated-input', kind: 'human', payload: { text: 'Different work, not a Decision answer' } });
    const mixed = f.c.leaseNextRun({ workerId: 'mixed' }); assert.deepEqual(new Set(mixed.activationIds), new Set([answer, unrelated]));
    f.c.deferUninjectedRun(mixed.runId, mixed.fencingToken); f.reopen();
    f.store.sqlite.prepare('UPDATE agent_activations SET priority=1000 WHERE id=?').run(unrelated);
    const generic = f.c.leaseNextRun({ workerId: 'generic', coalesceLimit: 1 }); assert.deepEqual(generic.activationIds, [unrelated]);
    assert.equal(f.c.requiredReplyObligationsForRun(generic.runId).length, 0); f.finish(generic);
    const exact = f.c.leaseNextRun({ workerId: 'exact' }); assert.deepEqual(exact.activationIds, [answer]);
    assert.equal(f.c.requiredReplyObligationsForRun(exact.runId)[0].sourceActivationId, source.activationIds[0]);
  } finally { f.close(); }
});

for (const receipt of [false, true]) for (const poisonAnswer of [false, true]) {
  test(`partial compilation restores only a surviving exact answer; receipt=${receipt}, poisonAnswer=${poisonAnswer}`, () => {
    const f = fixture();
    try {
      const source = f.human(); if (receipt) f.reply(source, 'initial');
      f.c.waitForTaskDecision({ runAuthorization: f.auth(source), decisionId: 'exact', scopeKey: `conversation:${f.chat.id}` }); f.finish(source);
      const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
        messageId: 'decision:exact:response', kind: 'human', payload: { decision: { id: 'exact' } } }); f.c.attachTaskDecisionWake('exact', answer);
      const poison = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
        messageId: 'poison-input', kind: 'human', payload: { text: 'Unrelated bad attachment' } });
      const claim = f.c.leaseNextRun({ workerId: 'prepare' });
      f.c.failRunForActivationCompilation({ runId: claim.runId, fencingToken: claim.fencingToken, workerId: 'prepare',
        activationId: poisonAnswer ? answer : poison, errorCode: 'attachment_unavailable' });
      assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(poisonAnswer ? answer : poison).state, 'failed');
      if (poisonAnswer) {
        assert.equal(f.c.requiredReplyObligationsForRun(claim.runId).some(o => o.sourceActivationId === source.activationIds[0]), true,
          'a permanently rejected answer must not restore an earlier owner');
      } else {
        assert.equal(f.c.requiredReplyObligationsForRun(claim.runId).length, 0); f.reopen();
        const retried = f.c.leaseNextRun({ workerId: 'retry' }); assert.deepEqual(retried.activationIds, [answer]);
        const root = f.c.requiredReplyObligationsForRun(retried.runId)[0];
        assert.equal(root.sourceActivationId, source.activationIds[0]); assert.equal(root.state, receipt ? 'satisfied' : 'pending');
        assert.equal(root.satisfiedCommunicationId, receipt ? 'initial' : undefined); assert.equal(root.attemptCount, 0);
        assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 0);
      }
    } finally { f.close(); }
  });
}

test('a repaired empty canonical index releases one bounded recovery, but foreign Decisions grant no wait', () => {
  let fails = true, decisions = [];
  const f = fixture({ canonicalTaskDecisions: () => { if (fails) throw Error('fixture read failure'); return decisions; } });
  try {
    const source = f.human(); accept(f, source); f.c.failRun({ runId: source.runId, fencingToken: source.fencingToken, workerId: 'lead', sameRunResumable: false });
    fails = false;
    decisions = [{ id: 'foreign', blocking: true, status: 'pending', coordinationRunId: source.runId,
      agentId: f.peer.id, projectId: f.project.id, conversationId: f.chat.id }];
    const recovery = f.c.leaseNextRun({ workerId: 'legitimate-recovery' });
    assert.equal(recovery.activations[0].kind, 'required_reply_recovery');
    assert.equal(f.c.requiredReplyObligationsForRun(recovery.runId)[0].blockingDecisionId, undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='required_reply_recovery'").get().n, 1);
  } finally { f.close(); }
});

test('a canonical reader fault does not hold collaboration-only recovery', () => {
  let reads = 0;
  const f = fixture({ canonicalTaskDecisions: () => { reads++; throw Error('fixture reader failure'); } });
  try {
    f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
      messageId: 'collaboration-only', kind: 'human', payload: { replyAuthority: { intent: 'collaboration', recipientAgentIds: [f.peer.id] } } });
    const run = f.c.leaseNextRun({ workerId: 'specialist' }); f.finish(run);
    assert.equal(reads, 0);
    assert.equal(f.c.requiredReplyObligationsForRun(run.runId)[0].state, 'recovery_pending');
    assert.equal(f.c.requiredReplyObligationsForRun(run.runId)[0].decisionWaitRepairPending, undefined);
    const recovery = f.c.leaseNextRun({ workerId: 'specialist-recovery' });
    assert.deepEqual(f.c.requiredReplyAuthoritiesForRun(recovery.runId), [{ intent: 'collaboration', recipientAgentIds: [f.peer.id] }]);
  } finally { f.close(); }
});

test('an exact response is held from both Run and steering claims, and cancellation retires its hold', () => {
  const f = fixture({ canonicalTaskDecisions: () => { throw Error('fixture reader failure'); } });
  try {
    const source = f.human(); accept(f, source);
    const answer = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id, scopeKey: `conversation:${f.chat.id}`,
      messageId: 'decision:held:response', kind: 'human', payload: { decision: { id: 'held', response: { optionId: 'approve' } } } });
    f.c.attachTaskDecisionWake('held', answer, new Date().toISOString(), source.runId);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind='task_decision_repair_wait'").get().n, 1);
    assert.equal(f.c.leaseNextSteering({ workerId: 'must-not-steer' }), undefined);
    assert.equal(f.c.leaseNextRun({ workerId: 'must-not-run' }), undefined);
    f.c.cancelAgentRun({ agentId: f.lead.id, expectedRunId: source.runId, idempotencyKey: 'cancel-held-owner' });
    assert.equal(f.store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(answer).state, 'cancelled');
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM activation_sources WHERE source_kind IN ('task_decision_repair','task_decision_repair_wait')").get().n, 0);
    f.reopen(); assert.equal(f.c.leaseNextRun({ workerId: 'no-revival' }), undefined);
  } finally { f.close(); }
});

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

for (const answerState of ['unsubmitted', 'submitted', 'acknowledged', 'fenced-before-ack', 'fenced-after-ack', 'different-response', 'unanchored']) test(`resolved Decision repair respects ${answerState} canonical answer evidence`, () => {
  const f = fixture();
  try {
    const lead = f.human(); f.reply(lead, 'initial-ack');
    const turn = { injectionId: lead.injectionId, runId: lead.runId, fencingToken: lead.fencingToken };
    f.c.preparePromptInjection({ ...turn, prompt: 'Original task' }); f.c.markPromptSubmitted(turn); f.c.acknowledgePromptInjection(turn);
    const response = { optionId: 'approve', respondedAt: '2026-10-07T00:00:00.000Z' };
    if (answerState.startsWith('fenced-')) f.c.waitForTaskDecision({ runAuthorization: f.auth(lead), decisionId: 'approval', scopeKey: `conversation:${f.chat.id}` });
    const id = f.c.enqueueMessageActivation({ projectId: f.project.id, agentId: f.lead.id,
      scopeKey: `conversation:${f.chat.id}`, messageId: answerState === 'unanchored' ? 'unrelated' : 'decision:approval:response',
      kind: 'human', payload: { decision: { id: 'approval', response: answerState === 'different-response' ? { ...response, optionId: 'deny' } : response } } });
    if (answerState.startsWith('fenced-')) f.c.attachTaskDecisionWake('approval', id);
    const run = f.c.leaseNextSteering({ workerId: 'answer' });
    const injection = { injectionId: run.injectionId, runId: run.runId, fencingToken: run.fencingToken };
    if (answerState !== 'unsubmitted') {
      f.c.preparePromptInjection({ ...injection, prompt: 'Exact canonical answer' }); f.c.markPromptSubmitted(injection);
      if (answerState === 'fenced-before-ack') f.store.sqlite.prepare('UPDATE scheduler_runs SET side_effects_fenced_at=? WHERE id=?').run(new Date().toISOString(), lead.runId);
      if (answerState !== 'submitted') f.c.acknowledgePromptInjection(injection);
      if (answerState === 'fenced-after-ack') f.store.sqlite.prepare('UPDATE scheduler_runs SET side_effects_fenced_at=? WHERE id=?').run(new Date().toISOString(), lead.runId);
    }
    f.c.reconcileTaskDecision({ decisionId: 'approval', runId: lead.runId, agentId: f.lead.id,
      projectId: f.project.id, scopeKey: `conversation:${f.chat.id}`, response });
    const cleared = answerState === 'acknowledged' || answerState === 'fenced-after-ack';
    assert.equal(f.c.requiredReplyObligationsForRun(lead.runId)[0].blockingDecisionId, cleared ? undefined : 'approval');
    assert.equal(f.c.taskDecisionOwnsDelivery('approval'), !cleared);
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
    const ownerTurn = { injectionId: owner.injectionId, runId: owner.runId, fencingToken: owner.fencingToken };
    f.c.preparePromptInjection({ ...ownerTurn, prompt: 'Disposable exact input' }); f.c.markPromptSubmitted(ownerTurn); f.c.acknowledgePromptInjection(ownerTurn);
    assert.equal(f.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(owner.runId).status, 'running');
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
      answer = enqueueAnswer(); f.c.completeRun(owner.runId, owner.fencingToken);
      unrelated = f.c.leaseNextRun({ workerId: 'unrelated', coalesceLimit: 1, excludedAgentIds: [f.peer.id] });
    } else { f.c.completeRun(owner.runId, owner.fencingToken); unrelated = f.human('unrelated'); }
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
