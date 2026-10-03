import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentStore, CoordinationV3Store } from '../dist/index.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'manual-rollover-'));
  let store = new AgentStore(directory), coordination = new CoordinationV3Store(store.sqlite);
  const project = store.createProject({ label: 'Disposable', hostPath: directory, defaultEngine: 'claude' });
  const chat = store.createConversation(project.id, { title: 'Disposable' });
  const agent = store.createAgent(project.id, { title: 'Disposable', engine: 'claude', conversationId: chat.id });
  const input = { projectId: project.id, agentId: agent.id, oldProviderSessionId: 'old', providerSessionGeneration: 'old',
    detectedOccupancy: 10000, threshold: 150000, lowWaterMark: 90000, triggerKind: 'human',
    sourceRunId: 'source', sourceActivationIds: [], compactionCutoffOrdinal: 1, compactionCutoffEventId: 'boundary',
    recentTail: [{ communicationEventId: 'boundary', contentSha256: 'a'.repeat(64) }],
    scopeKey: `conversation:${chat.id}`, conversationId: chat.id };
  return { get store() { return store; }, get coordination() { return coordination; }, input,
    reopen() { store.close(); store = new AgentStore(directory); coordination = new CoordinationV3Store(store.sqlite); },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('low/increasing old usage cannot retire a human refresh; missing occupancy is explicitly unavailable after restart', () => {
  const f = fixture();
  try {
    const { detectedOccupancy: _, ...missing } = f.input;
    const created = f.coordination.requestContextRollover(missing);
    assert.equal(created.rollover.detectedOccupancy, undefined);
    assert.equal(f.store.sqlite.prepare('SELECT detected_occupancy FROM context_rollovers WHERE id=?').get(created.rollover.id).detected_occupancy, null);
    for (const usedTokens of [0, 10000, 11000, 150001]) {
      assert.equal(f.coordination.retireContextRolloverAfterHeadroomRecovery({ agentId: f.input.agentId, providerSessionId: 'old', providerSessionGeneration: 'old', usedTokens }), undefined);
    }
    assert.equal(f.coordination.requestContextRollover(missing).rollover.id, created.rollover.id);
    f.reopen();
    const persisted = f.coordination.contextRollover(created.rollover.id);
    assert.equal(persisted.state, 'requested'); assert.equal(persisted.detectedOccupancy, undefined);
    assert.equal(persisted.replacementSessionId, undefined); assert.equal(persisted.completionReason, undefined);
    assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE kind='context_rollover_handoff'").get().n, 1);
  } finally { f.close(); }
});

test('automatic/human overlap rejects without altering boundary; restored headroom allows a later explicit refresh', () => {
  const f = fixture();
  try {
    const automatic = { ...f.input, triggerKind: 'automatic', detectedOccupancy: 150001 };
    const created = f.coordination.requestContextRollover(automatic);
    assert.throws(() => f.coordination.requestContextRollover(f.input), /context_refresh_already_underway/);
    assert.deepEqual(f.coordination.contextRollover(created.rollover.id), created.rollover);
    for (const invalid of [NaN, Infinity, -1, 1.5, 150001]) assert.equal(f.coordination.retireContextRolloverAfterHeadroomRecovery({ agentId: f.input.agentId, providerSessionId: 'old', providerSessionGeneration: 'old', usedTokens: invalid }), undefined);
    assert.equal(f.coordination.retireContextRolloverAfterHeadroomRecovery({ agentId: f.input.agentId, providerSessionId: 'old', providerSessionGeneration: 'stale', usedTokens: 10000 }), undefined);
    const retired = f.coordination.retireContextRolloverAfterHeadroomRecovery({ agentId: f.input.agentId, providerSessionId: 'old', providerSessionGeneration: 'old', usedTokens: 10000 });
    assert.equal(retired.completionReason, 'headroom_restored'); assert.equal(retired.replacementVerifiedAt, undefined);
    const human = f.coordination.requestContextRollover(f.input);
    assert.equal(human.created, true); assert.equal(human.rollover.triggerKind, 'human'); assert.equal(human.rollover.cycleNumber, 2);
    assert.equal(f.coordination.requestContextRollover(f.input).rollover.id, human.rollover.id);
  } finally { f.close(); }
});

test('automatic retirement requires decreased measured occupancy, not an increasing low count', () => {
  const f = fixture();
  try {
    f.coordination.requestContextRollover({ ...f.input, triggerKind: 'automatic' });
    assert.equal(f.coordination.retireContextRolloverAfterHeadroomRecovery({ agentId: f.input.agentId, providerSessionId: 'old', providerSessionGeneration: 'old', usedTokens: 11000 }), undefined);
    assert.throws(() => f.coordination.requestContextRollover({ ...f.input, triggerKind: 'automatic', detectedOccupancy: undefined }), /measured occupancy/);
  } finally { f.close(); }
});

test('observation migration preserves historical rows, exact provider packets, indexes, triggers and rowids', () => {
  const f = fixture();
  try {
    const c = f.coordination, db = f.store.sqlite;
    const created = c.requestContextRollover({ ...f.input, triggerKind: 'automatic', detectedOccupancy: 150001 });
    const lease = c.leaseNextRun({ workerId: 'disposable' });
    const injection = { injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken };
    c.preparePromptInjection({ ...injection, prompt: 'Historical exact handoff request' });
    c.recordProviderInput({ executionId: lease.runId, schedulerRunId: lease.runId, fencingToken: lease.fencingToken,
      agentId: f.input.agentId, projectId: f.input.projectId, prompt: 'Historical exact packet', systemPrompt: 'Historical policy',
      sourceManifest: { schemaVersion: 3, historyMessageCount: 0, retainedSessionSourceCount: 0,
        activationIds: lease.activationIds, communicationEventIds: [], artifactIds: [], sources: [], providerSessionDisposition: 'fresh_task' } });
    c.markPromptSubmitted(injection); c.acknowledgePromptInjection(injection); c.completeRun(lease.runId, lease.fencingToken);
    db.prepare("UPDATE context_rollovers SET state='completed', completion_reason='native_compaction' WHERE id=?").run(created.rollover.id);
    db.exec(`CREATE TABLE disposable_rollover_audit (id TEXT);
      CREATE TRIGGER disposable_rollover_trigger AFTER INSERT ON context_rollovers
      BEGIN INSERT INTO disposable_rollover_audit VALUES (NEW.id); END;`);
    const rows = db.prepare('SELECT rowid,* FROM context_rollovers ORDER BY rowid').all();
    const packets = db.prepare('SELECT * FROM provider_inputs').all();
    const dependent = db.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='context_rollovers' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
    // Recreate the exact pre-observation constraints in this private database.
    const oldSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='context_rollovers'").get().sql
      .replace(/^CREATE TABLE "?context_rollovers"?/, 'CREATE TABLE context_rollovers_previous')
      .replace('detected_occupancy INTEGER CHECK', 'detected_occupancy INTEGER NOT NULL CHECK')
      .replace(", 'headroom_restored'", '');
    db.exec(oldSchema);
    db.exec('INSERT INTO context_rollovers_previous SELECT * FROM context_rollovers; DROP TABLE context_rollovers; ALTER TABLE context_rollovers_previous RENAME TO context_rollovers');
    for (const entry of dependent) db.exec(entry.sql);
    db.prepare("DELETE FROM _schema_version WHERE name='0021_context_rollover_observations.ts'").run();
    f.reopen();
    assert.deepEqual(f.store.sqlite.prepare('SELECT rowid,* FROM context_rollovers ORDER BY rowid').all(), rows);
    assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM provider_inputs').all(), packets);
    assert.deepEqual(f.store.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='context_rollovers' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all(), dependent);
    assert.equal(f.coordination.contextRollover(created.rollover.id).completionReason, 'native_compaction');
    const { detectedOccupancy: _, ...missing } = f.input;
    const next = f.coordination.requestContextRollover(missing);
    assert.equal(next.rollover.detectedOccupancy, undefined);
    assert.deepEqual(f.store.sqlite.prepare('SELECT id FROM disposable_rollover_audit').all(), [{ id: next.rollover.id }]);
    f.reopen();
    assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM provider_inputs').all(), packets);
  } finally { f.close(); }
});
