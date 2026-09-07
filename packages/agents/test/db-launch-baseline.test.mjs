import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import { openDb } from "../dist/index.js";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-db-baseline-"));
  temporaryDirectories.push(directory);
  return join(directory, "agents.sqlite");
}

test("creates the canonical launch baseline for a fresh database", () => {
  const { client } = openDb(temporaryDatabase());
  try {
    assert.deepEqual(
      client.prepare("SELECT name FROM _schema_version ORDER BY name").all().map(row => row.name),
      [
        "0000_current_schema.sql",
        "0001_communication_v4_next_run_deliveries.sql",
        "0002_provider_process_authority.sql",
        "0003_collection_generations.sql",
        "0004_run_output_segments.sql",
        "0005_context_rollover_atomicity.ts",
        "0005_required_reply_obligations.sql",
        "0006_delivery_idempotency.sql",
        "0007_structured_provider_failure_state.sql",
        "0008_public_activation_provider_failures.sql",
        "0009_agent_creation_operations.sql",
        "0009_public_provider_request_updates.ts",
        "0010_agent_creation_artifact_identities.sql",
        "0010_provider_activation_execution_payloads.ts",
        "0011_agent_management_plans.sql",
        "0011_nested_provider_activation_execution_payloads.ts",
        "0012_context_rollover_failure_provenance.ts",
        "0012_conversation_deletion_receipts.sql",
        "0013_working_copy_authority.ts",
        "0014_project_deletion_ownership.ts",
        "0015_deletion_recovery_phases.ts",
        "0016_conversation_deletion_precommit.ts",
      ],
    );
  } finally {
    client.close();
  }
});

test("preserves and rejects a pre-baseline application database", () => {
  const file = temporaryDatabase();
  const old = new Database(file);
  old.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY);");
  old.prepare("INSERT INTO projects(id) VALUES (?)").run("important-project");
  old.close();

  assert.throws(() => openDb(file), /without the required launch baseline/u);

  const preserved = new Database(file, { readonly: true });
  try {
    assert.equal(preserved.prepare("SELECT id FROM projects").pluck().get(), "important-project");
  } finally {
    preserved.close();
  }
});
