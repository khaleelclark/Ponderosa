import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("context rollover schema migration", () => {
  it("transactionally strengthens legacy rows and reconciles generation ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "ponderosa-rollover-schema-"));
    directories.push(root);
    const file = join(root, "agents.sqlite");
    const opened = openDb(file);
    opened.client.prepare(`
      INSERT INTO context_rollovers (
        id, project_id, agent_id, state, old_provider_session_id,
        provider_session_generation, detected_occupancy, threshold,
        low_water_mark, compaction_cutoff_ordinal, compaction_cutoff_event_id,
        recent_tail_event_ids_json, recent_tail_hashes_json, source_run_id,
        source_activation_ids_json, scope_key, created_at, updated_at
      ) VALUES (
        'owner-new', 'project', 'agent', 'requested', 'old-session',
        'generation', 80000, 75000, 25000, 1, 'tail-event',
        '["tail-event"]', ?, 'source-run', '[]', 'scope', ?, ?
      )
    `).run(`["${"a".repeat(64)}"]`, "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    opened.client.close();

    const weak = new Database(file);
    weak.exec(`
      DROP INDEX IF EXISTS idx_context_rollovers_agent_state;
      DROP INDEX IF EXISTS idx_context_rollovers_generation_owner;
      DROP INDEX IF EXISTS idx_context_rollovers_continuation_activation;
      CREATE TABLE context_rollovers_weak AS SELECT * FROM context_rollovers;
      DROP TABLE context_rollovers;
      ALTER TABLE context_rollovers_weak RENAME TO context_rollovers;
      INSERT INTO context_rollovers SELECT * FROM context_rollovers WHERE id = 'owner-new';
    `);
    weak.prepare(`
      UPDATE context_rollovers SET id = 'owner-old', created_at = ?, updated_at = ?
      WHERE rowid = (SELECT MAX(rowid) FROM context_rollovers)
    `).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    weak.exec(`
      INSERT INTO context_rollovers SELECT * FROM context_rollovers WHERE id = 'owner-new';
      UPDATE context_rollovers SET id = 'legacy-invalid', provider_session_generation = 'legacy-generation',
        low_water_confirmation_required = 0, compaction_cutoff_ordinal = 0,
        compaction_cutoff_event_id = NULL, recent_tail_event_ids_json = '[]',
        recent_tail_hashes_json = '[]'
      WHERE rowid = (SELECT MAX(rowid) FROM context_rollovers);
      DELETE FROM _schema_version WHERE name = '0005_context_rollover_atomicity.ts';
    `);
    weak.close();

    const migrated = openDb(file);
    expect(migrated.client.prepare(`
      SELECT state, last_error FROM context_rollovers WHERE id = 'owner-old'
    `).get()).toMatchObject({
      state: "failed",
      last_error: "schema migration retired duplicate provider-generation ownership",
    });
    expect(migrated.client.prepare(`
      SELECT state, last_error FROM context_rollovers WHERE id = 'owner-new'
    `).get()).toMatchObject({
      state: "failed",
      last_error: "schema migration retired an unqualified draft rollover whose exact canonical authority cannot be proven",
    });
    expect(migrated.client.prepare(`
      SELECT state, low_water_confirmation_required AS confirmation, last_error
      FROM context_rollovers WHERE id = 'legacy-invalid'
    `).get()).toMatchObject({
      state: "failed",
      confirmation: 1,
      last_error: "schema migration rejected a rollover without an exact canonical boundary and content-hash-bound tail",
    });
    expect((migrated.client.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'context_rollovers'
    `).get() as { sql: string }).sql).toContain("low_water_confirmation_required = 1");
    expect(migrated.client.prepare(`
      SELECT 1 AS applied FROM _schema_version WHERE name = '0005_context_rollover_atomicity.ts'
    `).get()).toEqual({ applied: 1 });
    migrated.client.close();
  });
});
