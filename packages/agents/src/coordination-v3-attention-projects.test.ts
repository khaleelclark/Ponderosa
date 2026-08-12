import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { CoordinationV3Store } from "./coordination-v3-store.js";
import { openDb } from "./db.js";

const NOW = "2026-01-01T00:00:00.000Z";
const clients: Database.Database[] = [];

afterEach(() => {
  while (clients.length) clients.pop()!.close();
});

function fixture(): { sqlite: Database.Database; store: CoordinationV3Store } {
  const { client: sqlite } = openDb(":memory:");
  clients.push(sqlite);
  const insertProject = sqlite.prepare(`
    INSERT INTO projects (id, label, host_path, created_at, default_engine)
    VALUES (?, ?, ?, ?, 'codex')
  `);
  const insertConversation = sqlite.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at)
    VALUES (?, ?, 'Chat', ?, ?)
  `);
  const insertAgent = sqlite.prepare(`
    INSERT INTO agents (
      id, project_id, conversation_id, title, active_engine, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'codex', ?, ?)
  `);
  for (const projectId of [
    "activation-project",
    "join-project",
    "request-project",
    "run-project",
    "safe-project",
    "trigger-project",
  ]) {
    const conversationId = `${projectId}-conversation`;
    insertProject.run(projectId, projectId, `/tmp/${projectId}`, NOW);
    insertConversation.run(conversationId, projectId, NOW, NOW);
    insertAgent.run(
      `${projectId}-agent`,
      projectId,
      conversationId,
      projectId,
      NOW,
      NOW,
    );
  }
  return { sqlite, store: new CoordinationV3Store(sqlite) };
}

describe("coordination attention project candidates", () => {
  it("selects every canonical attention state while excluding healthy history", () => {
    const { sqlite, store } = fixture();
    sqlite.prepare(`
      INSERT INTO coordination_requests (
        id, project_id, recipient_agent_id, payload_json, state,
        lifetime_kind, created_at, updated_at
      ) VALUES (?, ?, ?, '{}', ?, 'indefinite', ?, ?)
    `).run(
      "failed-request",
      "request-project",
      "request-project-agent",
      "blocked",
      NOW,
      NOW,
    );
    sqlite.prepare(`
      INSERT INTO coordination_joins (
        id, project_id, owner_agent_id, mode, quorum,
        satisfying_outcomes_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, 'all', 1, '["completed"]', ?, ?, ?)
    `).run(
      "expired-join",
      "join-project",
      "join-project-agent",
      "expired",
      NOW,
      NOW,
    );
    sqlite.prepare(`
      INSERT INTO agent_activations (
        id, project_id, agent_id, kind, priority, dispatch_policy,
        prompt_class, state, dedupe_key, payload_json, available_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'ordinary_message', 1, 'next_run',
        'ordinary', ?, ?, '{}', ?, ?, ?)
    `).run(
      "failed-activation",
      "activation-project",
      "activation-project-agent",
      "outcome_unknown",
      "failed-activation",
      NOW,
      NOW,
      NOW,
    );
    sqlite.prepare(`
      INSERT INTO scheduler_runs (
        id, project_id, agent_id, status, lease_owner, lease_expires_at,
        fencing_token, prompt_injection_state, heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'worker', ?, 1, 'not_injected', ?, ?, ?)
    `).run(
      "failed-run",
      "run-project",
      "run-project-agent",
      "failed",
      NOW,
      NOW,
      NOW,
      NOW,
    );
    sqlite.prepare(`
      INSERT INTO trigger_occurrences (
        id, trigger_id, occurrence_key, project_id, agent_id, scope_key,
        payload_json, provenance_json, input_hash, activation_config_json,
        state, available_at, occurred_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', '{}', '{}', ?, '{}', ?, ?, ?, ?, ?)
    `).run(
      "dead-trigger",
      "trigger",
      "occurrence",
      "trigger-project",
      "trigger-project-agent",
      "hash",
      "dead_lettered",
      NOW,
      NOW,
      NOW,
      NOW,
    );
    sqlite.prepare(`
      INSERT INTO coordination_requests (
        id, project_id, recipient_agent_id, payload_json, state,
        lifetime_kind, created_at, updated_at
      ) VALUES (?, ?, ?, '{}', 'completed', 'indefinite', ?, ?)
    `).run(
      "completed-request",
      "safe-project",
      "safe-project-agent",
      NOW,
      NOW,
    );

    expect(store.coordinationAttentionProjectIds()).toEqual([
      "activation-project",
      "join-project",
      "request-project",
      "run-project",
      "trigger-project",
    ]);
  });
});
