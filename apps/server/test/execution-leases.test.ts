import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapter, AgentEvent, ContinueOptions, ModelOption, OpenRuntimeSessionOptions, RuntimeSession, SeedOptions } from "@ponderosa/core";
import { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { createServer, type EngineRegistration } from "../src/app.js";

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

class PersistentEventQueue implements AsyncIterable<AgentEvent> {
  private values: AgentEvent[] = [];
  private waiters: Array<(value: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;

  push(value: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false }); else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    this.values = [];
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return { next: () => {
      const value = this.values.shift();
      return value ? Promise.resolve({ value, done: false })
        : this.closed ? Promise.resolve({ value: undefined, done: true })
        : new Promise((resolve) => this.waiters.push(resolve));
    } };
  }
}

class PersistentLeaseAdapter implements Adapter {
  id = "codex";
  displayName = "Persistent lease adapter";
  opened = 0;
  alive = true;
  private readonly queue = new PersistentEventQueue();

  listModels(): ModelOption[] { return []; }
  listEfforts() { return []; }
  seed(_options: SeedOptions): AsyncIterable<AgentEvent> { throw new Error("persistent adapter must open a session"); }
  continue(_options: ContinueOptions): AsyncIterable<AgentEvent> { throw new Error("persistent adapter must open a session"); }

  async openSession(_options: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    this.opened += 1;
    this.queue.push({ type: "session", sessionId: "persistent-session" });
    return {
      engineAgentId: "persistent-session",
      events: this.queue,
      isAlive: () => this.alive,
      startTurn: async () => ({ turnId: "persistent-turn" }),
      steer: async () => ({ status: "accepted", turnId: "persistent-turn" }),
      interrupt: async () => undefined,
      close: async () => { this.alive = false; this.queue.close(); },
    };
  }

  finish(): void {
    this.queue.push({ type: "text", delta: "persistent work completed" });
    this.queue.push({ type: "turn_done" });
  }
}

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const eventually = async (condition: () => boolean) => {
  for (let index = 0; index < 1_000; index += 1) {
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
  let store: AgentStore;
  let adapter: LeaseAdapter;
  let engines: EngineRegistration[];
  let clock: FakeLeaseClock;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ponderosa-execution-lease-"));
    repoDir = mkdtempSync(path.join(tmpdir(), "ponderosa-execution-lease-repo-"));
    store = new AgentStore(dataDir);
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
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex" });
    const app = server();
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "hang" } });
    await eventually(() => adapter.seeds.length === 1);
    const capability = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN;

    await clock.advance(1_000);
    await flush();
    expect(adapter.aborts).toBe(1);
    expect(store.readEvents(agent.id).filter((item) => item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toHaveLength(1);
    expect((await app.inject({
      method: "POST", url: "/api/agent-session/rollover", headers: { authorization: `Bearer ${capability}` },
    })).statusCode).toBe(401);

    const second = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "new generation" } });
    expect(second.statusCode).toBe(202);
    await eventually(() => adapter.seeds.length === 2);
    adapter.releaseLateEvent();
    await flush();

    const events = store.readEvents(agent.id);
    expect(events.some((item) => item.event.type === "text" && item.event.delta === "late event from expired generation")).toBe(false);
    expect(events.some((item) => item.event.type === "text" && item.event.delta === "new generation completed")).toBe(true);
    expect(events.filter((item) => item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toHaveLength(1);
    const staleStop = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/cancel`,
      payload: { targetRunId: "already-finished", idempotencyKey: "late-lease-stop" },
    });
    expect(staleStop.statusCode).toBe(409);
    expect(staleStop.json()).toMatchObject({ cancelled: false, replayed: false });
    await app.close();
  });

  it("renews a quiet persistent turn while its engine process remains alive", async () => {
    const persistent = new PersistentLeaseAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const project = store.createProject({ label: "Lease", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex" });
    const app = server();

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "quiet tool call" } });
    await eventually(() => persistent.opened === 1);
    await clock.advance(1_500);

    expect(store.readEvents(agent.id).some((item) =>
      item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toBe(false);
    persistent.finish();
    await eventually(() => store.readEvents(agent.id).some((item) =>
      item.event.type === "agent_lifecycle" && item.event.reason === "turn_completed"));
    expect(store.readEvents(agent.id).some((item) =>
      item.event.type === "agent_output" && item.event.text === "persistent work completed")).toBe(true);
    await app.close();
  });

  it("fails closed instead of replaying an injected activation after lease expiry", async () => {
    const project = store.createProject({ label: "Lease", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: master.id });
    const app = server();
    const queued = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "queued follow-up", recipientAgentIds: [agent.id] },
    });
    expect(queued.statusCode).toBe(200);
    await eventually(() => adapter.seeds.length === 1);

    await clock.advance(1_000);
    await flush();
    expect(store.readEvents(agent.id).filter((item) => item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toHaveLength(1);
    expect(new CoordinationV3Store(store.sqlite).schedulerMetrics().outcomeUnknownRuns).toBe(1);
    expect(adapter.seeds).toHaveLength(1);
    adapter.releaseLateEvent();
    await flush();
    expect(store.readEvents(agent.id).some((item) => item.event.type === "text" && item.event.delta === "late event from expired generation")).toBe(false);
    await app.close();
  });

  it("clears supervision timers and preserves SQLite recovery state across restart", async () => {
    const project = store.createProject({ label: "Lease", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex" });
    const app = server();
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "hang" } });
    await eventually(() => adapter.seeds.length === 1);
    const closing = app.close();
    await eventually(() => adapter.aborts === 1);
    let settled = false;
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    adapter.releaseAllLateEvents();
    await closing;
    await clock.advance(2_000);
    store = new AgentStore(dataDir);
    expect(store.readEvents(agent.id).some((item) => item.event.type === "agent_lifecycle" && item.event.reason === "execution_lease_expired")).toBe(false);
    const restarted = createServer({ dataDir, store, engines, logger: false, executionLeaseScheduling: { leaseMs: 1_000, now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer } });
    await restarted.ready();
    expect(new CoordinationV3Store(store.sqlite).schedulerMetrics().outcomeUnknownRuns).toBe(1);
    await restarted.close();
  });
});
