import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { CoordinationV3Store } from "./coordination-v3-store.js";
import { openDb } from "./db.js";

const NOW = "2026-01-01T00:00:00.000Z";
const clients: Database.Database[] = [];

afterEach(() => {
  while (clients.length) clients.pop()!.close();
});

describe("communication attention activations", () => {
  it("includes provider outcome uncertainty without requiring a delivery terminal outcome", () => {
    const { client: sqlite } = openDb(":memory:");
    clients.push(sqlite);
    sqlite.prepare(`
      INSERT INTO runtime_communications (
        id, project_id, sender_json, intent, audience_json, payload_json,
        payload_hash, actionable, created_at
      ) VALUES (?, ?, '{}', 'user_dm', '{}', ?, 'hash', 1, ?)
    `).run(
      "dispatch:communication-1:agent-1",
      "project-1",
      JSON.stringify({ communication: { eventId: "communication-1" } }),
      NOW,
    );
    sqlite.prepare(`
      INSERT INTO agent_activations (
        id, project_id, agent_id, kind, priority, dispatch_policy,
        prompt_class, state, dedupe_key, payload_json, available_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'human_message', 100, 'steer_or_run',
        'human', 'outcome_unknown', ?, '{}', ?, ?, ?)
    `).run("activation-1", "project-1", "agent-1", "activation-1", NOW, NOW, NOW);
    sqlite.prepare(`
      INSERT INTO activation_sources (activation_id, source_kind, source_id)
      VALUES ('activation-1', 'communication', 'dispatch:communication-1:agent-1')
    `).run();

    const store = new CoordinationV3Store(sqlite);
    expect(store.communicationAttentionActivations()).toEqual([{
      id: "activation-1",
      projectId: "project-1",
      agentId: "agent-1",
      kind: "human_message",
      state: "outcome_unknown",
      communicationEventId: "communication-1",
      communicationIntent: "user_dm",
      deliveryFailures: 0,
      updatedAt: NOW,
    }]);
    expect(store.terminalActivationDisposition("activation-1")).toEqual({
      id: "activation-1",
      state: "outcome_unknown",
      supersededByRetry: false,
    });
  });
});
