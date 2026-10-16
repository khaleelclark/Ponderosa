import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  PendingActivationCapacityError,
  activationDefaults,
} from "./coordination-v3-activation.js";
import { stableJson } from "./coordination-v3-canonical-json.js";
import type { CreateActivationV3Input } from "./coordination-v3-runtime-communication-authority.js";
import type { CoordinationV3StoreOptions } from "./coordination-v3-types.js";

const DEFAULT_MAX_PENDING_ACTIVATIONS_PER_AGENT = 1_000;

/** Creates scheduler Activations and their canonical source/outbox records. */
export class CoordinationV3ActivationFactory {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: CoordinationV3StoreOptions,
  ) {}

  create(input: CreateActivationV3Input): string {
    const existing = this.sqlite.prepare(`
      SELECT id FROM agent_activations
      WHERE project_id = ? AND agent_id = ? AND dedupe_key = ?
    `).get(input.projectId, input.agentId, input.dedupeKey) as {
      id: string;
    } | undefined;
    if (existing) {
      this.sqlite.prepare(`
        INSERT OR IGNORE INTO activation_sources (
          activation_id, source_kind, source_id
        ) VALUES (?, ?, ?)
      `).run(existing.id, input.sourceKind, input.sourceId);
      return existing.id;
    }
    if (input.externalIntake) {
      const maximum = Math.max(
        1,
        this.options.maxPendingActivationsPerAgent
          ?? DEFAULT_MAX_PENDING_ACTIVATIONS_PER_AGENT,
      );
      const pending = (this.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM agent_activations
        WHERE agent_id = ? AND state IN ('pending', 'retry_pending')
      `).get(input.agentId) as { count: number }).count;
      if (pending >= maximum) {
        throw new PendingActivationCapacityError(
          `pending activation limit reached for Agent (${maximum})`,
        );
      }
    }
    const id = randomUUID();
    const defaults = activationDefaults(input.kind, input.priority);
    const inserted = this.sqlite.prepare(`
      INSERT OR IGNORE INTO agent_activations (
        id, project_id, agent_id, scope_key, kind, priority, dispatch_policy,
        prompt_class, state, dedupe_key, payload_json, available_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.agentId,
      input.scopeKey,
      input.kind,
      input.priority,
      input.dispatchPolicy ?? defaults.dispatchPolicy,
      input.promptClass ?? defaults.promptClass,
      input.dedupeKey,
      stableJson(input.payload),
      input.now,
      input.now,
      input.now,
    ).changes;
    const activationId = inserted === 1
      ? id
      : (this.sqlite.prepare(`
        SELECT id FROM agent_activations
        WHERE project_id = ? AND agent_id = ? AND dedupe_key = ?
      `).get(input.projectId, input.agentId, input.dedupeKey) as { id: string }).id;
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO activation_sources (
        activation_id, source_kind, source_id
      ) VALUES (?, ?, ?)
    `).run(activationId, input.sourceKind, input.sourceId);
    if (inserted === 1) {
      this.sqlite.prepare(`
        INSERT INTO activation_outbox (
          activation_id, event_kind, payload_json, created_at
        ) VALUES (?, 'activation_ready', ?, ?)
      `).run(
        activationId,
        stableJson({
          activationId,
          agentId: input.agentId,
          kind: input.kind,
        }),
        input.now,
      );
    }
    return activationId;
  }
}
