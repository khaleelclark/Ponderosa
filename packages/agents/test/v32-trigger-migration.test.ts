import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach((entry) => rmSync(entry, { recursive: true, force: true })));

describe("V3.2 Trigger migration", () => {
  it("fails closed for legacy pending intake that has no user-owned definition", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-v32-migration-"));
    cleanup.push(directory);
    const file = join(directory, "ponderosa.db");
    const sqlite = new Database(file);
    sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const migrations = join(dirname(fileURLToPath(import.meta.url)), "../src/migrations");
    for (const name of readdirSync(migrations).filter((entry) => entry.endsWith(".sql") && entry < "0015_v32_triggers.sql").sort()) {
      sqlite.exec(readFileSync(join(migrations, name), "utf8"));
      sqlite.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(name, "2026-07-16T00:00:00.000Z");
    }
    sqlite.prepare(`INSERT INTO projects (id, label, host_path, created_at, default_engine) VALUES ('project', 'P', '/repo', ?, 'codex')`)
      .run("2026-07-16T00:00:00.000Z");
    sqlite.prepare(`
      INSERT INTO agents (id, project_id, title, active_engine, created_at, updated_at, archived)
      VALUES ('agent', 'project', 'A', 'codex', ?, ?, 0)
    `).run("2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z");
    sqlite.prepare(`
      INSERT INTO trigger_occurrences (
        id, trigger_id, occurrence_key, project_id, agent_id, scope_key,
        payload_json, provenance_json, input_hash, activation_config_json,
        state, attempts, available_at, occurred_at, created_at, updated_at
      ) VALUES ('legacy', 'legacy-trigger', 'event', 'project', 'agent', 'agent:agent',
        '{}', '{"source":"legacy"}', 'hash', '{}', 'pending', 0, ?, ?, ?, ?)
    `).run(
      "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z",
    );
    sqlite.close();

    const migrated = openDb(file);
    try {
      expect(migrated.client.prepare(`SELECT state, cancelled_at FROM trigger_occurrences WHERE id = 'legacy'`).get())
        .toEqual({ state: "cancelled", cancelled_at: "2026-07-16T00:00:00.000Z" });
      expect(migrated.client.prepare(`SELECT COUNT(*) AS count FROM trigger_definitions`).get()).toEqual({ count: 0 });
    } finally {
      migrated.client.close();
    }
  });
});
