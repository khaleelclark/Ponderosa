import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

export type CollaborationDeliveryStatus = "queued" | "delivered" | "acknowledged" | "failed";

export interface CollaborationDelivery {
  id: string;
  masterChatId?: string;
  messageId: string;
  /** Canonical communication identity shared by every resulting projection. */
  communicationEventId?: string;
  targetThreadId: string;
  authorThreadId?: string;
  text: string;
  relayDepth: number;
  mentionTrail: string[];
  /** A delegated result is delivered by the server; ordinary messages are tags. */
  kind: "direct" | "tag" | "delegation_completion";
  /** Auditable selector resolved to this recipient at message creation time. */
  audience?: "mention" | "everyone";
  delegatedRunId?: string;
  model?: string;
  effort?: string;
  sourceChannel?: "main";
  replyToMessageId?: string;
  attachmentIds?: string[];
  /** Canonical total-order key for messages sharing the same millisecond. */
  orderKey?: string;
  status: CollaborationDeliveryStatus;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  /** Number of recipient turns started for this delivery, including retries. */
  attempts?: number;
  failure?: string;
}

/** A fixed, canonical-order snapshot dispatched in one recipient agent turn. */
export interface CollaborationDeliveryBatch {
  deliveries: CollaborationDelivery[];
}

type Record =
  | { type: "delivery" | "replace"; delivery: CollaborationDelivery }
  | { type: "message_receipt"; key: string; messageId: string }
  | { type: "reconciliation_boundary"; createdAt: string };

/**
 * Durable delivery ledger for collaboration handoffs. Collaboration text remains
 * in the thread-store chat log; this file records whether every recipient was
 * queued, entered a turn, or completed the delivery turn. It is deliberately
 * separate from the public chat DTO because it contains routing internals.
 */
export class CollaborationDeliveryStore {
  private readonly deliveries = new Map<string, CollaborationDelivery>();
  private readonly byMessageTarget = new Map<string, string>();
  private readonly messageReceipts = new Map<string, string>();
  private readonly file: string;
  private boundary: string | undefined;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "collaboration-deliveries.jsonl");
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) closeSync(openSync(this.file, "a", 0o600));
    chmodSync(this.file, 0o600);
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line) as Record;
      if (record.type === "message_receipt") {
        this.messageReceipts.set(record.key, record.messageId);
        continue;
      }
      if (record.type === "reconciliation_boundary") {
        this.boundary = record.createdAt;
        continue;
      }
      this.deliveries.set(record.delivery.id, record.delivery);
      this.byMessageTarget.set(`${record.delivery.messageId}:${record.delivery.targetThreadId}`, record.delivery.id);
    }
    if (!this.boundary) {
      this.boundary = [...this.deliveries.values()]
        .map((delivery) => delivery.createdAt)
        .sort()[0] ?? new Date().toISOString();
      appendFileSync(this.file, `${JSON.stringify({ type: "reconciliation_boundary", createdAt: this.boundary } satisfies Record)}\n`, "utf8");
    }
  }

  reconciliationBoundary(): string {
    return this.boundary!;
  }

  private persist(delivery: CollaborationDelivery, type: "delivery" | "replace"): CollaborationDelivery {
    appendFileSync(this.file, `${JSON.stringify({ type, delivery } satisfies Record)}\n`, "utf8");
    this.deliveries.set(delivery.id, delivery);
    this.byMessageTarget.set(`${delivery.messageId}:${delivery.targetThreadId}`, delivery.id);
    return delivery;
  }

  queue(
    input: Omit<CollaborationDelivery, "id" | "status" | "createdAt"> & { createdAt?: string },
  ): { delivery: CollaborationDelivery; replayed: boolean } {
    const previous = this.byMessageTarget.get(`${input.messageId}:${input.targetThreadId}`);
    if (previous) return { delivery: this.deliveries.get(previous)!, replayed: true };
    const delivery: CollaborationDelivery = {
      ...input,
      id: randomUUID(),
      status: "queued",
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    return { delivery: this.persist(delivery, "delivery"), replayed: false };
  }

  pending(threadId: string): CollaborationDelivery[] {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.targetThreadId === threadId && delivery.status === "queued")
      .sort((a, b) => (a.orderKey ?? a.createdAt).localeCompare(b.orderKey ?? b.createdAt));
  }

  pendingCount(threadId: string): number {
    return this.pending(threadId).length;
  }

  /**
   * Recover work after a process restart. A `delivered` record only means its
   * follow-up turn started; without an acknowledgement the process may have
   * stopped before the recipient handled it, so it is safe to retry.
   */
  recoverUnacknowledged(): string[] {
    for (const delivery of [...this.deliveries.values()]) {
      if (delivery.status === "delivered") this.requeue(delivery.id);
    }
    return [...new Set(
      [...this.deliveries.values()]
        .filter((delivery) => delivery.status === "queued")
        .map((delivery) => delivery.targetThreadId),
    )];
  }

  get(id: string): CollaborationDelivery | undefined {
    return this.deliveries.get(id);
  }

  getForMessageTarget(messageId: string, targetThreadId: string): CollaborationDelivery | undefined {
    const id = this.byMessageTarget.get(`${messageId}:${targetThreadId}`);
    return id ? this.deliveries.get(id) : undefined;
  }

  markDelivered(id: string): CollaborationDelivery | undefined {
    const delivery = this.deliveries.get(id);
    if (!delivery || delivery.status !== "queued") return delivery;
    return this.persist({
      ...delivery,
      status: "delivered",
      deliveredAt: new Date().toISOString(),
      attempts: (delivery.attempts ?? 0) + 1,
    }, "replace");
  }

  markBatchDelivered(ids: readonly string[]): CollaborationDelivery[] {
    return ids.flatMap((id) => {
      const delivery = this.markDelivered(id);
      return delivery ? [delivery] : [];
    });
  }

  requeueBatch(ids: readonly string[]): CollaborationDelivery[] {
    return ids.flatMap((id) => {
      const delivery = this.requeue(id);
      return delivery ? [delivery] : [];
    });
  }

  acknowledgeBatch(ids: readonly string[]): CollaborationDelivery[] {
    return ids.flatMap((id) => {
      const delivery = this.acknowledge(id);
      return delivery ? [delivery] : [];
    });
  }

  failBatch(ids: readonly string[], failure: string): CollaborationDelivery[] {
    return ids.flatMap((id) => {
      const delivery = this.fail(id, failure);
      return delivery ? [delivery] : [];
    });
  }

  requeue(id: string): CollaborationDelivery | undefined {
    const delivery = this.deliveries.get(id);
    if (!delivery || delivery.status !== "delivered") return delivery;
    const { deliveredAt: _deliveredAt, ...queued } = delivery;
    return this.persist({ ...queued, status: "queued" }, "replace");
  }

  acknowledge(id: string): CollaborationDelivery | undefined {
    const delivery = this.deliveries.get(id);
    if (!delivery || delivery.status !== "delivered") return delivery;
    const { failure: _failure, ...succeeded } = delivery;
    return this.persist({ ...succeeded, status: "acknowledged", acknowledgedAt: new Date().toISOString() }, "replace");
  }

  /**
   * A process accepting a turn is not proof that the recipient handled it.
   * Retry one failed runtime turn, then retain a terminal failed record instead
   * of creating an unbounded crash/retry loop.
   */
  retryFailedTurn(id: string, failure: string, maxAttempts = 2): CollaborationDelivery | undefined {
    const delivery = this.deliveries.get(id);
    if (!delivery || delivery.status !== "delivered") return delivery;
    if ((delivery.attempts ?? 1) >= maxAttempts) return this.fail(id, failure);
    const { deliveredAt: _deliveredAt, failure: _failure, ...queued } = delivery;
    return this.persist({ ...queued, status: "queued", failure }, "replace");
  }

  fail(id: string, failure: string): CollaborationDelivery | undefined {
    const delivery = this.deliveries.get(id);
    if (!delivery || delivery.status === "acknowledged" || delivery.status === "failed") return delivery;
    return this.persist({ ...delivery, status: "failed", failure }, "replace");
  }

  messageReceipt(key: string): string | undefined {
    return this.messageReceipts.get(key);
  }

  rememberMessageReceipt(key: string, messageId: string): void {
    if (this.messageReceipts.has(key)) return;
    appendFileSync(this.file, `${JSON.stringify({ type: "message_receipt", key, messageId } satisfies Record)}\n`, "utf8");
    this.messageReceipts.set(key, messageId);
  }
}
