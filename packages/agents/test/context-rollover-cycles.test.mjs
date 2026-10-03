import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, CoordinationV3Store } from "../dist/index.js";

test("headroom recovery permits a later rollover in the same provider session without claiming native compaction", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-rollover-cycle-"));
  const store = new AgentStore(directory);
  try {
    const coordination = new CoordinationV3Store(store.sqlite);
    const project = store.createProject({ label: "Isolated", hostPath: directory, defaultEngine: "codex" });
    const conversation = store.createConversation(project.id, { title: "Test" });
    const agent = store.createAgent(project.id, { title: "Test", engine: "codex", conversationId: conversation.id });
    const request = (ordinal, runId) => ({
      projectId: project.id, agentId: agent.id, oldProviderSessionId: "same-provider-session",
      providerSessionGeneration: "same-provider-session", detectedOccupancy: 150001,
      threshold: 150000, lowWaterMark: 75000, sourceRunId: runId,
      compactionCutoffOrdinal: ordinal, compactionCutoffEventId: `boundary-${ordinal}`,
      recentTail: [{ communicationEventId: `boundary-${ordinal}`, contentSha256: "a".repeat(64) }],
      sourceActivationIds: [], scopeKey: `conversation:${conversation.id}`, conversationId: conversation.id,
    });
    const firstInput = request(1, "run-one");
    const first = coordination.requestContextRollover(firstInput);
    assert.equal(first.created, true);
    assert.equal(coordination.requestContextRollover(firstInput).rollover.id, first.rollover.id);
    const compacted = coordination.retireContextRolloverAfterHeadroomRecovery({
      agentId: agent.id, providerSessionGeneration: "same-provider-session",
      providerSessionId: "same-provider-session", usedTokens: 50000,
    });
    assert.equal(compacted?.state, "completed");
    assert.equal(compacted?.completionReason, "headroom_restored");
    assert.equal(compacted?.cycleNumber, 1);
    const secondInput = request(2, "run-two");
    const second = coordination.requestContextRollover(secondInput);
    assert.equal(second.created, true);
    assert.notEqual(second.rollover.id, first.rollover.id);
    assert.equal(second.rollover.cycleNumber, 2);
    assert.equal(coordination.requestContextRollover(secondInput).rollover.id, second.rollover.id);
    assert.equal(coordination.requestContextRollover(firstInput).rollover.id, first.rollover.id);
    assert.throws(() => coordination.requestContextRollover({ ...secondInput, recentTail: [{ ...secondInput.recentTail[0], contentSha256: "b".repeat(64) }] }), /replay conflicts/);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM context_rollovers").get().count, 2);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_activations WHERE kind = 'context_rollover_handoff'").get().count, 2);
    const lease = coordination.leaseNextRun({ workerId: "isolated-worker" });
    assert.equal(lease?.agentId, agent.id);
    assert.equal(lease?.activations[0]?.kind, "context_rollover_handoff");
    coordination.preparePromptInjection({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken, prompt: "isolated handoff" });
    coordination.markPromptSubmitted({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken });
    coordination.acknowledgePromptInjection({ injectionId: lease.injectionId, runId: lease.runId, fencingToken: lease.fencingToken });
    coordination.completeRun(lease.runId, lease.fencingToken);
    assert.equal(store.sqlite.prepare("SELECT status FROM scheduler_runs WHERE id = ?").get(lease.runId).status, "completed");
    assert.equal(store.sqlite.prepare("SELECT state FROM agent_activations WHERE id = ?").get(lease.activationIds[0]).state, "consumed");
    assert.equal(coordination.activeRunCount(), 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart and repeated pressure do not create another handoff in the active cycle", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-rollover-restart-"));
  let store = new AgentStore(directory);
  try {
    const project = store.createProject({ label: "Isolated", hostPath: directory, defaultEngine: "codex" });
    const conversation = store.createConversation(project.id, { title: "Test" });
    const agent = store.createAgent(project.id, { title: "Test", engine: "codex", conversationId: conversation.id });
    const input = ordinal => ({
      projectId: project.id, agentId: agent.id, oldProviderSessionId: "provider-one", providerSessionGeneration: "provider-one",
      detectedOccupancy: 150001, threshold: 150000, lowWaterMark: 75000, sourceRunId: `run-${ordinal}`,
      compactionCutoffOrdinal: ordinal, compactionCutoffEventId: `event-${ordinal}`,
      recentTail: [{ communicationEventId: `event-${ordinal}`, contentSha256: "c".repeat(64) }],
      sourceActivationIds: [], scopeKey: `conversation:${conversation.id}`, conversationId: conversation.id,
    });
    const first = new CoordinationV3Store(store.sqlite).requestContextRollover(input(1));
    new CoordinationV3Store(store.sqlite).retireContextRolloverAfterHeadroomRecovery({
      agentId: agent.id, providerSessionGeneration: "provider-one", providerSessionId: "provider-one", usedTokens: 50000,
    });
    store.close();
    store = new AgentStore(directory);
    const coordination = new CoordinationV3Store(store.sqlite);
    const second = coordination.requestContextRollover(input(2));
    assert.equal(second.created, true);
    assert.equal(coordination.requestContextRollover(input(1)).rollover.id, first.rollover.id);
    assert.equal(coordination.requestContextRollover(input(2)).rollover.id, second.rollover.id);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM context_rollovers").get().count, 2);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_activations WHERE kind = 'context_rollover_handoff'").get().count, 2);
    coordination.failContextRollover(second.rollover.id, "failed", "test failure", "internal");
    assert.equal(store.sqlite.prepare("SELECT state FROM agent_activations WHERE id IN (SELECT activation_id FROM activation_sources WHERE source_id = ?) LIMIT 1").get(second.rollover.id).state, "cancelled");
    const blocked = coordination.requestContextRollover(input(3));
    assert.equal(blocked.created, false);
    assert.equal(blocked.rollover.id, second.rollover.id);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM context_rollovers").get().count, 2);
    const humanRetry = coordination.requestContextRollover({ ...input(3), triggerKind: "human" });
    assert.equal(humanRetry.created, true, "a human can retry before a handoff is durable");
    assert.equal(humanRetry.rollover.cycleNumber, 3);
    coordination.failContextRollover(humanRetry.rollover.id, "outcome_unknown", "test uncertainty", "internal");
    store.sqlite.prepare("UPDATE context_rollovers SET handoff_event_id = ? WHERE id = ?")
      .run("durable-handoff", humanRetry.rollover.id);
    const fenced = coordination.requestContextRollover({ ...input(4), triggerKind: "human" });
    assert.equal(fenced.created, false, "a durable handoff cannot be retried automatically or manually");
    assert.equal(fenced.rollover.id, humanRetry.rollover.id);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM context_rollovers").get().count, 3);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration preserves a completed native-compaction record and rekeys its index", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-rollover-migration-"));
  let store = new AgentStore(directory);
  try {
    const project = store.createProject({ label: "Isolated", hostPath: directory, defaultEngine: "codex" });
    const conversation = store.createConversation(project.id, { title: "Test" });
    const agent = store.createAgent(project.id, { title: "Test", engine: "codex", conversationId: conversation.id });
    const input = ordinal => ({
      projectId: project.id, agentId: agent.id, oldProviderSessionId: "provider-one", providerSessionGeneration: "provider-one",
      detectedOccupancy: 150001, threshold: 150000, lowWaterMark: 75000, sourceRunId: `run-${ordinal}`,
      compactionCutoffOrdinal: ordinal, compactionCutoffEventId: `event-${ordinal}`,
      recentTail: [{ communicationEventId: `event-${ordinal}`, contentSha256: "d".repeat(64) }],
      sourceActivationIds: [], scopeKey: `conversation:${conversation.id}`, conversationId: conversation.id,
    });
    const coordination = new CoordinationV3Store(store.sqlite);
    const first = coordination.requestContextRollover(input(1));
    coordination.retireContextRolloverAfterHeadroomRecovery({
      agentId: agent.id, providerSessionGeneration: "provider-one", providerSessionId: "provider-one", usedTokens: 50000,
    });
    // Recreate the previous database shape in this disposable fixture.
    store.sqlite.prepare("UPDATE context_rollovers SET completion_reason = 'native_compaction' WHERE id = ?").run(first.rollover.id);
    store.sqlite.exec(`
      DROP INDEX idx_context_rollovers_generation_cycle;
      ALTER TABLE context_rollovers DROP COLUMN cycle_number;
      CREATE UNIQUE INDEX idx_context_rollovers_generation_owner
        ON context_rollovers (agent_id, provider_session_generation)
        WHERE state IN ('requested','handoff_committed','session_retiring','continuation_ready','completed');
      DELETE FROM _schema_version WHERE name = '0020_context_rollover_cycles.ts';
    `);
    store.close();
    store = new AgentStore(directory);
    const migrated = new CoordinationV3Store(store.sqlite);
    assert.equal(migrated.contextRollover(first.rollover.id)?.completionReason, "native_compaction");
    assert.equal(migrated.contextRollover(first.rollover.id)?.cycleNumber, 1);
    assert.equal(migrated.requestContextRollover(input(2)).rollover.cycleNumber, 2);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM context_rollovers").get().count, 2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("human retry of a failed latest cycle works when the boundary is unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-rollover-same-boundary-retry-"));
  const store = new AgentStore(directory);
  try {
    const project = store.createProject({ label: "Isolated", hostPath: directory, defaultEngine: "codex" });
    const conversation = store.createConversation(project.id, { title: "Test" });
    const agent = store.createAgent(project.id, { title: "Test", engine: "codex", conversationId: conversation.id });
    const coordination = new CoordinationV3Store(store.sqlite);
    const input = {
      projectId: project.id, agentId: agent.id,
      oldProviderSessionId: "same-provider-session", providerSessionGeneration: "same-provider-session",
      detectedOccupancy: 150001, threshold: 150000, lowWaterMark: 75000,
      sourceRunId: "source-run", compactionCutoffOrdinal: 1, compactionCutoffEventId: "event-one",
      recentTail: [{ communicationEventId: "event-one", contentSha256: "e".repeat(64) }],
      sourceActivationIds: [], scopeKey: `conversation:${conversation.id}`, conversationId: conversation.id,
    };
    const failed = coordination.requestContextRollover(input);
    coordination.failContextRollover(failed.rollover.id, "outcome_unknown", "internal failure", "internal");
    assert.equal(coordination.requestContextRollover(input).rollover.id, failed.rollover.id);

    const retry = coordination.requestContextRollover({ ...input, triggerKind: "human" });
    assert.equal(retry.created, true);
    assert.equal(retry.rollover.cycleNumber, 2);
    assert.notEqual(retry.rollover.id, failed.rollover.id);
    assert.equal(coordination.requestContextRollover({ ...input, triggerKind: "human" }).rollover.id, retry.rollover.id);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM context_rollovers").get().count, 2);
    assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_activations WHERE kind = 'context_rollover_handoff'").get().count, 2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
