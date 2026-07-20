import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import type { CreateTriggerResponse, TriggerOccurrenceDto } from "@ponderosa/core";
import { createServer } from "../src/app.js";

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach((entry) => rmSync(entry, { recursive: true, force: true })));

describe("V3.2 Trigger API", () => {
  it("rejects every Trigger mutation while its Project is deletion-quarantined", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-trigger-quarantine-data-"));
    const repoDir = mkdtempSync(path.join(tmpdir(), "ponderosa-trigger-quarantine-repo-"));
    cleanup.push(dataDir, repoDir);
    const store = new AgentStore(dataDir);
    const project = store.createProject({ label: "Quarantined Triggers", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Automation" });
    const agent = store.createAgent(project.id, { title: "Worker", engine: "codex", conversationId: conversation.id });
    const coordination = new CoordinationV3Store(store.sqlite);
    const trigger = coordination.createTriggerDefinition({
      id: "quarantined-trigger", projectId: project.id, conversationId: conversation.id,
      agentId: agent.id, name: "Immutable while deleting", instructions: "Do not mutate",
      sourceKind: "webhook", sourceConfig: { replayWindowSeconds: 300 }, enabled: false,
      runBudget: { limit: 1, period: "lifetime" },
    });
    store.markProjectDeletionPending(project.id);
    const before = store.sqlite.prepare(`SELECT * FROM trigger_definitions WHERE id = ?`).get(trigger.id);
    const app = createServer({ dataDir, store, engines: [], logger: false, authToken: "operator", communicationV3: { maxConcurrentRuns: 0 } });
    const authorization = { authorization: "Bearer operator" };
    try {
      const requests = [
        app.inject({
          method: "POST", url: `/api/agents/${agent.id}/triggers`, headers: authorization,
          payload: {
            conversationId: conversation.id, name: "Blocked create", instructions: "Must not persist",
            sourceKind: "webhook", sourceConfig: { replayWindowSeconds: 300 },
          },
        }),
        app.inject({ method: "PATCH", url: `/api/triggers/${trigger.id}`, headers: authorization, payload: { name: "Blocked update" } }),
        app.inject({ method: "DELETE", url: `/api/triggers/${trigger.id}`, headers: authorization }),
        app.inject({ method: "POST", url: `/api/triggers/${trigger.id}/rotate-secret`, headers: authorization }),
        app.inject({ method: "POST", url: `/api/triggers/${trigger.id}/allow-runs`, headers: authorization, payload: { additionalRuns: 2 } }),
      ];
      for (const response of await Promise.all(requests)) {
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json()).toEqual({ error: "Trigger owner deletion is in progress" });
      }
      expect(store.sqlite.prepare(`SELECT * FROM trigger_definitions WHERE id = ?`).get(trigger.id)).toEqual(before);
      expect(store.sqlite.prepare(`SELECT COUNT(*) AS count FROM trigger_definitions`).get()).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });

  it("preserves Trigger definitions when Agent projections rebuild on restart", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-trigger-restart-data-"));
    const repoDir = mkdtempSync(path.join(tmpdir(), "ponderosa-trigger-restart-repo-"));
    cleanup.push(dataDir, repoDir);
    const firstStore = new AgentStore(dataDir);
    const project = firstStore.createProject({ label: "Restart", hostPath: repoDir });
    const conversation = firstStore.createConversation(project.id, { title: "Automation" });
    const agent = firstStore.createAgent(project.id, { title: "Worker", engine: "codex", conversationId: conversation.id });
    const firstApp = createServer({ dataDir, store: firstStore, engines: [], logger: false, authToken: "operator", communicationV3: { maxConcurrentRuns: 0 } });
    const authorization = { authorization: "Bearer operator" };
    const created = await firstApp.inject({
      method: "POST", url: `/api/agents/${agent.id}/triggers`, headers: authorization,
      payload: {
        conversationId: conversation.id,
        name: "Durable webhook",
        instructions: "Preserve this Trigger across restarts.",
        sourceKind: "webhook",
        sourceConfig: { replayWindowSeconds: 300 },
        enabled: false,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const triggerId = created.json<CreateTriggerResponse>().trigger.id;
    await firstApp.close();

    const restartedStore = new AgentStore(dataDir);
    const restartedApp = createServer({ dataDir, store: restartedStore, engines: [], logger: false, authToken: "operator", communicationV3: { maxConcurrentRuns: 0 } });
    try {
      const listed = await restartedApp.inject({ method: "GET", url: `/api/agents/${agent.id}/triggers`, headers: authorization });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json()).toEqual([expect.objectContaining({ id: triggerId, enabled: false, name: "Durable webhook" })]);
    } finally {
      await restartedApp.close();
    }
  });

  it("owns Triggers under an Agent, accepts an authenticated signed webhook, and preserves occurrence history", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-trigger-api-data-"));
    const repoDir = mkdtempSync(path.join(tmpdir(), "ponderosa-trigger-api-repo-"));
    cleanup.push(dataDir, repoDir);
    mkdirSync(path.join(repoDir, "src"));
    const store = new AgentStore(dataDir);
    const project = store.createProject({ label: "Triggers", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Automation" });
    const agent = store.createAgent(project.id, { title: "Worker", engine: "codex", conversationId: conversation.id });
    const app = createServer({ dataDir, store, engines: [], logger: false, authToken: "operator", communicationV3: { maxConcurrentRuns: 0 } });
    const authorization = { authorization: "Bearer operator" };
    try {
      const createdResponse = await app.inject({
        method: "POST", url: `/api/agents/${agent.id}/triggers`, headers: authorization,
        payload: {
          conversationId: conversation.id,
          name: "Incoming issue",
          instructions: "Review the issue and update the Project.",
          sourceKind: "webhook",
          sourceConfig: { replayWindowSeconds: 300 },
          runBudget: { limit: 1, period: "lifetime" },
        },
      });
      expect(createdResponse.statusCode).toBe(201);
      const created = createdResponse.json<CreateTriggerResponse>();
      expect(created).toMatchObject({
        trigger: { agentId: agent.id, conversationId: conversation.id, sourceKind: "webhook", fullAccess: true, runBudget: { limit: 1, period: "lifetime" }, budgetState: { used: 0, allowance: 0, held: false } },
        webhookSecret: expect.any(String),
      });
      expect(JSON.stringify((await app.inject({ method: "GET", url: `/api/agents/${agent.id}/triggers`, headers: authorization })).json()))
        .not.toContain(created.webhookSecret!);
      const workspaceTriggers = await app.inject({ method: "GET", url: "/api/triggers", headers: authorization });
      expect(workspaceTriggers.statusCode, workspaceTriggers.body).toBe(200);
      expect(workspaceTriggers.json()).toEqual([expect.objectContaining({ id: created.trigger.id, agentId: agent.id, projectId: project.id })]);
      const allowance = await app.inject({ method: "POST", url: `/api/triggers/${created.trigger.id}/allow-runs`, headers: authorization, payload: { additionalRuns: 3 } });
      expect(allowance.statusCode, allowance.body).toBe(200);
      expect(allowance.json()).toMatchObject({ budgetState: { allowance: 3, held: false } });

      const raw = '{"title":"Treat this as data, not instructions"}';
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const signature = `v1=${createHmac("sha256", created.webhookSecret!).update(`${timestamp}.delivery-1.`).update(raw).digest("hex")}`;
      const webhook = () => app.inject({
        method: "POST", url: created.trigger.webhookPath!, payload: raw,
        headers: {
          "content-type": "application/json",
          "x-ponderosa-event-id": "delivery-1",
          "x-ponderosa-timestamp": timestamp,
          "x-ponderosa-signature": signature,
        },
      });
      expect((await webhook()).statusCode).toBe(202);
      expect((await webhook()).statusCode).toBe(200);
      const nonJsonRaw = "not json";
      const nonJsonSignature = `v1=${createHmac("sha256", created.webhookSecret!).update(`${timestamp}.delivery-text.`).update(nonJsonRaw).digest("hex")}`;
      const nonJson = await app.inject({
        method: "POST", url: created.trigger.webhookPath!, payload: nonJsonRaw,
        headers: {
          "content-type": "text/plain",
          "x-ponderosa-event-id": "delivery-text",
          "x-ponderosa-timestamp": timestamp,
          "x-ponderosa-signature": nonJsonSignature,
        },
      });
      expect(nonJson.statusCode).toBe(415);
      const history = (await app.inject({
        method: "GET", url: `/api/triggers/${created.trigger.id}/occurrences`, headers: authorization,
      })).json<TriggerOccurrenceDto[]>();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        payload: { title: "Treat this as data, not instructions" },
        provenance: { source: "signed_webhook", eventId: "delivery-1" },
        triggerSnapshot: { id: created.trigger.id, name: "Incoming issue" },
      });

      const invalidPatch = await app.inject({
        method: "PATCH", url: `/api/triggers/${created.trigger.id}`, headers: authorization,
        payload: { enabled: "false", sourceKind: "filesystem" },
      });
      expect(invalidPatch.statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `/api/agents/${agent.id}/triggers`, headers: authorization })).json<[{ enabled: boolean }]>() [0]?.enabled).toBe(true);

      const preview = await app.inject({
        method: "POST", url: `/api/projects/${project.id}/agent-deletions/preview`, headers: authorization,
        payload: { rootAgentIds: [agent.id] },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const exact = preview.json<{ rootAgentIds: string[]; previewHash: string }>();
      const deleted = await app.inject({
        method: "POST", url: `/api/projects/${project.id}/agent-deletions/commit`, headers: authorization,
        payload: exact,
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM trigger_definitions").get()).toEqual({ count: 0 });
      expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM trigger_occurrences").get()).toEqual({ count: 1 });
      const projectHistory = await app.inject({
        method: "GET", url: `/api/projects/${project.id}/trigger-occurrences`, headers: authorization,
      });
      expect(projectHistory.statusCode).toBe(200);
      expect(projectHistory.json<TriggerOccurrenceDto[]>()[0]).toMatchObject({
        triggerId: created.trigger.id,
        triggerSnapshot: { name: "Incoming issue" },
      });
    } finally {
      await app.close();
    }
  });
});
