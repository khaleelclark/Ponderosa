import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import type { MultiAgentDirectMessageResponse } from "@ponderosa/core";
import { AssetStore } from "./assets.js";
import {
  registerConversationDeliveryRoutes,
  type PreparedCommunicationArtifact,
} from "./routes/conversation-deliveries.js";
import {
  applyQueuedMessageChangeOutbox,
  registerQueuedMessageRoutes,
} from "./routes/queued-messages.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function openRouteRuntime(dataDir: string): Promise<{
  app: FastifyInstance;
  store: AgentStore;
  workspace: WorkspaceStore;
  coordinationV3: CoordinationV3Store;
  queuedMessageChanges: unknown[];
  coordinationChanges: unknown[];
  schedulerNotifications: { count: number };
}> {
  const store = new AgentStore(dataDir);
  const workspace = new WorkspaceStore(dataDir);
  const assets = new AssetStore(dataDir);
  const coordinationV3 = new CoordinationV3Store(store.sqlite);
  const queuedMessageChanges: unknown[] = [];
  const coordinationChanges: unknown[] = [];
  const schedulerNotifications = { count: 0 };
  const app = Fastify({ logger: false });
  const runtimeArtifactMetadata = (artifact: PreparedCommunicationArtifact) => ({
    id: artifact.id,
    role: artifact.role,
    title: artifact.title,
    mediaType: artifact.mediaType,
    blobPath: artifact.blobPath,
    blobHash: artifact.blobHash,
    byteLength: artifact.byteLength,
    ...(artifact.originAgentId ? { originAgentId: artifact.originAgentId } : {}),
    ...(artifact.executionId ? { executionId: artifact.executionId } : {}),
  });
  const prepareUserCommunicationText = async (input: { text: string }) => ({
    canonicalText: input.text,
    publishedText: input.text,
  });
  registerConversationDeliveryRoutes(app, {
    store,
    coordinationV3,
    assets,
    projectDeletionInProgress: () => false,
    assetMetadata: async () => undefined,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    recordCommunication: (event) => store.appendCommunicationEvent(event).event,
    reconcileRuntimeCommunicationProjections: async () => 0,
    projectCommunicationArtifact: () => undefined,
    communicationArtifactAccess: (event) => ({
      ownerKind: "communication",
      ownerId: event.eventId,
      audience: event.audience,
    }),
    projectBroadcastToAgentAudits: () => undefined,
    projectCommunicationToAgentAudit: () => undefined,
    appendWorkspace: (event) => workspace.append(event),
    publishCoordinationV3Changed: () => undefined,
    notifyScheduler: () => { schedulerNotifications.count += 1; },
  });
  registerQueuedMessageRoutes(app, {
    store,
    coordinationV3,
    workspace,
    prepareUserCommunicationText,
    runtimeArtifactMetadata,
    appendWorkspace: (event) => {
      queuedMessageChanges.push(event);
      return workspace.append(event);
    },
    publishWorkspaceSince: () => undefined,
    publishCoordinationV3Changed: (agentId, options) => {
      coordinationChanges.push({ agentId, ...options });
    },
    publishMessageDeliveryChanged: () => undefined,
    notifyScheduler: () => { schedulerNotifications.count += 1; },
  });
  await app.ready();
  return {
    app,
    store,
    workspace,
    coordinationV3,
    queuedMessageChanges,
    coordinationChanges,
    schedulerNotifications,
  };
}

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ponderosa-delivery-idempotency-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const hostPath = path.join(root, "workspace");
  mkdirSync(hostPath, { recursive: true });
  const runtime = await openRouteRuntime(dataDir);
  const project = runtime.store.createProject({
    label: "Delivery idempotency",
    hostPath,
    defaultEngine: "codex",
  });
  const conversationId = project.lastConversationId!;
  const agentA = runtime.store.createAgent(project.id, {
    title: "Agent A",
    engine: "codex",
    conversationId,
  });
  const agentB = runtime.store.createAgent(project.id, {
    title: "Agent B",
    engine: "codex",
    conversationId,
  });
  return {
    ...runtime,
    dataDir,
    projectId: project.id,
    conversationId,
    agentAId: agentA.id,
    agentBId: agentB.id,
  };
}

async function restartFixture(input: Awaited<ReturnType<typeof fixture>>) {
  await input.app.close();
  input.store.close();
  const runtime = await openRouteRuntime(input.dataDir);
  return { ...input, ...runtime };
}

async function queueDirectMessage(
  input: Awaited<ReturnType<typeof fixture>>,
  idempotencyKey: string,
  recipientAgentIds: string[],
): Promise<MultiAgentDirectMessageResponse> {
  const response = await input.app.inject({
    method: "POST",
    url: `/api/conversations/${input.conversationId}/direct-messages`,
    payload: {
      text: `Queued ${idempotencyKey}`,
      idempotencyKey,
      activeRunDelivery: "queue",
      recipients: recipientAgentIds.map((agentId) => ({ agentId })),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as MultiAgentDirectMessageResponse;
}

function claimQueuedMessageChange(
  coordinationV3: CoordinationV3Store,
  workerId: string,
) {
  const claimed = coordinationV3.claimOutbox(workerId, 500);
  const change = claimed.find((item) => item.eventKind === "queued_message_change");
  for (const item of claimed) {
    if (item !== change) coordinationV3.completeOutbox(item.id, workerId);
  }
  expect(change).toBeDefined();
  return change!;
}

function removeDeliveryIntakeSchema(
  input: Awaited<ReturnType<typeof fixture>>,
): void {
  input.store.sqlite.transaction(() => {
    input.store.sqlite.exec("DROP TABLE runtime_communication_activation_intake");
    input.store.sqlite.prepare(`
      DELETE FROM _schema_version WHERE name = '0006_delivery_idempotency.sql'
    `).run();
  })();
}

describe("delivery transport idempotency", () => {
  test("replays original ordered delivery IDs after retry, rollover lineage, and restart", async () => {
    let input = await fixture();
    try {
      const first = await queueDirectMessage(input, "multi-recipient", [
        input.agentAId,
        input.agentBId,
      ]);
      const firstIds = new Map(first.recipients.map((recipient) => [
        recipient.agentId,
        recipient.deliveryId,
      ]));
      expect(first.replayed).toBe(false);
      expect([...firstIds.values()].every(Boolean)).toBe(true);

      input.store.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'failed', terminal_outcome = 'permanent_failure', terminal_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        "2026-08-14T00:00:00.000Z",
        "2026-08-14T00:00:00.000Z",
        firstIds.get(input.agentAId),
      );
      const retry = input.coordinationV3.retryMessageDelivery({
        projectId: input.projectId,
        activationId: firstIds.get(input.agentAId)!,
        idempotencyKey: "retry-descendant",
      });
      expect(retry.accepted).toBe(true);

      const communicationId = (input.store.sqlite.prepare(`
        SELECT communication_id
        FROM runtime_communication_activation_intake
        WHERE activation_id = ?
      `).get(firstIds.get(input.agentBId)) as { communication_id: string }).communication_id;
      const rolloverActivationId = randomUUID();
      input.store.sqlite.prepare(`
        INSERT INTO agent_activations (
          id, project_id, agent_id, scope_key, kind, priority, dispatch_policy,
          prompt_class, state, dedupe_key, payload_json, available_at,
          created_at, updated_at
        )
        SELECT ?, project_id, agent_id, scope_key, 'context_rollover_continuation',
          priority, dispatch_policy, prompt_class, 'pending', ?, payload_json,
          available_at, ?, ?
        FROM agent_activations WHERE id = ?
      `).run(
        rolloverActivationId,
        `test-rollover:${rolloverActivationId}`,
        "2026-08-14T00:00:03.000Z",
        "2026-08-14T00:00:03.000Z",
        firstIds.get(input.agentBId),
      );
      input.store.sqlite.prepare(`
        INSERT INTO activation_sources (activation_id, source_kind, source_id)
        VALUES (?, 'communication', ?)
      `).run(rolloverActivationId, communicationId);

      input = await restartFixture(input);

      const replay = await queueDirectMessage(input, "multi-recipient", [
        input.agentAId,
        input.agentBId,
      ]);
      expect(replay.replayed).toBe(true);
      expect(replay.recipients).toEqual(first.recipients);
      expect(replay.recipients.map((recipient) => recipient.agentId)).toEqual([
        input.agentAId,
        input.agentBId,
      ]);
      expect(replay.recipients.map((recipient) => recipient.deliveryId)).not.toContain(
        retry.activationId,
      );
      expect(replay.recipients.map((recipient) => recipient.deliveryId)).not.toContain(
        rolloverActivationId,
      );
      for (const recipient of replay.recipients) {
        expect(input.store.sqlite.prepare(`
          SELECT agent_id FROM agent_activations WHERE id = ?
        `).get(recipient.deliveryId)).toEqual({ agent_id: recipient.agentId });
      }
    } finally {
      await input.app.close();
      input.store.close();
    }
  });

  test("backfills exact original receipts when a pre-0006 database upgrades", async () => {
    let input = await fixture();
    try {
      const first = await queueDirectMessage(input, "pre-0006-replay", [
        input.agentAId,
        input.agentBId,
      ]);
      const firstIds = first.recipients.map((recipient) => recipient.deliveryId!);
      const communicationId = (input.store.sqlite.prepare(`
        SELECT communication_id
        FROM runtime_communication_activation_intake
        WHERE activation_id = ?
      `).get(firstIds[0]) as { communication_id: string }).communication_id;
      input.store.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'failed', terminal_outcome = 'permanent_failure',
          terminal_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        "2026-08-14T00:00:00.000Z",
        "2026-08-14T00:00:00.000Z",
        firstIds[0],
      );
      const retry = input.coordinationV3.retryMessageDelivery({
        projectId: input.projectId,
        activationId: firstIds[0]!,
        idempotencyKey: "pre-0006-retry-descendant",
      });
      expect(retry.accepted).toBe(true);
      const rolloverActivationId = randomUUID();
      input.store.sqlite.prepare(`
        INSERT INTO agent_activations (
          id, project_id, agent_id, scope_key, kind, priority, dispatch_policy,
          prompt_class, state, dedupe_key, payload_json, available_at,
          created_at, updated_at
        )
        SELECT ?, project_id, agent_id, scope_key, 'context_rollover_continuation',
          priority, dispatch_policy, prompt_class, 'pending', ?, payload_json,
          available_at, ?, ?
        FROM agent_activations WHERE id = ?
      `).run(
        rolloverActivationId,
        `test-upgrade-rollover:${rolloverActivationId}`,
        "2026-08-14T00:00:03.000Z",
        "2026-08-14T00:00:03.000Z",
        firstIds[1],
      );
      input.store.sqlite.prepare(`
        INSERT INTO activation_sources (activation_id, source_kind, source_id)
        VALUES (?, 'communication', ?)
      `).run(rolloverActivationId, communicationId);
      const workBefore = input.store.sqlite.prepare(`
        SELECT
          (SELECT COUNT(*) FROM agent_activations) AS activations,
          (SELECT COUNT(*) FROM activation_outbox) AS outbox
      `).get();
      removeDeliveryIntakeSchema(input);

      input = await restartFixture(input);
      expect(input.store.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM runtime_communication_activation_intake
      `).get()).toEqual({ count: 0 });
      expect(input.store.sqlite.prepare(`
        SELECT 1 AS applied FROM _schema_version
        WHERE name = '0006_delivery_idempotency.sql'
      `).get()).toEqual({ applied: 1 });

      const replay = await queueDirectMessage(input, "pre-0006-replay", [
        input.agentAId,
        input.agentBId,
      ]);
      expect(replay.replayed).toBe(true);
      expect(replay.recipients).toEqual(first.recipients);
      expect(replay.recipients.map((recipient) => recipient.deliveryId)).not.toContain(
        retry.activationId,
      );
      expect(replay.recipients.map((recipient) => recipient.deliveryId)).not.toContain(
        rolloverActivationId,
      );
      expect(input.store.sqlite.prepare(`
        SELECT agent_id, activation_id
        FROM runtime_communication_activation_intake
        ORDER BY recipient_index
      `).all()).toEqual(first.recipients.map((recipient) => ({
        agent_id: recipient.agentId,
        activation_id: recipient.deliveryId,
      })));
      expect(input.store.sqlite.prepare(`
        SELECT
          (SELECT COUNT(*) FROM agent_activations) AS activations,
          (SELECT COUNT(*) FROM activation_outbox) AS outbox
      `).get()).toEqual(workBefore);
      expect(input.store.sqlite.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(input.store.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      await input.app.close();
      input.store.close();
    }
  });

  test("rejects duplicate direct-message recipients before canonical intake", async () => {
    const input = await fixture();
    try {
      const response = await input.app.inject({
        method: "POST",
        url: `/api/conversations/${input.conversationId}/direct-messages`,
        payload: {
          text: "Duplicate target",
          idempotencyKey: "duplicate-target",
          recipients: [{ agentId: input.agentAId }, { agentId: input.agentAId }],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "recipient agent IDs must be unique" });
      expect(input.store.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM runtime_communications
      `).get()).toEqual({ count: 0 });
    } finally {
      await input.app.close();
      input.store.close();
    }
  });

  test("keeps agent ownership checks while replaying an exact queued-message cancel", async () => {
    const input = await fixture();
    try {
      const delivery = await queueDirectMessage(input, "cancel-owner", [input.agentAId]);
      const deliveryId = delivery.recipients[0]!.deliveryId!;
      const wrongAgent = await input.app.inject({
        method: "POST",
        url: `/api/agents/${input.agentBId}/queued-messages/${deliveryId}/cancel`,
        payload: { idempotencyKey: "cancel-once" },
      });
      expect(wrongAgent.statusCode).toBe(404);
      expect(input.store.sqlite.prepare(`
        SELECT state FROM agent_activations WHERE id = ?
      `).get(deliveryId)).toEqual({ state: "pending" });

      const first = await input.app.inject({
        method: "POST",
        url: `/api/agents/${input.agentAId}/queued-messages/${deliveryId}/cancel`,
        payload: { idempotencyKey: "cancel-once" },
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({
        cancelled: true,
        replayed: false,
        status: "cancelled",
      });
      const replay = await input.app.inject({
        method: "POST",
        url: `/api/agents/${input.agentAId}/queued-messages/${deliveryId}/cancel`,
        payload: { idempotencyKey: "cancel-once" },
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual({
        cancelled: true,
        replayed: true,
        status: "cancelled",
      });
      expect(input.queuedMessageChanges).toHaveLength(0);
      expect(input.store.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM activation_outbox
        WHERE activation_id = ? AND event_kind = 'queued_message_change'
      `).get(deliveryId)).toEqual({ count: 1 });
    } finally {
      await input.app.close();
      input.store.close();
    }
  });

  test("repairs a failed cancellation workspace invalidation after exact replay and restart", async () => {
    let input = await fixture();
    try {
      const delivery = await queueDirectMessage(input, "cancel-repair", [input.agentAId]);
      const deliveryId = delivery.recipients[0]!.deliveryId!;
      const first = await input.app.inject({
        method: "POST",
        url: `/api/agents/${input.agentAId}/queued-messages/${deliveryId}/cancel`,
        payload: { idempotencyKey: "cancel-repair" },
      });
      expect(first.statusCode, first.body).toBe(200);
      const firstOutbox = claimQueuedMessageChange(input.coordinationV3, "fault-worker");
      expect(() => applyQueuedMessageChangeOutbox(firstOutbox, {
        coordinationV3: input.coordinationV3,
        workspace: input.workspace,
        appendWorkspace: () => { throw new Error("injected workspace append failure"); },
        publishCoordinationV3Changed: () => undefined,
      })).toThrow("injected workspace append failure");
      input.coordinationV3.failOutbox(
        firstOutbox.id,
        "fault-worker",
        "injected workspace append failure",
      );
      input.store.sqlite.prepare(`
        UPDATE activation_outbox SET dead_lettered_at = ? WHERE id = ?
      `).run("2026-08-14T00:00:00.000Z", firstOutbox.id);
      expect(input.workspace.hasQueuedMessageChange({
        conversationId: input.conversationId,
        deliveryId,
        action: "cancelled",
      })).toBe(false);

      const replay = await input.app.inject({
        method: "POST",
        url: `/api/agents/${input.agentAId}/queued-messages/${deliveryId}/cancel`,
        payload: { idempotencyKey: "cancel-repair" },
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual({
        cancelled: true,
        replayed: true,
        status: "cancelled",
      });
      expect(input.store.sqlite.prepare(`
        SELECT dead_lettered_at, attempts FROM activation_outbox WHERE id = ?
      `).get(firstOutbox.id)).toEqual({ dead_lettered_at: null, attempts: 0 });

      input = await restartFixture(input);
      const repairOutbox = claimQueuedMessageChange(input.coordinationV3, "repair-worker");
      applyQueuedMessageChangeOutbox(repairOutbox, {
        coordinationV3: input.coordinationV3,
        workspace: input.workspace,
        appendWorkspace: (event) => input.workspace.append(event),
        publishCoordinationV3Changed: () => undefined,
      });
      input.coordinationV3.completeOutbox(repairOutbox.id, "repair-worker");
      expect(input.workspace.hasQueuedMessageChange({
        conversationId: input.conversationId,
        deliveryId,
        action: "cancelled",
      })).toBe(true);
      const cursor = input.workspace.cursor();
      applyQueuedMessageChangeOutbox(repairOutbox, {
        coordinationV3: input.coordinationV3,
        workspace: input.workspace,
        appendWorkspace: (event) => input.workspace.append(event),
        publishCoordinationV3Changed: () => undefined,
      });
      expect(input.workspace.cursor()).toBe(cursor);
    } finally {
      await input.app.close();
      input.store.close();
    }
  });

  test("repairs poisoned cancellation dead letters only in canonical scope", async () => {
    const input = await fixture();
    try {
      const foreignRoot = path.join(path.dirname(input.dataDir), "foreign-workspace");
      mkdirSync(foreignRoot, { recursive: true });
      const foreignProject = input.store.createProject({
        label: "Foreign project",
        hostPath: foreignRoot,
        defaultEngine: "codex",
      });
      const foreignConversationId = foreignProject.lastConversationId!;
      const foreignAgent = input.store.createAgent(foreignProject.id, {
        title: "Foreign agent",
        engine: "codex",
        conversationId: foreignConversationId,
      });
      const foreignDeliveryId = randomUUID();

      const delivery = await queueDirectMessage(input, "poisoned-cancel", [
        input.agentAId,
      ]);
      const deliveryId = delivery.recipients[0]!.deliveryId!;
      const first = await input.app.inject({
        method: "POST",
        url: `/api/agents/${input.agentAId}/queued-messages/${deliveryId}/cancel`,
        payload: { idempotencyKey: "poisoned-cancel" },
      });
      expect(first.statusCode, first.body).toBe(200);
      const outbox = input.store.sqlite.prepare(`
        SELECT id FROM activation_outbox
        WHERE activation_id = ? AND event_kind = 'queued_message_change'
      `).get(deliveryId) as { id: number };
      input.store.sqlite.prepare(`
        UPDATE activation_outbox
        SET payload_json = ?, dead_lettered_at = ?, attempts = 8,
          last_error = 'poisoned scope'
        WHERE id = ?
      `).run(JSON.stringify({
        activationId: foreignDeliveryId,
        projectId: foreignProject.id,
        agentId: foreignAgent.id,
        conversationId: foreignConversationId,
        action: "cancelled",
      }), "2026-08-14T00:00:00.000Z", outbox.id);

      const replay = await input.app.inject({
        method: "POST",
        url: `/api/agents/${input.agentAId}/queued-messages/${deliveryId}/cancel`,
        payload: { idempotencyKey: "poisoned-cancel" },
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual({
        cancelled: true,
        replayed: true,
        status: "cancelled",
      });
      expect(input.store.sqlite.prepare(`
        SELECT payload_json, dead_lettered_at, attempts
        FROM activation_outbox WHERE id = ?
      `).get(outbox.id)).toEqual({
        payload_json: JSON.stringify({
          action: "cancelled",
          activationId: deliveryId,
          agentId: input.agentAId,
          conversationId: input.conversationId,
          projectId: input.projectId,
        }),
        dead_lettered_at: null,
        attempts: 0,
      });

      const repair = claimQueuedMessageChange(input.coordinationV3, "poison-repair");
      const poisonedClaim = {
        ...repair,
        payload: {
          activationId: foreignDeliveryId,
          projectId: foreignProject.id,
          agentId: foreignAgent.id,
          conversationId: foreignConversationId,
          action: "cancelled",
        },
      };
      applyQueuedMessageChangeOutbox(poisonedClaim, {
        coordinationV3: input.coordinationV3,
        workspace: input.workspace,
        appendWorkspace: (event) => {
          input.queuedMessageChanges.push(event);
          return input.workspace.append(event);
        },
        publishCoordinationV3Changed: (agentId, options) => {
          input.coordinationChanges.push({ agentId, ...options });
        },
      });
      input.coordinationV3.completeOutbox(repair.id, "poison-repair");
      expect(input.workspace.hasQueuedMessageChange({
        conversationId: input.conversationId,
        deliveryId,
        action: "cancelled",
      })).toBe(true);
      expect(input.workspace.hasQueuedMessageChange({
        conversationId: foreignConversationId,
        deliveryId: foreignDeliveryId,
        action: "cancelled",
      })).toBe(false);
      expect(input.queuedMessageChanges).toEqual([{
        type: "queued_message_changed",
        conversationId: input.conversationId,
        deliveryId,
        action: "cancelled",
      }]);
      expect(input.coordinationChanges).toEqual([{
        agentId: input.agentAId,
        conversationIds: [input.conversationId],
      }]);

      const secondReplay = await input.app.inject({
        method: "POST",
        url: `/api/agents/${input.agentAId}/queued-messages/${deliveryId}/cancel`,
        payload: { idempotencyKey: "poisoned-cancel" },
      });
      expect(secondReplay.statusCode, secondReplay.body).toBe(200);
      expect(input.store.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM activation_outbox
        WHERE activation_id = ? AND event_kind = 'queued_message_change'
      `).get(deliveryId)).toEqual({ count: 1 });
      expect(input.coordinationV3.claimOutbox("unexpected-repair", 500)
        .filter((item) => item.eventKind === "queued_message_change")).toEqual([]);
    } finally {
      await input.app.close();
      input.store.close();
    }
  });

  test("returns 409 when either queued-cancel route reuses a key for another delivery", async () => {
    const input = await fixture();
    try {
      const agentFirst = await queueDirectMessage(input, "agent-collision-first", [input.agentAId]);
      const agentSecond = await queueDirectMessage(input, "agent-collision-second", [input.agentAId]);
      const agentFirstId = agentFirst.recipients[0]!.deliveryId!;
      const agentSecondId = agentSecond.recipients[0]!.deliveryId!;
      expect((await input.app.inject({
        method: "POST",
        url: `/api/agents/${input.agentAId}/queued-messages/${agentFirstId}/cancel`,
        payload: { idempotencyKey: "agent-collision" },
      })).statusCode).toBe(200);
      const agentConflict = await input.app.inject({
        method: "POST",
        url: `/api/agents/${input.agentAId}/queued-messages/${agentSecondId}/cancel`,
        payload: { idempotencyKey: "agent-collision" },
      });
      expect(agentConflict.statusCode).toBe(409);
      expect(agentConflict.json()).toEqual({ error: "idempotency key collision" });

      const conversationFirst = await queueDirectMessage(input, "conversation-collision-first", [input.agentAId]);
      const conversationSecond = await queueDirectMessage(input, "conversation-collision-second", [input.agentAId]);
      const conversationFirstId = conversationFirst.recipients[0]!.deliveryId!;
      const conversationSecondId = conversationSecond.recipients[0]!.deliveryId!;
      expect((await input.app.inject({
        method: "POST",
        url: `/api/conversations/${input.conversationId}/queued-messages/${conversationFirstId}/cancel`,
        payload: { idempotencyKey: "conversation-collision" },
      })).statusCode).toBe(200);
      const conversationConflict = await input.app.inject({
        method: "POST",
        url: `/api/conversations/${input.conversationId}/queued-messages/${conversationSecondId}/cancel`,
        payload: { idempotencyKey: "conversation-collision" },
      });
      expect(conversationConflict.statusCode).toBe(409);
      expect(conversationConflict.json()).toEqual({ error: "idempotency key collision" });

      for (const activationId of [agentSecondId, conversationSecondId]) {
        expect(input.store.sqlite.prepare(`
          SELECT state FROM agent_activations WHERE id = ?
        `).get(activationId)).toEqual({ state: "pending" });
      }
    } finally {
      await input.app.close();
      input.store.close();
    }
  });

  test("does not cancel already consumed or terminal queued deliveries", async () => {
    const input = await fixture();
    try {
      const consumed = await queueDirectMessage(input, "consumed-boundary", [input.agentAId]);
      const terminal = await queueDirectMessage(input, "terminal-boundary", [input.agentAId]);
      const consumedId = consumed.recipients[0]!.deliveryId!;
      const terminalId = terminal.recipients[0]!.deliveryId!;
      input.store.sqlite.prepare(`
        UPDATE agent_activations SET state = 'consumed', consumed_at = ?, updated_at = ?
        WHERE id = ?
      `).run("2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z", consumedId);
      input.store.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'failed', terminal_outcome = 'permanent_failure', terminal_at = ?, updated_at = ?
        WHERE id = ?
      `).run("2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z", terminalId);

      for (const [deliveryId, idempotencyKey] of [
        [consumedId, "cancel-consumed"],
        [terminalId, "cancel-terminal"],
      ]) {
        const response = await input.app.inject({
          method: "POST",
          url: `/api/agents/${input.agentAId}/queued-messages/${deliveryId}/cancel`,
          payload: { idempotencyKey },
        });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toEqual({
          cancelled: false,
          replayed: false,
          status: "delivery_started",
        });
      }
      expect(input.store.sqlite.prepare(`
        SELECT state FROM agent_activations WHERE id = ?
      `).get(consumedId)).toEqual({ state: "consumed" });
      expect(input.store.sqlite.prepare(`
        SELECT state FROM agent_activations WHERE id = ?
      `).get(terminalId)).toEqual({ state: "failed" });
    } finally {
      await input.app.close();
      input.store.close();
    }
  });
});
