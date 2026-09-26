import type Database from "better-sqlite3";
import type { CommunicationEvent } from "@ponderosa/core";
import { stableJson } from "./coordination-v3-canonical-json.js";
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
          AND available_at <= ?
          AND (claimed_at IS NULL OR claimed_at <= ?)
        ORDER BY id LIMIT ?
      `).all(now, stale, Math.max(1, Math.min(limit, 500))) as Array<{
        id: number; activation_id: string; event_kind: string; payload_json: string; attempts: number;
      }>;
      const claim = this.sqlite.prepare(`
        UPDATE activation_outbox SET claimed_by = ?, claimed_at = ?, attempts = attempts + 1
        WHERE id = ? AND processed_at IS NULL AND dead_lettered_at IS NULL
          AND available_at <= ?
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
        if (claim.run(workerId, now, row.id, now, stale).changes !== 1) continue;
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

  failOutbox(id: number, workerId: string, error: string, now = new Date().toISOString()): void {
    const claim = this.sqlite.prepare(`
      SELECT attempts FROM activation_outbox
      WHERE id = ? AND claimed_by = ? AND processed_at IS NULL AND dead_lettered_at IS NULL
    `).get(id, workerId) as { attempts: number } | undefined;
    if (!claim) throw new Error("outbox claim is stale");
    const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(claim.attempts - 1, 9));
    const availableAt = new Date(Date.parse(now) + delayMs).toISOString();
    const changed = this.sqlite.prepare(`
      UPDATE activation_outbox
      SET claimed_by = NULL, claimed_at = NULL, last_error = ?,
        available_at = ?
      WHERE id = ? AND claimed_by = ? AND processed_at IS NULL AND dead_lettered_at IS NULL
    `).run(error.slice(0, 2_000), availableAt, id, workerId).changes;
    if (changed !== 1) throw new Error("outbox claim is stale");
  }

  deadLetterOutbox(id: number, workerId: string, error: string, now = new Date().toISOString()): void {
    const changed = this.sqlite.prepare(`
      UPDATE activation_outbox
      SET dead_lettered_at = ?, last_error = ?, claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND claimed_by = ? AND processed_at IS NULL AND dead_lettered_at IS NULL
    `).run(now, error.slice(0, 2_000), id, workerId).changes;
    if (changed !== 1) throw new Error("outbox claim is stale");
  }

  /** Exact-row operator repair, never automatic revival. The original
   * Activation remains blocked until its corrected signal is processed. */
  requeueDeadLetteredRevision(
    id: number,
    activationId: string,
    expectedLastError: string,
    payload: unknown,
    canonicalSource: CommunicationEvent,
    reason: string,
    now = new Date().toISOString(),
  ): void {
    this.sqlite.transaction(() => {
      if (!reason.trim() || reason.length > 2_000) throw new Error("outbox repair reason is required and must be bounded");
      const row = this.sqlite.prepare(`
        SELECT outbox.id, outbox.last_error, outbox.payload_json,
          activation.project_id, activation.agent_id, activation.payload_json AS activation_payload_json
        FROM activation_outbox outbox
        JOIN agent_activations activation ON activation.id = outbox.activation_id
        WHERE outbox.id = ? AND outbox.activation_id = ?
          AND outbox.event_kind = 'communication_revision'
          AND outbox.processed_at IS NULL AND outbox.dead_lettered_at IS NOT NULL
          AND outbox.claimed_by IS NULL
      `).get(id, activationId) as {
        id: number; last_error: string | null; payload_json: string;
        project_id: string; agent_id: string; activation_payload_json: string;
      } | undefined;
      if (!row || row.last_error !== expectedLastError) throw new Error("dead-letter repair target changed");
      const candidate = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown> : undefined;
      const revision = candidate?.revision && typeof candidate.revision === "object" && !Array.isArray(candidate.revision)
        ? candidate.revision as Record<string, unknown> : undefined;
      if (!candidate || !revision || candidate.activationId !== activationId ||
          candidate.agentId !== row.agent_id || typeof candidate.conversationId !== "string" ||
          revision.schemaVersion !== 1 || revision.kind !== "edit" ||
          revision.projectId !== row.project_id || revision.conversationId !== candidate.conversationId ||
          typeof revision.targetEventId !== "string" || !revision.targetEventId ||
          typeof revision.eventId !== "string" || !revision.eventId ||
          typeof revision.idempotencyKey !== "string" || !revision.idempotencyKey ||
          typeof revision.text !== "string" || typeof revision.createdAt !== "string" ||
          !revision.sender || typeof revision.sender !== "object") {
        throw new Error("corrected revision payload does not match its canonical Activation");
      }
      const sources = this.sqlite.prepare(`
        SELECT source.source_id, runtime.project_id AS runtime_project_id,
          runtime.sender_json, runtime.intent, runtime.audience_json,
          runtime.payload_json AS runtime_payload_json
        FROM activation_sources source
        LEFT JOIN runtime_communications runtime ON runtime.id = source.source_id
        WHERE source.activation_id = ? AND source.source_kind = 'communication'
      `).all(activationId) as Array<{
        source_id: string; runtime_project_id: string | null; sender_json: string | null;
        intent: string | null; audience_json: string | null; runtime_payload_json: string | null;
      }>;
      const source = sources.length === 1 ? sources[0] : undefined;
      if (!source?.runtime_payload_json ||
          source.runtime_project_id !== row.project_id ||
          canonicalSource.eventId !== source.source_id ||
          canonicalSource.projectId !== row.project_id ||
          typeof canonicalSource.conversationId !== "string" ||
          candidate.conversationId !== canonicalSource.conversationId ||
          revision.conversationId !== canonicalSource.conversationId ||
          revision.targetEventId !== canonicalSource.eventId ||
          canonicalSource.sender.kind !== "user" ||
          stableJson(revision.sender) !== stableJson(canonicalSource.sender)) {
        throw new Error("corrected revision does not match the Activation's canonical Communication source");
      }
      const activationPayload = JSON.parse(row.activation_payload_json) as { communication?: unknown };
      const runtimePayload = JSON.parse(source.runtime_payload_json) as { communication?: unknown };
      const sameSource = (value: unknown): boolean => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const event = value as Record<string, unknown>;
        return event.eventId === canonicalSource.eventId &&
          event.projectId === canonicalSource.projectId &&
          event.conversationId === canonicalSource.conversationId &&
          event.intent === canonicalSource.intent &&
          stableJson(event.sender) === stableJson(canonicalSource.sender) &&
          stableJson(event.audience) === stableJson(canonicalSource.audience);
      };
      if (source.intent !== canonicalSource.intent ||
          stableJson(JSON.parse(source.sender_json ?? "null")) !== stableJson(canonicalSource.sender) ||
          stableJson(JSON.parse(source.audience_json ?? "null")) !== stableJson(canonicalSource.audience) ||
          !sameSource(activationPayload.communication) || !sameSource(runtimePayload.communication)) {
        throw new Error("Activation source audience or conversation does not match canonical Communication");
      }
      const payloadJson = JSON.stringify(candidate);
      this.sqlite.prepare(`
        INSERT INTO activation_outbox_repair_audit (
          outbox_id, activation_id, previous_payload_json,
          replacement_payload_json, previous_error, reason, repaired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, activationId, row.payload_json, payloadJson, expectedLastError, reason.trim(), now);
      const changed = this.sqlite.prepare(`
        UPDATE activation_outbox
        SET payload_json = ?, dead_lettered_at = NULL, last_error = NULL,
          claimed_by = NULL, claimed_at = NULL, attempts = 0, available_at = ?
        WHERE id = ? AND activation_id = ? AND dead_lettered_at IS NOT NULL
          AND processed_at IS NULL AND last_error = ? AND claimed_by IS NULL
      `).run(payloadJson, now, id, activationId, expectedLastError).changes;
      if (changed !== 1) throw new Error("dead-letter repair target changed");
    })();
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
