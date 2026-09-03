import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { payloadHash, stableJson } from "./coordination-v3-canonical-json.js";
import type { RunAuthorizationV3 } from "./coordination-v3-types.js";

export interface CommunicationV4NextRunDelivery {
  id: string;
  projectId: string;
  conversationId: string;
  publisherKind: "agent" | "operator";
  publisherAgentId?: string;
  publisherUserId?: string;
  publisherLabel: string;
  sourceRunId?: string;
  text: string;
  recipientAgentIds: string[];
  expiresAt?: string;
  createdAt: string;
}

export interface PublishAgentNextRunDeliveryInput {
  projectId: string;
  conversationId: string;
  publisherAgentId: string;
  sourceRunId: string;
  runAuthorization: RunAuthorizationV3;
  idempotencyKey: string;
  text: string;
  recipientAgentIds: string[];
  expiresAt?: string;
  now?: string;
}

export interface PublishOperatorNextRunDeliveryInput {
  projectId: string;
  conversationId: string;
  publisherUserId: string;
  publisherLabel: string;
  idempotencyKey: string;
  text: string;
  recipientAgentIds: string[];
  expiresAt?: string;
  now?: string;
}

export interface PublishNextRunDeliveryResult {
  delivery: CommunicationV4NextRunDelivery;
  replayed: boolean;
}

export type ReplayAgentNextRunDeliveryInput = Omit<
  PublishAgentNextRunDeliveryInput,
  "runAuthorization" | "now"
>;

export interface NextRunDeliveryMaintenanceResult {
  reconciled: number;
  expired: number;
  pruned: number;
}

export interface OperatorNextRunDeliveryReceipt {
  deliveryId: string;
  projectId: string;
  conversationId: string;
  text: string;
  createdAt: string;
  expiresAt?: string;
  recipients: Array<{
    agentId: string;
    agentTitle: string;
    state: "pending" | "delivered" | "expired" | "unavailable";
    deliveredRunId?: string;
    settledAt?: string;
    unavailableReason?: string;
  }>;
}

interface DeliveryRow {
  id: string;
  project_id: string;
  conversation_id: string;
  publisher_kind: "agent" | "operator";
  publisher_agent_id: string | null;
  publisher_user_id: string | null;
  publisher_label: string;
  source_run_id: string | null;
  text: string;
  recipient_agent_ids_json: string;
  expires_at: string | null;
  created_at: string;
}

const MAX_RETAINED_DELIVERIES_PER_PROJECT = 10_000;
const MAX_PENDING_RECIPIENTS_PER_PROJECT = 1_000;
const SETTLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DELIVERY_REF_PREFIX = "ponderosa://next-run-delivery/";

const view = (row: DeliveryRow): CommunicationV4NextRunDelivery => ({
  id: row.id,
  projectId: row.project_id,
  conversationId: row.conversation_id,
  publisherKind: row.publisher_kind,
  ...(row.publisher_agent_id ? { publisherAgentId: row.publisher_agent_id } : {}),
  ...(row.publisher_user_id ? { publisherUserId: row.publisher_user_id } : {}),
  publisherLabel: row.publisher_label,
  ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
  text: row.text,
  recipientAgentIds: JSON.parse(row.recipient_agent_ids_json) as string[],
  ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  createdAt: row.created_at,
});

/** Durable one-way delivery for the next otherwise-authorized recipient Run. */
export class CommunicationV4NextRunDeliveryAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly requireAuthorizedRun: (
      authorization: RunAuthorizationV3,
      expectedScopeKey?: string,
    ) => void,
  ) {
    this.maintain();
  }

  publishAgent(input: PublishAgentNextRunDeliveryInput): PublishNextRunDeliveryResult {
    const now = input.now ?? new Date().toISOString();
    if (input.runAuthorization.runId !== input.sourceRunId ||
        input.runAuthorization.agentId !== input.publisherAgentId) {
      throw new Error("next-run publisher does not match the authoritative Run");
    }
    const recipients = [...new Set(input.recipientAgentIds)].sort();
    if (recipients.length === 0) throw new Error("next_run requires at least one recipient");
    if (recipients.length !== input.recipientAgentIds.length) {
      throw new Error("next_run recipients must be unique");
    }
    if (recipients.includes(input.publisherAgentId)) {
      throw new Error("an Agent cannot deliver next_run information to itself");
    }
    this.validateExpiry(input.expiresAt, now);
    const hash = this.agentPayloadHash(input, recipients);
    const deliveryId = randomUUID();
    return this.sqlite.transaction(() => {
      const prior = this.sqlite.prepare(`
        SELECT * FROM communication_v4_next_run_deliveries
        WHERE publisher_kind = 'agent' AND publisher_agent_id = ?
          AND source_run_id = ? AND idempotency_key = ?
      `).get(input.publisherAgentId, input.sourceRunId, input.idempotencyKey) as
        (DeliveryRow & { payload_hash: string }) | undefined;
      if (prior) {
        if (prior.payload_hash !== hash) throw new Error("next_run idempotency conflict");
        return { delivery: view(prior), replayed: true };
      }
      this.requireAuthorizedRun(input.runAuthorization, `conversation:${input.conversationId}`);
      const publisher = this.sqlite.prepare(`
        SELECT title FROM agents
        WHERE id = ? AND project_id = ? AND archived = 0 AND deleted_at IS NULL
      `).get(input.publisherAgentId, input.projectId) as { title: string } | undefined;
      if (!publisher || !this.isConversationMember(input.publisherAgentId, input.conversationId)) {
        throw new Error("next-run publisher is not an active member of this Team Chat");
      }
      const recipientLabels = this.recipientLabels(
        input.projectId,
        input.conversationId,
        recipients,
      );
      this.maintain(now);
      this.enforceQuota(input.projectId, recipients.length);
      this.sqlite.prepare(`
        INSERT INTO communication_v4_next_run_deliveries (
          id, project_id, conversation_id, publisher_kind, publisher_agent_id,
          publisher_user_id, publisher_label, source_run_id, idempotency_key,
          payload_hash, text, recipient_agent_ids_json, expires_at, created_at
        ) VALUES (?, ?, ?, 'agent', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deliveryId,
        input.projectId,
        input.conversationId,
        input.publisherAgentId,
        publisher.title,
        input.sourceRunId,
        input.idempotencyKey,
        hash,
        input.text,
        stableJson(recipients),
        input.expiresAt ?? null,
        now,
      );
      this.insertRecipients(deliveryId, recipients, recipientLabels, now);
      const delivery = this.get(deliveryId);
      if (!delivery) throw new Error("next-run delivery did not commit");
      return { delivery, replayed: false };
    })();
  }

  replayAgent(
    input: ReplayAgentNextRunDeliveryInput,
  ): PublishNextRunDeliveryResult | undefined {
    const recipients = [...new Set(input.recipientAgentIds)].sort();
    const prior = this.sqlite.prepare(`
      SELECT * FROM communication_v4_next_run_deliveries
      WHERE publisher_kind = 'agent' AND publisher_agent_id = ?
        AND source_run_id = ? AND idempotency_key = ?
    `).get(input.publisherAgentId, input.sourceRunId, input.idempotencyKey) as
      (DeliveryRow & { payload_hash: string }) | undefined;
    if (!prior) return undefined;
    if (prior.payload_hash !== this.agentPayloadHash(input, recipients)) {
      throw new Error("next_run idempotency conflict");
    }
    return { delivery: view(prior), replayed: true };
  }

  publishOperator(
    input: PublishOperatorNextRunDeliveryInput,
  ): PublishNextRunDeliveryResult {
    const now = input.now ?? new Date().toISOString();
    const recipients = [...new Set(input.recipientAgentIds)].sort();
    if (recipients.length === 0) throw new Error("next_run requires at least one recipient");
    if (recipients.length !== input.recipientAgentIds.length) {
      throw new Error("next_run recipients must be unique");
    }
    this.validateExpiry(input.expiresAt, now);
    const hash = payloadHash({
      projectId: input.projectId,
      conversationId: input.conversationId,
      publisherKind: "operator",
      publisherUserId: input.publisherUserId,
      text: input.text,
      recipients,
      expiresAt: input.expiresAt ?? null,
    });
    const deliveryId = randomUUID();
    return this.sqlite.transaction(() => {
      const prior = this.sqlite.prepare(`
        SELECT * FROM communication_v4_next_run_deliveries
        WHERE publisher_kind = 'operator' AND publisher_user_id = ?
          AND conversation_id = ? AND idempotency_key = ?
      `).get(input.publisherUserId, input.conversationId, input.idempotencyKey) as
        (DeliveryRow & { payload_hash: string }) | undefined;
      if (prior) {
        if (prior.payload_hash !== hash) throw new Error("next_run idempotency conflict");
        return { delivery: view(prior), replayed: true };
      }
      const conversation = this.sqlite.prepare(`
        SELECT 1 FROM conversations
        WHERE id = ? AND project_id = ? AND archived = 0
      `).get(input.conversationId, input.projectId);
      if (!conversation) throw new Error("next-run Team Chat is unavailable");
      const recipientLabels = this.recipientLabels(
        input.projectId,
        input.conversationId,
        recipients,
      );
      this.maintain(now);
      this.enforceQuota(input.projectId, recipients.length);
      this.sqlite.prepare(`
        INSERT INTO communication_v4_next_run_deliveries (
          id, project_id, conversation_id, publisher_kind, publisher_agent_id,
          publisher_user_id, publisher_label, source_run_id, idempotency_key,
          payload_hash, text, recipient_agent_ids_json, expires_at, created_at
        ) VALUES (?, ?, ?, 'operator', NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        deliveryId,
        input.projectId,
        input.conversationId,
        input.publisherUserId,
        input.publisherLabel,
        input.idempotencyKey,
        hash,
        input.text,
        stableJson(recipients),
        input.expiresAt ?? null,
        now,
      );
      this.insertRecipients(deliveryId, recipients, recipientLabels, now);
      const delivery = this.get(deliveryId);
      if (!delivery) throw new Error("next-run delivery did not commit");
      return { delivery, replayed: false };
    })();
  }

  get(deliveryId: string): CommunicationV4NextRunDelivery | undefined {
    const row = this.sqlite.prepare(`
      SELECT * FROM communication_v4_next_run_deliveries WHERE id = ?
    `).get(deliveryId) as DeliveryRow | undefined;
    return row ? view(row) : undefined;
  }

  private agentPayloadHash(
    input: ReplayAgentNextRunDeliveryInput,
    recipients: string[],
  ): string {
    return payloadHash({
      projectId: input.projectId,
      conversationId: input.conversationId,
      publisherAgentId: input.publisherAgentId,
      sourceRunId: input.sourceRunId,
      text: input.text,
      recipients,
      expiresAt: input.expiresAt ?? null,
    });
  }

  listOperatorReceipts(input: {
    projectId: string;
    conversationId: string;
    publisherUserId: string;
    limit?: number;
    now?: string;
  }): OperatorNextRunDeliveryReceipt[] {
    this.maintain(input.now);
    const limit = Math.max(1, Math.min(50, input.limit ?? 20));
    const deliveries = this.sqlite.prepare(`
      SELECT * FROM communication_v4_next_run_deliveries
      WHERE project_id = ? AND conversation_id = ?
        AND publisher_kind = 'operator' AND publisher_user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      input.projectId,
      input.conversationId,
      input.publisherUserId,
      limit,
    ) as DeliveryRow[];
    if (deliveries.length === 0) return [];
    const placeholders = deliveries.map(() => "?").join(", ");
    const recipients = this.sqlite.prepare(`
      SELECT recipient.delivery_id, recipient.agent_id, recipient.state,
        recipient.delivered_run_id, recipient.delivered_at, recipient.expired_at,
        recipient.unavailable_at, recipient.unavailable_reason,
        recipient.recipient_label AS agent_title
      FROM communication_v4_next_run_recipients recipient
      WHERE recipient.delivery_id IN (${placeholders})
      ORDER BY recipient.delivery_id, recipient.agent_id
    `).all(...deliveries.map((delivery) => delivery.id)) as Array<{
      delivery_id: string;
      agent_id: string;
      agent_title: string;
      state: "pending" | "delivered" | "expired" | "unavailable";
      delivered_run_id: string | null;
      delivered_at: string | null;
      expired_at: string | null;
      unavailable_at: string | null;
      unavailable_reason: string | null;
    }>;
    return deliveries.map((delivery) => ({
      deliveryId: delivery.id,
      projectId: delivery.project_id,
      conversationId: delivery.conversation_id,
      text: delivery.text,
      createdAt: delivery.created_at,
      ...(delivery.expires_at ? { expiresAt: delivery.expires_at } : {}),
      recipients: recipients
        .filter((recipient) => recipient.delivery_id === delivery.id)
        .map((recipient) => ({
          agentId: recipient.agent_id,
          agentTitle: recipient.agent_title,
          state: recipient.state,
          ...(recipient.delivered_run_id ? { deliveredRunId: recipient.delivered_run_id } : {}),
          ...((recipient.delivered_at ?? recipient.expired_at ?? recipient.unavailable_at)
            ? { settledAt: recipient.delivered_at ?? recipient.expired_at ?? recipient.unavailable_at ?? undefined }
            : {}),
          ...(recipient.unavailable_reason
            ? { unavailableReason: recipient.unavailable_reason }
            : {}),
        })),
    }));
  }

  pendingForNextRun(input: {
    projectId: string;
    conversationId: string;
    agentId: string;
    limit?: number;
    now?: string;
  }): CommunicationV4NextRunDelivery[] {
    if (!this.isConversationMember(input.agentId, input.conversationId)) return [];
    const now = input.now ?? new Date().toISOString();
    this.reconcileCompletedDeliveries();
    this.expirePendingDeliveries(now);
    const limit = Math.max(1, Math.min(50, input.limit ?? 20));
    return (this.sqlite.prepare(`
      SELECT delivery.* FROM communication_v4_next_run_recipients recipient
      JOIN communication_v4_next_run_deliveries delivery
        ON delivery.id = recipient.delivery_id
      WHERE recipient.agent_id = ? AND recipient.state = 'pending'
        AND delivery.project_id = ? AND delivery.conversation_id = ?
        AND (delivery.expires_at IS NULL OR delivery.expires_at > ?)
      ORDER BY delivery.created_at, delivery.id
      LIMIT ?
    `).all(
      input.agentId,
      input.projectId,
      input.conversationId,
      now,
      limit,
    ) as DeliveryRow[]).map(view);
  }

  markDelivered(input: {
    projectId: string;
    conversationId: string;
    agentId: string;
    runId: string;
    deliveryIds: string[];
    now?: string;
  }): number {
    if (input.deliveryIds.length === 0) return 0;
    const now = input.now ?? new Date().toISOString();
    const placeholders = input.deliveryIds.map(() => "?").join(", ");
    return this.sqlite.prepare(`
      UPDATE communication_v4_next_run_recipients
      SET state = 'delivered',
        delivered_run_id = (
          SELECT provider.scheduler_run_id
          FROM provider_inputs provider
          JOIN scheduler_runs scheduler ON scheduler.id = provider.scheduler_run_id
          WHERE provider.execution_id = ? AND scheduler.status = 'completed'
          LIMIT 1
        ),
        delivered_at = COALESCE((
          SELECT scheduler.terminal_at
          FROM provider_inputs provider
          JOIN scheduler_runs scheduler ON scheduler.id = provider.scheduler_run_id
          WHERE provider.execution_id = ? AND scheduler.status = 'completed'
          LIMIT 1
        ), ?)
      WHERE agent_id = ? AND state = 'pending' AND delivery_id IN (${placeholders})
        AND EXISTS (
          SELECT 1 FROM communication_v4_next_run_deliveries delivery
          WHERE delivery.id = communication_v4_next_run_recipients.delivery_id
            AND delivery.project_id = ? AND delivery.conversation_id = ?
        )
        AND EXISTS (
          SELECT 1
          FROM provider_inputs provider,
            json_each(json_extract(provider.source_manifest_json, '$.sources')) source
          WHERE provider.execution_id = ? AND provider.agent_id = ? AND provider.project_id = ?
            AND EXISTS (
              SELECT 1 FROM scheduler_runs scheduler
              WHERE scheduler.id = provider.scheduler_run_id
                AND scheduler.status = 'completed'
            )
            AND json_extract(source.value, '$.ref') =
              ? || communication_v4_next_run_recipients.delivery_id
        )
    `).run(
      input.runId,
      input.runId,
      now,
      input.agentId,
      ...input.deliveryIds,
      input.projectId,
      input.conversationId,
      input.runId,
      input.agentId,
      input.projectId,
      DELIVERY_REF_PREFIX,
    ).changes;
  }

  maintain(now = new Date().toISOString()): NextRunDeliveryMaintenanceResult {
    return this.sqlite.transaction(() => {
      const reconciled = this.reconcileCompletedDeliveries();
      const expired = this.expirePendingDeliveries(now);
      const cutoff = new Date(Date.parse(now) - SETTLED_RETENTION_MS).toISOString();
      const pruned = this.sqlite.prepare(`
        DELETE FROM communication_v4_next_run_deliveries
        WHERE NOT EXISTS (
          SELECT 1 FROM communication_v4_next_run_recipients recipient
          WHERE recipient.delivery_id = communication_v4_next_run_deliveries.id
            AND (
              recipient.state = 'pending'
              OR COALESCE(
                recipient.delivered_at,
                recipient.expired_at,
                recipient.unavailable_at,
                recipient.created_at
              ) > ?
            )
        )
      `).run(cutoff).changes;
      return { reconciled, expired, pruned };
    })();
  }

  private reconcileCompletedDeliveries(): number {
    return this.sqlite.prepare(`
      WITH completed_delivery AS (
        SELECT
          recipient.delivery_id,
          recipient.agent_id,
          provider.scheduler_run_id,
          COALESCE(scheduler.terminal_at, provider.updated_at) AS settled_at,
          ROW_NUMBER() OVER (
            PARTITION BY recipient.delivery_id, recipient.agent_id
            ORDER BY scheduler.terminal_at, provider.created_at, provider.execution_id
          ) AS candidate_rank
        FROM communication_v4_next_run_recipients recipient
        JOIN communication_v4_next_run_deliveries delivery
          ON delivery.id = recipient.delivery_id
        JOIN provider_inputs provider
          ON provider.agent_id = recipient.agent_id
          AND provider.project_id = delivery.project_id
        JOIN scheduler_runs scheduler
          ON scheduler.id = provider.scheduler_run_id
          AND scheduler.status = 'completed'
        JOIN json_each(json_extract(provider.source_manifest_json, '$.sources')) source
        WHERE recipient.state = 'pending'
          AND json_extract(source.value, '$.ref') = ? || recipient.delivery_id
      )
      UPDATE communication_v4_next_run_recipients
      SET state = 'delivered',
        delivered_run_id = (
          SELECT candidate.scheduler_run_id
          FROM completed_delivery candidate
          WHERE candidate.delivery_id = communication_v4_next_run_recipients.delivery_id
            AND candidate.agent_id = communication_v4_next_run_recipients.agent_id
            AND candidate.candidate_rank = 1
        ),
        delivered_at = (
          SELECT candidate.settled_at
          FROM completed_delivery candidate
          WHERE candidate.delivery_id = communication_v4_next_run_recipients.delivery_id
            AND candidate.agent_id = communication_v4_next_run_recipients.agent_id
            AND candidate.candidate_rank = 1
        )
      WHERE state = 'pending'
        AND EXISTS (
          SELECT 1 FROM completed_delivery candidate
          WHERE candidate.delivery_id = communication_v4_next_run_recipients.delivery_id
            AND candidate.agent_id = communication_v4_next_run_recipients.agent_id
            AND candidate.candidate_rank = 1
        )
    `).run(DELIVERY_REF_PREFIX).changes;
  }

  private expirePendingDeliveries(now: string): number {
    return this.sqlite.prepare(`
      UPDATE communication_v4_next_run_recipients
      SET state = 'expired',
        expired_at = (
          SELECT delivery.expires_at
          FROM communication_v4_next_run_deliveries delivery
          WHERE delivery.id = communication_v4_next_run_recipients.delivery_id
        )
      WHERE state = 'pending'
        AND EXISTS (
          SELECT 1 FROM communication_v4_next_run_deliveries delivery
          WHERE delivery.id = communication_v4_next_run_recipients.delivery_id
            AND delivery.expires_at IS NOT NULL AND delivery.expires_at <= ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM communication_v4_next_run_deliveries delivery
          JOIN provider_inputs provider
            ON provider.agent_id = communication_v4_next_run_recipients.agent_id
            AND provider.project_id = delivery.project_id
          JOIN scheduler_runs scheduler
            ON scheduler.id = provider.scheduler_run_id
            AND scheduler.status IN ('leased', 'running')
          JOIN json_each(json_extract(provider.source_manifest_json, '$.sources')) source
          WHERE delivery.id = communication_v4_next_run_recipients.delivery_id
            AND json_extract(source.value, '$.ref') = ? || delivery.id
        )
    `).run(now, DELIVERY_REF_PREFIX).changes;
  }

  private recipientLabels(
    projectId: string,
    conversationId: string,
    recipients: string[],
  ): Map<string, string> {
    const labels = new Map<string, string>();
    for (const recipientAgentId of recipients) {
      const recipient = this.sqlite.prepare(`
        SELECT agent.title FROM agents agent
        JOIN agent_conversation_memberships membership
          ON membership.agent_id = agent.id AND membership.conversation_id = ?
        WHERE agent.id = ? AND agent.project_id = ?
          AND agent.archived = 0 AND agent.deleted_at IS NULL
      `).get(conversationId, recipientAgentId, projectId) as { title: string } | undefined;
      if (!recipient) {
        throw new Error("every next_run recipient must be an active Agent in this Team Chat");
      }
      labels.set(recipientAgentId, recipient.title);
    }
    return labels;
  }

  private insertRecipients(
    deliveryId: string,
    recipients: string[],
    labels: Map<string, string>,
    now: string,
  ): void {
    const insert = this.sqlite.prepare(`
      INSERT INTO communication_v4_next_run_recipients (
        delivery_id, agent_id, recipient_label, state, created_at
      ) VALUES (?, ?, ?, 'pending', ?)
    `);
    for (const recipientAgentId of recipients) {
      insert.run(deliveryId, recipientAgentId, labels.get(recipientAgentId), now);
    }
  }

  private validateExpiry(expiresAt: string | undefined, now: string): void {
    if (expiresAt && (
      !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(now)
    )) throw new Error("next_run expiry must be a future ISO timestamp");
  }

  private enforceQuota(projectId: string, newPendingRecipients: number): void {
    const retained = this.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM communication_v4_next_run_deliveries WHERE project_id = ?
    `).get(projectId) as { count: number };
    if (retained.count >= MAX_RETAINED_DELIVERIES_PER_PROJECT) {
      throw new Error(
        `next-run Project quota reached (${MAX_RETAINED_DELIVERIES_PER_PROJECT} retained deliveries)`,
      );
    }
    const pending = this.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM communication_v4_next_run_recipients recipient
      JOIN communication_v4_next_run_deliveries delivery
        ON delivery.id = recipient.delivery_id
      WHERE delivery.project_id = ? AND recipient.state = 'pending'
    `).get(projectId) as { count: number };
    if (pending.count + newPendingRecipients > MAX_PENDING_RECIPIENTS_PER_PROJECT) {
      throw new Error(
        `next-run pending-recipient quota exceeded (${MAX_PENDING_RECIPIENTS_PER_PROJECT} per Project)`,
      );
    }
  }

  private isConversationMember(agentId: string, conversationId: string): boolean {
    return Boolean(this.sqlite.prepare(`
      SELECT 1 FROM agent_conversation_memberships
      WHERE agent_id = ? AND conversation_id = ?
      UNION ALL
      SELECT 1 FROM agents
      WHERE id = ? AND conversation_id = ?
      LIMIT 1
    `).get(agentId, conversationId, agentId, conversationId));
  }
}
