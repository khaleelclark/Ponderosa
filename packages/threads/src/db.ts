// Open the SQLite projection DB (better-sqlite3) and apply migrations. Synchronous
// throughout — ideal for a single-node daemon (SPEC §6). Drizzle wraps it for
// type-safe queries; migrations are plain .sql applied by a tiny idempotent runner.

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

/** The drizzle db plus the raw better-sqlite3 handle (for close()/pragmas). */
export interface OpenedDb {
  db: Db;
  client: Database.Database;
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Apply any not-yet-applied .sql migrations, tracked in `_migrations`. */
function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`,
  );
  const applied = new Set<string>(
    sqlite.prepare(`SELECT name FROM _migrations`).all().map((r) => (r as { name: string }).name),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const insert = sqlite.prepare(
    `INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`,
  );
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    sqlite.transaction(() => {
      sqlite.exec(sql);
      insert.run(file, new Date().toISOString());
    })();
  }
}

/**
 * Open (or create) the projection DB at `file` and bring the schema up to date.
 * Pass ":memory:" for tests.
 */
export function openDb(file: string): OpenedDb {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  return { db: drizzle(sqlite, { schema }), client: sqlite };
}
