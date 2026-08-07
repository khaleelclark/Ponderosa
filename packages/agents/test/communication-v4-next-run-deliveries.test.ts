import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoordinationV3Store } from "../src/coordination-v3-store.js";
import { openDb, type OpenedDb } from "../src/db.js";

let opened: OpenedDb;
let store: CoordinationV3Store;
let projectId: string;
let conversationId: string;
let publisherId: string;
let recipientId: string;

beforeEach(() => {
  opened = openDb(":memory:");
  store = new CoordinationV3Store(opened.client);
  projectId = randomUUID();
  conversationId = randomUUID();
  publisherId = randomUUID();
  recipientId = randomUUID();
  opened.client.prepare(`
    INSERT INTO projects (id, label, host_path, created_at, default_engine)
    VALUES (?, 'V4 research', '/repo', '2026-08-06T00:00:00.000Z', 'codex')
  `).run(projectId);
  opened.client.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived)
    VALUES (?, ?, 'Delivery lab', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z', 0)
  `).run(conversationId, projectId);
  const insertAgent = opened.client.prepare(`
    INSERT INTO agents (id, project_id, title, active_engine, created_at, updated_at, archived)
    VALUES (?, ?, ?, 'codex', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z', 0)
  `);
  insertAgent.run(publisherId, projectId, "Publisher");
  insertAgent.run(recipientId, projectId, "Recipient");
  const membership = opened.client.prepare(`
    INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
    VALUES (?, ?, 0)
  `);
  membership.run(publisherId, conversationId);
  membership.run(recipientId, conversationId);
});

afterEach(() => opened.client.close());

function leaseFor(agentId: string, messageId: string) {
  store.enqueueMessageActivation({
    projectId,
    agentId,
    scopeKey: `conversation:${conversationId}`,
    messageId,
    kind: "ordinary",
    payload: { text: "Authorized next-run delivery work" },
  });
  const lease = store.leaseNextRun({ workerId: `worker:${agentId}` });
  expect(lease?.agentId).toBe(agentId);
  return lease!;
}

function acknowledgeLease(lease: ReturnType<typeof leaseFor>): void {
  store.preparePromptInjection({
    injectionId: lease.injectionId,
    runId: lease.runId,
    fencingToken: lease.fencingToken,
    prompt: "Next-run-delivery-aware provider input",
  });
  store.markRunStarted(lease.runId, lease.fencingToken);
  store.markPromptSubmitted({
    injectionId: lease.injectionId,
    runId: lease.runId,
    fencingToken: lease.fencingToken,
    providerSessionId: "next-run-delivery-test-session",
  });
  store.acknowledgePromptInjection({
    injectionId: lease.injectionId,
    runId: lease.runId,
    fencingToken: lease.fencingToken,
    providerSessionId: "next-run-delivery-test-session",
    providerTurnId: `turn:${lease.runId}`,
  });
}

function publishInput(lease: ReturnType<typeof leaseFor>, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    conversationId,
    publisherAgentId: publisherId,
    sourceRunId: lease.runId,
    runAuthorization: {
      runId: lease.runId,
      agentId: publisherId,
      fencingToken: lease.fencingToken,
    },
    idempotencyKey: "delivery-1",
    text: "Authentication review found one material constraint.",
    recipientAgentIds: [recipientId],
    now: "2026-08-06T00:00:01.000Z",
    ...overrides,
  };
}

describe("Communication V4 next-run deliveries", () => {
  it("publishes operator-authored targeted next-run delivery without Activation or obligation", () => {
    const result = store.publishOperatorNextRunDelivery({
      projectId,
      conversationId,
      publisherUserId: "local-operator",
      publisherLabel: "Operator",
      idempotencyKey: "operator-targeted-1",
      text: "Use this passive input on your next run.",
      recipientAgentIds: [recipientId],
      now: "2026-08-06T00:00:01.000Z",
    });

    expect(result).toMatchObject({ replayed: false });
    expect(store.pendingCommunicationV4NextRunDeliveries({
      projectId,
      conversationId,
      agentId: recipientId,
    })).toEqual([result.delivery]);
    expect(store.operatorNextRunDeliveryReceipts({
      projectId,
      conversationId,
      publisherUserId: "local-operator",
    })).toEqual([expect.objectContaining({
      deliveryId: result.delivery.id,
      text: "Use this passive input on your next run.",
      recipients: [expect.objectContaining({
        agentId: recipientId,
        agentTitle: "Recipient",
        state: "pending",
      })],
    })]);
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM coordination_requests").get())
      .toEqual({ count: 0 });
    expect(opened.client.prepare("SELECT COUNT(*) AS count FROM agent_activations").get())
      .toEqual({ count: 0 });
    expect(store.publishOperatorNextRunDelivery({
      projectId,
      conversationId,
      publisherUserId: "local-operator",
      publisherLabel: "Operator",
      idempotencyKey: "operator-targeted-1",
      text: "Use this passive input on your next run.",
      recipientAgentIds: [recipientId],
      now: "2026-08-06T00:00:02.000Z",
    })).toMatchObject({ replayed: true, delivery: { id: result.delivery.id } });
  });

  it("expires operator-authored next-run deliveries transactionally and exposes the receipt", () => {
    const result = store.publishOperatorNextRunDelivery({
      projectId,
      conversationId,
      publisherUserId: "local-operator",
      publisherLabel: "Operator",
      idempotencyKey: "operator-targeted-expiry",
      text: "Use this only before the delivery deadline.",
      recipientAgentIds: [recipientId],
      expiresAt: "2026-08-06T00:00:10.000Z",
      now: "2026-08-06T00:00:01.000Z",
    });

    expect(store.operatorNextRunDeliveryReceipts({
      projectId,
      conversationId,
      publisherUserId: "local-operator",
      now: "2026-08-06T00:00:10.000Z",
    })).toEqual([expect.objectContaining({
      deliveryId: result.delivery.id,
      expiresAt: "2026-08-06T00:00:10.000Z",
      recipients: [expect.objectContaining({
        agentId: recipientId,
        state: "expired",
        settledAt: "2026-08-06T00:00:10.000Z",
      })],
    })]);
  });

  it("rejects invalid operator recipients without partial delivery state", () => {
    opened.client.prepare(`
      DELETE FROM agent_conversation_memberships
      WHERE agent_id = ? AND conversation_id = ?
    `).run(recipientId, conversationId);

    expect(() => store.publishOperatorNextRunDelivery({
      projectId,
      conversationId,
      publisherUserId: "local-operator",
      publisherLabel: "Operator",
      idempotencyKey: "operator-invalid-recipient",
      text: "This must not be partially committed.",
      recipientAgentIds: [recipientId],
      now: "2026-08-06T00:00:01.000Z",
    })).toThrow("every next_run recipient must be an active Agent in this Team Chat");
    expect(opened.client.prepare(
      "SELECT COUNT(*) AS count FROM communication_v4_next_run_deliveries",
    ).get()).toEqual({ count: 0 });
    expect(opened.client.prepare(
      "SELECT COUNT(*) AS count FROM communication_v4_next_run_recipients",
    ).get()).toEqual({ count: 0 });
  });

  it("replays the same publication exactly and rejects conflicting reuse", () => {
    const lease = leaseFor(publisherId, "publish-replay");
    const input = publishInput(lease);
    const first = store.publishAgentNextRunDelivery(input);
    const replay = store.publishAgentNextRunDelivery(input);

    expect(replay).toEqual({ ...first, replayed: true });
    expect(() => store.publishAgentNextRunDelivery({
      ...input,
      text: "Different material under the same idempotency key.",
    })).toThrow("next_run idempotency conflict");
  });

  it("omits expired next-run state", () => {
    const lease = leaseFor(publisherId, "publish-expiring-state");
    const nextRun = store.publishAgentNextRunDelivery(publishInput(lease, {
      idempotencyKey: "expiring-next-run",
      recipientAgentIds: [recipientId],
      expiresAt: "2026-08-06T00:00:10.000Z",
    }));
    expect(store.pendingCommunicationV4NextRunDeliveries({
      projectId,
      conversationId,
      agentId: recipientId,
      now: "2026-08-06T00:00:09.000Z",
    })).toEqual([nextRun.delivery]);
    expect(store.pendingCommunicationV4NextRunDeliveries({
      projectId,
      conversationId,
      agentId: recipientId,
      now: "2026-08-06T00:00:10.000Z",
    })).toEqual([]);
    expect(opened.client.prepare(`
      SELECT state, expired_at AS expiredAt
      FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(nextRun.delivery.id, recipientId)).toEqual({
      state: "expired",
      expiredAt: "2026-08-06T00:00:10.000Z",
    });
  });

  it("keeps next-run delivery pending until the exact provider input is durable", () => {
    const publisherLease = leaseFor(publisherId, "publish-next-run");
    const result = store.publishAgentNextRunDelivery(publishInput(publisherLease, {
      recipientAgentIds: [recipientId],
    }));
    expect(store.pendingCommunicationV4NextRunDeliveries({
      projectId,
      conversationId,
      agentId: recipientId,
    })).toEqual([result.delivery]);
    expect(store.markCommunicationV4NextRunDeliveriesDelivered({
      projectId,
      conversationId,
      agentId: recipientId,
      runId: "missing-provider-input",
      deliveryIds: [result.delivery.id],
    })).toBe(0);

    expect(store.cancelAgentRun({
      agentId: publisherId,
      expectedRunId: publisherLease.runId,
      idempotencyKey: "finish-publisher-run",
    }).cancelled).toBe(true);
    const recipientLease = leaseFor(recipientId, "recipient-normal-work");
    acknowledgeLease(recipientLease);
    store.recordProviderInput({
      executionId: "recipient-execution",
      schedulerRunId: recipientLease.runId,
      fencingToken: recipientLease.fencingToken,
      agentId: recipientId,
      projectId,
      prompt: "Normal work plus the pending V4 next-run delivery",
      sourceManifest: {
        schemaVersion: 1,
        historyMessageCount: 0,
        activationIds: recipientLease.activationIds,
        communicationEventIds: [],
        artifactIds: [],
        providerSessionDisposition: "fresh_task",
        sources: [{
          kind: "context_reference",
          ref: `ponderosa://next-run-delivery/${result.delivery.id}`,
        }],
      },
    });
    expect(store.markCommunicationV4NextRunDeliveriesDelivered({
      projectId,
      conversationId,
      agentId: recipientId,
      runId: "recipient-execution",
      deliveryIds: [result.delivery.id],
    })).toBe(0);
    store.completeRun(recipientLease.runId, recipientLease.fencingToken);
    expect(store.markCommunicationV4NextRunDeliveriesDelivered({
      projectId,
      conversationId,
      agentId: recipientId,
      runId: "recipient-execution",
      deliveryIds: [result.delivery.id],
    })).toBe(1);
    expect(store.pendingCommunicationV4NextRunDeliveries({
      projectId,
      conversationId,
      agentId: recipientId,
    })).toEqual([]);
    expect(opened.client.prepare(`
      SELECT state, delivered_run_id AS deliveredRunId
      FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(result.delivery.id, recipientId)).toEqual({
      state: "delivered",
      deliveredRunId: recipientLease.runId,
    });
  });

  it("does not expire a next-run delivery manifested into an active recipient Run", () => {
    const publisherLease = leaseFor(publisherId, "publish-before-in-flight-expiry");
    const result = store.publishAgentNextRunDelivery(publishInput(publisherLease, {
      idempotencyKey: "in-flight-expiry",
      recipientAgentIds: [recipientId],
      expiresAt: "2026-08-06T00:00:10.000Z",
    }));
    expect(store.cancelAgentRun({
      agentId: publisherId,
      expectedRunId: publisherLease.runId,
      idempotencyKey: "finish-publisher-before-in-flight-expiry",
    }).cancelled).toBe(true);

    const recipientLease = leaseFor(recipientId, "recipient-in-flight-expiry-work");
    acknowledgeLease(recipientLease);
    store.recordProviderInput({
      executionId: "in-flight-expiry-execution",
      schedulerRunId: recipientLease.runId,
      fencingToken: recipientLease.fencingToken,
      agentId: recipientId,
      projectId,
      prompt: "Active work containing expiring V4 next-run delivery",
      sourceManifest: {
        schemaVersion: 1,
        historyMessageCount: 0,
        activationIds: recipientLease.activationIds,
        communicationEventIds: [],
        artifactIds: [],
        providerSessionDisposition: "fresh_task",
        sources: [{
          kind: "context_reference",
          ref: `ponderosa://next-run-delivery/${result.delivery.id}`,
        }],
      },
    });

    expect(store.maintainCommunicationV4NextRunDeliveries(
      "2026-08-06T00:00:11.000Z",
    )).toEqual({ reconciled: 0, expired: 0, pruned: 0 });
    expect(opened.client.prepare(`
      SELECT state, expired_at AS expiredAt
      FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(result.delivery.id, recipientId)).toEqual({
      state: "pending",
      expiredAt: null,
    });

    store.completeRun(
      recipientLease.runId,
      recipientLease.fencingToken,
      "2026-08-06T00:00:20.000Z",
    );
    expect(store.maintainCommunicationV4NextRunDeliveries(
      "2026-08-06T00:00:21.000Z",
    )).toEqual({ reconciled: 1, expired: 0, pruned: 0 });
    expect(opened.client.prepare(`
      SELECT state, delivered_run_id AS deliveredRunId,
        delivered_at AS deliveredAt, expired_at AS expiredAt
      FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(result.delivery.id, recipientId)).toEqual({
      state: "delivered",
      deliveredRunId: recipientLease.runId,
      deliveredAt: "2026-08-06T00:00:20.000Z",
      expiredAt: null,
    });
  });

  it("does not consume next-run state when its recipient Run is cancelled", () => {
    const publisherLease = leaseFor(publisherId, "publish-before-recipient-cancel");
    const result = store.publishAgentNextRunDelivery(publishInput(publisherLease, {
      recipientAgentIds: [recipientId],
      expiresAt: "2099-08-06T00:00:10.000Z",
    }));
    expect(store.cancelAgentRun({
      agentId: publisherId,
      expectedRunId: publisherLease.runId,
      idempotencyKey: "finish-publisher-before-recipient-cancel",
    }).cancelled).toBe(true);
    const recipientLease = leaseFor(recipientId, "recipient-cancelled-work");
    acknowledgeLease(recipientLease);
    store.recordProviderInput({
      executionId: "cancelled-recipient-execution",
      schedulerRunId: recipientLease.runId,
      fencingToken: recipientLease.fencingToken,
      agentId: recipientId,
      projectId,
      prompt: "Cancelled work containing V4 next-run delivery",
      sourceManifest: {
        schemaVersion: 1,
        historyMessageCount: 0,
        activationIds: recipientLease.activationIds,
        communicationEventIds: [],
        artifactIds: [],
        providerSessionDisposition: "fresh_task",
        sources: [{ kind: "context_reference", ref: `ponderosa://next-run-delivery/${result.delivery.id}` }],
      },
    });
    expect(store.cancelAgentRun({
      agentId: recipientId,
      expectedRunId: recipientLease.runId,
      idempotencyKey: "cancel-recipient-run",
    }).cancelled).toBe(true);
    expect(store.markCommunicationV4NextRunDeliveriesDelivered({
      projectId,
      conversationId,
      agentId: recipientId,
      runId: "cancelled-recipient-execution",
      deliveryIds: [result.delivery.id],
    })).toBe(0);
    expect(store.pendingCommunicationV4NextRunDeliveries({
      projectId,
      conversationId,
      agentId: recipientId,
    })).toEqual([result.delivery]);
    expect(store.maintainCommunicationV4NextRunDeliveries(
      "2099-08-06T00:00:10.000Z",
    )).toEqual({ reconciled: 0, expired: 1, pruned: 0 });
    expect(opened.client.prepare(`
      SELECT state, expired_at AS expiredAt
      FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(result.delivery.id, recipientId)).toEqual({
      state: "expired",
      expiredAt: "2099-08-06T00:00:10.000Z",
    });
  });

  it("reconciles a completed manifest after authority restart and stores the scheduler Run ID", () => {
    const publisherLease = leaseFor(publisherId, "publish-before-reconciliation");
    const result = store.publishAgentNextRunDelivery(publishInput(publisherLease, {
      recipientAgentIds: [recipientId],
    }));
    expect(store.cancelAgentRun({
      agentId: publisherId,
      expectedRunId: publisherLease.runId,
      idempotencyKey: "finish-publisher-before-reconciliation",
    }).cancelled).toBe(true);
    const recipientLease = leaseFor(recipientId, "recipient-reconciliation-work");
    acknowledgeLease(recipientLease);
    store.recordProviderInput({
      executionId: "reconciled-provider-execution",
      schedulerRunId: recipientLease.runId,
      fencingToken: recipientLease.fencingToken,
      agentId: recipientId,
      projectId,
      prompt: "Completed work containing durable V4 next-run delivery",
      sourceManifest: {
        schemaVersion: 1,
        historyMessageCount: 0,
        activationIds: recipientLease.activationIds,
        communicationEventIds: [],
        artifactIds: [],
        providerSessionDisposition: "fresh_task",
        sources: [{
          kind: "context_reference",
          ref: `ponderosa://next-run-delivery/${result.delivery.id}`,
        }],
      },
    });
    store.completeRun(recipientLease.runId, recipientLease.fencingToken,
      "2026-08-06T00:00:20.000Z");

    store = new CoordinationV3Store(opened.client);

    expect(opened.client.prepare(`
      SELECT state, delivered_run_id AS deliveredRunId,
        delivered_at AS deliveredAt
      FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(result.delivery.id, recipientId)).toEqual({
      state: "delivered",
      deliveredRunId: recipientLease.runId,
      deliveredAt: "2026-08-06T00:00:20.000Z",
    });
    expect(store.pendingCommunicationV4NextRunDeliveries({
      projectId,
      conversationId,
      agentId: recipientId,
    })).toEqual([]);
  });

  it("retains settled state for 30 days, then prunes it deterministically", () => {
    const lease = leaseFor(publisherId, "publish-retained-state");
    const nextRun = store.publishAgentNextRunDelivery(publishInput(lease, {
      idempotencyKey: "retained-next-run",
      recipientAgentIds: [recipientId],
      expiresAt: "2026-08-06T00:00:10.000Z",
    }));
    expect(store.maintainCommunicationV4NextRunDeliveries(
      "2026-08-06T00:00:10.000Z",
    )).toEqual({ reconciled: 0, expired: 1, pruned: 0 });
    expect(store.communicationV4NextRunDelivery(nextRun.delivery.id)).toBeDefined();

    expect(store.maintainCommunicationV4NextRunDeliveries(
      "2026-09-06T00:00:11.000Z",
    )).toEqual({ reconciled: 0, expired: 0, pruned: 1 });
    expect(store.communicationV4NextRunDelivery(nextRun.delivery.id)).toBeUndefined();
  });

  it("fails closed before exceeding pending-delivery or retained-delivery quotas", () => {
    const lease = leaseFor(publisherId, "publish-at-quota");
    const insertNextRunDelivery = opened.client.prepare(`
      INSERT INTO communication_v4_next_run_deliveries (
        id, project_id, conversation_id, publisher_kind, publisher_agent_id,
        publisher_user_id, publisher_label,
        source_run_id, idempotency_key, payload_hash, text,
        recipient_agent_ids_json, created_at
      ) VALUES (?, ?, ?, 'agent', ?, NULL, 'Publisher', ?, ?, ?, 'bounded',
        ?, '2026-08-06T00:00:00.000Z')
    `);
    const insertDelivery = opened.client.prepare(`
      INSERT INTO communication_v4_next_run_recipients (
        delivery_id, agent_id, recipient_label, state, created_at
      ) VALUES (?, ?, 'Recipient', 'pending', '2026-08-06T00:00:00.000Z')
    `);
    opened.client.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        const deliveryId = `quota-delivery-${index}`;
        insertNextRunDelivery.run(
          deliveryId,
          projectId,
          conversationId,
          publisherId,
          `quota-run-${index}`,
          `quota-key-${index}`,
          `quota-hash-${index}`,
          JSON.stringify([recipientId]),
        );
        insertDelivery.run(deliveryId, recipientId);
      }
    })();

    expect(() => store.publishAgentNextRunDelivery(publishInput(lease, {
      idempotencyKey: "quota-overflow",
      recipientAgentIds: [recipientId],
    }))).toThrow("next-run pending-recipient quota exceeded (1000 per Project)");
    expect(opened.client.prepare(`
      SELECT COUNT(*) AS count FROM communication_v4_next_run_deliveries
      WHERE idempotency_key = 'quota-overflow'
    `).get()).toEqual({ count: 0 });

    opened.client.prepare("DELETE FROM communication_v4_next_run_recipients").run();
    opened.client.prepare("DELETE FROM communication_v4_next_run_deliveries").run();
    const insertRetained = opened.client.prepare(`
      INSERT INTO communication_v4_next_run_deliveries (
        id, project_id, conversation_id, publisher_kind, publisher_agent_id,
        publisher_user_id, publisher_label,
        source_run_id, idempotency_key, payload_hash, text,
        recipient_agent_ids_json, created_at
      ) VALUES (?, ?, ?, 'agent', ?, NULL, 'Publisher', ?, ?, ?, 'bounded',
        ?, '2026-08-06T00:00:00.000Z')
    `);
    const insertSettledRecipient = opened.client.prepare(`
      INSERT INTO communication_v4_next_run_recipients (
        delivery_id, agent_id, recipient_label, state, created_at, delivered_at
      ) VALUES (?, ?, 'Recipient', 'delivered',
        '2026-08-06T00:00:00.000Z', '2026-08-06T00:01:00.000Z')
    `);
    opened.client.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const deliveryId = `retained-delivery-${index}`;
        insertRetained.run(
          deliveryId,
          projectId,
          conversationId,
          publisherId,
          `retained-run-${index}`,
          `retained-key-${index}`,
          `retained-hash-${index}`,
          JSON.stringify([recipientId]),
        );
        insertSettledRecipient.run(deliveryId, recipientId);
      }
    })();
    expect(() => store.publishAgentNextRunDelivery(publishInput(lease, {
      idempotencyKey: "retained-overflow",
    }))).toThrow("next-run Project quota reached (10000 retained deliveries)");
  });

  it("survives deletion of rebuildable Project, Team Chat, and Agent projections", () => {
    const lease = leaseFor(publisherId, "publish-before-projection-rebuild");
    const result = store.publishAgentNextRunDelivery(publishInput(lease, {
      recipientAgentIds: [recipientId],
    }));

    // Startup projection rebuilds replace these rows from canonical files.
    // delivery authority must not cascade with their temporary deletion.
    opened.client.prepare("DELETE FROM projects WHERE id = ?").run(projectId);

    expect(opened.client.prepare(`
      SELECT id FROM communication_v4_next_run_deliveries WHERE id = ?
    `).get(result.delivery.id)).toEqual({ id: result.delivery.id });
    expect(opened.client.prepare(`
      SELECT state FROM communication_v4_next_run_recipients
      WHERE delivery_id = ? AND agent_id = ?
    `).get(result.delivery.id, recipientId)).toEqual({ state: "pending" });
  });

  it("explicitly cleans delivery state at Agent, Team Chat, and Project deletion boundaries", () => {
    const lease = leaseFor(publisherId, "publish-before-explicit-cleanup");
    const first = store.publishAgentNextRunDelivery(publishInput(lease, {
      recipientAgentIds: [recipientId],
    }));
    const operator = store.publishOperatorNextRunDelivery({
      projectId,
      conversationId,
      publisherUserId: "local-operator",
      publisherLabel: "Operator",
      idempotencyKey: "operator-before-agent-delete",
      text: "Preserve the intended recipient in the durable receipt.",
      recipientAgentIds: [recipientId],
    });
    store.handleAgentDeletion(recipientId, "2026-08-06T00:00:02.000Z");
    expect(opened.client.prepare(`
      SELECT state, unavailable_reason AS reason
      FROM communication_v4_next_run_recipients
      WHERE agent_id = ?
    `).get(recipientId)).toEqual({
      state: "unavailable",
      reason: "recipient Agent was deleted",
    });
    expect(store.communicationV4NextRunDelivery(first.delivery.id)).toBeDefined();
    expect(store.operatorNextRunDeliveryReceipts({
      projectId,
      conversationId,
      publisherUserId: "local-operator",
    })).toEqual([expect.objectContaining({
      deliveryId: operator.delivery.id,
      recipients: [expect.objectContaining({
        agentId: recipientId,
        agentTitle: "Recipient",
        state: "unavailable",
      })],
    })]);
    const replacementId = randomUUID();
    opened.client.prepare(`
      INSERT INTO agents (id, project_id, title, active_engine, created_at, updated_at, archived)
      VALUES (?, ?, 'Replacement', 'codex', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z', 0)
    `).run(replacementId, projectId);
    opened.client.prepare(`
      INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
      VALUES (?, ?, 1)
    `).run(replacementId, conversationId);
    const chatDelivery = store.publishAgentNextRunDelivery(publishInput(lease, {
      idempotencyKey: "next-run-before-chat-delete",
      recipientAgentIds: [replacementId],
    }));
    store.purgeCommunicationV4Conversation(conversationId);
    expect(store.communicationV4NextRunDelivery(chatDelivery.delivery.id)).toBeUndefined();

    const projectDelivery = store.publishAgentNextRunDelivery(publishInput(lease, {
      idempotencyKey: "next-run-before-project-delete",
      recipientAgentIds: [replacementId],
    }));
    store.purgeProject(projectId);
    expect(store.communicationV4NextRunDelivery(projectDelivery.delivery.id)).toBeUndefined();
  });

  it("rejects cross-Chat recipients even inside the same Project", () => {
    const otherConversationId = randomUUID();
    opened.client.prepare(`
      INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived)
      VALUES (?, ?, 'Other', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z', 0)
    `).run(otherConversationId, projectId);
    opened.client.prepare(`
      DELETE FROM agent_conversation_memberships WHERE agent_id = ? AND conversation_id = ?
    `).run(recipientId, conversationId);
    opened.client.prepare(`
      INSERT INTO agent_conversation_memberships (agent_id, conversation_id, position)
      VALUES (?, ?, 0)
    `).run(recipientId, otherConversationId);
    const lease = leaseFor(publisherId, "publish-cross-chat");

    expect(() => store.publishAgentNextRunDelivery(publishInput(lease, {
      recipientAgentIds: [recipientId],
    }))).toThrow("every next_run recipient must be an active Agent in this Team Chat");
  });

});
