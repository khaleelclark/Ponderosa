import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationV3Store } from "./coordination-v3-store.js";
import { openDb } from "./db.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("structured provider failure migration", () => {
  it("backfills historical activation errors and keeps legacy Agent Work reads marker-free", () => {
    const root = mkdtempSync(join(tmpdir(), "ponderosa-provider-failure-migration-"));
    directories.push(root);
    const database = join(root, "agents.sqlite");
    const opened = openDb(database);
    const marker = "HISTORICAL_ACTIVATION_RAW_MARKER_4e18 access_token=private-activation-token";
    const now = "2026-08-14T00:00:00.000Z";
    opened.client.prepare(`
      INSERT INTO agent_activations (
        id, project_id, agent_id, kind, priority, dispatch_policy,
        prompt_class, state, dedupe_key, payload_json, scope_key,
        available_at, created_at, updated_at, delivery_failures,
        last_delivery_error, terminal_outcome, terminal_at
      ) VALUES (
        'activation-legacy-provider', 'project-provider', 'agent-provider',
        'human_message', 100, 'steer_or_run', 'human', 'failed',
        'legacy-provider-failure', '{}', 'conversation:conversation-provider',
        ?, ?, ?, 1, ?, 'permanent_failure', ?
      )
    `).run(now, now, now, marker, now);
    opened.client.prepare(`
      INSERT INTO scheduler_runs (
        id, project_id, agent_id, status, lease_owner, lease_expires_at,
        fencing_token, prompt_injection_state, heartbeat_at, created_at,
        updated_at, terminal_at, scope_key, context_disposition,
        provider_failure_json
      ) VALUES (
        'run-legacy-provider', 'project-provider', 'agent-provider', 'failed',
        'legacy-worker', ?, 1, 'not_injected', ?, ?, ?, ?,
        'conversation:conversation-provider', 'fresh_task', ?
      )
    `).run(now, now, now, now, now, JSON.stringify({
      category: "authentication",
      message: marker,
    }));
    opened.client.prepare(`
      INSERT INTO scheduler_run_activations (run_id, activation_id, attached_at)
      VALUES ('run-legacy-provider', 'activation-legacy-provider', ?)
    `).run(now);
    opened.client.prepare(`
      DELETE FROM _schema_version
      WHERE name = '0008_public_activation_provider_failures.sql'
    `).run();
    opened.client.close();

    const migrated = openDb(database);
    expect(migrated.client.prepare(`
      SELECT provider_failure_category, last_delivery_error
      FROM agent_activations WHERE id = 'activation-legacy-provider'
    `).get()).toEqual({
      provider_failure_category: "authentication",
      last_delivery_error: "Provider authentication was rejected.",
    });
    expect(migrated.client.prepare(`
      SELECT 1 AS applied FROM _schema_version
      WHERE name = '0008_public_activation_provider_failures.sql'
    `).get()).toEqual({ applied: 1 });

    const coordination = new CoordinationV3Store(migrated.client);
    const migratedReads = JSON.stringify({
      terminal: coordination.terminalActivations("project-provider"),
      activation: coordination.agentWorkItemDetails({
        projectId: "project-provider",
        recordId: "activation-legacy-provider",
        kind: "activation",
      }),
      run: coordination.agentWorkItemDetails({
        projectId: "project-provider",
        recordId: "run-legacy-provider",
        kind: "run",
      }),
    });
    expect(migratedReads).toContain("Provider authentication was rejected.");
    expect(migratedReads).not.toMatch(
      /HISTORICAL_ACTIVATION_RAW_MARKER_4e18|private-activation-token|access_token/u,
    );

    const defenseMarker = "POST_MIGRATION_LEGACY_RAW_MARKER_773c refresh_token=private-defense-token";
    migrated.client.prepare(`
      UPDATE agent_activations
      SET provider_failure_category = NULL, last_delivery_error = ?
      WHERE id = 'activation-legacy-provider'
    `).run(defenseMarker);
    const defendedReads = JSON.stringify({
      terminal: coordination.terminalActivations("project-provider"),
      activation: coordination.agentWorkItemDetails({
        projectId: "project-provider",
        recordId: "activation-legacy-provider",
        kind: "activation",
      }),
      run: coordination.agentWorkItemDetails({
        projectId: "project-provider",
        recordId: "run-legacy-provider",
        kind: "run",
      }),
    });
    expect(defendedReads).toContain("Provider execution failed.");
    expect(defendedReads).toContain("Provider authentication was rejected.");
    expect(defendedReads).not.toMatch(
      /POST_MIGRATION_LEGACY_RAW_MARKER_773c|private-defense-token|refresh_token/u,
    );
    migrated.client.close();
  });
});
