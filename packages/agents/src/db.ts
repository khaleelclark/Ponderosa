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

/** Additive read indexes are safe to establish for both adopted and already
 * baselined databases without rewriting canonical rows. */
function establishReadIndexes(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_coordination_request_updates_request_created
      ON coordination_request_updates (request_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_owner
      ON runtime_artifacts (owner_kind, owner_id, created_at, id);
  `);
}

/** Additive columns preserve existing launch-baseline databases without
 * rebuilding canonical projections. */
function establishAdditiveSchema(sqlite: Database.Database): void {
  const projectColumns = sqlite
    .prepare("PRAGMA table_info(projects)")
    .all() as Array<{ name: string }>;
  if (!projectColumns.some((column) => column.name === "provider_permission_mode")) {
    sqlite.exec(
      "ALTER TABLE projects ADD COLUMN provider_permission_mode TEXT NOT NULL DEFAULT 'inherit'",
    );
  }
  const conversationColumns = sqlite
    .prepare("PRAGMA table_info(conversations)")
    .all() as Array<{ name: string }>;
  if (!conversationColumns.some((column) => column.name === "provider_permission_mode")) {
    sqlite.exec(
      "ALTER TABLE conversations ADD COLUMN provider_permission_mode TEXT NOT NULL DEFAULT 'ask'",
    );
  }
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
  establishAdditiveSchema(sqlite);
  establishReadIndexes(sqlite);
  return { db: drizzle(sqlite, { schema }), client: sqlite };
}
