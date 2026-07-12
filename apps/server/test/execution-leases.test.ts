import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapter, AgentEvent, ContinueOptions, ModelOption, SeedOptions } from "@ponderosa/core";
import { ThreadStore } from "@ponderosa/threads";
import { createServer, type EngineRegistration } from "../src/app.js";
import { CollaborationDeliveryStore } from "../src/handoffs.js";

class LeaseAdapter implements Adapter {
  id = "codex";
  displayName = "Lease adapter";
  seeds: SeedOptions[] = [];
  continues: ContinueOptions[] = [];
  aborts = 0;
  hangRuns = 1;
  private lateReleases: Array<() => void> = [];

  listModels(): ModelOption[] { return []; }
  listEfforts() { return []; }

  releaseLateEvent(): void { this.lateReleases.shift()?.(); }
  releaseAllLateEvents(): void { for (const release of this.lateReleases.splice(0)) release(); }

  private async *run(options: SeedOptions | ContinueOptions): AsyncIterable<AgentEvent> {
    if (this.hangRuns-- > 0) {
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => {
        this.aborts += 1;
        resolve();
      }, { once: true }));
      await new Promise<void>((resolve) => { this.lateReleases.push(resolve); });
      yield { type: "text", delta: "late event from expired generation" };
      yield { type: "turn_done" };
      return;
    }
    yield { type: "session", sessionId: "new-generation" };
    yield { type: "text", delta: "new generation completed" };
    yield { type: "turn_done" };
  }

  seed(options: SeedOptions): AsyncIterable<AgentEvent> {
    this.seeds.push(options);
    return this.run(options);
  }

  continue(options: ContinueOptions): AsyncIterable<AgentEvent> {
    this.continues.push(options);
    return this.run(options);
  }
}

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const eventually = async (condition: () => boolean) => {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not reached");
};

class FakeLeaseClock {
  now = Date.parse("2026-07-12T12:00:00.000Z");
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): NodeJS.Timeout => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return { unref() {}, __leaseTimerId: id } as unknown as NodeJS.Timeout;
  };

  clearTimer = (timer: NodeJS.Timeout): void => {
    this.timers.delete((timer as unknown as { __leaseTimerId: number }).__leaseTimerId);
  };

  async advance(ms: number): Promise<void> {
    this.now += ms;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      due[1].callback();
      await flush();
    }
  }
}

describe("enforced execution leases", () => {
  let dataDir: string;
  let repoDir: string;
  let store: ThreadStore;
  let adapter: LeaseAdapter;
  let engines: EngineRegistration[];
  let clock: FakeLeaseClock;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-execution-lease-"));
    repoDir = mkdtempSync(path.join(tmpdir(), "ponderosa-execution-lease-repo-"));
    store = new ThreadStore(dataDir);
    adapter = new LeaseAdapter();
    clock = new FakeLeaseClock();
    engines = [{ adapter, authStatus: async () => ({ authenticated: true }) }];
  });

  afterEach(() => {
    try { store.close(); } catch { /* app.close may already own shutdown */ }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  const server = () => createServer({
    dataDir,
    store,
    engines,
    logger: false,
    executionLeaseScheduling: { leaseMs: 1_000, now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  });

  it("expires once, aborts, revokes capabilities, and fences late events from a newer generation", async () => {
    const project = store.createProject({ label: "Lease", hostPath: repoDir });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex" });
    const app = server();
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "hang" } });
    await flush();
    const capability = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN;

    await clock.advance(1_000);
    await flush();
    expect(adapter.aborts).toBe(1);
    expect(store.readEvents(thread.id).filter((item) => item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toHaveLength(1);
    expect((await app.inject({
      method: "POST", url: "/api/agent-session/rollover", headers: { authorization: `Bearer ${capability}` },
    })).statusCode).toBe(401);

    const second = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "new generation" } });
    expect(second.statusCode).toBe(200);
    await flush();
    adapter.releaseLateEvent();
    await flush();

    const events = store.readEvents(thread.id);
    expect(events.some((item) => item.event.type === "text" && item.event.delta === "late event from expired generation")).toBe(false);
    expect(events.some((item) => item.event.type === "text" && item.event.delta === "new generation completed")).toBe(true);
    expect(events.filter((item) => item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/threads/${thread.id}/cancel` })).json()).toEqual({ cancelled: false });
    await app.close();
  });

  it("requeues a claimed collaboration delivery and resumes FIFO dispatch after expiry", async () => {
    const project = store.createProject({ label: "Lease", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Room" });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex", masterChatId: master.id });
    const app = server();
    const queued = await app.inject({
      method: "POST", url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "queued follow-up", recipientAgentIds: [thread.id] },
    });
    expect(queued.statusCode).toBe(200);
    await eventually(() => adapter.seeds.length === 1);

    await clock.advance(1_000);
    await flush();
    await eventually(() => adapter.seeds.length === 2);
    expect(adapter.seeds[1]!.prompt).toContain("#Agent queued follow-up");
    expect(store.readEvents(thread.id).filter((item) => item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toHaveLength(1);
    adapter.releaseLateEvent();
    await flush();
    await eventually(() => store.readEvents(thread.id).some((item) => item.event.type === "text" && item.event.delta === "new generation completed"));
    await app.close();
  });

  it("bounds repeated lease-expired recipient turns using the durable turn-attempt policy", async () => {
    adapter.hangRuns = 2;
    const project = store.createProject({ label: "Lease", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Room" });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex", masterChatId: master.id });
    const app = server();
    const queued = await app.inject({
      method: "POST", url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "bounded expiry", recipientAgentIds: [thread.id] },
    });
    const messageId = queued.json<{ message: { id: string } }>().message.id;
    await eventually(() => adapter.seeds.length === 1);

    await clock.advance(1_000);
    await eventually(() => adapter.seeds.length === 2);
    await clock.advance(1_000);
    await flush();

    const delivery = new CollaborationDeliveryStore(dataDir).getForMessageTarget(messageId, thread.id);
    expect(delivery).toMatchObject({ status: "failed", attempts: 2, failure: "execution lease expired" });
    expect(adapter.seeds).toHaveLength(2);
    expect(store.readEvents(thread.id).filter((item) =>
      item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toHaveLength(2);
    adapter.releaseAllLateEvents();
    await flush();
    await app.close();
  });

  it("settles a delegated runtime as failed when its execution lease expires", async () => {
    adapter.hangRuns = 2;
    const project = store.createProject({ label: "Lease", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Room" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const app = server();
    await app.inject({ method: "POST", url: `/api/threads/${parent.id}/messages`, payload: { text: "delegate" } });
    await flush();
    const token = adapter.seeds[0]!.environment!.PONDEROSA_DELEGATION_TOKEN;
    const response = await app.inject({
      method: "POST", url: "/api/agent-delegations", headers: { authorization: `Bearer ${token}` },
      payload: { displayLabel: "Hung child", delegationPrompt: "wait", runtime: "codex", idempotencyKey: "hung-child" },
    });
    const delegated = response.json<{ run: { id: string; childThreadId: string } }>().run;
    await flush();
    await clock.advance(1_000);
    await flush();

    expect((await app.inject({ method: "GET", url: `/api/master-chats/${master.id}/subagents` })).json()).toEqual([
      expect.objectContaining({ id: delegated.id, status: "failed", failure: expect.objectContaining({ message: "execution lease expired" }) }),
    ]);
    expect(store.readEvents(delegated.childThreadId).filter((item) => item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toHaveLength(1);
    adapter.releaseAllLateEvents();
    await flush();
    await app.close();
  });

  it("clears supervision timers on shutdown and preserves restart interruption recovery", async () => {
    const project = store.createProject({ label: "Lease", hostPath: repoDir });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex" });
    const app = server();
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "hang" } });
    await flush();
    await app.close();
    await clock.advance(2_000);
    store = new ThreadStore(dataDir);
    expect(store.readEvents(thread.id).some((item) => item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toBe(false);
    const restarted = createServer({ dataDir, store, engines, logger: false, executionLeaseScheduling: { leaseMs: 1_000, now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer } });
    expect(store.readEvents(thread.id).filter((item) => item.event.type === "agent_lifecycle" && item.event.reason === "execution_interrupted")).toHaveLength(1);
    await restarted.close();
  });
});
