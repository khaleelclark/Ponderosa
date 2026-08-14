import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { CoordinationV3Store } from "./coordination-v3-store.js";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = "project-1";
const CONVERSATION_ID = "conversation-1";
const REQUESTER_ID = "requester";
const RECIPIENT_ID = "recipient";

const clients: Database.Database[] = [];
afterEach(() => {
  while (clients.length) clients.pop()!.close();
});

function fixture(): {
  sqlite: Database.Database;
  store: CoordinationV3Store;
  requestId: string;
  requesterRun: ReturnType<CoordinationV3Store["leaseNextRun"]> & {};
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

  const store = new CoordinationV3Store(sqlite);
  store.enqueueMessageActivation({
    projectId: PROJECT_ID,
    agentId: REQUESTER_ID,
    scopeKey: `conversation:${CONVERSATION_ID}`,
    messageId: "seed-message",
    kind: "human",
    payload: { text: "seed" },
    now: NOW,
  });
  const requesterRun = store.leaseNextRun({
    workerId: "worker",
    now: NOW,
  });
  if (!requesterRun) throw new Error("requester Run was not leased");
  store.preparePromptInjection({
    injectionId: requesterRun.injectionId,
    runId: requesterRun.runId,
    fencingToken: requesterRun.fencingToken,
    prompt: "seed prompt",
    now: NOW,
  });
  store.markPromptSubmitted({
    injectionId: requesterRun.injectionId,
    runId: requesterRun.runId,
    fencingToken: requesterRun.fencingToken,
    now: NOW,
  });
  store.acknowledgePromptInjection({
    injectionId: requesterRun.injectionId,
    runId: requesterRun.runId,
    fencingToken: requesterRun.fencingToken,
    now: NOW,
  });

  const [requestId] = store.coordinate({
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
  }, NOW).requestIds;
  if (!requestId) throw new Error("request was not created");
  store.updateRequest({
    requestId,
    updateId: "question-1",
    kind: "question",
    actor: { kind: "agent", id: RECIPIENT_ID },
    payload: { question: "Need input" },
    now: NOW,
  });
  return { sqlite, store, requestId, requesterRun };
}

function activationState(
  sqlite: Database.Database,
  kind: string,
): { id: string; state: string; payload_json: string } | undefined {
  return sqlite.prepare(`
    SELECT id, state, payload_json FROM agent_activations
    WHERE kind = ? ORDER BY created_at, id LIMIT 1
  `).get(kind) as {
    id: string;
    state: string;
    payload_json: string;
  } | undefined;
}

describe("cleared coordination questions", () => {
  it("rejects hostile provider turn identifiers before durable acknowledgement", () => {
    const { sqlite, store, requesterRun } = fixture();
    const marker = "PROVIDER_TURN_PERSISTENCE_MARKER_64f2";
    for (const providerTurnId of [
      `${marker}\u0000hidden`,
      marker.repeat(40),
      "access_token=private-provider-turn",
    ]) {
      expect(() => store.acknowledgePromptInjection({
        injectionId: requesterRun.injectionId,
        runId: requesterRun.runId,
        fencingToken: requesterRun.fencingToken,
        providerTurnId,
        now: NOW,
      })).toThrow("provider turn id must be a bounded identifier");
    }
    expect(sqlite.prepare(`
      SELECT provider_turn_id AS providerTurnId
      FROM scheduler_prompt_injections WHERE id = ?
    `).get(requesterRun.injectionId)).toEqual({ providerTurnId: null });
  });

  it("cancels an attached question and its unsubmitted steering injection", () => {
    const { sqlite, store, requestId } = fixture();
    const unrelatedActivationId = store.enqueueMessageActivation({
      projectId: PROJECT_ID,
      agentId: REQUESTER_ID,
      scopeKey: `conversation:${CONVERSATION_ID}`,
      messageId: "unrelated-urgent",
      kind: "urgent",
      payload: { text: "unrelated" },
      now: NOW,
    });
    const steering = store.leaseNextSteering({ workerId: "worker", now: NOW });
    expect(steering?.activations.map(activation => activation.kind)).toContain(
      "coordination_question",
    );

    store.updateRequest({
      requestId,
      updateId: "cancel-1",
      kind: "cancelled",
      actor: { kind: "agent", id: REQUESTER_ID },
      now: NOW,
    });

    expect(store.getRequest(requestId)?.state).toBe("cancelled");
    expect(activationState(sqlite, "coordination_question")?.state).toBe(
      "cancelled",
    );
    expect(sqlite.prepare(`
      SELECT state FROM scheduler_prompt_injections WHERE id = ?
    `).get(steering!.injectionId)).toEqual({ state: "cancelled" });
    expect(sqlite.prepare(`
      SELECT state FROM agent_activations WHERE id = ?
    `).get(unrelatedActivationId)).toEqual({ state: "retry_pending" });
    expect(activationState(sqlite, "coordination_question_retracted")).toBeUndefined();
    expect(() => store.updateRequest({
      requestId,
      updateId: "stale-answer-1",
      kind: "answer",
      actor: { kind: "agent", id: REQUESTER_ID },
      inReplyToUpdateId: "question-1",
      payload: { answer: "stale" },
      now: NOW,
    })).toThrow(/terminal \(cancelled\)/);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates
      WHERE id = 'stale-answer-1'
    `).get()).toEqual({ count: 0 });
  });

  it("adds one terminal retraction after a question steer was submitted", () => {
    const { sqlite, store, requestId, requesterRun } = fixture();
    const steering = store.leaseNextSteering({ workerId: "worker", now: NOW });
    if (!steering) throw new Error("question steering was not leased");
    store.preparePromptInjection({
      injectionId: steering.injectionId,
      runId: steering.runId,
      fencingToken: steering.fencingToken,
      prompt: "question prompt",
      now: NOW,
    });
    store.markPromptSubmitted({
      injectionId: steering.injectionId,
      runId: steering.runId,
      fencingToken: steering.fencingToken,
      now: NOW,
    });

    store.updateRequest({
      requestId,
      updateId: "cancel-1",
      kind: "cancelled",
      actor: { kind: "agent", id: REQUESTER_ID },
      now: NOW,
    });
    store.updateRequest({
      requestId,
      updateId: "cancel-1",
      kind: "cancelled",
      actor: { kind: "agent", id: REQUESTER_ID },
      now: NOW,
    });

    expect(sqlite.prepare(`
      SELECT state FROM scheduler_prompt_injections WHERE id = ?
    `).get(steering.injectionId)).toEqual({ state: "submitted" });
    expect(activationState(sqlite, "coordination_question")?.state).toBe(
      "cancelled",
    );
    const retraction = activationState(
      sqlite,
      "coordination_question_retracted",
    );
    expect(retraction?.state).toBe("pending");
    expect(JSON.parse(retraction!.payload_json)).toMatchObject({
      requestId,
      inReplyToUpdateId: "question-1",
      state: "cancelled",
      settledByUpdateId: "cancel-1",
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'coordination_question_retracted'
    `).get()).toEqual({ count: 1 });

    store.acknowledgePromptInjection({
      injectionId: steering.injectionId,
      runId: requesterRun.runId,
      fencingToken: requesterRun.fencingToken,
      now: NOW,
    });
    expect(store.leaseNextSteering({
      workerId: "worker",
      now: NOW,
    })?.activations.map(activation => activation.kind)).toContain(
      "coordination_question_retracted",
    );
  });

  it("settles an answered live question without a terminal retraction", () => {
    const { sqlite, store, requestId } = fixture();
    store.updateRequest({
      requestId,
      updateId: "answer-1",
      kind: "answer",
      actor: { kind: "agent", id: REQUESTER_ID },
      inReplyToUpdateId: "question-1",
      payload: { answer: "continue" },
      now: NOW,
    });

    expect(store.getRequest(requestId)?.state).toBe("in_progress");
    expect(activationState(sqlite, "coordination_question")?.state).toBe(
      "cancelled",
    );
    expect(activationState(sqlite, "coordination_question_retracted")).toBeUndefined();
  });
});
