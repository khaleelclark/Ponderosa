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
    "high-card-project",
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

describe("coordination attention record candidates", () => {
  it("selects exact coordination records without standalone Activation or Run failures", () => {
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

    expect(store.coordinationAttentionCandidates()).toEqual([
      {
        kind: "request",
        recordId: "failed-request",
        projectId: "request-project",
        agentId: "request-project-agent",
        updatedAt: NOW,
      },
      {
        kind: "join",
        recordId: "expired-join",
        projectId: "join-project",
        agentId: "join-project-agent",
        updatedAt: NOW,
      },
      {
        kind: "trigger",
        recordId: "dead-trigger",
        projectId: "trigger-project",
        agentId: "trigger-project-agent",
        updatedAt: NOW,
      },
    ]);
    const first = store.coordinationAttentionCandidates(1);
    const second = store.coordinationAttentionCandidates(1, {
      updatedAt: first[0]!.updatedAt,
      kind: first[0]!.kind,
      recordId: first[0]!.recordId,
    });
    const third = store.coordinationAttentionCandidates(1, {
      updatedAt: second[0]!.updatedAt,
      kind: second[0]!.kind,
      recordId: second[0]!.recordId,
    });
    expect([first[0]?.kind, second[0]?.kind, third[0]?.kind]).toEqual([
      "request",
      "join",
      "trigger",
    ]);
  });

  it("paginates exact candidates beyond the reconciliation page size", () => {
    const { sqlite, store } = fixture();
    const insertRequest = sqlite.prepare(`
      INSERT INTO coordination_requests (
        id, project_id, recipient_agent_id, payload_json, state,
        lifetime_kind, created_at, updated_at
      ) VALUES (?, 'high-card-project', 'high-card-project-agent', '{}',
        'failed', 'indefinite', ?, ?)
    `);
    sqlite.transaction(() => {
      for (let index = 0; index < 201; index += 1) {
        insertRequest.run(`failed-${index.toString().padStart(3, "0")}`, NOW, NOW);
      }
    })();

    const first = store.coordinationAttentionCandidates(200);
    const last = first.at(-1)!;
    const second = store.coordinationAttentionCandidates(200, {
      updatedAt: last.updatedAt,
      kind: last.kind,
      recordId: last.recordId,
    });

    expect(first).toHaveLength(200);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((candidate) => candidate.recordId)).size).toBe(201);
    expect(second[0]?.recordId).toBe("failed-000");
  });

  it("focuses an old failure even when more than 200 active Requests are newer", () => {
    const { sqlite, store } = fixture();
    const insertRequest = sqlite.prepare(`
      INSERT INTO coordination_requests (
        id, project_id, recipient_agent_id, payload_json, state,
        lifetime_kind, created_at, updated_at
      ) VALUES (?, 'high-card-project', 'high-card-project-agent', '{}',
        ?, 'indefinite', ?, ?)
    `);
    const older = "2025-12-31T23:59:59.000Z";
    insertRequest.run("old-failure", "failed", older, older);
    sqlite.transaction(() => {
      for (let index = 0; index < 201; index += 1) {
        insertRequest.run(`open-${index.toString().padStart(3, "0")}`, "open", NOW, NOW);
      }
    })();

    const [candidate] = store.coordinationAttentionCandidates(200);
    expect(candidate).toMatchObject({
      kind: "request",
      recordId: "old-failure",
      agentId: "high-card-project-agent",
    });
    const projection = store.agentWorkItems({
      projectId: candidate!.projectId,
      agentId: candidate!.agentId,
      focusId: `${candidate!.kind}:${candidate!.recordId}`,
      limit: 200,
    });

    expect(projection.items).toContainEqual(expect.objectContaining({
      id: "request:old-failure",
      state: "failed",
    }));
  });
});
