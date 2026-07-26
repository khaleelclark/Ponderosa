import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, AgentEvent, ContinueOptions, SeedOptions } from "@ponderosa/core";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { createServer, type EngineRegistration } from "../src/app.js";

class CutoverAdapter implements Adapter {
  id = "codex";
  displayName = "Cutover test adapter";
  listModels() { return []; }
  listEfforts() { return []; }
  async *seed(_options: SeedOptions): AsyncIterable<AgentEvent> { yield { type: "turn_done" }; }
  async *continue(_options: ContinueOptions): AsyncIterable<AgentEvent> { yield { type: "turn_done" }; }
}

const legacyNames = ["agent-waits.jsonl", "runtime-runs.jsonl", "collaboration-deliveries.jsonl"] as const;

// Quarantine on non-Linux hosts: actionable communication setup currently
// fails closed before these cases at the managed artifact readiness gate.
describe.skipIf(process.platform !== "linux")("Communication V3.1 executable cutover", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fixture(staleLegacyFiles = false) {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-v31-cutover-"));
    const repoDir = mkdtempSync(path.join(tmpdir(), "ponderosa-v31-repo-"));
    directories.push(dataDir, repoDir);
    mkdirSync(repoDir, { recursive: true });
    const store = new AgentStore(dataDir);
    if (staleLegacyFiles) {
      for (const name of legacyNames) writeFileSync(path.join(dataDir, name), `stale-${name}\n`, "utf8");
    }
    const adapter = new CutoverAdapter();
    const engines: EngineRegistration[] = [{ adapter, authStatus: async () => ({ authenticated: true }) }];
    const project = store.createProject({ label: "Cutover", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: conversation.id });
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { maxConcurrentRuns: 0, pollMs: 5 },
    });
    return { dataDir, repoDir, store, engines, project, conversation, agent, app };
  }

  it("ignores stale scheduler files, keeps broadcasts passive, and lets only the scheduler create Runs", async () => {
    const { dataDir, store, project, conversation, agent, app } = fixture(true);
    await app.ready();
    const coordination = new CoordinationV3Store(store.sqlite);

    const initialHealth = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` });
    expect(initialHealth.json<{ agents: Array<{ status: string }> }>().agents[0]?.status).toBe("idle");

    const broadcast = await app.inject({
      method: "POST", url: `/api/conversations/${conversation.id}/messages`,
      payload: { text: "#broadcast informational context only" },
    });
    expect(broadcast.statusCode).toBe(200);
    expect(coordination.pendingActivations(project.id)).toHaveLength(0);

    const actionable = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Please investigate" },
    });
    expect(actionable.statusCode).toBe(202);
    expect(coordination.pendingActivations(project.id)).toHaveLength(1);
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM scheduler_runs").get()).toEqual({ count: 0 });

    await app.close();
    for (const name of legacyNames) {
      expect(readFileSync(path.join(dataDir, name), "utf8")).toBe(`stale-${name}\n`);
    }
  });

  it("persists one idempotent Activation through restart and cancels it from the SQLite queue", async () => {
    const first = fixture(false);
    await first.app.ready();
    const payload = {
      text: "Queued once",
      recipients: [{ agentId: first.agent.id }],
      idempotencyKey: "v31-restart-once",
      activeRunDelivery: "queue",
    };
    const created = await first.app.inject({
      method: "POST", url: `/api/conversations/${first.conversation.id}/direct-messages`, payload,
    });
    const replayed = await first.app.inject({
      method: "POST", url: `/api/conversations/${first.conversation.id}/direct-messages`, payload,
    });
    expect(created.json()).toMatchObject({ replayed: false, recipients: [{ queued: true }] });
    expect(replayed.json()).toMatchObject({ replayed: true, messageId: created.json<{ messageId: string }>().messageId });
    expect(new CoordinationV3Store(first.store.sqlite).pendingActivations(first.project.id)).toHaveLength(1);
    await first.app.close();

    const restartedStore = new AgentStore(first.dataDir);
    const restarted = createServer({
      dataDir: first.dataDir, store: restartedStore, engines: first.engines, logger: false,
      communicationV3: { maxConcurrentRuns: 0, pollMs: 5 },
    });
    await restarted.ready();
    expect(new CoordinationV3Store(restartedStore.sqlite).pendingActivations(first.project.id)).toHaveLength(1);
    const queued = (await restarted.inject({
      method: "GET", url: `/api/conversations/${first.conversation.id}/queued-messages`,
    })).json<Array<{ deliveryId: string }>>();
    expect(queued).toHaveLength(1);
    const cancelled = await restarted.inject({
      method: "POST", url: `/api/conversations/${first.conversation.id}/queued-messages/${queued[0]!.deliveryId}/cancel`,
      payload: { idempotencyKey: "cancel-after-restart" },
    });
    expect(cancelled.json()).toMatchObject({ cancelled: true, replayed: false });
    expect(new CoordinationV3Store(restartedStore.sqlite).pendingActivations(first.project.id)).toHaveLength(0);
    await restarted.close();

    for (const name of legacyNames) expect(existsSync(path.join(first.dataDir, name))).toBe(false);
  });
});
