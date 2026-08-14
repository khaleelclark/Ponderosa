// Open the SQLite projection DB and establish its launch baseline. New databases
// are created directly at that schema; only the known pre-baseline schema is
// adopted, preserving its useful runtime and organizational data.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  normalizeProviderFailureCategory,
  publicProviderFailureSummary,
  type CoordinationRequestUpdateKind,
} from "@ponderosa/core";
import { payloadHash, stableJson } from "./coordination-v3-canonical-json.js";
import type { Actor, RuntimeArtifactInputV3 } from "./coordination-v3-types.js";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

/** The drizzle db plus the raw better-sqlite3 handle (for close()/pragmas). */
export interface OpenedDb {
  db: Db;
  client: Database.Database;
}

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "schema");
const baselineName = "0000_current_schema.sql";
const schemaExtensions = [
  "0001_communication_v4_next_run_deliveries.sql",
  "0002_provider_process_authority.sql",
  "0003_collection_generations.sql",
  "0004_run_output_segments.sql",
  "0005_required_reply_obligations.sql",
  "0006_delivery_idempotency.sql",
  "0007_structured_provider_failure_state.sql",
  "0008_public_activation_provider_failures.sql",
] as const;
const legacyMigrationTable = "_migrations";
const schemaVersionTable = "_schema_version";
const contextRolloverAtomicityMigration = "0005_context_rollover_atomicity.ts";
const publicProviderRequestUpdatesMigration = "0009_public_provider_request_updates.ts";
const latestLegacyMigration = "0035_coordination_question_suspensions.sql";

// Fingerprint of the complete schema that was current when the launch baseline
// was introduced. It gates adoption so an arbitrary old or damaged database is
// never mistaken for the preserved current one.
const currentLegacySchemaFingerprint =
  "764f940012bb9ee404368fb8a04f12e77b7b2206bdd81077921934aad8ab317a";

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

function tableExists(sqlite: Database.Database, name: string): boolean {
  return sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function schemaFingerprint(sqlite: Database.Database): string {
  const rows = sqlite
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
         AND name NOT IN (?, ?)
       ORDER BY CASE type
         WHEN 'table' THEN 1
         WHEN 'view' THEN 2
         WHEN 'index' THEN 3
         WHEN 'trigger' THEN 4
         ELSE 5
       END, name`,
    )
    .all(legacyMigrationTable, schemaVersionTable) as SchemaObject[];
  const catalog = rows.map((row) => [row.type, row.name, row.tbl_name, row.sql].join("|")).join("\n");
  return createHash("sha256").update(catalog.length > 0 ? `${catalog}\n` : catalog).digest("hex");
}

function hasApplicationSchema(sqlite: Database.Database): boolean {
  return sqlite
    .prepare(
      `SELECT 1 FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
         AND name NOT IN (?, ?)
       LIMIT 1`,
    )
    .get(legacyMigrationTable, schemaVersionTable) !== undefined;
}

function baselineApplied(sqlite: Database.Database): boolean {
  return sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(baselineName) !== undefined;
}

/** Adopt the one preserved pre-baseline schema without rewriting its data. */
function adoptCurrentLegacySchema(sqlite: Database.Database): boolean {
  if (!tableExists(sqlite, legacyMigrationTable)) return false;
  const reachedCurrentSchema = sqlite
    .prepare(`SELECT 1 FROM ${legacyMigrationTable} WHERE name = ?`)
    .get(latestLegacyMigration) !== undefined;
  if (!reachedCurrentSchema) return false;

  if (schemaFingerprint(sqlite) !== currentLegacySchemaFingerprint) {
    throw new Error(
      "Ponderosa refused to adopt a legacy database whose schema does not match the preserved launch baseline.",
    );
  }

  sqlite.transaction(() => {
    sqlite
      .prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(baselineName, new Date().toISOString());
  })();
  return true;
}

/** Establish the launch baseline or adopt a verified current legacy database. */
function establishSchema(sqlite: Database.Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${schemaVersionTable} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`,
  );
  if (baselineApplied(sqlite)) return;
  if (adoptCurrentLegacySchema(sqlite)) return;

  if (hasApplicationSchema(sqlite) || tableExists(sqlite, legacyMigrationTable)) {
    throw new Error(
      "Ponderosa found a database outside the supported launch baseline. Restore the last compatible Ponderosa version before adopting it.",
    );
  }

  const sql = readFileSync(join(schemaDir, baselineName), "utf8");
  sqlite.transaction(() => {
    sqlite.exec(sql);
    sqlite
      .prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(baselineName, new Date().toISOString());
  })();
}

/** Apply explicit post-baseline extensions in order. Every extension and its
 * marker commit together, so an interrupted open is safe to retry. Extension
 * SQL is also idempotent to support fresh baselines that already include the
 * latest tables. */
function establishSchemaExtensions(sqlite: Database.Database): void {
  for (const extensionName of schemaExtensions) {
    const sql = readFileSync(join(schemaDir, extensionName), "utf8");
    const applied = sqlite
      .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
      .get(extensionName) !== undefined;
    if (applied) continue;
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
        .run(extensionName, new Date().toISOString());
    })();
  }
}

function replaceMaterializedRequestUpdate(
  value: unknown,
  updateId: string,
  publicPayload: Record<string, unknown>,
  budget = { nodes: 0 },
  depth = 0,
): { value: unknown; changed: boolean } {
  budget.nodes += 1;
  if (budget.nodes > 100_000 || depth > 128) {
    return { value: { providerFailure: publicPayload.reason }, changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const projected = value.map((item) => {
      const next = replaceMaterializedRequestUpdate(item, updateId, publicPayload, budget, depth + 1);
      changed ||= next.changed;
      return next.value;
    });
    return { value: changed ? projected : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  const record = value as Record<string, unknown>;
  let changed = false;
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "update" && record.updateId === updateId) {
      projected[key] = publicPayload;
      changed = true;
      continue;
    }
    const next = replaceMaterializedRequestUpdate(child, updateId, publicPayload, budget, depth + 1);
    projected[key] = next.value;
    changed ||= next.changed;
  }
  return { value: changed ? projected : value, changed };
}

/** Backfill provider-derived Request updates materialized before activation
 * failure text gained a finite public projection. Exact provider evidence
 * remains unchanged in restricted scheduler_runs rows. */
function establishPublicProviderRequestUpdates(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(publicProviderRequestUpdatesMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    const columns = new Set(
      (sqlite.pragma("table_info(coordination_request_updates)") as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has("provider_failure_category")) {
      sqlite.exec(`
        ALTER TABLE coordination_request_updates ADD COLUMN provider_failure_category TEXT
          CHECK (provider_failure_category IS NULL OR provider_failure_category IN (
            'authentication', 'rate_limit', 'capacity', 'context_length',
            'invalid_request', 'unavailable', 'unknown'
          ));
      `);
    }
    const rows = sqlite.prepare(`
      SELECT request_update.id, request_update.request_id, request_update.kind,
        request_update.actor_kind, request_update.actor_id,
        request_update.in_reply_to_update_id, activation.id AS activation_id,
        activation.terminal_outcome, activation.provider_failure_category
      FROM coordination_request_updates request_update
      JOIN coordination_requests request ON request.id = request_update.request_id
      JOIN activation_sources source
        ON source.source_kind = 'request' AND source.source_id = request.id
      JOIN agent_activations activation ON activation.id = source.activation_id
      WHERE request_update.kind IN ('failed', 'recipient_unavailable')
        AND request_update.actor_kind IN ('system', 'supervisor')
        AND json_valid(request_update.payload_json)
        AND json_extract(request_update.payload_json, '$.activationId') = activation.id
        AND EXISTS (
          SELECT 1 FROM scheduler_run_activations attached
          JOIN scheduler_runs scheduler ON scheduler.id = attached.run_id
          WHERE attached.activation_id = activation.id
            AND scheduler.provider_failure_json IS NOT NULL
        )
      ORDER BY request_update.created_at, request_update.id
    `).all() as Array<{
      id: string;
      request_id: string;
      kind: CoordinationRequestUpdateKind;
      actor_kind: Actor["kind"];
      actor_id: string | null;
      in_reply_to_update_id: string | null;
      activation_id: string;
      terminal_outcome: string | null;
      provider_failure_category: string | null;
    }>;
    const updateRequest = sqlite.prepare(`
      UPDATE coordination_request_updates
      SET payload_json = ?, payload_hash = ?, provider_failure_category = ?
      WHERE id = ?
    `);
    const updateActivation = sqlite.prepare(`
      UPDATE agent_activations SET payload_json = ? WHERE id = ?
    `);
    for (const row of rows) {
      const category = normalizeProviderFailureCategory(row.provider_failure_category);
      const publicPayload = {
        activationId: row.activation_id,
        activationOutcome: row.terminal_outcome ?? "permanent_failure",
        reason: publicProviderFailureSummary(undefined, category)
          ?? "Provider execution failed.",
      };
      const artifacts = sqlite.prepare(`
        SELECT id, role, title, media_type, blob_path, blob_hash, byte_length,
          origin_agent_id, execution_id
        FROM runtime_artifacts
        WHERE owner_kind = 'request_update' AND owner_id = ?
        ORDER BY created_at, id
      `).all(row.id) as Array<{
        id: string;
        role: RuntimeArtifactInputV3["role"];
        title: string;
        media_type: RuntimeArtifactInputV3["mediaType"];
        blob_path: string;
        blob_hash: string;
        byte_length: number;
        origin_agent_id: string | null;
        execution_id: string | null;
      }>;
      const projectedArtifacts: RuntimeArtifactInputV3[] = artifacts.map((artifact) => ({
        id: artifact.id,
        role: artifact.role,
        title: artifact.title,
        mediaType: artifact.media_type,
        blobPath: artifact.blob_path,
        blobHash: artifact.blob_hash,
        byteLength: artifact.byte_length,
        ...(artifact.origin_agent_id ? { originAgentId: artifact.origin_agent_id } : {}),
        ...(artifact.execution_id ? { executionId: artifact.execution_id } : {}),
      }));
      const actor: Actor = {
        kind: row.actor_kind,
        ...(row.actor_id ? { id: row.actor_id } : {}),
      };
      const hash = payloadHash({
        requestId: row.request_id,
        kind: row.kind,
        actor,
        inReplyToUpdateId: row.in_reply_to_update_id,
        payload: publicPayload,
        providerFailureCategory: category,
        artifacts: projectedArtifacts,
      });
      updateRequest.run(stableJson(publicPayload), hash, category, row.id);

      const activations = sqlite.prepare(`
        SELECT id, payload_json FROM agent_activations
        WHERE json_valid(payload_json) AND instr(payload_json, ?) > 0
      `).all(row.id) as Array<{ id: string; payload_json: string }>;
      for (const activation of activations) {
        const projected = replaceMaterializedRequestUpdate(
          JSON.parse(activation.payload_json) as unknown,
          row.id,
          publicPayload,
        );
        if (projected.changed) updateActivation.run(stableJson(projected.value), activation.id);
      }
    }
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(publicProviderRequestUpdatesMigration, new Date().toISOString());
  })();
}

/** Context rollover first shipped behind a draft qualification branch, where
 * adopted databases could receive additive columns with weaker constraints.
 * Rebuild it once under the same transactional version authority as SQL
 * extensions. Rows lacking the exact boundary/hash binding are terminally
 * failed; their old accepted provider session remains untouched. */
function establishContextRolloverAtomicitySchema(sqlite: Database.Database): void {
  const applied = sqlite
    .prepare(`SELECT 1 FROM ${schemaVersionTable} WHERE name = ?`)
    .get(contextRolloverAtomicityMigration) !== undefined;
  if (applied) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS context_rollovers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'requested', 'handoff_committed', 'session_retiring',
          'continuation_ready', 'completed', 'failed', 'outcome_unknown'
        )),
        old_provider_session_id TEXT NOT NULL,
        provider_session_generation TEXT NOT NULL,
        detected_occupancy INTEGER NOT NULL CHECK (detected_occupancy >= 0),
        aggregate_tokens INTEGER,
        threshold INTEGER NOT NULL CHECK (threshold > 0),
        context_window INTEGER,
        low_water_mark INTEGER NOT NULL CHECK (low_water_mark >= 0),
        low_water_confirmation_required INTEGER NOT NULL DEFAULT 1,
        trigger_kind TEXT NOT NULL DEFAULT 'automatic',
        compaction_cutoff_ordinal INTEGER NOT NULL DEFAULT 0,
        compaction_cutoff_event_id TEXT,
        recent_tail_event_ids_json TEXT NOT NULL DEFAULT '[]',
        recent_tail_hashes_json TEXT NOT NULL DEFAULT '[]',
        source_run_id TEXT NOT NULL,
        source_activation_ids_json TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        conversation_id TEXT,
        reply_authority_json TEXT,
        handoff_event_id TEXT,
        continuation_activation_id TEXT,
        replacement_session_id TEXT,
        replacement_run_id TEXT,
        replacement_prompt_hash TEXT,
        replacement_system_prompt_hash TEXT,
        replacement_manifest_hash TEXT,
        replacement_attempt INTEGER NOT NULL DEFAULT 0,
        visible_response_committed INTEGER NOT NULL DEFAULT 0,
        handoff_committed_at TEXT,
        session_retiring_at TEXT,
        continuation_ready_at TEXT,
        replacement_session_at TEXT,
        replacement_input_committed_at TEXT,
        replacement_verified_at TEXT,
        visible_response_committed_at TEXT,
        completion_reason TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT
      );
    `);
    const columns = new Set(
      (sqlite.pragma("table_info(context_rollovers)") as Array<{ name: string }>)
        .map((column) => column.name),
    );
    const additions: Array<[string, string]> = [
      ["compaction_cutoff_ordinal", "INTEGER NOT NULL DEFAULT 0"],
      ["compaction_cutoff_event_id", "TEXT"],
      ["recent_tail_event_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["recent_tail_hashes_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["replacement_run_id", "TEXT"],
      ["replacement_prompt_hash", "TEXT"],
      ["replacement_system_prompt_hash", "TEXT"],
      ["replacement_manifest_hash", "TEXT"],
      ["replacement_attempt", "INTEGER NOT NULL DEFAULT 0"],
      ["replacement_input_committed_at", "TEXT"],
      ["replacement_verified_at", "TEXT"],
      ["completion_reason", "TEXT"],
      ["trigger_kind", "TEXT NOT NULL DEFAULT 'automatic'"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) sqlite.exec(`ALTER TABLE context_rollovers ADD COLUMN ${name} ${definition}`);
    }
    const now = new Date().toISOString();
    // Only the newest row may own one provider generation. Older duplicate
    // draft rows remain as terminal audit evidence but cannot schedule work.
    sqlite.prepare(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY agent_id, provider_session_generation
          ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS generation_rank
        FROM context_rollovers
      )
      UPDATE context_rollovers
      SET state = 'failed',
        last_error = 'schema migration retired duplicate provider-generation ownership',
        terminal_at = COALESCE(terminal_at, ?), updated_at = ?
      WHERE id IN (SELECT id FROM ranked WHERE generation_rank > 1)
    `).run(now, now);
    // This migration only upgrades databases created by the unqualified draft
    // implementation. Those rows predate canonical order/content/scope and
    // aggregate-tail guarantees, which cannot be reconstructed from SQLite
    // alone without competing with the append-only Communication journal.
    // Retire every adopted row instead of preserving a permanently weaker
    // compatibility path; the old accepted provider snapshot remains intact.
    sqlite.prepare(`
      UPDATE context_rollovers
      SET state = 'failed',
        last_error = 'schema migration retired an unqualified draft rollover whose exact canonical authority cannot be proven',
        terminal_at = COALESCE(terminal_at, ?), updated_at = ?
      WHERE state NOT IN ('failed','outcome_unknown')
    `).run(now, now);
    sqlite.prepare(`
      UPDATE context_rollovers
      SET state = CASE
          WHEN compaction_cutoff_ordinal <= 0
            OR compaction_cutoff_event_id IS NULL
            OR CASE WHEN json_valid(recent_tail_event_ids_json) = 1
                  AND json_valid(recent_tail_hashes_json) = 1
              THEN json_array_length(recent_tail_event_ids_json) = 0
                OR json_array_length(recent_tail_event_ids_json) <> json_array_length(recent_tail_hashes_json)
              ELSE 1 END
          THEN 'failed' ELSE state END,
        last_error = CASE
          WHEN compaction_cutoff_ordinal <= 0
            OR compaction_cutoff_event_id IS NULL
            OR CASE WHEN json_valid(recent_tail_event_ids_json) = 1
                  AND json_valid(recent_tail_hashes_json) = 1
              THEN json_array_length(recent_tail_event_ids_json) = 0
                OR json_array_length(recent_tail_event_ids_json) <> json_array_length(recent_tail_hashes_json)
              ELSE 1 END
          THEN 'schema migration rejected a rollover without an exact canonical boundary and content-hash-bound tail'
          ELSE last_error END,
        terminal_at = CASE
          WHEN compaction_cutoff_ordinal <= 0
            OR compaction_cutoff_event_id IS NULL
            OR CASE WHEN json_valid(recent_tail_event_ids_json) = 1
                  AND json_valid(recent_tail_hashes_json) = 1
              THEN json_array_length(recent_tail_event_ids_json) = 0
                OR json_array_length(recent_tail_event_ids_json) <> json_array_length(recent_tail_hashes_json)
              ELSE 1 END
          THEN COALESCE(terminal_at, ?) ELSE terminal_at END,
        low_water_confirmation_required = 1,
        updated_at = CASE WHEN low_water_confirmation_required <> 1 THEN ? ELSE updated_at END
    `).run(now, now);
    sqlite.exec(`
      DROP TABLE IF EXISTS context_rollovers_atomic;
      CREATE TABLE context_rollovers_atomic (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'requested', 'handoff_committed', 'session_retiring',
          'continuation_ready', 'completed', 'failed', 'outcome_unknown'
        )),
        old_provider_session_id TEXT NOT NULL,
        provider_session_generation TEXT NOT NULL,
        detected_occupancy INTEGER NOT NULL CHECK (detected_occupancy >= 0),
        aggregate_tokens INTEGER,
        threshold INTEGER NOT NULL CHECK (threshold > 0),
        context_window INTEGER,
        low_water_mark INTEGER NOT NULL CHECK (low_water_mark >= 0),
        low_water_confirmation_required INTEGER NOT NULL DEFAULT 1 CHECK (low_water_confirmation_required = 1),
        trigger_kind TEXT NOT NULL DEFAULT 'automatic' CHECK (trigger_kind IN ('automatic','human')),
        compaction_cutoff_ordinal INTEGER NOT NULL CHECK (compaction_cutoff_ordinal >= 0),
        compaction_cutoff_event_id TEXT,
        recent_tail_event_ids_json TEXT NOT NULL,
        recent_tail_hashes_json TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        source_activation_ids_json TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        conversation_id TEXT,
        reply_authority_json TEXT,
        handoff_event_id TEXT,
        continuation_activation_id TEXT,
        replacement_session_id TEXT,
        replacement_run_id TEXT,
        replacement_prompt_hash TEXT,
        replacement_system_prompt_hash TEXT,
        replacement_manifest_hash TEXT,
        replacement_attempt INTEGER NOT NULL DEFAULT 0 CHECK (replacement_attempt >= 0),
        visible_response_committed INTEGER NOT NULL DEFAULT 0,
        handoff_committed_at TEXT,
        session_retiring_at TEXT,
        continuation_ready_at TEXT,
        replacement_session_at TEXT,
        replacement_input_committed_at TEXT,
        replacement_verified_at TEXT,
        visible_response_committed_at TEXT,
        completion_reason TEXT CHECK (completion_reason IN (
          'replacement_verified', 'native_compaction', 'no_continuation_required'
        )),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        CHECK (state IN ('failed','outcome_unknown') OR
          (compaction_cutoff_ordinal > 0 AND compaction_cutoff_event_id IS NOT NULL))
      );
      INSERT INTO context_rollovers_atomic SELECT
        id, project_id, agent_id, state, old_provider_session_id,
        provider_session_generation, detected_occupancy, aggregate_tokens,
        threshold, context_window, low_water_mark, 1, trigger_kind,
        compaction_cutoff_ordinal, compaction_cutoff_event_id,
        recent_tail_event_ids_json, recent_tail_hashes_json,
        source_run_id, source_activation_ids_json, scope_key, conversation_id,
        reply_authority_json, handoff_event_id, continuation_activation_id,
        replacement_session_id, replacement_run_id, replacement_prompt_hash,
        replacement_system_prompt_hash, replacement_manifest_hash,
        replacement_attempt, visible_response_committed, handoff_committed_at,
        session_retiring_at, continuation_ready_at, replacement_session_at,
        replacement_input_committed_at, replacement_verified_at,
        visible_response_committed_at, completion_reason, last_error,
        created_at, updated_at, terminal_at
      FROM context_rollovers;
      DROP TABLE context_rollovers;
      ALTER TABLE context_rollovers_atomic RENAME TO context_rollovers;
      CREATE INDEX idx_context_rollovers_agent_state
        ON context_rollovers (agent_id, state, updated_at DESC);
      CREATE UNIQUE INDEX idx_context_rollovers_generation_owner
        ON context_rollovers (agent_id, provider_session_generation)
        WHERE state IN (
          'requested', 'handoff_committed', 'session_retiring',
          'continuation_ready', 'completed'
        );
      CREATE UNIQUE INDEX idx_context_rollovers_continuation_activation
        ON context_rollovers (continuation_activation_id)
        WHERE continuation_activation_id IS NOT NULL;
    `);
    sqlite.prepare(`INSERT INTO ${schemaVersionTable} (name, applied_at) VALUES (?, ?)`)
      .run(contextRolloverAtomicityMigration, now);
  })();
}

/** Additive read indexes are safe to establish for both adopted and already
 * baselined databases without rewriting canonical rows. */
function establishReadIndexes(sqlite: Database.Database): void {
  const providerInputColumns = new Set(
    (sqlite.pragma("table_info(provider_inputs)") as Array<{ name: string }>)
      .map((column) => column.name),
  );
  if (!providerInputColumns.has("provider_system_prompt")) {
    sqlite.exec("ALTER TABLE provider_inputs ADD COLUMN provider_system_prompt TEXT NOT NULL DEFAULT ''");
  }
  if (!providerInputColumns.has("system_prompt_hash")) {
    sqlite.exec("ALTER TABLE provider_inputs ADD COLUMN system_prompt_hash TEXT NOT NULL DEFAULT ''");
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS compaction_history_messages (
      project_id TEXT NOT NULL,
      communication_event_id TEXT NOT NULL,
      canonical_ordinal INTEGER NOT NULL,
      conversation_id TEXT,
      created_at TEXT NOT NULL,
      revision_event_id TEXT,
      edited_at TEXT,
      content_sha256 TEXT NOT NULL,
      text TEXT NOT NULL,
      communication_intent TEXT NOT NULL DEFAULT '',
      context_policy TEXT NOT NULL DEFAULT '',
      sender_kind TEXT NOT NULL DEFAULT '',
      sender_agent_id TEXT,
      PRIMARY KEY (project_id, communication_event_id)
    );
  `);
  const historyColumns = new Set(
    (sqlite.pragma("table_info(compaction_history_messages)") as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const [name, declaration] of [
    ["communication_intent", "TEXT NOT NULL DEFAULT ''"],
    ["context_policy", "TEXT NOT NULL DEFAULT ''"],
    ["sender_kind", "TEXT NOT NULL DEFAULT ''"],
    ["sender_agent_id", "TEXT"],
  ] as const) {
    if (!historyColumns.has(name)) {
      sqlite.exec(`ALTER TABLE compaction_history_messages ADD COLUMN ${name} ${declaration}`);
    }
  }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_compaction_history_messages_boundary
      ON compaction_history_messages (project_id, canonical_ordinal);
    CREATE INDEX IF NOT EXISTS idx_compaction_history_messages_conversation_ordinal
      ON compaction_history_messages (project_id, conversation_id, canonical_ordinal);
    CREATE TABLE IF NOT EXISTS compaction_history_agent_participants (
      project_id TEXT NOT NULL,
      communication_event_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (project_id, communication_event_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS compaction_history_relation_candidates (
      project_id TEXT NOT NULL,
      communication_event_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      canonical_ordinal INTEGER NOT NULL,
      authority_agent_id TEXT NOT NULL,
      PRIMARY KEY (project_id, communication_event_id, authority_agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_history_relation_candidates_lookup
      ON compaction_history_relation_candidates (
        project_id, conversation_id, authority_agent_id, canonical_ordinal DESC
      );
    CREATE VIRTUAL TABLE IF NOT EXISTS compaction_history_fts USING fts5(
      project_id UNINDEXED,
      communication_event_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    );
    CREATE INDEX IF NOT EXISTS idx_coordination_request_updates_request_created
      ON coordination_request_updates (request_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_coordination_requests_communication
      ON coordination_requests (project_id, communication_event_id, created_at, id);
    CREATE INDEX IF NOT EXISTS coordination_requests_attention
      ON coordination_requests (updated_at DESC, id DESC)
      WHERE state IN ('blocked', 'failed', 'outcome_unknown', 'expired', 'recipient_unavailable');
    CREATE INDEX IF NOT EXISTS coordination_joins_attention
      ON coordination_joins (updated_at DESC, id DESC)
      WHERE state IN ('impossible', 'expired');
    CREATE INDEX IF NOT EXISTS trigger_occurrences_attention
      ON trigger_occurrences (updated_at DESC, id DESC)
      WHERE state = 'dead_lettered';
    CREATE INDEX IF NOT EXISTS agent_activations_communication_attention
      ON agent_activations (updated_at DESC, id DESC)
      WHERE state IN ('failed', 'outcome_unknown')
        AND kind IN ('human_message', 'urgent_message', 'ordinary_message');
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_owner
      ON runtime_artifacts (owner_kind, owner_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_projects_directory
      ON projects (last_used_at DESC, created_at DESC, label, id);
    CREATE INDEX IF NOT EXISTS idx_conversations_project_directory
      ON conversations (project_id, updated_at DESC, title, id);
    CREATE INDEX IF NOT EXISTS idx_agents_project_directory
      ON agents (project_id, deleted_at, archived, updated_at DESC, title, id);
    CREATE INDEX IF NOT EXISTS idx_trigger_definitions_project_directory
      ON trigger_definitions (project_id, updated_at DESC, name, id);
    CREATE INDEX IF NOT EXISTS idx_trigger_definitions_agent_directory
      ON trigger_definitions (agent_id, updated_at DESC, name, id);
  `);
}

/**
 * Open (or create) the projection DB at `file` and establish its launch schema.
 * Pass ":memory:" for isolated callers.
 */
export function openDb(file: string): OpenedDb {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  establishSchema(sqlite);
  establishContextRolloverAtomicitySchema(sqlite);
  establishSchemaExtensions(sqlite);
  establishPublicProviderRequestUpdates(sqlite);
  establishReadIndexes(sqlite);
  return { db: drizzle(sqlite, { schema }), client: sqlite };
}
