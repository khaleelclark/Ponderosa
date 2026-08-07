import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

const BASELINE = "0000_current_schema.sql";
const NEXT_RUN_EXTENSION = "0001_communication_v4_next_run_deliveries.sql";

function withDatabase(run: (file: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-db-upgrade-"));
  try {
    run(join(directory, "state.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("SQLite schema extensions", () => {
  it("creates the current next-run schema and records its explicit extension on a fresh database", () => {
    withDatabase((file) => {
      const opened = openDb(file);
      try {
        expect(opened.client.prepare(`
          SELECT name FROM _schema_version ORDER BY name
        `).all()).toEqual([
          { name: BASELINE },
          { name: NEXT_RUN_EXTENSION },
        ]);
        expect(opened.client.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'communication_v4_next_run%'
          ORDER BY name
        `).all()).toEqual([
          { name: "communication_v4_next_run_deliveries" },
          { name: "communication_v4_next_run_recipients" },
        ]);

        opened.client.prepare(`
          INSERT INTO communication_v4_next_run_deliveries (
            id, project_id, conversation_id, publisher_kind, publisher_agent_id,
            publisher_user_id, publisher_label, source_run_id, idempotency_key, payload_hash,
            text, recipient_agent_ids_json, created_at
          ) VALUES (
            'fresh-delivery', 'fresh-project', 'fresh-chat', 'agent', 'publisher',
            NULL, 'Publisher', 'source-run', 'fresh-key', 'hash',
            'fresh state', '["recipient"]',
            '2026-08-07T00:00:00.000Z'
          )
        `).run();
        expect(() => opened.client.prepare(`
          INSERT INTO communication_v4_next_run_recipients (
            delivery_id, agent_id, recipient_label, state, created_at, expired_at
          ) VALUES (
            'fresh-delivery', 'recipient', 'Recipient', 'expired',
            '2026-08-07T00:00:00.000Z', '2026-08-07T00:01:00.000Z'
          )
        `).run()).not.toThrow();
        expect(() => opened.client.prepare(`
          INSERT INTO communication_v4_next_run_deliveries (
            id, project_id, conversation_id, publisher_kind, publisher_agent_id,
            publisher_user_id, publisher_label, source_run_id, idempotency_key, payload_hash,
            text, recipient_agent_ids_json, created_at
          ) VALUES (
            'invalid-operator-delivery', 'fresh-project', 'fresh-chat', 'operator', 'publisher',
            'local-operator', 'Operator', 'source-run', 'invalid-key', 'hash',
            'invalid publisher authority', '["recipient"]',
            '2026-08-07T00:00:00.000Z'
          )
        `).run()).toThrow();
      } finally {
        opened.client.close();
      }
    });
  });
});
