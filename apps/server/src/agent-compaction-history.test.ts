import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PONDEROSA_HISTORY_TOOL } from "@ponderosa/core";
import { AgentStore } from "@ponderosa/agents";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import type { BrowserSessionManager, BrowserScope } from "./browser-session-manager.js";
import type { ActiveRun, AgentMessageCapability } from "./app-contracts.js";
import { registerAgentRuntimeToolRoutes } from "./routes/agent-runtime-tools.js";

const apps: FastifyInstance[] = [];
const stores: AgentStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (stores.length) stores.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ponderosa-agent-history-route-"));
  directories.push(root);
  const hostPath = join(root, "workspace");
  mkdirSync(hostPath, { recursive: true });
  const store = new AgentStore(join(root, "data"));
  stores.push(store);
  const project = store.createProject({ label: "History route", hostPath, defaultEngine: "codex" });
  const conversationId = project.lastConversationId!;
  const agent = store.createAgent(project.id, {
    title: "History Agent",
    engine: "codex",
    conversationId,
  });
  for (const event of [
    { eventId: "older-nonce", text: "Release nonce is OLDER-SAFE.", createdAt: "2026-01-01T00:00:00.000Z" },
    { eventId: "submitted-nonce", text: "Release nonce is ALREADY-SUBMITTED.", createdAt: "2026-01-02T00:00:00.000Z" },
    { eventId: "retained-tail-nonce", text: "Release nonce is RETAINED-TAIL.", createdAt: "2026-01-02T12:00:00.000Z" },
  ]) store.appendCommunicationEvent({
    schemaVersion: 2,
    projectId: project.id,
    conversationId,
    sender: { kind: "user", userId: "local-user" },
    intent: "user_dm",
    audience: { kind: "user_agent", userId: "local-user", agentId: agent.id },
    ...event,
  });
  const token = "run-history-token";
  const run: ActiveRun = {
    runId: "run-history",
    startedAt: "2026-01-03T00:00:00.000Z",
    executionId: "run-history",
    leaseExpiresAt: "2026-01-03T00:05:00.000Z",
    controller: new AbortController(),
    messageCapability: token,
    v3SchedulerRunId: "run-history",
    v3FencingToken: 7,
    conversationId,
    generation: 7,
    ownershipState: "running",
  };
  const capability: AgentMessageCapability = {
    agentId: agent.id,
    conversationId,
    runId: run.runId,
    v3SchedulerRunId: run.runId,
    v3FencingToken: 7,
    mentionDepth: 0,
    mentionTrail: [],
    reachableArtifactIds: [],
    availableToolNames: [PONDEROSA_HISTORY_TOOL.name],
    // The first ID represents this Run's submitted manifest; the second
    // represents its bounded fresh-reseed tail on a resumed provider session.
    historyRetrievalExcludedCommunicationEventIds: ["submitted-nonce", "retained-tail-nonce"],
    historyRetrievalBoundary: {
      canonicalOrdinal: 3,
      communicationEventId: "retained-tail-nonce",
    },
  };
  const activeRuns = new Map([[agent.id, run]]);
  const capabilities = new Map([[token, capability]]);
  const app = Fastify({ logger: false });
  apps.push(app);
  registerAgentRuntimeToolRoutes(app, {
    store,
    agentMessageCapabilities: capabilities,
    activeRuns,
    browserSessions: {} as BrowserSessionManager,
    projectBrowserSessions: {} as BrowserSessionManager,
    projectBrowserGrants: new Map(),
    projectBrowserScope: () => ({ projectId: project.id, agentId: agent.id, runId: run.runId } satisfies BrowserScope),
    capabilityOwnsAuthoritativeRun: (candidate, active) => candidate === capability && active === run,
  });
  return { app, store, agent, token, activeRuns };
}

describe("agent compaction-history route", () => {
  test("requires the exact active Run capability and excludes its submitted manifest", async () => {
    const { app, store, agent, token, activeRuns } = fixture();
    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/agent-history",
      payload: { action: "search", query: "release nonce" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-history",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "search", query: "release nonce", limit: 5 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().hits.map((message: { communicationEventId: string }) => message.communicationEventId))
      .toEqual(["older-nonce"]);
    expect(response.json().excludedRecentTailMessages).toBe(2);
    const audit = store.readEvents(agent.id).at(-1)?.event;
    expect(audit).toMatchObject({
      type: "compaction_history_retrieval",
      outcome: "results",
      selected: [{ communicationEventId: "older-nonce" }],
      excludedCurrentContextEventIds: ["submitted-nonce", "retained-tail-nonce"],
    });

    const exact = await app.inject({
      method: "POST",
      url: "/api/agent-history",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "read", communicationEventId: "older-nonce", before: 0, after: 1 },
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({
      action: "read",
      untrustedHistoricalData: true,
      requestedCommunicationEventId: "older-nonce",
      messages: [{
        communicationEventId: "older-nonce",
        text: "Release nonce is OLDER-SAFE.",
      }],
    });

    activeRuns.clear();
    const stale = await app.inject({
      method: "POST",
      url: "/api/agent-history",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "search", query: "release nonce" },
    });
    expect(stale.statusCode).toBe(401);
  });

  test("fails broad queries closed and audits the rejection without history text", async () => {
    const { app, store, agent, token } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-history",
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "search", query: "show all history" },
    });
    expect(response.statusCode).toBe(400);
    const audit = store.readEvents(agent.id).at(-1)?.event;
    expect(audit).toMatchObject({
      type: "compaction_history_retrieval",
      outcome: "rejected",
      selected: [],
    });
    expect(JSON.stringify(audit)).not.toContain("OLDER-SAFE");
    expect(JSON.stringify(audit)).not.toContain("ALREADY-SUBMITTED");
  });

  test("rejects malformed actions and ranking modes instead of broadening to defaults", async () => {
    const { app, token } = fixture();
    for (const payload of [
      { query: "release nonce" },
      { action: "search", query: "release nonce", strategy: "all" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-history",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
