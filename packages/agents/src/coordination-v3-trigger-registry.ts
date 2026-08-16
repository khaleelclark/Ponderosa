import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  TriggerDefinitionDto,
  TriggerOccurrenceDto,
  TriggerRunBudgetDto,
  TriggerSourceConfig,
  TriggerSourceKind,
} from "@ponderosa/core";
import { stableJson } from "./coordination-v3-canonical-json.js";
import { triggerBudgetEndsAt } from "./coordination-v3-trigger-budget.js";
import type {
  CreateTriggerDefinitionInput,
  RecordTriggerOccurrenceInput,
  TriggerFilesystemBurst,
  TriggerOccurrenceResult,
  TriggerOccurrenceState,
  UpdateTriggerDefinitionInput,
} from "./coordination-v3-types.js";

export interface TriggerDefinitionRow {
  id: string;
  project_id: string;
  conversation_id: string;
  agent_id: string;
  name: string;
  instructions: string;
  source_kind: TriggerSourceKind;
  source_config_json: string;
  enabled: number;
  run_budget_limit: number | null;
  run_budget_period: TriggerRunBudgetDto["period"] | null;
  run_budget_used: number;
  run_budget_allowance: number;
  run_budget_period_started_at: string | null;
  next_fire_at: string | null;
  last_fired_at: string | null;
  secret_ciphertext: string | null;
  secret_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

interface TriggerOccurrenceRow {
  id: string;
  trigger_id: string;
  project_id: string;
  agent_id: string;
  state: TriggerOccurrenceState;
  payload_json: string;
  provenance_json: string;
  payload_media_type: string;
  input_hash: string;
  trigger_snapshot_json: string;
  activation_id: string | null;
  last_error: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
}

interface TriggerFilesystemBurstRow {
  trigger_id: string;
  occurrence_key: string;
  project_id: string;
  agent_id: string;
  started_at: string;
  last_at: string;
  event_count: number;
  changes_json: string;
  dropped_path_event_count: number;
  updated_at: string;
}

/**
 * Trigger definition, occurrence-read, schedule, budget, and filesystem-burst
 * authority. Scheduler execution and occurrence mutation are delegated to
 * their dedicated coordination authorities.
 */
export class CoordinationV3TriggerRegistry {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly cancelPendingWork: (
      triggerId: string,
      reason: string,
      now: string,
    ) => void,
    private readonly recordOccurrence: (
      input: RecordTriggerOccurrenceInput,
    ) => TriggerOccurrenceResult,
  ) {}

  create(input: CreateTriggerDefinitionInput): TriggerDefinitionDto {
    const name = input.name.trim();
    const instructions = input.instructions.trim();
    if (!name || name.length > 120) {
      throw new Error("Automation name must be between 1 and 120 characters");
    }
    if (!instructions || instructions.length > 20_000) {
      throw new Error("Automation instructions must be between 1 and 20000 characters");
    }
    this.validateRunBudget(input.runBudget);
    const now = input.now ?? new Date().toISOString();
    const id = input.id ?? randomUUID();
    return this.sqlite.transaction(() => {
      this.requireProject(input.projectId);
      this.requireAgent(input.projectId, input.agentId);
      this.requireConversation(input.projectId, input.conversationId);
      this.requireConversationMember(input.conversationId, input.agentId);
      const ownedCount = (this.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM trigger_definitions WHERE agent_id = ?
      `).get(input.agentId) as { count: number }).count;
      if (ownedCount >= 100) throw new Error("an Agent may own at most 100 Automations");
      if (input.sourceKind === "filesystem") {
        const watcherCount = (this.sqlite.prepare(`
          SELECT COUNT(*) AS count FROM trigger_definitions
          WHERE agent_id = ? AND source_kind = 'filesystem'
        `).get(input.agentId) as { count: number }).count;
        if (watcherCount >= 25) {
          throw new Error("an Agent may own at most 25 filesystem Automations");
        }
      }
      this.sqlite.prepare(`
        INSERT INTO trigger_definitions (
          id, project_id, conversation_id, agent_id, name, instructions,
          source_kind, source_config_json, enabled, next_fire_at,
          run_budget_limit, run_budget_period, run_budget_used, run_budget_allowance, run_budget_period_started_at,
          secret_ciphertext, secret_fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.projectId,
        input.conversationId,
        input.agentId,
        name,
        instructions,
        input.sourceKind,
        stableJson(input.sourceConfig),
        input.enabled === false ? 0 : 1,
        input.nextFireAt ?? null,
        input.runBudget?.limit ?? null,
        input.runBudget?.period ?? null,
        input.runBudget ? now : null,
        input.secretCiphertext ?? null,
        input.secretFingerprint ?? null,
        now,
        now,
      );
      return this.get(id)!;
    })();
  }

  list(agentId?: string): TriggerDefinitionDto[] {
    const rows = (agentId
      ? this.sqlite.prepare(`
        SELECT * FROM trigger_definitions WHERE agent_id = ? ORDER BY created_at, id
      `).all(agentId)
      : this.sqlite.prepare(`
        SELECT * FROM trigger_definitions ORDER BY created_at, id
      `).all()) as TriggerDefinitionRow[];
    return rows.map((row) => this.definitionDto(row));
  }

  get(id: string): TriggerDefinitionDto | undefined {
    const row = this.definitionRow(id);
    return row ? this.definitionDto(row) : undefined;
  }

  getSecretCiphertext(id: string): string | undefined {
    return this.definitionRow(id)?.secret_ciphertext ?? undefined;
  }

  allowRuns(
    id: string,
    additionalRuns: number,
    now = new Date().toISOString(),
  ): TriggerDefinitionDto | undefined {
    if (
      !Number.isSafeInteger(additionalRuns)
      || additionalRuns < 1
      || additionalRuns > 1_000_000
    ) {
      throw new Error("additionalRuns must be an integer between 1 and 1000000");
    }
    return this.sqlite.transaction(() => {
      this.resetExpiredBudgets(now);
      const row = this.definitionRow(id);
      if (!row) return undefined;
      if (row.run_budget_limit === null) throw new Error("this Automation has no Run budget");
      this.sqlite.prepare(`
        UPDATE trigger_definitions
        SET run_budget_allowance = run_budget_allowance + ?, updated_at = ?
        WHERE id = ?
      `).run(additionalRuns, now, id);
      return this.get(id);
    })();
  }

  update(
    id: string,
    input: UpdateTriggerDefinitionInput,
  ): TriggerDefinitionDto | undefined {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const row = this.definitionRow(id);
      if (!row) return undefined;
      const name = input.name === undefined ? row.name : input.name.trim();
      const instructions = input.instructions === undefined
        ? row.instructions
        : input.instructions.trim();
      if (!name || name.length > 120) {
        throw new Error("Automation name must be between 1 and 120 characters");
      }
      if (!instructions || instructions.length > 20_000) {
        throw new Error("Automation instructions must be between 1 and 20000 characters");
      }
      if (input.runBudget !== undefined && input.runBudget !== null) {
        this.validateRunBudget(input.runBudget);
      }
      const nextFireAt = input.nextFireAt === undefined
        ? row.next_fire_at
        : input.nextFireAt;
      this.sqlite.prepare(`
        UPDATE trigger_definitions
        SET name = ?, instructions = ?, source_config_json = ?, enabled = ?, next_fire_at = ?,
            run_budget_limit = ?, run_budget_period = ?, run_budget_used = ?, run_budget_allowance = ?, run_budget_period_started_at = ?,
            secret_ciphertext = ?, secret_fingerprint = ?, updated_at = ?
        WHERE id = ?
      `).run(
        name,
        instructions,
        input.sourceConfig === undefined
          ? row.source_config_json
          : stableJson(input.sourceConfig),
        input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
        nextFireAt,
        input.runBudget === undefined
          ? row.run_budget_limit
          : input.runBudget?.limit ?? null,
        input.runBudget === undefined
          ? row.run_budget_period
          : input.runBudget?.period ?? null,
        input.runBudget === undefined ? row.run_budget_used : 0,
        input.runBudget === undefined ? row.run_budget_allowance : 0,
        input.runBudget === undefined
          ? row.run_budget_period_started_at
          : input.runBudget ? now : null,
        input.secretCiphertext ?? row.secret_ciphertext,
        input.secretFingerprint ?? row.secret_fingerprint,
        now,
        id,
      );
      if (input.enabled === false) {
        this.cancelPendingWork(id, "Automation disabled", now);
      }
      return this.get(id);
    })();
  }

  delete(id: string, now = new Date().toISOString()): boolean {
    return this.sqlite.transaction(() => {
      if (!this.definitionRow(id)) return false;
      this.cancelPendingWork(id, "Automation deleted", now);
      return this.sqlite.prepare(`
        DELETE FROM trigger_definitions WHERE id = ?
      `).run(id).changes === 1;
    })();
  }

  listOccurrences(triggerId: string, limit = 100): TriggerOccurrenceDto[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM trigger_occurrences WHERE trigger_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?
    `).all(triggerId, Math.max(1, Math.min(limit, 500))) as TriggerOccurrenceRow[];
    return rows.map((row) => this.occurrenceDto(row));
  }

  listAgentOccurrences(agentId: string, limit = 100): TriggerOccurrenceDto[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM trigger_occurrences WHERE agent_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?
    `).all(agentId, Math.max(1, Math.min(limit, 500))) as TriggerOccurrenceRow[];
    return rows.map((row) => this.occurrenceDto(row));
  }

  listProjectOccurrences(projectId: string, limit = 100): TriggerOccurrenceDto[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM trigger_occurrences WHERE project_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT ?
    `).all(projectId, Math.max(1, Math.min(limit, 500))) as TriggerOccurrenceRow[];
    return rows.map((row) => this.occurrenceDto(row));
  }

  getOccurrence(id: string): TriggerOccurrenceDto | undefined {
    const row = this.sqlite.prepare(`
      SELECT * FROM trigger_occurrences WHERE id = ?
    `).get(id) as TriggerOccurrenceRow | undefined;
    return row ? this.occurrenceDto(row) : undefined;
  }

  listPendingFilesystemBursts(): TriggerFilesystemBurst[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM trigger_filesystem_bursts ORDER BY started_at, trigger_id
    `).all() as TriggerFilesystemBurstRow[];
    return rows.map((row) => this.filesystemBurst(row));
  }

  recordFilesystemEvent(input: {
    triggerId: string;
    path: string;
    eventType: string;
    maxCapturedPaths: number;
    now?: string;
  }): TriggerFilesystemBurst {
    const now = input.now ?? new Date().toISOString();
    if (!input.path || !input.eventType) {
      throw new Error("filesystem Automation path and event type are required");
    }
    if (!Number.isSafeInteger(input.maxCapturedPaths) || input.maxCapturedPaths < 1) {
      throw new Error("filesystem Automation captured path limit must be positive");
    }
    return this.sqlite.transaction(() => {
      const definition = this.definitionRow(input.triggerId);
      if (!definition || !definition.enabled || definition.source_kind !== "filesystem") {
        throw new Error("filesystem Automation is unavailable");
      }
      const existing = this.sqlite.prepare(`
        SELECT * FROM trigger_filesystem_bursts WHERE trigger_id = ?
      `).get(input.triggerId) as TriggerFilesystemBurstRow | undefined;
      if (!existing) {
        this.sqlite.prepare(`
          INSERT INTO trigger_filesystem_bursts (
            trigger_id, occurrence_key, project_id, agent_id, started_at, last_at,
            event_count, changes_json, dropped_path_event_count, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?)
        `).run(
          definition.id,
          `filesystem:${randomUUID()}`,
          definition.project_id,
          definition.agent_id,
          now,
          now,
          stableJson([{ path: input.path, types: [input.eventType] }]),
          now,
        );
      } else {
        const changes = JSON.parse(existing.changes_json) as Array<{
          path: string;
          types: string[];
        }>;
        const changed = changes.find((item) => item.path === input.path);
        let dropped = existing.dropped_path_event_count;
        if (changed) {
          if (!changed.types.includes(input.eventType)) changed.types.push(input.eventType);
        } else if (changes.length < input.maxCapturedPaths) {
          changes.push({ path: input.path, types: [input.eventType] });
        } else {
          dropped += 1;
        }
        this.sqlite.prepare(`
          UPDATE trigger_filesystem_bursts
          SET last_at = ?, event_count = event_count + 1, changes_json = ?,
              dropped_path_event_count = ?, updated_at = ?
          WHERE trigger_id = ?
        `).run(now, stableJson(changes), dropped, now, input.triggerId);
      }
      const row = this.sqlite.prepare(`
        SELECT * FROM trigger_filesystem_bursts WHERE trigger_id = ?
      `).get(input.triggerId) as TriggerFilesystemBurstRow;
      return this.filesystemBurst(row);
    })();
  }

  flushFilesystemBurst(triggerId: string): TriggerOccurrenceResult | undefined {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare(`
        SELECT * FROM trigger_filesystem_bursts WHERE trigger_id = ?
      `).get(triggerId) as TriggerFilesystemBurstRow | undefined;
      if (!row) return undefined;
      const changes = JSON.parse(row.changes_json) as Array<{
        path: string;
        types: string[];
      }>;
      const result = this.recordOccurrence({
        triggerId,
        occurrenceKey: row.occurrence_key,
        payload: {
          changes,
          lowLevelEventCount: row.event_count,
          capturedPathCount: changes.length,
          startedAt: row.started_at,
          endedAt: row.last_at,
          ...(row.dropped_path_event_count ? {
            pathLimitReached: true,
            droppedPathEventCount: row.dropped_path_event_count,
          } : {}),
        },
        provenance: {
          source: "project_filesystem",
          watcher: "project_root",
          contentInjected: false,
        },
        now: row.last_at,
      });
      this.sqlite.prepare(`
        DELETE FROM trigger_filesystem_bursts WHERE trigger_id = ?
      `).run(triggerId);
      return result;
    })();
  }

  listDueSchedules(
    now = new Date().toISOString(),
    limit = 100,
  ): TriggerDefinitionDto[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM trigger_definitions
      WHERE enabled = 1 AND source_kind = 'schedule'
        AND next_fire_at IS NOT NULL AND next_fire_at <= ?
      ORDER BY next_fire_at, id LIMIT ?
    `).all(now, Math.max(1, Math.min(limit, 500))) as TriggerDefinitionRow[];
    return rows.map((row) => this.definitionDto(row));
  }

  definitionRow(id: string): TriggerDefinitionRow | undefined {
    return this.sqlite.prepare(`
      SELECT * FROM trigger_definitions WHERE id = ?
    `).get(id) as TriggerDefinitionRow | undefined;
  }

  definitionDto(row: TriggerDefinitionRow): TriggerDefinitionDto {
    const runBudget = row.run_budget_limit !== null && row.run_budget_period
      ? { limit: row.run_budget_limit, period: row.run_budget_period }
      : undefined;
    const periodStartedAt = row.run_budget_period_started_at ?? row.created_at;
    const periodEndsAt = runBudget
      ? triggerBudgetEndsAt(runBudget.period, periodStartedAt)
      : undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      name: row.name,
      instructions: row.instructions,
      sourceKind: row.source_kind,
      sourceConfig: JSON.parse(row.source_config_json) as TriggerSourceConfig,
      enabled: Boolean(row.enabled),
      fullAccess: true,
      ...(runBudget ? {
        runBudget,
        budgetState: {
          used: row.run_budget_used,
          allowance: row.run_budget_allowance,
          periodStartedAt,
          ...(periodEndsAt ? { periodEndsAt } : {}),
          held: row.run_budget_used
            >= row.run_budget_limit! + row.run_budget_allowance,
        },
      } : {}),
      ...(row.next_fire_at ? { nextFireAt: row.next_fire_at } : {}),
      ...(row.last_fired_at ? { lastFiredAt: row.last_fired_at } : {}),
      ...(row.source_kind === "webhook"
        ? { webhookPath: `/api/trigger-webhooks/${row.id}` }
        : {}),
      ...(row.secret_fingerprint
        ? { secretFingerprint: row.secret_fingerprint }
        : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  resetExpiredBudgets(now = new Date().toISOString()): number {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite.prepare(`
        SELECT * FROM trigger_definitions
        WHERE run_budget_limit IS NOT NULL AND run_budget_period != 'lifetime'
      `).all() as TriggerDefinitionRow[];
      let reset = 0;
      for (const row of rows) {
        const startedAt = row.run_budget_period_started_at ?? row.created_at;
        const endsAt = row.run_budget_period
          ? triggerBudgetEndsAt(row.run_budget_period, startedAt)
          : undefined;
        if (!endsAt || endsAt > now) continue;
        this.sqlite.prepare(`
          UPDATE trigger_definitions
          SET run_budget_used = 0, run_budget_allowance = 0,
              run_budget_period_started_at = ?, updated_at = ?
          WHERE id = ?
        `).run(now, now, row.id);
        reset += 1;
      }
      return reset;
    })();
  }

  private validateRunBudget(budget: TriggerRunBudgetDto | undefined): void {
    if (!budget) return;
    if (
      !Number.isSafeInteger(budget.limit)
      || budget.limit < 1
      || budget.limit > 1_000_000
    ) {
      throw new Error(
        "Automation Run budget limit must be an integer between 1 and 1000000",
      );
    }
    if (!["day", "week", "month", "lifetime"].includes(budget.period)) {
      throw new Error("Automation Run budget period must be day, week, month, or lifetime");
    }
  }

  private occurrenceDto(row: TriggerOccurrenceRow): TriggerOccurrenceDto {
    const triggerSnapshot = JSON.parse(
      row.trigger_snapshot_json,
    ) as TriggerOccurrenceDto["triggerSnapshot"];
    return {
      id: row.id,
      artifactId: `trigger-occurrence:${row.id}`,
      triggerId: row.trigger_id,
      projectId: row.project_id,
      agentId: row.agent_id,
      state: row.state,
      payload: JSON.parse(row.payload_json) as unknown,
      provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
      payloadMediaType: row.payload_media_type,
      inputHash: row.input_hash,
      ...(triggerSnapshot ? { triggerSnapshot } : {}),
      ...(row.activation_id ? { activationId: row.activation_id } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private filesystemBurst(row: TriggerFilesystemBurstRow): TriggerFilesystemBurst {
    return {
      triggerId: row.trigger_id,
      occurrenceKey: row.occurrence_key,
      projectId: row.project_id,
      agentId: row.agent_id,
      startedAt: row.started_at,
      lastAt: row.last_at,
      eventCount: row.event_count,
      changes: JSON.parse(row.changes_json) as Array<{
        path: string;
        types: string[];
      }>,
      droppedPathEventCount: row.dropped_path_event_count,
    };
  }

  private requireProject(projectId: string): void {
    if (!this.sqlite.prepare(`
      SELECT 1 FROM projects WHERE id = ?
    `).get(projectId)) throw new Error("project not found");
  }

  private requireAgent(projectId: string, agentId: string): void {
    if (!this.sqlite.prepare(`
      SELECT 1 FROM agents
      WHERE id = ? AND project_id = ? AND archived = 0
    `).get(agentId, projectId)) {
      throw new Error("agent not found in project");
    }
  }

  private requireConversation(projectId: string, conversationId: string): void {
    if (!this.sqlite.prepare(`
      SELECT 1 FROM conversations
      WHERE id = ? AND project_id = ? AND archived = 0
    `).get(conversationId, projectId)) {
      throw new Error("Team Chat not found in project");
    }
  }

  private requireConversationMember(conversationId: string, agentId: string): void {
    if (!this.sqlite.prepare(`
      SELECT 1 FROM agent_conversation_memberships
      WHERE conversation_id = ? AND agent_id = ?
    `).get(conversationId, agentId)) {
      throw new Error(
        "every coordination participant must be an active member of this Team Chat",
      );
    }
  }
}
