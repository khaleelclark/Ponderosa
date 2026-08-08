import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { CoordinationV3Store } from "./coordination-v3-store.js";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = "project-1";
const CONVERSATION_ID = "conversation-1";
const REQUESTER_ID = "requester";
const RECIPIENT_ID = "recipient";
const SCOPE_KEY = `conversation:${CONVERSATION_ID}`;

const clients: Database.Database[] = [];
afterEach(() => {
  while (clients.length) clients.pop()!.close();
});

function storeFixture(): {
  sqlite: Database.Database;
  store: CoordinationV3Store;
} {
  const { client: sqlite } = openDb(":memory:");
  clients.push(sqlite);
  sqlite.prepare(`
    INSERT INTO projects (id, label, host_path, created_at, default_engine)
    VALUES (?, 'Project', '/tmp/project', ?, 'codex')
  `).run(PROJECT_ID, NOW);
  sqlite.prepare(`
    INSERT INTO conversations (id, project_id, title, created_at, updated_at)
    VALUES (?, ?, 'Chat', ?, ?)
  `).run(CONVERSATION_ID, PROJECT_ID, NOW, NOW);
  const insertAgent = sqlite.prepare(`
    INSERT INTO agents (
      id, project_id, conversation_id, title, active_engine,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'codex', ?, ?)
  `);
  insertAgent.run(
    REQUESTER_ID,
    PROJECT_ID,
    CONVERSATION_ID,
    "Requester",
    NOW,
    NOW,
  );
  insertAgent.run(
    RECIPIENT_ID,
    PROJECT_ID,
    CONVERSATION_ID,
    "Recipient",
    NOW,
    NOW,
  );
  const insertMembership = sqlite.prepare(`
    INSERT INTO agent_conversation_memberships (
      agent_id, conversation_id, position
    ) VALUES (?, ?, ?)
  `);
  insertMembership.run(REQUESTER_ID, CONVERSATION_ID, 0);
  insertMembership.run(RECIPIENT_ID, CONVERSATION_ID, 1);
  return { sqlite, store: new CoordinationV3Store(sqlite) };
}

function retireRollover(input: {
  store: CoordinationV3Store;
  sourceRunId: string;
  sourceActivationIds: string[];
  replyAuthority?: { intent: "direct_to_user" };
}): string {
  const requested = input.store.requestContextRollover({
    projectId: PROJECT_ID,
    agentId: RECIPIENT_ID,
    oldProviderSessionId: "provider-old",
    providerSessionGeneration: "generation-1",
    detectedOccupancy: 80_000,
    threshold: 75_000,
    lowWaterMark: 25_000,
    sourceRunId: input.sourceRunId,
    sourceActivationIds: input.sourceActivationIds,
    scopeKey: SCOPE_KEY,
    conversationId: CONVERSATION_ID,
    ...(input.replyAuthority
      ? { replyAuthority: input.replyAuthority }
      : {}),
    now: NOW,
  });
  input.store.commitContextRolloverHandoff(
    requested.rollover.id,
    `handoff:${requested.rollover.id}`,
    NOW,
  );
  input.store.beginContextRolloverRetirement(requested.rollover.id, NOW);
  return requested.rollover.id;
}

function requestSourceFixture(): ReturnType<typeof storeFixture> & {
  requestId: string;
  sourceRunId: string;
  sourceActivationIds: string[];
} {
  const fixture = storeFixture();
  const requestId = fixture.store.coordinate({
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    requesterAgentId: REQUESTER_ID,
    actorScope: `agent:${REQUESTER_ID}`,
    idempotencyKey: "request-1",
    requests: [{
      recipientAgentId: RECIPIENT_ID,
      lifetime: { kind: "indefinite" },
      payload: { text: "work" },
    }],
  }, NOW).requestIds[0]!;
  const lease = fixture.store.leaseNextRun({ workerId: "worker", now: NOW });
  if (!lease) throw new Error("source Run was not leased");
  return {
    ...fixture,
    requestId,
    sourceRunId: lease.runId,
    sourceActivationIds: lease.activationIds,
  };
}

describe("context rollover continuation obligations", () => {
  it("completes a rollover without manufacturing work for a terminal inbound Request", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });
    fixture.store.updateRequest({
      requestId: fixture.requestId,
      updateId: "completed-1",
      kind: "completed",
      actor: { kind: "agent", id: RECIPIENT_ID },
      payload: { text: "done" },
      now: NOW,
    });

    const completed = fixture.store.prepareContextRolloverContinuation({
      id: rolloverId,
      now: NOW,
    });
    expect(completed.state).toBe("completed");
    expect(completed.continuationActivationId).toBeUndefined();
    expect(fixture.store.prepareContextRolloverContinuation({
      id: rolloverId,
      now: NOW,
    })).toEqual(completed);
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'context_rollover_continuation'
    `).get()).toEqual({ count: 0 });
  });

  it("creates exactly one continuation for nonterminal Request lineage", () => {
    const fixture = requestSourceFixture();
    const rolloverId = retireRollover({
      store: fixture.store,
      sourceRunId: fixture.sourceRunId,
      sourceActivationIds: fixture.sourceActivationIds,
      replyAuthority: { intent: "direct_to_user" },
    });

    const continued = fixture.store.prepareContextRolloverContinuation({
      id: rolloverId,
      now: NOW,
    });
    expect(continued.state).toBe("continuation_ready");
    const activation = fixture.sqlite.prepare(`
      SELECT scope_key, payload_json FROM agent_activations
      WHERE id = ? AND kind = 'context_rollover_continuation'
    `).get(continued.continuationActivationId) as {
      scope_key: string;
      payload_json: string;
    };
    expect(activation.scope_key).toBe(SCOPE_KEY);
    expect(JSON.parse(activation.payload_json)).toMatchObject({
      rolloverId,
      replyAuthority: { intent: "direct_to_user" },
    });
    expect(fixture.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM activation_sources
      WHERE activation_id = ? AND source_kind = 'request' AND source_id = ?
    `).get(continued.continuationActivationId, fixture.requestId)).toEqual({
      count: 1,
    });
  });

  it("continues direct work only when an immutable reply route exists", () => {
    for (const withReplyAuthority of [false, true]) {
      const fixture = storeFixture();
      fixture.store.enqueueMessageActivation({
        projectId: PROJECT_ID,
        agentId: RECIPIENT_ID,
        scopeKey: SCOPE_KEY,
        messageId: `message-${withReplyAuthority}`,
        kind: "human",
        payload: { text: "work" },
        now: NOW,
      });
      const lease = fixture.store.leaseNextRun({
        workerId: `worker-${withReplyAuthority}`,
        now: NOW,
      });
      if (!lease) throw new Error("direct source Run was not leased");
      const rolloverId = retireRollover({
        store: fixture.store,
        sourceRunId: lease.runId,
        sourceActivationIds: lease.activationIds,
        ...(withReplyAuthority
          ? { replyAuthority: { intent: "direct_to_user" as const } }
          : {}),
      });
      const result = fixture.store.prepareContextRolloverContinuation({
        id: rolloverId,
        now: NOW,
      });
      expect(result.state).toBe(
        withReplyAuthority ? "continuation_ready" : "completed",
      );
    }
  });
});
