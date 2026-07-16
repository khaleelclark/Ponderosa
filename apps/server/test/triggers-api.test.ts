import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "@ponderosa/agents";
import type { CreateTriggerResponse, TriggerOccurrenceDto } from "@ponderosa/core";
import { createServer } from "../src/app.js";

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach((entry) => rmSync(entry, { recursive: true, force: true })));

describe("V3.2 Trigger API", () => {
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
        },
      });
      expect(createdResponse.statusCode).toBe(201);
      const created = createdResponse.json<CreateTriggerResponse>();
      expect(created).toMatchObject({
        trigger: { agentId: agent.id, conversationId: conversation.id, sourceKind: "webhook", fullAccess: true },
        webhookSecret: expect.any(String),
      });
      expect(JSON.stringify((await app.inject({ method: "GET", url: `/api/agents/${agent.id}/triggers`, headers: authorization })).json()))
        .not.toContain(created.webhookSecret!);

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

      const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}`, headers: authorization });
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
