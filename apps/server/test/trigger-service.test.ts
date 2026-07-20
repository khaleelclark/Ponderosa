import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { TriggerSourceService, normalizeTriggerSourceConfig } from "../src/trigger-service.js";
import { TriggerSecretStore } from "../src/trigger-secrets.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(now: Date) {
  const directory = mkdtempSync(join(tmpdir(), "ponderosa-triggers-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const agents = new AgentStore(join(directory, "data"));
  const project = agents.createProject({ label: "Triggers", hostPath: workspace });
  const conversation = agents.createConversation(project.id, { title: "Automation" });
  const agent = agents.createAgent(project.id, { title: "Worker", engine: "codex", conversationId: conversation.id });
  const coordination = new CoordinationV3Store(agents.sqlite);
  let notifications = 0;
  const service = new TriggerSourceService({
    store: agents, coordination, dataDir: join(directory, "secrets"), now: () => now,
    notify: () => { notifications += 1; },
  });
  return { directory, agents, project, conversation, agent, coordination, service, notifications: () => notifications };
}

describe("V3.2 Trigger sources", () => {
  it("keeps webhook encryption keys owner-only", () => {
    const directory = mkdtempSync(join(tmpdir(), "ponderosa-trigger-key-"));
    directories.push(directory);
    const store = new TriggerSecretStore(directory);
    const generated = store.create();
    expect(generated.ciphertext).not.toContain(generated.secret);
    chmodSync(join(directory, "trigger-secrets.key"), 0o644);
    expect(() => new TriggerSecretStore(directory)).toThrow("owner-only");
  });

  it("validates schedules and filesystem bundling bounds", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    expect(normalizeTriggerSourceConfig("schedule", {
      scheduleKind: "interval", everyMs: 60_000, startsAt: "2026-07-16T11:59:30.000Z",
    }, now).nextFireAt).toBe("2026-07-16T12:00:30.000Z");
    expect(normalizeTriggerSourceConfig("filesystem", {
      include: [], exclude: [], quietMs: 1_000, maxWindowMs: 10_000,
    }, now).config).toMatchObject({ include: ["**/*"], quietMs: 1_000, maxWindowMs: 10_000 });
    expect(normalizeTriggerSourceConfig("filesystem", {
      include: ["**/*"], exclude: [], quietMs: 5_000, maxWindowMs: 60_000,
    }, now).config).toMatchObject({ quietMs: 5_000, maxWindowMs: 60_000 });
    expect(() => normalizeTriggerSourceConfig("filesystem", {
      include: ["**/*"], exclude: [], quietMs: 5_000, maxWindowMs: 3_600_001,
    }, now)).toThrow("between quietMs and 3600000 ms");
    expect(() => normalizeTriggerSourceConfig("filesystem", {
      include: ["../secrets/**"], exclude: [], quietMs: 1_000, maxWindowMs: 10_000,
    }, now)).toThrow("relative glob patterns");
  });

  it("authenticates exact webhook bytes, deduplicates event IDs, and rejects conflicts", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const context = setup(now);
    try {
      const generated = context.service.createWebhookSecret();
      const trigger = context.coordination.createTriggerDefinition({
        id: "webhook", projectId: context.project.id, conversationId: context.conversation.id,
        agentId: context.agent.id, name: "Webhook", instructions: "Review the event",
        sourceKind: "webhook", sourceConfig: { replayWindowSeconds: 300 },
        secretCiphertext: generated.ciphertext, secretFingerprint: generated.fingerprint,
      });
      const rawBody = Buffer.from('{"action":"opened"}');
      const timestamp = String(Math.floor(now.getTime() / 1_000));
      const signature = `v1=${createHmac("sha256", generated.secret).update(`${timestamp}.delivery-1.`).update(rawBody).digest("hex")}`;
      const intake = { triggerId: trigger.id, eventId: "delivery-1", timestamp, signature, rawBody, payload: { action: "opened" } };
      expect(context.service.verifyAndRecordWebhook(intake)).toMatchObject({ replayed: false });
      expect(context.service.verifyAndRecordWebhook(intake)).toMatchObject({ replayed: true });
      expect(context.notifications()).toBe(1);
      context.coordination.updateTriggerDefinition(trigger.id, { instructions: "Use the edited instructions" });
      expect(context.service.verifyAndRecordWebhook({ ...intake, remoteAddress: "127.0.0.2" })).toMatchObject({ replayed: true });
      expect(() => context.service.verifyAndRecordWebhook({ ...intake, rawBody: Buffer.from('{"action":"closed"}'), payload: { action: "closed" } }))
        .toThrow("invalid webhook signature");
      expect(() => context.service.verifyAndRecordWebhook({ ...intake, eventId: "delivery-2" }))
        .toThrow("invalid webhook signature");
      expect(context.coordination.listTriggerOccurrences(trigger.id)).toHaveLength(1);
      expect(context.coordination.listTriggerOccurrences(trigger.id)[0]).toMatchObject({
        artifactId: expect.stringMatching(/^trigger-occurrence:/),
        provenance: { source: "signed_webhook", eventId: "delivery-1" },
      });
    } finally {
      context.agents.close();
    }
  });

  it("collapses missed schedule times into one durable occurrence and advances the cursor", async () => {
    const now = new Date("2026-07-16T12:03:30.000Z");
    const context = setup(now);
    try {
      const trigger = context.coordination.createTriggerDefinition({
        id: "schedule", projectId: context.project.id, conversationId: context.conversation.id,
        agentId: context.agent.id, name: "Schedule", instructions: "Refresh the report",
        sourceKind: "schedule",
        sourceConfig: { scheduleKind: "interval", everyMs: 60_000, startsAt: "2026-07-16T12:01:00.000Z" },
        nextFireAt: "2026-07-16T12:01:00.000Z",
      });
      await context.service.processDueSchedules();
      expect(context.coordination.listTriggerOccurrences(trigger.id)[0]?.payload).toEqual({
        collapsedRecovery: true,
        missedCount: 3,
        scheduledTimes: [
          "2026-07-16T12:01:00.000Z", "2026-07-16T12:02:00.000Z", "2026-07-16T12:03:00.000Z",
        ],
      });
      expect(context.coordination.getTriggerDefinition(trigger.id)?.nextFireAt).toBe("2026-07-16T12:04:00.000Z");
      expect(context.notifications()).toBe(1);
    } finally {
      context.agents.close();
    }
  });

  it("runs a one-time occurrence after atomically disabling its completed schedule", async () => {
    const now = new Date("2026-07-16T12:00:01.000Z");
    const context = setup(now);
    try {
      const trigger = context.coordination.createTriggerDefinition({
        id: "schedule-once", projectId: context.project.id, conversationId: context.conversation.id,
        agentId: context.agent.id, name: "Once", instructions: "Publish the one-time report",
        sourceKind: "schedule",
        sourceConfig: { scheduleKind: "once", at: "2026-07-16T12:00:00.000Z" },
        nextFireAt: "2026-07-16T12:00:00.000Z",
      });
      await context.service.processDueSchedules();
      expect(context.coordination.getTriggerDefinition(trigger.id)).toMatchObject({
        enabled: false,
        lastFiredAt: "2026-07-16T12:00:00.000Z",
      });
      expect(context.coordination.listTriggerOccurrences(trigger.id)).toHaveLength(1);

      const lease = context.coordination.leaseNextRun({ workerId: "scheduler", now: now.toISOString() })!;
      expect(lease.activations).toHaveLength(1);
      context.coordination.preparePromptInjection({
        injectionId: lease.injectionId, runId: lease.runId,
        fencingToken: lease.fencingToken, prompt: "one-time work",
      });
      context.coordination.markRunStarted(lease.runId, lease.fencingToken, now.toISOString());
      expect(() => context.coordination.markPromptSubmitted({
        injectionId: lease.injectionId, runId: lease.runId,
        fencingToken: lease.fencingToken, now: now.toISOString(),
      })).not.toThrow();
      expect(context.coordination.schedulerMetrics()).toMatchObject({ activeRuns: 1, failedRuns: 0 });
    } finally {
      context.agents.close();
    }
  });

  it("shares one Project watcher while routing metadata to each matching Trigger", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const context = setup(now);
    try {
      const trigger = context.coordination.createTriggerDefinition({
        id: "filesystem", projectId: context.project.id, conversationId: context.conversation.id,
        agentId: context.agent.id, name: "Files", instructions: "Inspect relevant changes",
        sourceKind: "filesystem",
        sourceConfig: { include: ["src/**"], exclude: ["**/*.tmp"], quietMs: 100, maxWindowMs: 500 },
      });
      const second = context.coordination.createTriggerDefinition({
        id: "filesystem-second", projectId: context.project.id, conversationId: context.conversation.id,
        agentId: context.agent.id, name: "More files", instructions: "Inspect the same Project changes",
        sourceKind: "filesystem",
        sourceConfig: { include: ["src/**"], exclude: ["**/*.log"], quietMs: 100, maxWindowMs: 500 },
      });
      await context.service.start();
      await context.service.waitForFilesystemWatchers();
      expect((context.service as unknown as { watchers: Map<string, unknown> }).watchers.size).toBe(1);
      mkdirSync(join(context.project.hostPath, "src"), { recursive: true });
      writeFileSync(join(context.project.hostPath, "src", "app.ts"), "SECRET_FILE_CONTENT");
      const deadline = Date.now() + 2_000;
      while ((context.coordination.listTriggerOccurrences(trigger.id).length === 0 || context.coordination.listTriggerOccurrences(second.id).length === 0) && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      const occurrence = context.coordination.listTriggerOccurrences(trigger.id)[0];
      expect(occurrence).toMatchObject({
        payload: { changes: expect.arrayContaining([{ path: "src/app.ts", types: expect.any(Array) }]) },
        provenance: { source: "project_filesystem", contentInjected: false },
      });
      expect(JSON.stringify(occurrence)).not.toContain("SECRET_FILE_CONTENT");
      expect(context.coordination.listTriggerOccurrences(second.id)).toHaveLength(1);
    } finally {
      await context.service.stop();
      context.agents.close();
    }
  });

  it("restores a persisted filesystem quiet-window burst after service restart", async () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const context = setup(now);
    let restarted: TriggerSourceService | undefined;
    try {
      const trigger = context.coordination.createTriggerDefinition({
        id: "filesystem-restart", projectId: context.project.id, conversationId: context.conversation.id,
        agentId: context.agent.id, name: "Files", instructions: "Inspect relevant changes",
        sourceKind: "filesystem",
        sourceConfig: { include: ["src/**"], exclude: [], quietMs: 500, maxWindowMs: 1_000 },
      });
      await context.service.start();
      await context.service.waitForFilesystemWatchers();
      mkdirSync(join(context.project.hostPath, "src"), { recursive: true });
      writeFileSync(join(context.project.hostPath, "src", "durable.ts"), "durable metadata only");
      const persistenceDeadline = Date.now() + 2_000;
      while (context.coordination.listPendingFilesystemTriggerBursts().length === 0 && Date.now() < persistenceDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(context.coordination.listPendingFilesystemTriggerBursts()).toMatchObject([{
        triggerId: trigger.id,
        changes: expect.arrayContaining([{ path: "src/durable.ts", types: expect.any(Array) }]),
      }]);
      await context.service.stop();
      expect(context.coordination.listTriggerOccurrences(trigger.id)).toHaveLength(0);

      restarted = new TriggerSourceService({
        store: context.agents,
        coordination: context.coordination,
        dataDir: join(context.directory, "secrets"),
        now: () => now,
        notify: () => undefined,
      });
      await restarted.start();
      const flushDeadline = Date.now() + 2_000;
      while (context.coordination.listTriggerOccurrences(trigger.id).length === 0 && Date.now() < flushDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(context.coordination.listTriggerOccurrences(trigger.id)[0]).toMatchObject({
        state: "activated",
        payload: { changes: expect.arrayContaining([{ path: "src/durable.ts", types: expect.any(Array) }]) },
      });
      expect(context.coordination.listPendingFilesystemTriggerBursts()).toHaveLength(0);
    } finally {
      await restarted?.stop();
      await context.service.stop();
      context.agents.close();
    }
  });
});
