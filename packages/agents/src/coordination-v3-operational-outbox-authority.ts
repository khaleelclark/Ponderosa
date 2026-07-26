import type Database from "better-sqlite3";
import type { CoordinationV3StoreOptions, OutboxItem, ProviderOperation } from "./coordination-v3-types.js";

const DEFAULT_MAX_OUTBOX_ATTEMPTS = 8;

export class CoordinationV3OperationalOutboxAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: CoordinationV3StoreOptions,
  ) {}

  claimProviderOperations(workerId: string, limit = 20, now = new Date().toISOString(), staleMs = 30_000): ProviderOperation[] {
    return this.sqlite.transaction(() => {
      const stale = new Date(Date.parse(now) - staleMs).toISOString();
      const rows = this.sqlite.prepare(`
        SELECT id, run_id, operation, idempotency_key, payload_json, attempts
        FROM provider_operation_outbox
        WHERE available_at <= ? AND (
          state = 'pending' OR (state = 'claimed' AND claimed_at <= ?)
        )
        ORDER BY id LIMIT ?
      `).all(now, stale, Math.max(1, Math.min(limit, 100))) as Array<{
        id: number; run_id: string; operation: "interrupt"; idempotency_key: string;
        payload_json: string; attempts: number;
      }>;
      const claimed: ProviderOperation[] = [];
      for (const row of rows) {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload_json) as unknown;
        } catch {
          this.sqlite.prepare(`
            UPDATE provider_operation_outbox
            SET state = 'failed', dead_lettered_at = ?, last_error = ?, updated_at = ?,
              claimed_by = NULL, claimed_at = NULL
            WHERE id = ?
          `).run(now, "invalid provider-operation payload", now, row.id);
          continue;
        }
        const changed = this.sqlite.prepare(`
          UPDATE provider_operation_outbox
          SET state = 'claimed', claimed_by = ?, claimed_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND (state = 'pending' OR (state = 'claimed' AND claimed_at <= ?))
        `).run(workerId, now, now, row.id, stale).changes;
        if (changed === 1) claimed.push({
          id: row.id,
          runId: row.run_id,
          operation: row.operation,
          idempotencyKey: row.idempotency_key,
          payload,
          attempts: row.attempts + 1,
        });
      }
      return claimed;
    })();
  }

  completeProviderOperation(id: number, workerId: string, now = new Date().toISOString()): void {
    const changed = this.sqlite.prepare(`
      UPDATE provider_operation_outbox
      SET state = 'completed', completed_at = ?, updated_at = ?, claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND state = 'claimed' AND claimed_by = ?
    `).run(now, now, id, workerId).changes;
    if (changed !== 1) throw new Error("provider operation claim is stale");
  }

  failProviderOperation(id: number, workerId: string, error: string, retryDelayMs = 1_000, now = new Date().toISOString()): void {
    const availableAt = new Date(Date.parse(now) + retryDelayMs).toISOString();
    const maximumAttempts = Math.max(1, this.options.maxOutboxAttempts ?? DEFAULT_MAX_OUTBOX_ATTEMPTS);
    const changed = this.sqlite.prepare(`
      UPDATE provider_operation_outbox
      SET state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
        dead_lettered_at = CASE WHEN attempts >= ? THEN ? ELSE NULL END,
        available_at = ?, last_error = ?, updated_at = ?,
        claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND state = 'claimed' AND claimed_by = ?
    `).run(maximumAttempts, maximumAttempts, now, availableAt, error.slice(0, 2_000), now, id, workerId).changes;
    if (changed !== 1) throw new Error("provider operation claim is stale");
  }

  deadLetterProviderOperation(id: number, workerId: string, error: string, now = new Date().toISOString()): void {
    const changed = this.sqlite.prepare(`
      UPDATE provider_operation_outbox
      SET state = 'failed', dead_lettered_at = ?, last_error = ?, updated_at = ?,
        claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND state = 'claimed' AND claimed_by = ?
    `).run(now, error.slice(0, 2_000), now, id, workerId).changes;
    if (changed !== 1) throw new Error("provider operation claim is stale");
  }

  claimOutbox(workerId: string, limit = 50, now = new Date().toISOString(), staleMs = 30_000): OutboxItem[] {
    return this.sqlite.transaction(() => {
      const stale = new Date(Date.parse(now) - staleMs).toISOString();
      const rows = this.sqlite.prepare(`
        SELECT id, activation_id, event_kind, payload_json, attempts
        FROM activation_outbox
        WHERE processed_at IS NULL AND dead_lettered_at IS NULL
          AND (claimed_at IS NULL OR claimed_at <= ?)
        ORDER BY id LIMIT ?
      `).all(stale, Math.max(1, Math.min(limit, 500))) as Array<{
        id: number; activation_id: string; event_kind: string; payload_json: string; attempts: number;
      }>;
      const claim = this.sqlite.prepare(`
        UPDATE activation_outbox SET claimed_by = ?, claimed_at = ?, attempts = attempts + 1
        WHERE id = ? AND processed_at IS NULL AND dead_lettered_at IS NULL
          AND (claimed_at IS NULL OR claimed_at <= ?)
      `);
      const claimed: OutboxItem[] = [];
      for (const row of rows) {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload_json) as unknown;
        } catch {
          this.sqlite.prepare(`
            UPDATE activation_outbox
            SET dead_lettered_at = ?, last_error = ?, claimed_by = NULL, claimed_at = NULL
            WHERE id = ? AND processed_at IS NULL
          `).run(now, "invalid activation-outbox payload", row.id);
          continue;
        }
        if (claim.run(workerId, now, row.id, stale).changes !== 1) continue;
        claimed.push({
          id: row.id,
          activationId: row.activation_id,
          eventKind: row.event_kind,
          payload,
          attempts: row.attempts + 1,
        });
      }
      return claimed;
    })();
  }

  completeOutbox(id: number, workerId: string, now = new Date().toISOString()): void {
    const changed = this.sqlite.prepare(`
      UPDATE activation_outbox SET processed_at = ?, claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND claimed_by = ? AND processed_at IS NULL AND dead_lettered_at IS NULL
    `).run(now, id, workerId).changes;
    if (changed !== 1) throw new Error("outbox claim is stale");
  }

  failOutbox(id: number, workerId: string, error: string): void {
    const maximumAttempts = Math.max(1, this.options.maxOutboxAttempts ?? DEFAULT_MAX_OUTBOX_ATTEMPTS);
    const now = new Date().toISOString();
    const changed = this.sqlite.prepare(`
      UPDATE activation_outbox
      SET claimed_by = NULL, claimed_at = NULL, last_error = ?,
        dead_lettered_at = CASE WHEN attempts >= ? THEN ? ELSE dead_lettered_at END
      WHERE id = ? AND claimed_by = ? AND processed_at IS NULL AND dead_lettered_at IS NULL
    `).run(error.slice(0, 2_000), maximumAttempts, now, id, workerId).changes;
    if (changed !== 1) throw new Error("outbox claim is stale");
  }

  /** Settled delivery receipts are operational bookkeeping, not semantic
   * communication history. Keep a bounded diagnostic tail while preserving all
   * pending and dead-lettered work. */
  pruneSettledOutboxes(retain = 10_000): { activationOutbox: number; providerOperations: number } {
    const keep = Math.max(100, Math.floor(retain));
    return this.sqlite.transaction(() => {
      const activationOutbox = this.sqlite.prepare(`
        DELETE FROM activation_outbox
        WHERE processed_at IS NOT NULL AND id NOT IN (
          SELECT id FROM activation_outbox WHERE processed_at IS NOT NULL ORDER BY id DESC LIMIT ?
        )
      `).run(keep).changes;
      const providerOperations = this.sqlite.prepare(`
        DELETE FROM provider_operation_outbox
        WHERE state = 'completed' AND id NOT IN (
          SELECT id FROM provider_operation_outbox WHERE state = 'completed' ORDER BY id DESC LIMIT ?
        )
      `).run(keep).changes;
      return { activationOutbox, providerOperations };
    })();
  }

}

