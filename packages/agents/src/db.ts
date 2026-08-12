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
] as const;
const legacyMigrationTable = "_migrations";
const schemaVersionTable = "_schema_version";
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
      source_run_id TEXT NOT NULL,
      source_activation_ids_json TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      conversation_id TEXT,
      reply_authority_json TEXT,
      handoff_event_id TEXT,
      continuation_activation_id TEXT,
      replacement_session_id TEXT,
      visible_response_committed INTEGER NOT NULL DEFAULT 0,
      handoff_committed_at TEXT,
      session_retiring_at TEXT,
      continuation_ready_at TEXT,
      replacement_session_at TEXT,
      visible_response_committed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_context_rollovers_agent_state
      ON context_rollovers (agent_id, state, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_context_rollovers_generation_owner
      ON context_rollovers (agent_id, provider_session_generation)
      WHERE state IN (
        'requested', 'handoff_committed', 'session_retiring',
        'continuation_ready', 'completed'
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_context_rollovers_continuation_activation
      ON context_rollovers (continuation_activation_id)
      WHERE continuation_activation_id IS NOT NULL;
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
  establishSchemaExtensions(sqlite);
  establishReadIndexes(sqlite);
  return { db: drizzle(sqlite, { schema }), client: sqlite };
}
