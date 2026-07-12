import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AgentEvent, ContinueOptions, SeedOptions, ThreadDto } from "@ponderosa/core";
import { ThreadStore } from "@ponderosa/threads";
import { COLLABORATION_DISPATCH_LIMITS, createServer } from "../src/app.js";
import { projectAgentHealth } from "../src/agent-health.js";
import { CollaborationDeliveryStore } from "../src/handoffs.js";

class RecordingAdapter implements Adapter {
  id = "codex";
  displayName = "Codex";
  prompts: string[] = [];
  listModels() { return []; }
  listEfforts() { return []; }
  async *seed(options: SeedOptions): AsyncIterable<AgentEvent> {
    this.prompts.push(options.prompt);
    yield { type: "session", sessionId: "session" };
    yield { type: "turn_done" };
  }
  async *continue(options: ContinueOptions): AsyncIterable<AgentEvent> {
    this.prompts.push(options.prompt);
    yield { type: "turn_done" };
  }
}

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(count: number, text: (index: number) => string = (index) => `message-${index}`) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "pond-delivery-scheduling-"));
  dirs.push(dataDir);
  const store = new ThreadStore(dataDir);
  const project = store.createProject({ label: "Project", hostPath: dataDir });
  const master = store.createMasterChat(project.id, { title: "Room" });
  const thread = store.createThread(project.id, { title: "Recipient", engine: "codex", masterChatId: master.id });
  const ledger = new CollaborationDeliveryStore(dataDir);
  const ids = Array.from({ length: count }, (_, index) => ledger.queue({
    masterChatId: master.id,
    messageId: `message-${index}`,
    targetThreadId: thread.id,
    text: text(index),
    relayDepth: 0,
    mentionTrail: [],
    kind: "tag",
    createdAt: `2026-07-12T00:00:${String(index).padStart(2, "0")}.000Z`,
    orderKey: String(index).padStart(8, "0"),
  }).delivery.id);
  return { dataDir, store, project, master, thread, ids };
}

async function waitForPrompts(adapter: RecordingAdapter, count: number) {
  for (let index = 0; index < 100 && adapter.prompts.length < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("bounded collaboration delivery scheduling", () => {
  it.each([429, 500])("deduplicates timers and dead-letters a persistent %s claim", async (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:00:00.000Z"));
    const { dataDir, store, thread, ids } = fixture(1);
    let claims = 0;
    const adapter = new RecordingAdapter();
    const app = createServer({
      dataDir, store, engines: [{ adapter }], logger: false,
      deliveryScheduling: { random: () => 0.5, claimStatus: () => { claims += 1; return status; } },
    });
    await app.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(1);
    const timerCountAfterFirstClaim = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(COLLABORATION_DISPATCH_LIMITS.baseRetryMs - 1);
    expect(claims).toBe(1);
    expect(vi.getTimerCount()).toBe(timerCountAfterFirstClaim);
    await vi.advanceTimersByTimeAsync(60_000);

    const failed = new CollaborationDeliveryStore(dataDir).get(ids[0]!);
    expect(claims).toBe(COLLABORATION_DISPATCH_LIMITS.maxDispatchAttempts);
    expect(failed).toMatchObject({ status: "failed", dispatchAttempts: 5 });
    expect(failed?.failure).toContain("dead-lettered after 5 dispatch attempts");
    expect(new CollaborationDeliveryStore(dataDir).pendingCount(thread.id)).toBe(0);
    await app.close();
  });

  it("recovers a durable delayed retry after restart without losing FIFO", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:00:00.000Z"));
    const { dataDir, store, ids } = fixture(2);
    const adapter = new RecordingAdapter();
    const first = createServer({
      dataDir, store, engines: [{ adapter }], logger: false,
      deliveryScheduling: { random: () => 0.5, claimStatus: () => 500 },
    });
    await first.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(new CollaborationDeliveryStore(dataDir).get(ids[0]!)?.dispatchAttempts).toBe(1);
    await first.close();

    const reopenedStore = new ThreadStore(dataDir);
    const second = createServer({ dataDir, store: reopenedStore, engines: [{ adapter }], logger: false });
    await second.ready();
    await vi.advanceTimersByTimeAsync(COLLABORATION_DISPATCH_LIMITS.baseRetryMs);
    await vi.runOnlyPendingTimersAsync();
    expect(adapter.prompts[0]?.indexOf("message-0")).toBeLessThan(adapter.prompts[0]?.indexOf("message-1") ?? -1);
    expect(ids.map((id) => new CollaborationDeliveryStore(dataDir).get(id)?.status)).toEqual(["acknowledged", "acknowledged"]);
    await second.close();
  });

  it("caps a recipient turn by delivery count and leaves the ordered remainder queued", async () => {
    const { dataDir, store } = fixture(COLLABORATION_DISPATCH_LIMITS.maxBatchDeliveries + 3);
    const adapter = new RecordingAdapter();
    const app = createServer({ dataDir, store, engines: [{ adapter }], logger: false });
    await app.ready();
    await waitForPrompts(adapter, 2);
    expect(adapter.prompts[0]).toContain(`CollaborationDeliveryBatch (${COLLABORATION_DISPATCH_LIMITS.maxBatchDeliveries} deliveries`);
    expect(adapter.prompts[0]).not.toContain(`message-${COLLABORATION_DISPATCH_LIMITS.maxBatchDeliveries}`);
    expect(adapter.prompts[1]).toContain(`message-${COLLABORATION_DISPATCH_LIMITS.maxBatchDeliveries}`);
    expect(adapter.prompts[1]?.indexOf("message-20")).toBeLessThan(adapter.prompts[1]?.indexOf("message-22") ?? -1);
    await app.close();
  });

  it("caps a recipient turn by UTF-8 bytes without reordering multibyte messages", async () => {
    const payload = "🦊".repeat(30_000);
    const { dataDir, store } = fixture(3, (index) => `${index}:${payload}`);
    const adapter = new RecordingAdapter();
    const app = createServer({ dataDir, store, engines: [{ adapter }], logger: false });
    await app.ready();
    await waitForPrompts(adapter, 3);
    expect(adapter.prompts).toHaveLength(3);
    expect(adapter.prompts.map((prompt) => prompt.includes("0:") ? 0 : prompt.includes("1:") ? 1 : 2)).toEqual([0, 1, 2]);
    expect(adapter.prompts.every((prompt) => {
      const batch = prompt.slice(prompt.indexOf("CollaborationDeliveryBatch"));
      return Buffer.byteLength(batch, "utf8") <= COLLABORATION_DISPATCH_LIMITS.maxBatchUtf8Bytes;
    })).toBe(true);
    await app.close();
  });

  it("projects 1,000 busy agents from indexed queues and realistic events within a bounded interval", () => {
    const { dataDir, store, project } = fixture(0);
    const ledger = new CollaborationDeliveryStore(dataDir);
    const threads: ThreadDto[] = [];
    const events = new Map<string, ReturnType<ThreadStore["readEvents"]>>();
    for (let index = 0; index < 1_000; index += 1) {
      const agent = store.createThread(project.id, { title: `Agent ${index}`, engine: "codex" });
      threads.push(agent);
      ledger.queue({ messageId: `busy-${index}`, targetThreadId: agent.id, text: "queued", relayDepth: 0, mentionTrail: [], kind: "direct" });
      store.appendEvent(agent.id, { type: "task_update", taskId: `task-${index}`, status: "running" });
      store.appendEvent(agent.id, { type: "text", delta: "busy output" });
      events.set(agent.id, store.readEvents(agent.id));
    }
    const started = performance.now();
    const result = projectAgentHealth({
      scope: { type: "project", id: project.id }, threads, delegations: [], activeRuns: new Map(),
      queuedDeliveries: (threadId) => ledger.pending(threadId), events: (threadId) => events.get(threadId) ?? [],
      now: "2026-07-12T00:00:00.000Z",
    });
    const elapsedMs = performance.now() - started;
    expect(result.agents).toHaveLength(1_000);
    expect(result.agents.every((agent) => agent.reason === "queued_delivery")).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
