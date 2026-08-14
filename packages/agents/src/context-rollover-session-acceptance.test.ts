import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ProviderInputSourceManifest } from "@ponderosa/core";
import { AgentStore } from "./store.js";

const stores: AgentStore[] = [];
const roots: string[] = [];

function insertProviderInput(
  store: AgentStore,
  input: {
    executionId: string;
    agentId: string;
    projectId: string;
    communicationEventIds: string[];
    providerSessionId?: string;
    promptInjectionState?: "injecting" | "injected";
    runStatus?: "completed" | "failed" | "outcome_unknown";
  },
) {
  const manifest: ProviderInputSourceManifest = {
    schemaVersion: 3,
    historyMessageCount: 0,
    retainedSessionSourceCount: 0,
    activationIds: [],
    communicationEventIds: input.communicationEventIds,
    artifactIds: [],
    providerSessionDisposition: "fresh_task",
    sources: input.communicationEventIds.map((ref) => ({
      kind: "communication" as const,
      ref,
      delivery: "submitted" as const,
    })),
  };
  const now = new Date().toISOString();
  const fencingToken = (store.sqlite.prepare(`
    SELECT COUNT(*) AS count FROM scheduler_runs WHERE agent_id = ?
  `).get(input.agentId) as { count: number }).count + 1;
  store.sqlite.prepare(`
    INSERT INTO scheduler_runs (
      id, project_id, agent_id, status, lease_owner, lease_expires_at,
      fencing_token, prompt_injection_state, provider_session_id,
      heartbeat_at, created_at, updated_at, started_at, terminal_at
    ) VALUES (?, ?, ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.executionId,
    input.projectId,
    input.agentId,
    input.runStatus ?? "completed",
    now,
    fencingToken,
    input.promptInjectionState ?? "injected",
    input.providerSessionId ?? "provider-old",
    now,
    now,
    now,
    now,
    now,
  );
  store.sqlite.prepare(`
    INSERT INTO provider_inputs (
      execution_id, scheduler_run_id, agent_id, project_id,
      provider_prompt, prompt_hash, source_manifest_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.executionId,
    `scheduler-${input.executionId}`,
    input.agentId,
    input.projectId,
    "exact input",
    `hash-${input.executionId}`,
    JSON.stringify(manifest),
    now,
    now,
  );
}

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-rollover-acceptance-"));
  roots.push(root);
  const hostPath = join(root, "workspace");
  mkdirSync(hostPath, { recursive: true });
  const store = new AgentStore(join(root, "data"));
  stores.push(store);
  const project = store.createProject({ label: "Rollover", hostPath, defaultEngine: "codex" });
  const conversation = store.getConversation(project.lastConversationId!)!;
  const agent = store.createAgent(project.id, {
    title: "Agent",
    engine: "codex",
    conversationId: conversation.id,
  });
  store.updateAgentConversationMemberships(agent.id, {
    conversationIds: [conversation.id],
    primaryConversationId: conversation.id,
  });
  store.appendEvent(agent.id, {
    type: "session_snapshot",
    sessionId: "provider-old",
    executionId: "source-run",
    toolContractHash: "contract-old",
    artifactIds: ["artifact-old"],
  });
  insertProviderInput(store, {
    executionId: "source-run",
    agentId: agent.id,
    projectId: project.id,
    communicationEventIds: ["communication-opening"],
    providerSessionId: "provider-old",
  });
  store.appendEvent(agent.id, {
    type: "continuation_handoff",
    handoffId: "handoff-1",
    executionId: "source-run",
    text: "Objective: test\nCompleted work: old\nUnfinished work: new\nBlockers: none\nExact next action: resume\nVerified facts: old accepted\nAssumptions: none",
  });
  return { store, agent, project, conversation };
}

describe("context rollover session acceptance", () => {
  test.each([
    "candidate failure",
    "candidate cancellation",
    "missing context observation",
    "Claude candidate without normalized context_usage",
  ])(
    "keeps the old snapshot and handoff authoritative after %s",
    () => {
      const { store, agent } = fixture();
      store.appendEvent(agent.id, { type: "session", sessionId: "provider-candidate" });

      expect(store.resumeSessionState(agent.id)).toEqual({
        sessionId: "provider-old",
        toolContractHash: "contract-old",
        artifactIds: ["artifact-old"],
      });
      expect(store.continuationHandoffForRun(agent.id, "source-run")?.consumedAt).toBeUndefined();
    },
  );

  test("switches the verified snapshot and consumes its handoff in one acceptance event", () => {
    const { store, agent } = fixture();
    store.appendEvent(agent.id, { type: "session", sessionId: "provider-candidate" });
    store.appendEvent(agent.id, {
      type: "context_rollover_session_accepted",
      rolloverId: "rollover-1",
      sessionId: "provider-candidate",
      toolContractHash: "contract-new",
      artifactIds: ["artifact-new"],
      handoffId: "handoff-1",
      executionId: "replacement-run",
    });

    expect(store.resumeSessionState(agent.id)).toEqual({
      sessionId: "provider-candidate",
      toolContractHash: "contract-new",
      artifactIds: ["artifact-new"],
    });
    expect(store.continuationHandoffForRun(agent.id, "source-run")?.consumedAt).toBeDefined();
  });

  test("reconstructs the complete accepted-session Communication identity set across Runs", () => {
    const { store, agent, project } = fixture();
    store.appendEvent(agent.id, { type: "text", executionId: "followup-run", delta: "done" });
    insertProviderInput(store, {
      executionId: "followup-run",
      agentId: agent.id,
      projectId: project.id,
      communicationEventIds: ["communication-followup", "communication-opening"],
      providerSessionId: "provider-old",
    });

    expect(store.acceptedProviderSessionCommunicationEventIds(agent.id)).toEqual([
      "communication-opening",
      "communication-followup",
    ]);
  });

  test("excludes provider input and history reads observed only by a rejected candidate", () => {
    const { store, agent, project } = fixture();
    insertProviderInput(store, {
      executionId: "rejected-candidate",
      agentId: agent.id,
      projectId: project.id,
      communicationEventIds: ["never-accepted-message"],
      providerSessionId: "provider-candidate",
    });
    store.appendEvent(agent.id, {
      type: "compaction_history_retrieval",
      executionId: "rejected-candidate",
      runId: "rejected-candidate",
      action: "search",
      query: "secret",
      normalizedQuery: "secret",
      querySha256: "query-hash",
      strategy: "lexical",
      compactionCutoffOrdinal: 1,
      outcome: "results",
      scannedMessages: 1,
      eligibleMessages: 1,
      matchedMessages: 1,
      selected: [{ communicationEventId: "candidate-selection", contentSha256: "selection-hash" }],
      excludedCurrentContextEventIds: [],
      responseUtf8Bytes: 100,
      hasMore: false,
      durationMs: 1,
    });

    expect(store.acceptedProviderSessionCommunicationEventIds(agent.id)).toEqual([
      "communication-opening",
    ]);
  });

  test("fails closed on an injecting Run before provider acknowledgement", () => {
    const { store, agent, project, conversation } = fixture();
    for (const event of [
      {
        eventId: "canonical-a",
        text: "Canonical A reached the accepted provider session.",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        eventId: "queued-c",
        text: "Queued C must remain future work and unavailable to history.",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        eventId: "never-delivered-b",
        text: "Never-delivered B was recorded before the provider stream opened.",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ]) store.appendCommunicationEvent({
      schemaVersion: 2,
      projectId: project.id,
      conversationId: conversation.id,
      sender: { kind: "user", userId: "local-user" },
      intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-user", agentId: agent.id },
      ...event,
    });
    const sourceInput = store.sqlite.prepare(`
      SELECT source_manifest_json FROM provider_inputs WHERE execution_id = 'source-run'
    `).get() as { source_manifest_json: string };
    const sourceManifest = JSON.parse(sourceInput.source_manifest_json) as ProviderInputSourceManifest;
    sourceManifest.communicationEventIds = ["canonical-a"];
    sourceManifest.sources = [{
      kind: "communication",
      ref: "canonical-a",
      delivery: "submitted",
    }];
    store.sqlite.prepare(`
      UPDATE provider_inputs SET source_manifest_json = ? WHERE execution_id = 'source-run'
    `).run(JSON.stringify(sourceManifest));
    insertProviderInput(store, {
      executionId: "crashed-before-provider-call",
      agentId: agent.id,
      projectId: project.id,
      communicationEventIds: ["never-delivered-b"],
      providerSessionId: "provider-old",
      promptInjectionState: "injecting",
      runStatus: "outcome_unknown",
    });

    const acceptedIds = store.acceptedProviderSessionCommunicationEventIds(agent.id);
    expect(acceptedIds).toEqual(["canonical-a"]);
    const boundary = store.bindContextRolloverBoundary({
      agentId: agent.id,
      currentConversationId: conversation.id,
      submittedCommunicationEventIds: acceptedIds!,
    });
    expect(boundary).toMatchObject({
      canonicalOrdinal: 1,
      communicationEventId: "canonical-a",
    });
    expect(store.searchCompactionHistory({
      agentId: agent.id,
      currentConversationId: conversation.id,
      boundary,
      excludedCommunicationEventIds: new Set(boundary.recentTail.map((binding) =>
        binding.communicationEventId)),
      query: "queued future work",
    }).response.hits).toEqual([]);
    store.sqlite.prepare(`
      UPDATE scheduler_runs SET prompt_injection_state = 'injecting' WHERE id = 'source-run'
    `).run();
    expect(store.acceptedProviderSessionCommunicationEventIds(agent.id)).toBeUndefined();
  });

  test("fails closed for a legacy accepted snapshot without an execution boundary", () => {
    const { store, agent } = fixture();
    store.appendEvent(agent.id, {
      type: "session_snapshot",
      sessionId: "provider-legacy",
      toolContractHash: "contract-legacy",
      artifactIds: [],
    });

    expect(store.acceptedProviderSessionCommunicationEventIds(agent.id)).toBeUndefined();
  });
});
