import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AgentEvent, CommunicationEvent, ContinueOptions, EffortOption, ModelOption, OpenRuntimeSessionOptions, RuntimeSession, RuntimeTurnInput, SeedOptions } from "@ponderosa/core";
import { AgentStore } from "@ponderosa/agents";
import { boundedSeedHistory, createServer, isProjectFileReferenceAllowed, parseGitStatus, runtimeIdentityPrompt, type EngineRegistration } from "../src/app.js";
import { CollaborationDeliveryStore } from "../src/handoffs.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function appendBroadcast(store: AgentStore, projectId: string, conversationId: string, text: string) {
  const eventId = randomUUID();
  store.appendCommunicationEvent({
    eventId, schemaVersion: 1, projectId, conversationId,
    sender: { kind: "user", userId: "local-operator" },
    intent: "broadcast", audience: { kind: "organization", organizationId: projectId },
    text, createdAt: new Date().toISOString(),
  });
  return store.appendConversationMessage(conversationId, { text }, undefined, "main", undefined, undefined, eventId);
}

function appendCanonicalMessage(
  store: AgentStore,
  projectId: string,
  conversationId: string,
  input: Parameters<AgentStore["appendConversationMessage"]>[1],
  authorAgentId?: string,
  channel: Parameters<AgentStore["appendConversationMessage"]>[3] = "main",
  deliveryIntents?: Parameters<AgentStore["appendConversationMessage"]>[4],
  messageReceiptKey?: string,
  audienceAgentIds = [...new Set((deliveryIntents ?? []).map((intent) => intent.targetAgentId))],
) {
  const eventId = randomUUID();
  const event: CommunicationEvent = channel === "collaboration"
    ? {
        eventId, schemaVersion: 2, projectId, conversationId,
        sender: authorAgentId ? { kind: "agent", agentId: authorAgentId } : { kind: "user", userId: "local-operator" },
        intent: "collaboration", audience: { kind: "agents", agentIds: audienceAgentIds as [string, ...string[]] },
        text: input.text, createdAt: new Date().toISOString(),
      }
    : audienceAgentIds.length
      ? {
          eventId, schemaVersion: 2, projectId, conversationId,
          sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
          audience: audienceAgentIds.length === 1
            ? { kind: "user_agent", userId: "local-operator", agentId: audienceAgentIds[0]! }
            : { kind: "user_agents", userId: "local-operator", agentIds: audienceAgentIds as [string, ...string[]] },
          text: input.text, createdAt: new Date().toISOString(),
        }
      : {
          eventId, schemaVersion: 1, projectId, conversationId,
          sender: authorAgentId ? { kind: "agent", agentId: authorAgentId } : { kind: "user", userId: "local-operator" },
          intent: "broadcast", audience: { kind: "organization", organizationId: projectId },
          text: input.text, createdAt: new Date().toISOString(),
        };
  store.appendCommunicationEvent(event);
  return store.appendConversationMessage(
    conversationId, input, authorAgentId, channel, deliveryIntents, messageReceiptKey, eventId,
  );
}

class MockAdapter implements Adapter {
  id = "codex";
  displayName = "Mock Codex";
  readonly seeds: SeedOptions[] = [];
  readonly continues: ContinueOptions[] = [];
  abortedSeeds = 0;
  mode: "normal" | "hang" | "boundary" | "resume_compaction_fail" | "material_compaction_fail" = "normal";
  responseText = "done";
  beforeResponse?: (opts: SeedOptions) => Promise<void>;
  failuresRemaining = 0;
  failNextTurn = false;
  turnUsage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; totalTokens?: number };

  listModels(): ModelOption[] {
    return [{ id: "mock-model", label: "Mock Model" }];
  }

  listEfforts(): EffortOption[] {
    return [{ id: "high", label: "High" }];
  }

  async *seed(opts: SeedOptions): AsyncIterable<AgentEvent> {
    this.seeds.push(opts);
    yield { type: "session", sessionId: "sess-1" };
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      yield { type: "error", message: "simulated runtime failure" };
      return;
    }
    if (this.failNextTurn) {
      this.failNextTurn = false;
      yield { type: "error", message: "transient runtime failure" };
      yield { type: "turn_done" };
      return;
    }
    if (this.mode === "hang") {
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      this.abortedSeeds += 1;
      yield { type: "error", message: "run cancelled" };
      return;
    }
    if (this.mode === "boundary") {
      // Leave a real safe-boundary window after a tool event. Collaboration
      // notifications must queue here rather than alter the in-flight turn.
      yield { type: "command", command: "long-running-tool", cwd: opts.cwd };
      await sleep(40);
    }
    const beforeResponse = this.beforeResponse;
    this.beforeResponse = undefined;
    if (beforeResponse) await beforeResponse(opts);
    await sleep(5);
    yield { type: "command", command: "pnpm test", cwd: opts.cwd };
    yield { type: "file_change", path: "a.ts", kind: "edit", diff: "diff --git a/a.ts b/a.ts\n" };
    yield { type: "text", delta: this.responseText };
    yield { type: "turn_done", ...(this.turnUsage ? { usage: this.turnUsage } : {}) };
  }

  async *continue(opts: ContinueOptions): AsyncIterable<AgentEvent> {
    this.continues.push(opts);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      yield { type: "error", message: "simulated runtime failure" };
      return;
    }
    if (this.mode === "resume_compaction_fail") {
      yield { type: "session", sessionId: opts.resumeSessionId };
      yield {
        type: "error",
        message: "codex exited with code 1: Failed to run pre-sampling compact",
      };
      return;
    }
    if (this.mode === "material_compaction_fail") {
      yield { type: "session", sessionId: opts.resumeSessionId };
      yield { type: "command", command: "touch already-ran", cwd: opts.cwd };
      yield { type: "error", message: "codex exited with code 1: Failed to run pre-sampling compact" };
      return;
    }
    if (this.failNextTurn) {
      this.failNextTurn = false;
      yield { type: "error", message: "transient runtime failure" };
      yield { type: "turn_done" };
      return;
    }
    yield { type: "text", delta: `continued ${opts.resumeSessionId}` };
    yield { type: "turn_done" };
  }
}

class TestEventQueue implements AsyncIterable<AgentEvent> {
  private values: AgentEvent[] = [];
  private waiters: Array<(value: IteratorResult<AgentEvent>) => void> = [];
  push(value: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false }); else this.values.push(value);
  }
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return { next: () => {
      const value = this.values.shift();
      return value ? Promise.resolve({ value, done: false }) : new Promise((resolve) => this.waiters.push(resolve));
    } };
  }
}

class SteerableMockAdapter extends MockAdapter {
  readonly starts: RuntimeTurnInput[] = [];
  readonly steers: RuntimeTurnInput[] = [];
  readonly openedOptions: OpenRuntimeSessionOptions[] = [];
  opened = 0;
  closed = 0;
  completeStartedTurns = false;
  onStartedTurn?: (turnNumber: number, environment: NonNullable<OpenRuntimeSessionOptions["environment"]>) => Promise<void>;

  async openSession(opts: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    this.opened += 1;
    this.openedOptions.push(opts);
    const queue = new TestEventQueue();
    queue.push({ type: "session", sessionId: "persistent-session" });
    return {
      engineAgentId: "persistent-session",
      events: queue,
      isAlive: () => true,
      startTurn: async (input) => {
        this.starts.push(input);
        if (this.completeStartedTurns) {
          await this.onStartedTurn?.(this.starts.length, opts.environment ?? {});
          queue.push({ type: "turn_done" });
        }
        return { turnId: "persistent-turn" };
      },
      steer: async (input) => {
        this.steers.push(input);
        queue.push({ type: "text", delta: "steered result" });
        queue.push({ type: "turn_done" });
        return { status: "accepted", turnId: "persistent-turn" };
      },
      interrupt: async () => undefined,
      close: async () => { this.closed += 1; },
    };
  }
}

let dataDir: string;
let repoDir: string;
let store: AgentStore;
let adapter: MockAdapter;
let engines: EngineRegistration[];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-server-data-"));
  repoDir = mkdtempSync(path.join(tmpdir(), "pond-server-repo-"));
  writeFileSync(path.join(repoDir, "README.md"), "# demo\n", "utf8");
  store = new AgentStore(dataDir);
  adapter = new MockAdapter();
  engines = [{ adapter, authStatus: async () => ({ authenticated: true, detail: "test" }) }];
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

async function createProjectAndAgent() {
  const app = createServer({ dataDir, store, engines, logger: false });
  const projectRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { label: "Demo", hostPath: repoDir },
  });
  const project = projectRes.json<{ id: string }>();
  const agentRes = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/agents`,
    payload: { title: "Agent", engine: "codex" },
  });
  const agent = agentRes.json<{ id: string }>();
  return { app, project, agent };
}

async function waitForRun(agentId: string, expectedTurnDoneCount = 1): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const done = store.readEvents(agentId).filter((event) => event.event.type === "turn_done").length;
    if (done >= expectedTurnDoneCount) return;
    await sleep(10);
  }
  throw new Error("run did not finish");
}

async function waitForSeedCount(expected: number): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (adapter.seeds.length >= expected) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${expected} seeded runs`);
}

describe("generated artifact endpoints", () => {
  it("previews and downloads a canonical PDF only inside its owning project", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const pdf = Buffer.from("%PDF-1.4\n% test\n");
    const pdfPath = path.join(repoDir, "report.pdf");
    writeFileSync(pdfPath, pdf);
    store.appendEvent(agent.id, { type: "file_change", path: pdfPath, kind: "create" });
    const artifact = store.getArtifacts(agent.id).find((item) => item.kind === "document")!;

    expect(artifact).toMatchObject({ mediaType: "application/pdf", previewUrl: expect.any(String), downloadUrl: expect.any(String) });
    const preview = await app.inject({ method: "GET", url: artifact.previewUrl! });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("application/pdf");
    expect(preview.headers["content-disposition"]).toContain("inline");
    expect(preview.rawPayload).toEqual(pdf);

    const download = await app.inject({ method: "GET", url: artifact.downloadUrl! });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    const foreign = artifact.previewUrl!.replace(`/projects/${project.id}/`, "/projects/not-the-owner/");
    expect((await app.inject({ method: "GET", url: foreign })).statusCode).toBe(404);
    await app.close();
  });
});

describe("token usage API", () => {
  it("reports provider usage at agent, project, and overall scopes after a real run", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    adapter.turnUsage = { inputTokens: 120, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 150 };
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Meter this run" } })).statusCode).toBe(200);
    await waitForRun(agent.id);
    await expect.poll(() => store.getRuns(agent.id)[0]?.status).toBe("completed");

    const agentUsage = (await app.inject({ method: "GET", url: `/api/agents/${agent.id}/usage` })).json();
    expect(agentUsage).toMatchObject({ scope: "agent", scopeId: agent.id, inputTokens: 120, cachedInputTokens: 40, outputTokens: 30, totalTokens: 150, finalizedRuns: 1, reportedRuns: 1, coverage: 1 });
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/usage` })).json()).toMatchObject({ scope: "project", totalTokens: 150 });
    expect((await app.inject({ method: "GET", url: "/api/usage" })).json()).toMatchObject({ scope: "overall", totalTokens: 150 });
    expect((await app.inject({ method: "GET", url: "/api/agents/missing/usage" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("project lifecycle API", () => {
  it("creates a safe managed workspace when working folder selection is omitted", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const response = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Optional folder" } });
    expect(response.statusCode).toBe(200);
    const project = response.json<{ id: string; hostPath: string }>();
    expect(project.hostPath.startsWith(path.join(dataDir, "workspaces") + path.sep)).toBe(true);
    expect(statSync(project.hostPath).isDirectory()).toBe(true);
    await app.close();
  });

  it("lists only registered and managed folders and creates a named empty managed folder", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    store.createProject({ label: "Registered", hostPath: repoDir });
    const outside = mkdtempSync(path.join(tmpdir(), "pond-unregistered-"));
    const created = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Created", createFolderName: "fresh-work" } });
    expect(created.statusCode).toBe(200);
    const createdProject = created.json<{ hostPath: string }>();
    expect(createdProject.hostPath).toBe(path.join(dataDir, "workspaces", "fresh-work"));
    expect(readdirSync(createdProject.hostPath)).toEqual([]);
    const choices = await app.inject({ method: "GET", url: "/api/project-folders" });
    const paths = choices.json<{ folders: Array<{ hostPath: string }> }>().folders.map((folder) => folder.hostPath);
    expect(paths).toContain(repoDir);
    expect(paths).toContain(createdProject.hostPath);
    expect(paths).not.toContain(outside);
    const collision = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Collision", createFolderName: "fresh-work" } });
    expect(collision.statusCode).toBe(409);
    rmSync(outside, { recursive: true, force: true });
    await app.close();
  });

  it("renames and permanently deletes canonical project data without deleting source files", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Before", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: master.id });
    store.appendEvent(agent.id, { type: "user_message", text: "canonical execution input" });
    const renamed = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, payload: { label: "After" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: project.id, label: "After", hostPath: repoDir });
    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(store.getProject(project.id)).toBeUndefined();
    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(existsSync(path.join(dataDir, "projects", project.id))).toBe(false);
    expect(existsSync(path.join(repoDir, "README.md"))).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/files?projectId=${project.id}` })).statusCode).toBe(404);
    await app.close();
  });
});

describe("persistent engine steering", () => {
  it("steers an active agent immediately instead of adding a FIFO delivery", async () => {
    const steerable = new SteerableMockAdapter();
    engines = [{ adapter: steerable, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Steering", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Persistent", engine: "codex" });

    const first = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Start working" } });
    expect(first.statusCode).toBe(200);
    await vi.waitFor(() => expect(steerable.starts).toHaveLength(1));
    const original = store.getMessages(agent.id).find((message) => message.text === "Start working")!;
    const second = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Use the new direction", replyToMessageId: original.id },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ queued: false, steered: true, mode: "steer" });
    expect(steerable.opened).toBe(1);
    expect(steerable.steers).toEqual([expect.objectContaining({ kind: "user_message" })]);
    expect(steerable.steers[0]?.prompt).toContain("Use the new direction");
    expect(steerable.steers[0]?.prompt).toContain("Replying specifically to this earlier message:\n> Start working");
    await waitForRun(agent.id);
    expect(store.getMessages(agent.id).map((message) => message.text)).toEqual([
      "Start working", "Use the new direction",
    ]);
    expect(store.getAgentDetail(agent.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), kind: "response", text: "steered result", completed: true }),
    ]);
    expect(new CollaborationDeliveryStore(dataDir).pendingCount(agent.id)).toBe(0);
    await app.close();
  });

  it("queues explicitly instead of steering an active agent", async () => {
    const steerable = new SteerableMockAdapter();
    engines = [{ adapter: steerable, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Explicit queue", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Persistent", engine: "codex" });

    expect((await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Start working" },
    })).statusCode).toBe(200);
    await vi.waitFor(() => expect(steerable.starts).toHaveLength(1));
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` })).json())
      .toMatchObject({ agents: [expect.objectContaining({
        agentId: agent.id,
        runtimeActivity: { state: "responding", executionId: expect.any(String), startedAt: expect.any(String) },
      })] });

    const queued = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Do this after", activeRunDelivery: "queue" },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({ queued: true, position: 1 });
    expect(steerable.steers).toHaveLength(0);
    expect(new CollaborationDeliveryStore(dataDir).pendingCount(agent.id)).toBe(1);
    await app.close();
  });

  it("reuses session-scoped capabilities while authorizing only the current turn", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: { maxIdleSessions: 1 },
    });
    const project = store.createProject({ label: "Persistent capabilities", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Dinosaur", engine: "codex", conversationId: master.id });
    const statuses: number[] = [];
    const observedTokens: string[] = [];
    persistent.onStartedTurn = async (turnNumber, environment) => {
      observedTokens.push(environment.PONDEROSA_AGENT_MESSAGE_TOKEN!);
      const sent = await app.inject({
        method: "POST", url: "/api/agent-messages",
        headers: { authorization: `Bearer ${environment.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { intent: "direct_to_user", text: `reply ${turnNumber}` },
      });
      statuses.push(sent.statusCode);
    };

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "first" } });
    await waitForRun(agent.id);
    const expiredBetweenTurns = await app.inject({
      method: "POST", url: "/api/agent-messages",
      headers: { authorization: `Bearer ${observedTokens[0]}` },
      payload: { intent: "direct_to_user", text: "must fail while idle" },
    });
    expect(expiredBetweenTurns.statusCode).toBe(401);

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "second" } });
    await waitForRun(agent.id, 2);
    expect(persistent.opened).toBe(1);
    expect(observedTokens).toEqual([observedTokens[0], observedTokens[0]]);
    expect(statuses).toEqual([200, 200]);
    expect(store.getConversationMessages(master.id).filter((message) => message.authorAgentId === agent.id)
      .map((message) => message.text)).toEqual(["#user reply 1", "#user reply 2"]);
    await app.close();
  });

  it("closes an idle persistent runtime after the bounded warm-session TTL", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    let idleCallback: (() => void) | undefined;
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: {
        idleTtlMs: 10,
        maxIdleSessions: 1,
        setTimer: (callback) => {
          idleCallback = callback;
          return { unref() {} } as unknown as NodeJS.Timeout;
        },
        clearTimer: () => undefined,
      },
    });
    const project = store.createProject({ label: "Runtime TTL", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Bounded", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "run" } });
    await waitForRun(agent.id);
    expect(persistent.opened).toBe(1);
    expect(persistent.closed).toBe(0);
    idleCallback?.();
    await vi.waitFor(() => expect(persistent.closed).toBe(1));
    await app.close();
    expect(persistent.closed).toBe(1);
  });

  it("closes idle persistent runtimes by default instead of retaining an implicit warm pool", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "No implicit warm pool", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Ephemeral", engine: "codex" });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "run" } });
    await waitForRun(agent.id);

    expect(persistent.opened).toBe(1);
    await vi.waitFor(() => expect(persistent.closed).toBe(1));
    await app.close();
  });

  it("closes an active persistent runtime and removes its ownership ledger when the agent is deleted", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Delete active runtime", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Ephemeral", engine: "codex" });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "keep running" } });
    await vi.waitFor(() => expect(persistent.opened).toBe(1));

    const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(persistent.closed).toBe(1);
    expect(readFileSync(path.join(dataDir, "runtime-runs.jsonl"), "utf8")).not.toContain(agent.id);
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel` })).json())
      .toEqual({ cancelled: false });
    await app.close();
  });

  it("bounds the global warm-idle runtime pool and resumes an evicted agent normally", async () => {
    const persistent = new SteerableMockAdapter();
    persistent.completeStartedTurns = true;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    let now = 0;
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: {
        idleTtlMs: 60_000,
        maxIdleSessions: 2,
        now: () => ++now,
        setTimer: () => ({ unref() {} }) as unknown as NodeJS.Timeout,
        clearTimer: () => undefined,
      },
    });
    const project = store.createProject({ label: "Warm pool", hostPath: repoDir });
    const agents = ["Oldest", "Middle", "Newest"].map((title) =>
      store.createAgent(project.id, { title, engine: "codex" }));

    for (const agent of agents) {
      await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: `run ${agent.title}` } });
      await waitForRun(agent.id);
    }

    expect(persistent.opened).toBe(3);
    await vi.waitFor(() => expect(persistent.closed).toBe(1));

    await app.inject({ method: "POST", url: `/api/agents/${agents[0]!.id}/messages`, payload: { text: "resume oldest" } });
    await waitForRun(agents[0]!.id, 2);
    expect(persistent.opened).toBe(4);
    expect(persistent.openedOptions.at(-1)?.resumeSessionId).toBe("persistent-session");
    await app.close();
  });

  it("never evicts an active runtime to satisfy the warm-idle limit", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      runtimeSessionScheduling: {
        maxIdleSessions: 1,
        setTimer: () => ({ unref() {} }) as unknown as NodeJS.Timeout,
        clearTimer: () => undefined,
      },
    });
    const project = store.createProject({ label: "Active runtime", hostPath: repoDir });
    const active = store.createAgent(project.id, { title: "Active", engine: "codex" });
    const firstIdle = store.createAgent(project.id, { title: "First idle", engine: "codex" });
    const secondIdle = store.createAgent(project.id, { title: "Second idle", engine: "codex" });

    await app.inject({ method: "POST", url: `/api/agents/${active.id}/messages`, payload: { text: "keep working" } });
    await vi.waitFor(() => expect(persistent.opened).toBe(1));
    persistent.completeStartedTurns = true;
    for (const agent of [firstIdle, secondIdle]) {
      await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "finish" } });
      await waitForRun(agent.id);
    }
    await vi.waitFor(() => expect(persistent.closed).toBe(1));

    const steered = await app.inject({ method: "POST", url: `/api/agents/${active.id}/messages`, payload: { text: "still alive" } });
    expect(steered.json()).toMatchObject({ steered: true });
    await waitForRun(active.id);
    expect(persistent.opened).toBe(3);
    await app.close();
  });
});

async function cancelAndWait(app: ReturnType<typeof createServer>, agentId: string): Promise<void> {
  await app.inject({ method: "POST", url: `/api/agents/${agentId}/cancel` });
  for (let i = 0; i < 80; i += 1) {
    const response = await app.inject({ method: "POST", url: `/api/agents/${agentId}/cancel` });
    if (!response.json<{ cancelled: boolean }>().cancelled) return;
    await sleep(10);
  }
  throw new Error("run did not cancel");
}

describe("server chunk F", () => {
  it("detects a received-but-unpersisted event as stalled without cancelling the owned run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let received = false;
    const transitions: string[] = [];
    const app = createServer({ dataDir, store, engines, logger: false, runtimeEventFaults: {
      stallAfterMs: 20,
      beforePersist: async ({ event }) => { if (event.type === "command") { received = true; await gate; } },
      onOwnershipState: ({ state }) => transitions.push(state),
    } });
    const project = store.createProject({ label: "Stall", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Stalled", engine: "codex" });
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "run" } })).statusCode).toBe(200);
    await vi.waitFor(() => expect(received).toBe(true));
    await sleep(25);
    const health = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` });
    expect(health.json<{ agents: Array<{ status: string; reason: string; runtimeOwnership: string }> }>().agents[0])
      .toMatchObject({ status: "stalled", reason: "runtime_event_consumer_stalled", runtimeOwnership: "stalled" });
    expect(transitions.filter((state) => state === "stalled")).toHaveLength(1);
    expect(store.readEvents(agent.id).some((item) => item.event.type === "command")).toBe(false);
    release();
    await waitForRun(agent.id);
    expect(transitions).toContain("running");
    await app.close();
  });

  it("fences a cancelled generation and executes its queued successor exactly once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blocked = false;
    const app = createServer({ dataDir, store, engines, logger: false, runtimeEventFaults: {
      beforePersist: async ({ event, generation }) => {
        if (generation === 1 && event.type === "command") { blocked = true; await gate; }
      },
    } });
    const project = store.createProject({ label: "Fence", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Fenced", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "first prompt" } });
    await vi.waitFor(() => expect(blocked).toBe(true));
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "queued prompt" } })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel` })).json()).toEqual({ cancelled: true });
    release();
    await vi.waitFor(() => expect(adapter.seeds.length + adapter.continues.length).toBe(2));
    await waitForRun(agent.id);
    expect(store.getMessages(agent.id).filter((message) => message.text === "queued prompt")).toHaveLength(1);
    expect(store.readEvents(agent.id).filter((item) => item.event.type === "agent_lifecycle" && item.event.status === "completed")).toHaveLength(1);
    await app.close();
  });

  it("serves server-owned agent health at project and conversation scope", async () => {
    const project = store.createProject({ label: "Health", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex", conversationId: room.id });
    const outside = store.createAgent(project.id, { title: "Outside", engine: "codex" });
    const app = createServer({ dataDir, store, engines, logger: false });

    const roomHealth = await app.inject({ method: "GET", url: `/api/conversations/${room.id}/agent-health` });
    expect(roomHealth.statusCode).toBe(200);
    expect(roomHealth.json()).toMatchObject({
      scope: { type: "conversation", id: room.id },
      agents: [{ agentId: agent.id, status: "idle", reason: "no_active_work" }],
    });

    const projectHealth = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` });
    expect(projectHealth.statusCode).toBe(200);
    expect(projectHealth.json<{ agents: Array<{ agentId: string }> }>().agents.map((item) => item.agentId).sort())
      .toEqual([agent.id, outside.id].sort());
    await app.close();
  });

  it("reports observed compaction and preserves ordinary cancellation", async () => {
    const project = store.createProject({ label: "Health transitions", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex" });
    const app = createServer({ dataDir, store, engines, logger: false });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Work" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect((await app.inject({
      method: "POST", url: "/api/agent-session/rollover",
      headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` })).json())
      .toMatchObject({ agents: [expect.objectContaining({ agentId: agent.id, status: "compacting", reason: "session_rollover_scheduled" })] });

    await cancelAndWait(app, agent.id);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health` })).json())
      .toMatchObject({ agents: [expect.objectContaining({ agentId: agent.id, status: "cancelled", reason: "agent_cancelled" })] });
    await app.close();
  });

  it("bounds fresh-session history by both characters and message count", () => {
    const history = Array.from({ length: 80 }, (_, index) => ({ role: "user" as const, text: `${index}:` + "x".repeat(1_000) }));
    const bounded = boundedSeedHistory(history, 5_000, 4);
    expect(bounded).toHaveLength(4);
    expect(bounded.reduce((total, message) => total + message.text.length, 0)).toBeLessThanOrEqual(5_000);
    expect(bounded.at(-1)?.text.startsWith("79:")).toBe(true);
  });

  it("binds every runtime turn to one stable agent and execution identity", () => {
    const prompt = runtimeIdentityPrompt({ id: "agent-10", title: "Great Basin", projectId: "project-a" }, "execution-2");
    expect(prompt).toContain("your agent id: agent-10");
    expect(prompt).toContain("your display name: Great Basin");
    expect(prompt).toContain("You are exactly Great Basin (agent-10)");
    expect(prompt).toContain("your execution id: execution-2");
  });

  it("exposes and injects a structured Team Directory through run-bound discovery capabilities", async () => {
    adapter.mode = "hang";
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Directory", hostPath: repoDir });
    const preset = store.listAgentPresets(project.id).find((item) => item.name === "Frontend")!;
    const parent = store.createAgent(project.id, { title: "Lead", engine: "codex", presetId: preset.id });
    const child = store.createAgent(project.id, { title: "Reviewer", engine: "codex" });
    store.updateAgentOrganization(child.id, { managerAgentId: parent.id });
    store.appendEvent(parent.id, { type: "work_item_update", workItemId: "directory", title: "Build directory", status: "running" });

    await app.inject({ method: "POST", url: `/api/agents/${parent.id}/messages`, payload: { text: "Start" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const directory = await app.inject({ method: "GET", url: "/api/agent-directory", headers: { authorization: `Bearer ${token}` } });
    expect(directory.statusCode).toBe(200);
    expect(directory.json()).toMatchObject({ projectId: project.id, agents: expect.arrayContaining([
      expect.objectContaining({ agentId: parent.id, role: "Frontend", status: "running", childAgentIds: [child.id], engine: "codex" }),
      expect.objectContaining({ agentId: child.id, managerAgentId: parent.id, role: "Generalist" }),
    ]) });
    expect((await app.inject({ method: "GET", url: `/api/agent-directory/${child.id}`, headers: { authorization: `Bearer ${token}` } })).json())
      .toMatchObject({ agentId: child.id, managerAgentId: parent.id });
    expect(adapter.seeds[0]!.environment!.PONDEROSA_AGENT_DIRECTORY_URL).toContain("/api/agent-directory");
    expect(adapter.seeds[0]!.prompt).toContain("Current Team Directory");
    expect(adapter.seeds[0]!.prompt).toContain(`\"agentId\":\"${child.id}\"`);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/team-directory` })).statusCode).toBe(200);
    await cancelAndWait(app, parent.id);
    expect((await app.inject({ method: "GET", url: "/api/agent-directory", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    await app.close();
  });

  it("excludes hidden, generated, and credential-like project references", () => {
    expect(isProjectFileReferenceAllowed("src/app.ts")).toBe(true);
    for (const candidate of [".git/config", ".env.example", ".oauth_tokens.json", "node_modules/pkg/index.js", "config/credentials.json", "build/app.js"]) {
      expect(isProjectFileReferenceAllowed(candidate), candidate).toBe(false);
    }
  });

  it("separates daemon liveness from work readiness", async () => {
    const app = createServer({
      dataDir,
      store,
      engines,
      authToken: "operator-secret",
      buildRevision: "test-revision-123",
      logger: false,
    });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      status: "ok",
      service: "ponderosa",
      version: "0.0.0",
      revision: "test-revision-123",
    });

    const ready = await app.inject({ method: "GET", url: "/api/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ready",
      canAcceptWork: true,
      checks: {
        daemon: { ok: true },
        dataDirectory: { ok: true },
        projections: { ok: true },
        runtimes: { ok: true },
      },
      runtimes: [{ id: "codex", authenticated: true }],
    });
    await app.close();

    const unavailable = createServer({
      dataDir,
      store: new AgentStore(dataDir),
      engines: [{ adapter, authStatus: async () => ({ authenticated: false, detail: "login required" }) }],
      logger: false,
    });
    const notReady = await unavailable.inject({ method: "GET", url: "/api/ready" });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toMatchObject({
      status: "not_ready",
      canAcceptWork: false,
      checks: { daemon: { ok: true }, dataDirectory: { ok: true }, projections: { ok: true }, runtimes: { ok: false } },
      runtimes: [{ id: "codex", authenticated: false, detail: "login required" }],
    });
    await unavailable.close();
  });

  it("keeps clean projects available when an older project has projection drift", async () => {
    const project = store.createProject({ label: "Drifted legacy test", hostPath: repoDir });
    vi.spyOn(store, "reconcileCommunicationEvents").mockReturnValue({
      projectId: project.id,
      canonicalEvents: 1,
      linkedProjections: 0,
      missingProjectionEventIds: ["legacy-event"],
      duplicateProjectionEventIds: [],
      orphanProjectionEventIds: [],
      missingClassificationEventIds: [],
      missingProjectionMetadataEventIds: [],
      ok: false,
    });
    const app = createServer({ dataDir, store, engines, logger: false });
    const ready = await app.inject({ method: "GET", url: "/api/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ready",
      canAcceptWork: true,
      checks: { communicationMigration: { ok: false, detail: expect.stringContaining("quarantined project") } },
    });
    await app.close();
  });

  it("validates preset options and snapshots server-resolved guidance into spawned agents", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Demo", hostPath: repoDir } })).json<{ id: string }>();
    const invalid = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent-presets`, payload: { name: "Security", description: "Review", guidance: "Review carefully", engine: "codex", model: "not-real" } });
    expect(invalid.statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent-presets`, payload: { name: "Security", description: "Review trust boundaries", guidance: "Review trust boundaries and capability checks.", engine: "codex", model: "mock-model", effort: "high" } });
    expect(created.statusCode).toBe(201);
    const preset = created.json<{ id: string }>();
    const spawned = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agents`, payload: { title: "Audit", engine: "spoofed", presetId: preset.id } });
    expect(spawned.statusCode).toBe(200);
    expect(spawned.json<{ activeEngine: string; presetSnapshot: { guidance: string } }>()).toMatchObject({ activeEngine: "codex", presetSnapshot: { guidance: "Review trust boundaries and capability checks." } });
    await app.close();
  });

  it("creates conversations, records control messages, and spawns linked agents", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Demo", hostPath: repoDir },
    });
    const project = projectRes.json<{ id: string }>();

    const masterRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      payload: {
        title: "Release control room",
        defaultEngine: "codex",
        defaultModel: "mock-model",
        defaultEffort: "high",
      },
    });
    expect(masterRes.statusCode).toBe(200);
    const conversation = masterRes.json<{ id: string; defaultEngine: string }>();
    expect(conversation.defaultEngine).toBe("codex");

    const messageRes = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/messages`,
      payload: { text: "#broadcast Start an API agent." },
    });
    expect(messageRes.statusCode).toBe(200);
    const recordedMessage = messageRes.json<{ communicationEventId: string }>();
    expect(recordedMessage.communicationEventId).toBeTruthy();
    expect(store.readCommunicationEvents(project.id)).toEqual([
      expect.objectContaining({
        eventId: recordedMessage.communicationEventId,
        intent: "broadcast",
        sender: { kind: "user", userId: "local-operator" },
        text: "Start an API agent.",
      }),
    ]);
    expect(store.listAgents(project.id)).toHaveLength(0);
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);

    const agentRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "API agent", engine: "codex", conversationId: conversation.id },
    });
    expect(agentRes.statusCode, agentRes.body).toBe(200);
    const agent = agentRes.json<{ id: string; conversationId: string }>();
    expect(agent.conversationId).toBe(conversation.id);

    const detailRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}`,
    });
    expect(detailRes.statusCode).toBe(200);
    expect(
      detailRes.json<{
        messages: { text: string }[];
        agents: { id: string; conversationId: string }[];
      }>(),
    ).toMatchObject({
      messages: [{ text: "#broadcast Start an API agent." }],
      agents: [{ id: agent.id, conversationId: conversation.id }],
    });

    await app.close();
  });

  it("lets the user create an idle subagent for an existing manager and cascade-delete its organization branch", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "User-managed organization", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Organization" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });

    const childResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "Specialist", engine: "codex", managerAgentId: manager.id },
    });
    expect(childResponse.statusCode, childResponse.body).toBe(200);
    const child = childResponse.json<AgentDto>();
    expect(child).toMatchObject({ managerAgentId: manager.id, conversationId: master.id });
    expect(adapter.seeds).toHaveLength(0);

    const grandchild = store.createAgent(project.id, {
      title: "Assistant", engine: "codex", conversationId: master.id, managerAgentId: child.id,
    });
    const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${manager.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, deletedAgentIds: [manager.id, child.id, grandchild.id] });
    expect(store.listAgents(project.id)).toEqual([]);
    await app.close();
  });

  it("routes a user-created managed agent opening message to the child as Collaboration", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "User-managed opening", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Organization" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });

    const childResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: {
        title: "Specialist",
        engine: "codex",
        managerAgentId: manager.id,
        initialMessage: "Investigate the usability risk and report to your manager.",
      },
    });
    expect(childResponse.statusCode, childResponse.body).toBe(200);
    const child = childResponse.json<AgentDto>();
    await waitForSeedCount(1);

    expect(store.readCommunicationEvents(project.id)).toContainEqual(expect.objectContaining({
      sender: { kind: "user", userId: "local-operator" },
      intent: "collaboration",
      audience: { kind: "agents", agentIds: [child.id] },
      text: "Investigate the usability risk and report to your manager.",
    }));
    expect(store.readCommunicationEvents(project.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ intent: "user_dm" })]),
    );
    expect(store.getConversationDetail(master.id)?.messages).toEqual([]);
    expect(store.getCollaborationViewDetail(master.id)?.messages).toContainEqual(expect.objectContaining({
      role: "user",
      text: "#Specialist Investigate the usability risk and report to your manager.",
    }));
    const prompt = adapter.seeds.find((turn) => turn.agentId === child.id)?.prompt ?? "";
    expect(prompt).toContain(`Your direct manager is the stable agent id ${manager.id}`);
    expect(prompt).toContain("That relationship defines accountability, escalation, creation, and lifecycle ownership; it does not restrict who you may contact.");
    expect(prompt).toContain("You may collaborate directly with any relevant agent in the project");
    expect(prompt).toContain("Latest message for you:\n#Specialist Investigate the usability risk and report to your manager.");
    expect(prompt).not.toContain("Required completion contract for this private user-to-agent request");
    await app.close();
  });

  it("shares Conversation context without copying broadcasts into unrelated agent histories", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Shared default", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Project chat" });
    const observer = store.createAgent(project.id, { title: "Observer", engine: "codex", conversationId: master.id });
    const responsible = store.createAgent(project.id, { title: "Responsible", engine: "codex", conversationId: master.id });

    const shared = await app.inject({
      method: "POST",
      url: `/api/agents/${responsible.id}/messages`,
      payload: {
        text: "Fix the onboarding flow",
        sourceChannel: "main",
        sourceConversationId: master.id,
        shareWithOrganization: true,
      },
    });
    expect(shared.statusCode, shared.body).toBe(200);
    await waitForRun(responsible.id);

    const { communicationEventId: eventId, runId } = shared.json<{ communicationEventId: string; runId: string }>();
    expect(store.getCommunicationEvent(project.id, eventId)).toMatchObject({
      intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "Fix the onboarding flow",
    });
    expect(store.readRunTriggers(project.id, responsible.id)).toEqual([
      expect.objectContaining({ communicationEventId: eventId, agentId: responsible.id, source: "project_request" }),
    ]);
    const responsibleDetail = await app.inject({ method: "GET", url: `/api/agents/${responsible.id}` });
    expect(responsibleDetail.json<{ runTriggers: Array<{ communicationEventId: string }> }>().runTriggers)
      .toEqual([expect.objectContaining({ communicationEventId: eventId })]);
    expect(responsibleDetail.json<{ runs: Array<{ id: string; communicationEventId?: string; status: string }> }>().runs)
      .toEqual([expect.objectContaining({ id: runId, communicationEventId: eventId, status: "completed" })]);
    expect((await app.inject({ method: "GET", url: `/api/agents/${responsible.id}/runs` }))
      .json<Array<{ id: string }>>()).toEqual([expect.objectContaining({ id: runId })]);
    store.appendEvent(responsible.id, { type: "work_item_update", workItemId: "follow-up", executionId: runId, title: "Verify onboarding", status: "done" });
    expect((await app.inject({ method: "GET", url: `/api/agents/${responsible.id}/work-items` }))
      .json<Array<{ executionId?: string; title: string }>>())
      .toEqual([expect.objectContaining({ executionId: runId, title: "Verify onboarding" })]);
    expect(store.getConversationMessages(master.id).filter((message) => message.communicationEventId === eventId)).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Fix the onboarding flow",
      }),
    ]);
    expect(store.getConversationMessages(master.id)
      .find((message) => message.authorAgentId === responsible.id && message.text === "done")).toBeUndefined();
    expect(store.getAgentDetail(responsible.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), kind: "response", text: "done", completed: true }),
    ]);
    expect(store.readCommunicationEvents(project.id).some((event) =>
      event.sender.kind === "agent" && event.text === "done")).toBe(false);
    expect(store.getMessages(observer.id)).toHaveLength(0);
    expect(store.getMessages(responsible.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "Fix the onboarding flow", communicationEventId: eventId }),
    ]));
    expect(adapter.seeds.filter((turn) => turn.agentId === observer.id)).toHaveLength(0);
    const responsiblePrompt = adapter.seeds.find((turn) => turn.agentId === responsible.id)?.prompt ?? "";
    expect(responsiblePrompt.match(/Fix the onboarding flow/g)).toHaveLength(1);

    const passive = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/messages`,
      payload: { text: "#broadcast Release window is Friday" },
    });
    expect(passive.statusCode).toBe(200);
    expect(store.getConversationMessages(master.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "#broadcast Release window is Friday" }),
    ]));
    expect(adapter.seeds.filter((turn) => turn.agentId === observer.id)).toHaveLength(0);
    expect(store.getMessages(observer.id)).toHaveLength(0);

    // A future agent receives room context only when it runs; its private
    // history starts empty and is never backfilled with organizational prose.
    const futureViaApi = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "Future via API", engine: "codex", conversationId: master.id },
    });
    expect(futureViaApi.statusCode).toBe(200);
    const futureId = futureViaApi.json<{ id: string }>().id;
    expect(store.getMessages(futureId)).toHaveLength(0);
    expect(adapter.seeds.filter((turn) => turn.agentId === futureId)).toHaveLength(0);
    await app.close();
  });

  it("isolates reused display names and deleted Conversation context", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Isolated rooms", hostPath: repoDir });
    const oldMaster = store.createConversation(project.id, { title: "Deleted room" });
    appendBroadcast(store, project.id, oldMaster.id, "OLD ROOM SECRET MARKER");
    const oldAgent = store.createAgent(project.id, {
      title: "Olympic", engine: "codex", conversationId: oldMaster.id,
    });
    store.appendEvent(oldAgent.id, { type: "session", sessionId: "old-provider-session" });

    const deleted = await app.inject({ method: "DELETE", url: `/api/conversations/${oldMaster.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    const freshMaster = store.createConversation(project.id, { title: "Fresh room" });
    const created = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`,
      payload: { title: "Olympic", engine: "codex", conversationId: freshMaster.id },
    });
    expect(created.statusCode).toBe(200);
    const freshAgent = created.json<{ id: string }>();
    expect(freshAgent.id).not.toBe(oldAgent.id);
    expect(store.resumeSessionId(freshAgent.id)).toBeUndefined();
    expect(store.getMessages(freshAgent.id)).toHaveLength(0);

    const turn = await app.inject({
      method: "POST", url: `/api/agents/${freshAgent.id}/messages`,
      payload: {
        text: "Start completely fresh", sourceChannel: "main",
        sourceConversationId: freshMaster.id, shareWithOrganization: true,
      },
    });
    expect(turn.statusCode, turn.body).toBe(200);
    await waitForRun(freshAgent.id);
    const prompt = adapter.seeds.find((seed) => seed.agentId === freshAgent.id)?.prompt ?? "";
    expect(prompt).toContain("Start completely fresh");
    expect(prompt).not.toContain("OLD ROOM SECRET MARKER");
    expect(adapter.continues.some((entry) => entry.agentId === freshAgent.id)).toBe(false);
    expect(store.readCommunicationProjections(project.id).some((projection) =>
      store.getCommunicationEvent(project.id, projection.eventId)?.conversationId === oldMaster.id)).toBe(false);
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);
    await app.close();
  });

  it("persists one tagged user message and fans it out to every explicit agent", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Group direct", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Friends" });
    const kings = store.createAgent(project.id, { title: "Kings Canyon", engine: "codex", conversationId: master.id });
    const cabrillo = store.createAgent(project.id, { title: "Cabrillo", engine: "codex", conversationId: master.id });
    const olympic = store.createAgent(project.id, { title: "Olympic", engine: "codex", conversationId: master.id });
    const text = "#Kings-Canyon #Cabrillo #Olympic guess what! I just got married!!!!";
    const payload = {
      text,
      recipients: [kings, cabrillo, olympic].map((agent) => ({ agentId: agent.id })),
      idempotencyKey: "wedding-news",
    };

    const sent = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/direct-messages`, payload,
    });
    expect(sent.statusCode, sent.body).toBe(200);
    await Promise.all([waitForRun(kings.id), waitForRun(cabrillo.id), waitForRun(olympic.id)]);

    const userMessages = store.getConversationMessages(master.id).filter((message) => message.role === "user");
    expect(userMessages).toEqual([expect.objectContaining({ text })]);
    for (const handle of ["#Kings-Canyon", "#Cabrillo", "#Olympic"]) {
      expect(userMessages[0]!.text.match(new RegExp(handle, "g"))).toHaveLength(1);
    }
    const communication = store.getCommunicationEvent(project.id, userMessages[0]!.communicationEventId!);
    expect(communication).toMatchObject({
      intent: "user_dm",
      audience: { kind: "user_agents", userId: "local-operator", agentIds: [kings.id, cabrillo.id, olympic.id].sort() },
      text,
    });
    for (const agent of [kings, cabrillo, olympic]) {
      expect(store.getMessages(agent.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", text, communicationEventId: communication?.eventId }),
      ]));
      const prompt = adapter.seeds.find((seed) => seed.agentId === agent.id)?.prompt ?? "";
      expect(prompt.match(/guess what! I just got married!!!!/g)).toHaveLength(1);
    }
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#user done")).toHaveLength(0);
    for (const agent of [kings, cabrillo, olympic]) {
      expect(store.getAgentDetail(agent.id)?.runOutput).toEqual([
        expect.objectContaining({ executionId: expect.any(String), text: "done", completed: true }),
      ]);
    }

    const replay = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/direct-messages`, payload,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, messageId: userMessages[0]!.id });
    expect(store.getConversationMessages(master.id).filter((message) => message.role === "user")).toHaveLength(1);
    expect(adapter.seeds).toHaveLength(3);
    await app.close();
  });

  it("projects a user reaction onto its message and privately notifies only the author with reply context", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "User emoji reaction", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const observer = store.createAgent(project.id, { title: "Observer", engine: "codex", conversationId: master.id });
    const text = "the user reacted with 🧑🏽‍🚀";
    const communicationEventId = randomUUID();
    store.appendCommunicationEvent({
      eventId: communicationEventId, schemaVersion: 2, projectId: project.id, conversationId: master.id,
      sender: { kind: "agent", agentId: author.id, executionId: "run-result" },
      intent: "broadcast", audience: { kind: "organization", organizationId: project.id },
      text: "Original agent result", createdAt: new Date().toISOString(),
    });
    const original = store.appendConversationMessage(
      master.id, { role: "assistant", text: "#broadcast Original agent result" }, author.id,
      "main", undefined, undefined, communicationEventId,
    )!;
    store.appendEvent(author.id, {
      type: "communication_projection", communicationEventId, text: "Original agent result", role: "assistant",
    });

    const sent = await app.inject({
      method: "POST",
      url: "/api/user-reactions",
      payload: {
        projectId: project.id,
        communicationEventId,
        emoji: "🧑🏽‍🚀",
        idempotencyKey: "reaction-to-author",
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const replay = await app.inject({
      method: "POST", url: "/api/user-reactions",
      payload: { projectId: project.id, communicationEventId, emoji: "🧑🏽‍🚀", idempotencyKey: "reaction-to-author" },
    });
    expect(replay.json()).toMatchObject({ replayed: true, targetAuthorAgentId: author.id });
    await waitForRun(author.id);

    expect(store.getConversationMessages(master.id)).toEqual([expect.objectContaining({ id: original.id })]);
    const detail = await app.inject({ method: "GET", url: `/api/conversations/${master.id}` });
    expect(detail.json<{ messages: Array<{ reactions?: unknown[] }> }>().messages[0]?.reactions).toEqual([
      { emoji: "🧑🏽‍🚀", count: 1, reactedByCurrentActor: true, reactors: [{ kind: "manager" }] },
    ]);
    const authorDetail = await app.inject({ method: "GET", url: `/api/agents/${author.id}` });
    expect(authorDetail.json<{ messages: Array<{ reactions?: unknown[] }> }>().messages[0]?.reactions).toEqual([
      { emoji: "🧑🏽‍🚀", count: 1, reactedByCurrentActor: true, reactors: [{ kind: "manager" }] },
    ]);
    expect(store.getMessages(author.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text, communicationEventId: undefined }),
    ]));
    expect(store.getMessages(observer.id).some((message) => message.text === text)).toBe(false);
    expect(adapter.seeds.filter((seed) => seed.agentId === author.id)).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain(text);
    expect(adapter.seeds[0]?.prompt).toContain("Replying specifically to this earlier message:\n> Original agent result");
    expect(adapter.seeds.filter((seed) => seed.agentId === observer.id)).toHaveLength(0);
    expect(store.readCommunicationEvents(project.id).filter((event) => event.text === text)).toHaveLength(0);
    await app.close();
  });

  it("lets a shared-task agent DM a question without publishing an accidental completion", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Question flow", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Planning" });
    const agent = store.createAgent(project.id, { title: "Planner", engine: "codex", conversationId: master.id });
    let dmStatus: number | undefined;
    adapter.responseText = "This ordinary response must be suppressed";
    adapter.beforeResponse = async (opts) => {
      const dm = await app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: {
          intent: "direct_to_user",
          text: "Which dates should I use?",
          idempotencyKey: "ask-dates",
        },
      });
      dmStatus = dm.statusCode;
    };

    const task = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: {
        text: "Plan my trip",
        sourceChannel: "main",
        sourceConversationId: master.id,
        shareWithOrganization: true,
      },
    });
    expect(task.statusCode, task.body).toBe(200);
    await waitForRun(agent.id);

    expect(dmStatus).toBe(200);
    const messages = store.getConversationMessages(master.id);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "Plan my trip" }),
      expect.objectContaining({ text: "#user Which dates should I use?", authorAgentId: agent.id }),
    ]));
    expect(messages.some((message) => message.text.includes("This ordinary response must be suppressed"))).toBe(false);
    await app.close();
  });

  it("deletes a conversation and preserves its agents as unassigned", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = (await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Delete demo", hostPath: repoDir },
    })).json<{ id: string }>();
    const conversation = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      payload: { title: "Temporary room" },
    })).json<{ id: string }>();
    const agent = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "Preserved agent", engine: "codex", conversationId: conversation.id },
    })).json<{ id: string }>();

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json()).toEqual({ deleted: true });
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/agents/${agent.id}` })).json<{ agent: { conversationId?: string } }>().agent.conversationId).toBeUndefined();
    expect((await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` })).statusCode).toBe(404);

    await app.close();
  });

  it("rejects linking an agent to another project's conversation", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const firstProjectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "One", hostPath: repoDir },
    });
    const secondProjectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Two", hostPath: repoDir },
    });
    const firstProject = firstProjectRes.json<{ id: string }>();
    const secondProject = secondProjectRes.json<{ id: string }>();
    const masterRes = await app.inject({
      method: "POST",
      url: `/api/projects/${firstProject.id}/conversations`,
      payload: { title: "Project one control room" },
    });
    const conversation = masterRes.json<{ id: string }>();

    const agentRes = await app.inject({
      method: "POST",
      url: `/api/projects/${secondProject.id}/agents`,
      payload: { title: "Wrong project", engine: "codex", conversationId: conversation.id },
    });

    expect(agentRes.statusCode).toBe(400);
    expect(agentRes.json()).toEqual({ error: "conversation does not belong to project" });
    await app.close();
  });

  it("authorizes membership changes and routes a secondary-chat turn", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Demo", hostPath: repoDir } })).json<{ id: string }>();
    const first = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/conversations`, payload: { title: "Home" } })).json<{ id: string }>();
    const second = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/conversations`, payload: { title: "Review" } })).json<{ id: string }>();
    const agent = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/agents`, payload: { title: "Agent", engine: "codex", conversationId: first.id } })).json<{ id: string }>();
    const membership = await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/conversation-memberships`, payload: { conversationIds: [first.id, second.id], primaryConversationId: first.id } });
    expect(membership.statusCode).toBe(200);
    expect(membership.json()).toMatchObject({ conversationIds: [first.id, second.id] });
    const turn = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Review this", sourceChannel: "main", sourceConversationId: second.id } });
    expect(turn.statusCode).toBe(200);
    await waitForRun(agent.id);
    expect(store.getConversationMessages(second.id).some((message) => message.authorAgentId === agent.id)).toBe(false);
    expect(store.getConversationMessages(first.id).some((message) => message.authorAgentId === agent.id)).toBe(false);
    expect(store.getAgentDetail(agent.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), text: "done", completed: true }),
    ]);
    await app.close();
  });

  it("seeds first message, then continues with the captured session id", async () => {
    const { app, agent } = await createProjectAndAgent();
    const first = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "first", model: "mock-model", effort: "high" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ mode: "seed" });
    await waitForRun(agent.id);
    const firstEventId = first.json<{ communicationEventId: string }>().communicationEventId;
    expect(firstEventId).toBeTruthy();
    expect(store.getMessages(agent.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "first", communicationEventId: firstEventId }),
    ]));
    expect(store.getMessages(agent.id).filter((message) => message.role === "assistant")).toEqual([]);
    expect(store.getAgentDetail(agent.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), text: "done", completed: true }),
    ]);
    expect(store.readCommunicationEvents(store.getAgent(agent.id)!.projectId).some((event) =>
      event.sender.kind === "agent" && event.text === "done")).toBe(false);
    expect(store.reconcileCommunicationEvents(store.getAgent(agent.id)!.projectId)).toMatchObject({ ok: true });

    const second = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "second" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ mode: "continue" });
    await waitForRun(agent.id, 2);

    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain(`your agent id: ${agent.id}`);
    expect(adapter.seeds[0]?.prompt).toContain("your display name: Agent");
    expect(adapter.seeds[0]?.history).toEqual([]);
    expect(adapter.continues).toHaveLength(1);
    expect(adapter.continues[0]?.resumeSessionId).toBe("sess-1");
    const artifacts = store.getArtifacts(agent.id);
    const artifactRes = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/artifacts/${artifacts.find((artifact) => artifact.kind === "diff")?.id}`,
    });
    expect(artifactRes.statusCode).toBe(200);
    expect(artifactRes.json<{ content: string; contentType: string }>()).toMatchObject({
      content: "diff --git a/a.ts b/a.ts\n",
      contentType: "diff",
    });
    await app.close();
  });

  it("rolls a failed Codex compaction resume into one fresh seeded session", async () => {
    const { app, agent } = await createProjectAndAgent();
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "first" },
    });
    await waitForRun(agent.id);

    adapter.mode = "resume_compaction_fail";
    const second = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "second" },
    });
    expect(second.json()).toMatchObject({ mode: "continue" });
    await waitForRun(agent.id, 2);

    expect(adapter.continues).toHaveLength(1);
    expect(adapter.seeds).toHaveLength(2);
    expect(adapter.seeds[1]?.history.map((message) => message.text)).toContain("first");
    expect(store.readEvents(agent.id).filter((item) => item.event.type === "session_reset"))
      .toHaveLength(1);
    expect(store.readEvents(agent.id).some((item) =>
      item.event.type === "error" && item.event.message.includes("pre-sampling compact"),
    )).toBe(false);
    expect(store.resumeSessionId(agent.id)).toBe("sess-1");
    await app.close();
  });

  it("does not replay a failed resume after material side effects", async () => {
    const { app, agent } = await createProjectAndAgent();
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "first" } });
    await waitForRun(agent.id);

    adapter.mode = "material_compaction_fail";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "second" } });
    await vi.waitFor(() => {
      expect(store.readEvents(agent.id).some((item) => item.event.type === "error" && item.event.message.includes("pre-sampling compact"))).toBe(true);
    });

    expect(adapter.continues).toHaveLength(1);
    expect(adapter.seeds).toHaveLength(1);
    expect(store.readEvents(agent.id).some((item) => item.event.type === "command" && item.event.command === "touch already-ran")).toBe(true);
    expect(store.readEvents(agent.id).some((item) => item.event.type === "error" && item.event.message.includes("pre-sampling compact"))).toBe(true);
    await app.close();
  });

  it("lets an active agent schedule a safe session rollover at turn completion", async () => {
    const { app, agent } = await createProjectAndAgent();
    adapter.mode = "boundary";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "work then refresh" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const url = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_ROLLOVER_URL;
    expect(token).toBeTruthy();
    expect(url).toBe("http://127.0.0.1:8787/api/agent-session/rollover");

    const scheduled = await app.inject({ method: "POST", url: "/api/agent-session/rollover", headers: { authorization: `Bearer ${token}` } });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json()).toMatchObject({ scheduled: true });
    await waitForRun(agent.id);

    expect(store.resumeSessionId(agent.id)).toBeUndefined();
    expect(store.readEvents(agent.id).some((item) => item.event.type === "session_reset" && item.event.reason === "explicit_compaction")).toBe(true);
    await app.close();
  });

  it("explicitly compacts only an idle persisted runtime session", async () => {
    const { app, agent } = await createProjectAndAgent();
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "active" } });
    await waitForSeedCount(1);

    const active = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/compact` });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toMatchObject({ retryable: true });
    await cancelAndWait(app, agent.id);

    const compacted = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/compact` });
    expect(compacted.statusCode).toBe(200);
    expect(compacted.json()).toEqual({ compacted: true });
    expect(store.resumeSessionId(agent.id)).toBeUndefined();
    expect(store.readEvents(agent.id).filter((item) => item.event.type === "session_reset"))
      .toEqual([expect.objectContaining({ event: expect.objectContaining({ reason: "explicit_compaction" }) })]);

    const replay = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/compact` });
    expect(replay.json()).toEqual({ compacted: false });
    expect(store.readEvents(agent.id).filter((item) => item.event.type === "session_reset"))
      .toHaveLength(1);
    await app.close();
  });

  it("seeds bounded room context once and sends only the new message on continuation", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Release room" });
    appendBroadcast(store, project.id, master.id, "Ship the API change.");
    const agent = store.createAgent(project.id, {
      title: "Aspen",
      engine: "codex",
      conversationId: master.id,
    });

    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Ship the API change.", sourceChannel: "main" },
    });
    await waitForRun(agent.id);

    expect(adapter.seeds[0]?.prompt).toContain("The latest request is a Direct Message");
    expect(adapter.seeds[0]?.prompt).toContain("Never Broadcast acknowledgments, questions, thanks, routine progress");
    expect(adapter.seeds[0]?.prompt).toContain("never use a canned acknowledgment");
    expect(adapter.seeds[0]?.prompt).toContain("Manager: Ship the API change.");
    expect(adapter.seeds[0]?.prompt).toContain("Latest message for you:\nShip the API change.");
    expect(adapter.seeds[0]?.prompt).toContain("- channel: main");
    expect(adapter.seeds[0]?.prompt).toContain("- author: Manager");
    expect(adapter.seeds[0]?.prompt).toContain("- you were tagged: no");
    expect(adapter.seeds[0]?.prompt).toContain(
      "never write routing tags into message text",
    );

    appendBroadcast(store, project.id, master.id, "#Aspen Is it tested?");
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "#Aspen Is it tested?", sourceChannel: "main" },
    });
    await waitForRun(agent.id, 2);

    expect(adapter.continues[0]?.prompt).not.toContain("Aspen: done");
    expect(adapter.continues[0]?.prompt).toContain("Manager: #Aspen Is it tested?");
    expect(adapter.continues[0]?.prompt).not.toContain("Communication scope is immutable");
    expect(adapter.continues[0]?.prompt).not.toContain("PONDEROSA_DELEGATION_URL");
    expect(adapter.continues[0]?.prompt).toContain("Context injection accounting: room_messages=1; room_characters=20");
    expect(adapter.continues[0]?.prompt).toContain("Latest message for you:\n#Aspen Is it tested?");
    expect(adapter.continues[0]?.prompt).toContain("- tagged agents: #Aspen");
    expect(adapter.continues[0]?.prompt).toContain("- you were tagged: yes");
    expect(store.getConversationMessages(master.id)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authorAgentId: agent.id, text: "Got it — I’m on it." }),
      ]),
    );
    await app.close();
  });

  it("treats tags on organizational messages as display-only context", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Scoped room" });
    const aspen = store.createAgent(project.id, { title: "Aspen", engine: "codex", conversationId: master.id });
    const birch = store.createAgent(project.id, { title: "Birch", engine: "codex", conversationId: master.id });
    appendBroadcast(store, project.id, master.id, "Shared release context.");
    appendBroadcast(store, project.id, master.id, "#Aspen private assignment marker");

    await app.inject({
      method: "POST",
      url: `/api/agents/${birch.id}/messages`,
      payload: { text: "Birch task", sourceChannel: "main" },
    });
    await waitForRun(birch.id);

    expect(adapter.seeds[0]?.prompt).toContain("Shared release context.");
    expect(adapter.seeds[0]?.prompt).toContain("#Aspen private assignment marker");
    expect(adapter.seeds[0]?.prompt).toContain("Context injection accounting: room_messages=2; room_characters=55");

    await app.inject({
      method: "POST",
      url: `/api/agents/${aspen.id}/messages`,
      payload: { text: "Aspen task", sourceChannel: "main" },
    });
    await waitForRun(aspen.id);

    expect(adapter.seeds[1]?.prompt).toContain("Shared release context.");
    expect(adapter.seeds[1]?.prompt).toContain("#Aspen private assignment marker");
    await app.close();
  });

  it("delivers only accepted-session room deltas and does not replay unchanged history", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Incremental room" });
    appendBroadcast(store, project.id, master.id, "seed-only marker");
    const agent = store.createAgent(project.id, { title: "Delta", engine: "codex", conversationId: master.id });

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "seed", sourceChannel: "main" } });
    await waitForRun(agent.id);
    expect(adapter.seeds[0]?.prompt).toContain("seed-only marker");
    expect(adapter.seeds[0]?.prompt).toContain("Context injection accounting: room_messages=1; room_characters=16");

    appendBroadcast(store, project.id, master.id, "delta marker");
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "delta", sourceChannel: "main" } });
    await waitForRun(agent.id, 2);
    expect(adapter.continues[0]?.prompt).toContain("delta marker");
    expect(adapter.continues[0]?.prompt).not.toContain("seed-only marker");

    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "unchanged", sourceChannel: "main" } });
    await waitForRun(agent.id, 3);
    expect(adapter.continues[1]?.prompt).toContain("room_messages=0; room_characters=0");
    expect(adapter.continues[1]?.prompt).not.toContain("delta marker");
    expect(adapter.continues[1]?.prompt).not.toContain("seed-only marker");
    await app.close();
  });

  it("does not advance context after a failed turn and reseeds a changed session epoch", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Retry room" });
    appendBroadcast(store, project.id, master.id, "original context");
    const agent = store.createAgent(project.id, { title: "Retry", engine: "codex", conversationId: master.id });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "seed", sourceChannel: "main" } });
    await waitForRun(agent.id);

    appendBroadcast(store, project.id, master.id, "must redeliver");
    adapter.failNextTurn = true;
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "fails", sourceChannel: "main" } });
    await waitForRun(agent.id, 2);
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "retry", sourceChannel: "main" } });
    await waitForRun(agent.id, 3);
    expect(adapter.continues[0]?.prompt).toContain("must redeliver");
    expect(adapter.continues[1]?.prompt).toContain("must redeliver");

    store.appendEvent(agent.id, { type: "session", sessionId: "sess-2" });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "new epoch", sourceChannel: "main" } });
    await waitForRun(agent.id, 4);
    expect(adapter.continues[2]?.resumeSessionId).toBe("sess-2");
    expect(adapter.continues[2]?.prompt).toContain("original context");
    expect(adapter.continues[2]?.prompt).toContain("Your ordinary runtime response is execution-scoped output saved in your Work log tab");
    await app.close();
  });

  it("keeps incremental cursors isolated by visible master room", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const first = store.createConversation(project.id, { title: "First" });
    const second = store.createConversation(project.id, { title: "Second" });
    appendBroadcast(store, project.id, first.id, "first-room secret");
    appendBroadcast(store, project.id, second.id, "second-room secret");
    const agent = store.createAgent(project.id, { title: "Rooms", engine: "codex", conversationId: first.id });
    store.updateAgentConversationMemberships(agent.id, { conversationIds: [first.id, second.id], primaryConversationId: first.id });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "first", sourceChannel: "main", sourceConversationId: first.id } });
    await waitForRun(agent.id);
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "second", sourceChannel: "main", sourceConversationId: second.id } });
    await waitForRun(agent.id, 2);
    expect(adapter.continues[0]?.prompt).toContain("second-room secret");
    expect(adapter.continues[0]?.prompt).not.toContain("first-room secret");
    expect(adapter.continues[0]?.prompt).toContain("Your ordinary runtime response is execution-scoped output saved in your Work log tab");
    await app.close();
  });

  it("preserves accepted context cursors across a server restart", async () => {
    const firstApp = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Restart room" });
    appendBroadcast(store, project.id, master.id, "before-restart marker");
    const agent = store.createAgent(project.id, { title: "Restart", engine: "codex", conversationId: master.id });
    await firstApp.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "seed", sourceChannel: "main" } });
    await waitForRun(agent.id);
    await firstApp.close();

    store = new AgentStore(dataDir);
    appendBroadcast(store, project.id, master.id, "after-restart marker");
    const secondApp = createServer({ dataDir, store, engines, logger: false });
    await secondApp.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "resume", sourceChannel: "main" } });
    await waitForRun(agent.id, 2);
    expect(adapter.continues[0]?.prompt).toContain("after-restart marker");
    expect(adapter.continues[0]?.prompt).not.toContain("before-restart marker");
    await secondApp.close();
  });

  it("starts a new conversation agent with its initial message in the creation request", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Release room" });

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: {
        title: "Acadia",
        engine: "codex",
        conversationId: master.id,
        initialMessage: "Check the first-run path.",
      },
    });

    expect(response.statusCode).toBe(200);
    const agent = response.json<{ id: string }>();
    await waitForRun(agent.id);
    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain("Latest message for you:\nCheck the first-run path.");
    const shared = store.getConversationMessages(master.id).find((message) => message.text === "#Acadia Check the first-run path.");
    const audit = store.getMessages(agent.id).find((message) => message.text === "Check the first-run path.");
    expect(shared).toMatchObject({ role: "user", communicationEventId: expect.any(String) });
    expect(audit?.communicationEventId).toBe(shared?.communicationEventId);
    const eventId = shared!.communicationEventId!;
    expect(store.readCommunicationEvents(project.id).filter((event) => event.eventId === eventId)).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        sender: { kind: "user", userId: "local-operator" },
        intent: "user_dm",
        audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
      }),
    ]);
    expect(store.readCommunicationProjections(project.id).filter((projection) => projection.eventId === eventId)
      .map((projection) => [projection.surface, projection.projectionKey])).toEqual(expect.arrayContaining([
        ["conversation", master.id],
        ["direct_agent_audit", agent.id],
        ["user_inbox", "local-operator"],
      ]));
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);
    await app.close();
  });

  it("dispatches a valid collaboration-chat mention without exposing it in the main chat", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Collaboration room" });
    const yosemite = store.createAgent(project.id, {
      title: "Yosemite",
      engine: "codex",
      conversationId: master.id,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "can you review this?", recipientAgentIds: [yosemite.id] },
    });

    expect(response.statusCode).toBe(200);
    await waitForRun(yosemite.id);
    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain("You received this context because you were an explicit collaboration recipient.");
    expect(adapter.seeds[0]?.prompt).toContain("This is the only chat for agent-to-agent coordination.");
    expect(adapter.seeds[0]?.prompt).toContain("Do not move agent-to-agent coordination into the shared user Conversation");
    expect(adapter.seeds[0]?.prompt).toContain("Latest message for you:\n#Yosemite can you review this?");
    expect(store.getMessages(yosemite.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", text: "#Yosemite can you review this?" })]),
    );
    expect(store.getConversationMessages(master.id)).toEqual([]);
    expect(store.getAgentDetail(yosemite.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), text: "done", completed: true }),
    ]);
    expect(store.getConversationMessages(master.id, "collaboration")).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "#Yosemite can you review this?" })]),
    );
    await app.close();
  });

  it("acknowledges a collaboration delivery only after a successful recipient turn", async () => {
    adapter.failuresRemaining = 1;
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Retry recipient failure" });
    const recipient = store.createAgent(project.id, { title: "Yosemite", engine: "codex", conversationId: master.id });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "retry this failed turn", recipientAgentIds: [recipient.id] },
    });
    const messageId = response.json<{ message: { id: string } }>().message.id;
    await waitForRun(recipient.id);

    const delivery = new CollaborationDeliveryStore(dataDir).getForMessageTarget(messageId, recipient.id);
    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.continues).toHaveLength(1);
    expect(delivery).toMatchObject({ status: "acknowledged", attempts: 2 });
    await app.close();
  });

  it("fails a collaboration delivery after its bounded recipient-turn retry", async () => {
    adapter.failuresRemaining = 2;
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Bounded recipient failure" });
    const recipient = store.createAgent(project.id, { title: "Yosemite", engine: "codex", conversationId: master.id });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "fail this turn twice", recipientAgentIds: [recipient.id] },
    });
    const messageId = response.json<{ message: { id: string } }>().message.id;
    for (let i = 0; i < 80 && adapter.continues.length < 1; i += 1) await sleep(10);
    for (let i = 0; i < 80; i += 1) {
      const state = new CollaborationDeliveryStore(dataDir).getForMessageTarget(messageId, recipient.id);
      if (state?.status === "failed") break;
      await sleep(10);
    }

    const delivery = new CollaborationDeliveryStore(dataDir).getForMessageTarget(messageId, recipient.id);
    expect(delivery).toMatchObject({
      status: "failed",
      attempts: 2,
      failure: "simulated runtime failure",
    });
    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.continues).toHaveLength(1);
    await app.close();
  });

  it("dispatches a canonical mention for an agent whose display name contains punctuation", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Collaboration room" });
    const wrangell = store.createAgent(project.id, {
      title: "Wrangell-St. Elias",
      engine: "codex",
      conversationId: master.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "can you review this?", recipientAgentIds: [wrangell.id] },
    });

    expect(response.statusCode).toBe(200);
    await waitForRun(wrangell.id);
    expect(adapter.seeds[0]?.prompt).toContain("You received this context because you were an explicit collaboration recipient.");
    expect(store.getMessages(wrangell.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", text: "#Wrangell-St-Elias can you review this?" })]),
    );
    await app.close();
  });

  it("delivers an explicit collaboration once to every selected active member", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Broadcast room" });
    const first = store.createAgent(project.id, { title: "First", engine: "codex", conversationId: master.id });
    const second = store.createAgent(project.id, { title: "Second", engine: "codex", conversationId: master.id });
    const archived = store.createAgent(project.id, { title: "Archived", engine: "codex", conversationId: master.id });
    store.updateAgent(archived.id, { archived: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "please report status.", recipientAgentIds: [first.id, second.id] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ notifiedAgentIds: string[] }>().notifiedAgentIds).toEqual([first.id, second.id]);
    await waitForSeedCount(2);
    expect(adapter.seeds).toHaveLength(2);
    expect(store.getMessages(first.id).filter((message) => message.text.includes("please report status"))).toHaveLength(1);
    expect(store.getMessages(second.id).filter((message) => message.text.includes("please report status"))).toHaveLength(1);
    expect(store.getMessages(archived.id)).toHaveLength(0);
    const intents = store.getConversationDeliveryIntents(master.id);
    expect(intents.map(({ intent }) => ({ id: intent.targetAgentId, audience: intent.audience }))).toEqual([
      { id: first.id, audience: "mention" },
      { id: second.id, audience: "mention" },
    ]);
    await Promise.all([cancelAndWait(app, first.id), cancelAndWait(app, second.id)]);
    await app.close();
  });

  it("rejects recipient-free collaboration and sends context only after explicit routing", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Private collaboration" });
    const agent = store.createAgent(project.id, {
      title: "Yosemite",
      engine: "codex",
      conversationId: master.id,
    });
    appendBroadcast(store, project.id, master.id, "Main-chat-only deployment plan.");

    const untargeted = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "Private review notes that should not reach an agent yet." },
    });
    expect(untargeted.statusCode).toBe(400);
    expect(untargeted.json()).toMatchObject({ error: expect.stringContaining("explicit recipient") });
    expect(adapter.seeds).toHaveLength(0);

    const targeted = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "Please review the private notes.", recipientAgentIds: [agent.id] },
    });
    expect(targeted.statusCode).toBe(200);
    await waitForRun(agent.id);

    const prompt = adapter.seeds[0]?.prompt ?? "";
    expect(prompt).not.toContain("Private review notes that should not reach an agent yet.");
    expect(prompt).toContain("#Yosemite Please review the private notes.");
    expect(prompt).toContain("Shared Broadcast context from Project chat");
    expect(prompt).toContain("Main-chat-only deployment plan.");
    expect(store.getConversationMessages(master.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Main-chat-only deployment plan." })]),
    );
    expect(store.getConversationMessages(master.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Private review notes that should not reach an agent yet." })]),
    );
    await app.close();
  });

  it("isolates three-agent collaboration context by canonical recipient audience", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Audience isolation", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Three-agent room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reviewer = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });
    const verifier = store.createAgent(project.id, { title: "Verifier", engine: "codex", conversationId: master.id });

    // Organization-audience system guidance is explicitly shared with every
    // project agent through the Main projection.
    const sharedAt = "2026-07-12T00:00:00.000Z";
    store.appendCommunicationEvent({
      eventId: "shared-collaboration-guidance", schemaVersion: 1, projectId: project.id, conversationId: master.id,
      sender: { kind: "system", component: "collaboration-policy" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "Shared system guidance for all project agents.", createdAt: sharedAt,
    });
    store.appendCommunicationProjection(project.id, {
      eventId: "shared-collaboration-guidance", surface: "conversation", projectionKey: master.id,
      projectedAt: sharedAt,
      message: { messageId: "shared-guidance-message", role: "system", createdAt: sharedAt },
    });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Coordinate reviews." } });
    await waitForSeedCount(1);
    const authorToken = adapter.seeds.find((turn) => turn.agentId === author.id)?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect(authorToken).toBeTruthy();

    const toReviewer = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${authorToken}` },
      payload: {
        intent: "collaboration", recipientAgentIds: [reviewer.id],
        text: "Reviewer-only launch credential: ALPHA.", idempotencyKey: "author-to-reviewer",
      },
    });
    expect(toReviewer.statusCode).toBe(200);
    await waitForSeedCount(2);

    const crossAudienceReply = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: {
        text: "Do not disclose the quoted credential.", recipientAgentIds: [verifier.id],
        replyToMessageId: toReviewer.json<{ messageId: string }>().messageId,
      },
    });
    expect(crossAudienceReply.statusCode).toBe(400);
    expect(crossAudienceReply.json()).toMatchObject({
      error: "reply target is not visible to every collaboration recipient",
    });

    const toVerifier = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${authorToken}` },
      payload: {
        intent: "collaboration", recipientAgentIds: [verifier.id],
        text: "Verifier-only release checklist.", idempotencyKey: "author-to-verifier",
      },
    });
    expect(toVerifier.statusCode).toBe(200);
    await waitForSeedCount(3);

    const reviewerPrompt = adapter.seeds.find((turn) => turn.agentId === reviewer.id)?.prompt ?? "";
    const verifierPrompt = adapter.seeds.find((turn) => turn.agentId === verifier.id)?.prompt ?? "";
    expect(reviewerPrompt).toContain("Reviewer-only launch credential: ALPHA.");
    expect(verifierPrompt).toContain("Verifier-only release checklist.");
    expect(verifierPrompt).not.toContain("Reviewer-only launch credential: ALPHA.");

    await Promise.all([
      cancelAndWait(app, author.id),
      cancelAndWait(app, reviewer.id),
      cancelAndWait(app, verifier.id),
    ]);
    await app.close();
  });

  it("inherits broadcasts but not direct messages or collaboration in a newly spawned agent", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Immutable scope", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Scope room" });
    const participant = store.createAgent(project.id, { title: "Participant", engine: "codex", conversationId: master.id });
    const collaborator = store.createAgent(project.id, { title: "Collaborator", engine: "codex", conversationId: master.id });

    appendBroadcast(store, project.id, master.id, "shared project finding");
    adapter.mode = "hang";
    const direct = await app.inject({
      method: "POST", url: `/api/agents/${participant.id}/messages`,
      payload: { text: "private manager note", sourceChannel: "main" },
    });
    expect(direct.statusCode).toBe(200);
    await waitForSeedCount(1);
    const token = adapter.seeds.find((turn) => turn.agentId === participant.id)?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const collaboration = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${token}` },
      payload: {
        intent: "collaboration", recipientAgentIds: [collaborator.id],
        text: "participant-only review", idempotencyKey: "local-review",
      },
    });
    expect(collaboration.statusCode).toBe(200);
    await waitForSeedCount(2);
    const directEvent = store.getCommunicationEvent(project.id, direct.json<{ communicationEventId: string }>().communicationEventId);
    const collaborationEvent = store.getCommunicationEvent(project.id, collaboration.json<{ eventId: string }>().eventId);
    expect(directEvent).toMatchObject({ schemaVersion: 2, intent: "user_dm" });
    expect(collaborationEvent).toMatchObject({ schemaVersion: 2, intent: "collaboration" });

    expect(store.getConversationMessages(master.id).filter((message) => message.communicationEventId === directEvent?.eventId)).toEqual([
      expect.objectContaining({ text: "#Participant private manager note" }),
    ]);
    await cancelAndWait(app, participant.id);
    await cancelAndWait(app, collaborator.id);
    adapter.mode = "normal";
    const future = store.createAgent(project.id, { title: "Future", engine: "codex", conversationId: master.id });
    await app.inject({
      method: "POST", url: `/api/agents/${future.id}/messages`,
      payload: { text: "Start", sourceChannel: "main" },
    });
    await waitForRun(future.id);
    const prompt = adapter.seeds.find((turn) => turn.agentId === future.id)?.prompt ?? "";
    expect(prompt).toContain("shared project finding");
    expect(prompt).not.toContain("Manager: #Participant private manager note");
    expect(prompt).not.toContain("participant-only review");
    await app.close();
  });

  it("keeps an ordinary conversational response in Work log instead of inferring a DM", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Conversational reply", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Team room" });
    appendBroadcast(store, project.id, master.id, "#Greeter sounds good thanks!");
    const greeter = store.createAgent(project.id, { title: "Greeter", engine: "codex", conversationId: master.id });
    adapter.responseText = "You're welcome!";

    await app.inject({
      method: "POST", url: `/api/agents/${greeter.id}/messages`,
      payload: { text: "#Greeter sounds good thanks!", sourceChannel: "main" },
    });
    await waitForRun(greeter.id);

    expect(store.getConversationMessages(master.id).some((message) => message.text.includes("You're welcome!"))).toBe(false);
    expect(store.getMessages(greeter.id).some((message) => message.text.includes("You're welcome!"))).toBe(false);
    expect(store.getAgentDetail(greeter.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), text: "You're welcome!", completed: true }),
    ]);
    expect(store.readCommunicationEvents(project.id).some((event) =>
      event.sender.kind === "agent" && event.text === "You're welcome!")).toBe(false);

    const observer = store.createAgent(project.id, { title: "Observer", engine: "codex", conversationId: master.id });
    await app.inject({
      method: "POST", url: `/api/agents/${observer.id}/messages`,
      payload: { text: "What shared context is available?", sourceChannel: "main" },
    });
    await waitForRun(observer.id);
    expect(adapter.seeds[1]?.prompt).not.toContain("#user You're welcome!");
    await app.close();
  });

  it("continues casual conversation through explicit broadcasts without inheriting ordinary output", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Casual conversation", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Trip planning" });
    const first = store.createAgent(project.id, { title: "First", engine: "codex", conversationId: master.id });
    adapter.responseText = "Here are three trip options";
    adapter.beforeResponse = async (opts) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { intent: "broadcast", text: "Here are three trip options" },
      });
      expect(response.statusCode, response.body).toBe(200);
    };

    const opening = await app.inject({
      method: "POST", url: `/api/agents/${first.id}/messages`,
      payload: {
        text: "Help me plan a trip",
        sourceChannel: "main",
        sourceConversationId: master.id,
        shareWithOrganization: true,
      },
    });
    expect(opening.statusCode, opening.body).toBe(200);
    await waitForRun(first.id);

    const openingPrompt = adapter.seeds.find((turn) => turn.agentId === first.id)?.prompt ?? "";
    expect(openingPrompt).toContain("Send its actual completed answer with intent broadcast, never direct_to_user");
    expect(openingPrompt).toContain("Required completion contract for this Project-chat request:");
    expect(openingPrompt).toContain("The user cannot see your ordinary runtime response");
    expect(openingPrompt).toContain("Ponderosa send-message tool");
    expect(openingPrompt).toContain('"intent":"broadcast"');
    expect(store.getConversationMessages(master.id)).toContainEqual(
      expect.objectContaining({ role: "assistant", text: "Here are three trip options", authorAgentId: first.id }),
    );
    expect(store.getConversationMessages(master.id).some((message) => message.text === "#broadcast Here are three trip options")).toBe(false);

    const privateAgent = store.createAgent(project.id, { title: "Private", engine: "codex", conversationId: master.id });
    adapter.responseText = "Private implementation detail";
    const privateTurn = await app.inject({
      method: "POST", url: `/api/agents/${privateAgent.id}/messages`,
      payload: { text: "Inspect a private issue", sourceChannel: "main", sourceConversationId: master.id },
    });
    expect(privateTurn.statusCode, privateTurn.body).toBe(200);
    await waitForRun(privateAgent.id);
    const privatePrompt = adapter.seeds.find((turn) => turn.agentId === privateAgent.id)?.prompt ?? "";
    expect(privatePrompt).toContain("Required completion contract for this private user-to-agent request:");
    expect(privatePrompt).toContain('"intent":"direct_to_user"');
    expect(privatePrompt).not.toContain("Required completion contract for this Project-chat request:");

    const next = store.createAgent(project.id, { title: "Next", engine: "codex", conversationId: master.id });
    adapter.responseText = "Let's continue";
    const followUp = await app.inject({
      method: "POST", url: `/api/agents/${next.id}/messages`,
      payload: {
        text: "I can leave Friday",
        sourceChannel: "main",
        sourceConversationId: master.id,
        shareWithOrganization: true,
      },
    });
    expect(followUp.statusCode, followUp.body).toBe(200);
    await waitForRun(next.id);

    const prompt = adapter.seeds.find((turn) => turn.agentId === next.id)?.prompt ?? "";
    expect(prompt).toContain("Manager: Help me plan a trip");
    expect(prompt).toContain("First: Here are three trip options");
    expect(prompt).not.toContain("Inspect a private issue");
    expect(prompt).not.toContain("Private implementation detail");
    expect(prompt.match(/I can leave Friday/g)).toHaveLength(1);
    expect(store.getAgentDetail(privateAgent.id)?.runOutput).toEqual([
      expect.objectContaining({ text: "Private implementation detail", completed: true }),
    ]);
    await app.close();
  });

  it("routes a persistent engine's managed send-message tool through the canonical communication endpoint", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Managed messaging", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, { title: "Sender", engine: "codex", conversationId: conversation.id });

    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: {
        text: "Answer the shared request",
        sourceChannel: "main",
        sourceConversationId: conversation.id,
        shareWithOrganization: true,
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const opened = persistent.openedOptions[0]!;
    expect(opened.dynamicTools).toContainEqual(expect.objectContaining({ name: "ponderosa_send_message" }));
    expect(opened.dynamicTools).toContainEqual(expect.objectContaining({ name: "ponderosa_spawn_agent" }));

    const result = await opened.handleDynamicToolCall!({
      name: "ponderosa_send_message",
      arguments: { intent: "broadcast", text: "#broadcast The managed answer" },
    });
    expect(result.success, result.text).toBe(true);
    expect(store.getConversationMessages(conversation.id)).toContainEqual(expect.objectContaining({
      role: "assistant",
      text: "The managed answer",
      authorAgentId: agent.id,
    }));
    expect(store.readCommunicationEvents(project.id)).toContainEqual(expect.objectContaining({
      intent: "broadcast",
      text: "The managed answer",
      sender: expect.objectContaining({ kind: "agent", agentId: agent.id }),
    }));

    const spawned = await opened.handleDynamicToolCall!({
      name: "ponderosa_spawn_agent",
      arguments: {
        displayName: "Research",
        initialMessage: "Investigate and report back privately.",
        idempotencyKey: "managed-research",
      },
    });
    expect(spawned.success, spawned.text).toBe(true);
    expect(JSON.parse(spawned.text)).toMatchObject({
      accepted: true,
      replayed: false,
      agent: {
        title: "Research",
        managerAgentId: agent.id,
        spawnedByAgentId: agent.id,
      },
    });
    await app.close();
  });

  it("serves every room timeline from canonical projections", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Cutover", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Canonical room" });
    const agent = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });

    const main = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/messages`, payload: { text: "Shared decision" },
    });
    const collaboration = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "Review this", recipientAgentIds: [agent.id] },
    });
    expect(main.statusCode).toBe(200);
    expect(collaboration.statusCode, collaboration.body).toBe(200);
    await waitForRun(agent.id);

    const mainDetail = (await app.inject({ method: "GET", url: `/api/conversations/${master.id}` })).json<{
      messages: ConversationMessageDto[];
    }>();
    const collaborationDetail = (await app.inject({ method: "GET", url: `/api/conversations/${master.id}/collaboration` })).json<{
      messages: ConversationMessageDto[];
    }>();
    expect(mainDetail.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId: main.json().communicationEventId, text: "#broadcast Shared decision" }),
    ]));
    expect(collaborationDetail.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId: collaboration.json<{ message: { communicationEventId: string } }>().message.communicationEventId, text: "#Reviewer Review this" }),
    ]));
    const readiness = (await app.inject({ method: "GET", url: "/api/ready" })).json();
    expect(readiness, JSON.stringify({ readiness, reconciliation: store.reconcileCommunicationEvents(project.id) }))
      .toMatchObject({ status: "ready", checks: { communicationMigration: { ok: true } } });
    await app.close();
  });

  it("routes authenticated agent communication intents and renders collaboration recipients", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Routing room" });
    const author = store.createAgent(project.id, {
      title: "Author Agent",
      engine: "codex",
      conversationId: master.id,
    });
    const reviewer = store.createAgent(project.id, {
      title: "Review Agent",
      engine: "codex",
      conversationId: master.id,
    });
    const verifier = store.createAgent(project.id, {
      title: "Verify Agent",
      engine: "codex",
      conversationId: master.id,
    });

    adapter.mode = "hang";
    await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/messages`,
      payload: { text: "#Review-Agent is tagged, but this is in my individual chat." },
    });
    await waitForSeedCount(1);
    expect(adapter.seeds[0]?.prompt).toContain("- channel: individual");
    expect(adapter.seeds[0]?.prompt).toContain("- tagged agents: #Review-Agent");
    expect(adapter.seeds[0]?.prompt).toContain("- you were tagged: no");
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect(token).toBeTruthy();
    const send = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });

    const direct = await send({ intent: "direct_to_user", text: "Private implementation note.", idempotencyKey: "private-note" });
    const directRetry = await send({ intent: "direct_to_user", text: "Private implementation note.", idempotencyKey: "private-note" });
    const broadcast = await send({ intent: "broadcast", text: "Manager-facing checkpoint." });
    const collaboration = await send({
      intent: "collaboration", recipientAgentIds: [reviewer.id, verifier.id, reviewer.id],
      text: "Please review the API contract.",
    });
    expect(direct.statusCode).toBe(200);
    expect(directRetry.json()).toMatchObject({ intent: "direct_to_user", replayed: true });
    expect(broadcast.statusCode).toBe(200);
    expect(collaboration.statusCode).toBe(200);
    await waitForSeedCount(3);

    expect(store.getMessages(author.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "Private implementation note." })]),
    );
    expect(store.getConversationMessages(master.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authorAgentId: author.id, text: "#user Private implementation note." }),
        expect.objectContaining({ authorAgentId: author.id, text: "Manager-facing checkpoint." }),
      ]),
    );
    expect(store.getConversationMessages(master.id, "collaboration")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorAgentId: author.id,
          text: "#Review-Agent #Verify-Agent Please review the API contract.",
        }),
      ]),
    );
    const reviewerPrompt = adapter.seeds.find((turn) => turn.agentId === reviewer.id)?.prompt ?? "";
    expect(reviewerPrompt).toContain("- channel: collaboration");
    expect(reviewerPrompt).toContain("- author: Author Agent");
    expect(reviewerPrompt).toContain("- tagged agents: #Review-Agent, #Verify-Agent");
    expect(reviewerPrompt).toContain("- you were tagged: yes");
    const communicationEvents = store.readCommunicationEvents(project.id);
    expect(communicationEvents).toHaveLength(4);
    expect(communicationEvents.map((event) => event.eventId)).toEqual(expect.arrayContaining([
      direct.json<{ eventId: string }>().eventId,
      broadcast.json<{ eventId: string }>().eventId,
      collaboration.json<{ eventId: string }>().eventId,
    ]));
    expect(communicationEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        schemaVersion: 2, intent: "user_dm",
        sender: expect.objectContaining({ kind: "agent", agentId: author.id }),
        audience: { kind: "user_agent", userId: "local-operator", agentId: author.id },
      }),
      expect.objectContaining({ intent: "broadcast", audience: { kind: "organization", organizationId: project.id } }),
      expect.objectContaining({
        intent: "collaboration",
        audience: { kind: "agents", agentIds: [reviewer.id, verifier.id].sort() },
      }),
    ]));
    expect(store.getMessages(author.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        communicationEventId: direct.json<{ eventId: string }>().eventId,
        text: "Private implementation note.",
      }),
    ]));
    const directEventId = direct.json<{ eventId: string }>().eventId;
    expect(communicationEvents.filter((event) => event.eventId === directEventId)).toHaveLength(1);
    expect(store.readCommunicationProjections(project.id).filter((projection) => projection.eventId === directEventId)
      .map((projection) => [projection.surface, projection.projectionKey])).toEqual(expect.arrayContaining([
        ["conversation", master.id],
        ["direct_agent_audit", author.id],
        ["user_inbox", "local-operator"],
      ]));
    expect(store.getConversationMessages(master.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId: broadcast.json<{ eventId: string }>().eventId }),
    ]));
    expect(store.getMessages(author.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "#broadcast Manager-facing checkpoint." }),
    ]));
    for (const agent of [reviewer, verifier]) {
      expect(store.getMessages(agent.id).some((message) =>
        message.text === "#broadcast Manager-facing checkpoint.")).toBe(false);
    }
    expect(store.getConversationMessages(master.id, "collaboration")).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId: collaboration.json<{ eventId: string }>().eventId }),
    ]));
    const collaborationEventId = collaboration.json<{ eventId: string }>().eventId;
    expect(communicationEvents.filter((event) => event.eventId === collaborationEventId)).toHaveLength(1);
    expect(store.readCommunicationProjections(project.id).filter((projection) =>
      projection.eventId === collaborationEventId && projection.surface === "collaboration_view")).toHaveLength(1);
    const deliveryStore = new CollaborationDeliveryStore(dataDir);
    expect([reviewer.id, verifier.id].map((agentId) =>
      deliveryStore.getForMessageTarget(collaboration.json<{ messageId: string }>().messageId, agentId)?.communicationEventId))
      .toEqual([collaborationEventId, collaborationEventId]);
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      canonicalEvents: 4,
      linkedProjections: 15,
      missingProjectionEventIds: [],
      duplicateProjectionEventIds: [],
      orphanProjectionEventIds: [],
      missingClassificationEventIds: [],
      missingProjectionMetadataEventIds: [],
      ok: true,
    });
    const reconciliation = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/communication-reconciliation`,
    });
    expect(reconciliation.statusCode).toBe(200);
    expect(reconciliation.json()).toMatchObject({ ok: true, canonicalEvents: 4, linkedProjections: 15 });
    await Promise.all([cancelAndWait(app, author.id), cancelAndWait(app, reviewer.id)]);
    await app.close();
  });

  it("rejects ambiguous routing payloads and preserves explicit intents", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Retirement", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Explicit room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reviewer = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });

    const manualMention = await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/collaboration/messages`, payload: { text: "#Reviewer inspect this" },
    });
    expect(manualMention.statusCode).toBe(400);
    expect(manualMention.json()).toMatchObject({ error: expect.stringContaining("explicit recipientAgentIds") });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Begin" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const legacy = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${token}` },
      payload: { channel: "collaboration", text: "#Reviewer legacy route" },
    });
    expect(legacy.statusCode).toBe(400);
    const explicit = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${token}` },
      payload: { intent: "collaboration", recipientAgentIds: [reviewer.id], text: "Explicit route" },
    });
    expect(explicit.statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/cancel` });
    for (let index = 0; index < 80 && adapter.abortedSeeds < 1; index += 1) await sleep(10);
    expect(adapter.abortedSeeds).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("delivers scoped Markdown documents as concise summaries with on-demand content", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Documents", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Private room" });
    const outsiderRoom = store.createConversation(project.id, { title: "Unrelated room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reviewer = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });
    const outsider = store.createAgent(project.id, { title: "Outsider", engine: "codex", conversationId: outsiderRoom.id });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Begin" } });
    await waitForSeedCount(1);
    const authorToken = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const full = `# Detailed review\n\n${"private analysis ".repeat(400)}`;
    const sent = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${authorToken}` },
      payload: { intent: "collaboration", recipientAgentIds: [reviewer.id], text: "Review complete; see the attached document.", document: { title: "Detailed Review", content: full, mediaType: "text/markdown" } },
    });
    expect(sent.statusCode).toBe(200);
    await waitForSeedCount(2);
    const event = store.getCommunicationEvent(project.id, sent.json<{ eventId: string }>().eventId)!;
    expect(event.document).toMatchObject({ title: "Detailed Review", authorAgentId: author.id, executionId: expect.any(String) });
    expect(store.getProjectedConversationMessages(master.id, "main")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ document: expect.anything() })]),
    );
    const projected = store.getProjectedConversationMessages(master.id, "collaboration")[0]!;
    expect(projected.text).toContain("Review complete");
    expect(projected.text).not.toContain("private analysis");
    expect(projected.document).toMatchObject({ title: "Detailed Review", previewUrl: expect.any(String), downloadUrl: expect.any(String) });
    expect(adapter.seeds[1]!.prompt).toContain(`id: ${event.document!.id}`);
    expect(adapter.seeds[1]!.prompt).not.toContain("private analysis");

    const uiPreview = await app.inject({ method: "GET", url: projected.document!.previewUrl });
    expect(uiPreview.statusCode).toBe(200);
    expect(uiPreview.json()).toMatchObject({ content: full, title: "Detailed Review" });
    const reviewerToken = adapter.seeds[1]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const agentPreview = await app.inject({ method: "GET", url: `/api/agent-documents/${event.document!.id}`, headers: { authorization: `Bearer ${reviewerToken}` } });
    expect(agentPreview.statusCode).toBe(200);
    expect(agentPreview.json()).toMatchObject({ content: full });
    expect(adapter.seeds[1]!.environment!.PONDEROSA_DOCUMENT_URL).toContain("/api/agent-documents");

    await app.inject({ method: "POST", url: `/api/agents/${outsider.id}/messages`, payload: { text: "Unrelated work" } });
    await waitForSeedCount(3);
    const outsiderToken = adapter.seeds[2]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const forbiddenCollaboration = await app.inject({ method: "GET", url: `/api/agent-documents/${event.document!.id}`, headers: { authorization: `Bearer ${outsiderToken}` } });
    expect(forbiddenCollaboration.statusCode).toBe(404);
    expect(forbiddenCollaboration.json()).toEqual({ error: "document not found" });

    const direct = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${authorToken}` },
      payload: { intent: "direct_to_user", text: "Private manager summary", document: { title: "Manager Detail", content: "# Manager only\n\nSensitive." } },
    });
    expect(direct.statusCode).toBe(200);
    const directEvent = store.getCommunicationEvent(project.id, direct.json<{ eventId: string }>().eventId)!;
    const forbiddenDirect = await app.inject({ method: "GET", url: `/api/agent-documents/${directEvent.document!.id}`, headers: { authorization: `Bearer ${outsiderToken}` } });
    expect(forbiddenDirect.statusCode).toBe(404);
    expect(forbiddenDirect.json()).toEqual({ error: "document not found" });

    await Promise.all([cancelAndWait(app, author.id), cancelAndWait(app, reviewer.id), cancelAndWait(app, outsider.id)]);
    await app.close();
  });

  it("lets eligible room agents retrieve broadcast documents without seeding full content", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Broadcast documents", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Shared room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reader = store.createAgent(project.id, { title: "Reader", engine: "codex", conversationId: master.id });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Prepare shared guidance" } });
    await waitForSeedCount(1);
    const authorToken = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const full = `# Organization Runbook\n\n${"FULL-SECRET-BODY ".repeat(500)}`;
    const sent = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${authorToken}` },
      payload: { intent: "broadcast", text: "The organization runbook is ready.", document: { title: "Organization Runbook", content: full } },
    });
    expect(sent.statusCode).toBe(200);
    const event = store.getCommunicationEvent(project.id, sent.json<{ eventId: string }>().eventId)!;

    const turn = await app.inject({
      method: "POST", url: `/api/agents/${reader.id}/messages`,
      payload: { text: "Use the shared guidance", sourceChannel: "main", sourceConversationId: master.id, shareWithOrganization: true },
    });
    expect(turn.statusCode).toBe(200);
    await waitForSeedCount(2);
    const seeded = adapter.seeds[1]!.prompt;
    expect(seeded).toContain("The organization runbook is ready.");
    expect(seeded).toContain(`document: Organization Runbook; id: ${event.document!.id}`);
    expect(seeded).not.toContain("FULL-SECRET-BODY");

    const readerToken = adapter.seeds[1]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const retrieved = await app.inject({ method: "GET", url: `/api/agent-documents/${event.document!.id}`, headers: { authorization: `Bearer ${readerToken}` } });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json()).toMatchObject({ title: "Organization Runbook", content: full });
    await Promise.all([cancelAndWait(app, author.id), cancelAndWait(app, reader.id)]);
    await app.close();
  });

  it("rejects recipient-free and out-of-room collaboration intents before persistence", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Routing room" });
    const otherMaster = store.createConversation(project.id, { title: "Other room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const outsider = store.createAgent(project.id, { title: "Outsider", engine: "codex", conversationId: otherMaster.id });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Start." } });
    await waitForSeedCount(1);
    const headers = { authorization: `Bearer ${adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN}` };

    const recipientFree = await app.inject({
      method: "POST", url: "/api/agent-messages", headers,
      payload: { intent: "collaboration", recipientAgentIds: [], text: "Unroutable." },
    });
    const unauthorized = await app.inject({
      method: "POST", url: "/api/agent-messages", headers,
      payload: { intent: "collaboration", recipientAgentIds: [outsider.id], text: "Cross-room." },
    });

    expect(recipientFree.statusCode).toBe(400);
    expect(unauthorized.statusCode).toBe(400);
    expect(store.getConversationMessages(master.id, "collaboration")).toHaveLength(0);
    expect(store.getConversationDeliveryIntents(master.id)).toHaveLength(0);
    await cancelAndWait(app, author.id);
    await app.close();
  });

  it("lets a room member broadcast idempotently without delivering to itself", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Agent broadcast" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reviewer = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Start." } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const payload = { intent: "collaboration", recipientAgentIds: [reviewer.id], text: "review this.", idempotencyKey: "broadcast-review" };
    const first = await app.inject({ method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${token}` }, payload });
    const retry = await app.inject({ method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${token}` }, payload });

    expect(first.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ replayed: true, messageId: first.json<{ messageId: string }>().messageId });
    await waitForSeedCount(2);
    expect(adapter.seeds).toHaveLength(2);
    expect(store.getMessages(author.id).filter((message) => message.text.includes("review this"))).toHaveLength(1);
    expect(store.getMessages(reviewer.id).filter((message) => message.text.includes("review this"))).toHaveLength(1);
    expect(store.getConversationDeliveryIntents(master.id).filter(({ message }) => message.id === first.json<{ messageId: string }>().messageId))
      .toHaveLength(1);
    await Promise.all([cancelAndWait(app, author.id), cancelAndWait(app, reviewer.id)]);
    await app.close();
  });

  it("rejects a broadcast when the authenticated agent is no longer a current room member", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Membership room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reviewer = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Start." } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    store.updateAgentConversationMemberships(author.id, { conversationIds: [] });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { intent: "collaboration", recipientAgentIds: [reviewer.id], text: "should not receive this.", idempotencyKey: "removed-author" },
    });

    expect(response.statusCode).toBe(409);
    expect(store.getConversationMessages(master.id, "collaboration")).toHaveLength(0);
    expect(store.getMessages(reviewer.id)).toHaveLength(0);
    expect(store.getConversationDeliveryIntents(master.id)).toHaveLength(0);
    await cancelAndWait(app, author.id);
    await app.close();
  });

  it("expires an agent messaging capability when its run ends", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Room" });
    const agent = store.createAgent(project.id, {
      title: "Agent",
      engine: "codex",
      conversationId: master.id,
    });
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Finish." } });
    await waitForRun(agent.id);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { intent: "direct_to_user", text: "Too late." },
    });
    expect(response.statusCode).toBe(401);
    expect(store.getConversationMessages(master.id)).toEqual([
      expect.objectContaining({ text: "#Agent Finish.", communicationEventId: expect.any(String) }),
    ]);
    expect(store.getConversationMessages(master.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Too late." })]),
    );
    await app.close();
  });

  it("does not let forwarded or Host headers redirect capability callbacks", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Agent", engine: "codex" });
    adapter.mode = "hang";
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      headers: { host: "pine.example.test", "x-forwarded-proto": "https" },
      payload: { text: "Use the routed endpoint." },
    });
    await waitForSeedCount(1);
    expect(adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_URL).toBe("http://127.0.0.1:8787/api/agent-messages");
    await cancelAndWait(app, agent.id);
    await app.close();
  });

  it("queues a handoff sent through an active agent's messaging capability", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Collaboration room" });
    const reviewer = store.createAgent(project.id, { title: "Pinnacles", engine: "codex", conversationId: master.id });
    const author = store.createAgent(project.id, { title: "Badlands", engine: "codex", conversationId: master.id });

    adapter.mode = "hang";
    await app.inject({
      method: "POST",
      url: `/api/agents/${reviewer.id}/messages`,
      payload: { text: "Review the current change." },
    });
    await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/messages`,
      payload: { text: "Prepare the handoff." },
    });
    await waitForSeedCount(2);
    const token = adapter.seeds.find((seed) => seed.agentId === author.id)?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect(token).toBeTruthy();

    const handoff = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { intent: "collaboration", recipientAgentIds: [reviewer.id], text: "Please review this once you finish." },
    });
    expect(handoff.statusCode).toBe(200);

    await app.inject({ method: "POST", url: `/api/agents/${reviewer.id}/cancel` });
    await waitForRun(reviewer.id);
    expect(adapter.continues.at(-1)?.prompt).toContain(
      "Latest message for you:\n#Pinnacles Please review this once you finish.",
    );

    await cancelAndWait(app, author.id);
    await app.close();
  });

  it("preserves queued tags when an unrelated active turn is cancelled and de-duplicates an agent retry", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Async handoffs" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    const child = store.createAgent(project.id, { title: "Child", engine: "codex", conversationId: master.id });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${parent.id}/messages`, payload: { text: "Stay busy." } });
    await app.inject({ method: "POST", url: `/api/agents/${child.id}/messages`, payload: { text: "Wait for a retry." } });
    await waitForSeedCount(2);
    const childToken = adapter.seeds.find((seed) => seed.agentId === child.id)?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect(childToken).toBeTruthy();

    const tag = { intent: "collaboration" as const, recipientAgentIds: [parent.id], text: "first completed result", idempotencyKey: "result-1" };
    const first = await app.inject({ method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${childToken}` }, payload: tag });
    const retry = await app.inject({ method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${childToken}` }, payload: tag });
    expect(first.json()).toMatchObject({ replayed: false });
    expect(retry.json()).toMatchObject({ replayed: true, messageId: first.json<{ messageId: string }>().messageId });
    await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "second completed result", recipientAgentIds: [parent.id] },
    });
    await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "third completed result", recipientAgentIds: [parent.id] },
    });

    // The recipient is still in a tool-like wait. Cancellation must not consume
    // its queued tags; all three enter one lossless FIFO continuation turn.
    adapter.mode = "normal";
    await app.inject({ method: "POST", url: `/api/agents/${parent.id}/cancel` });
    await waitForRun(parent.id);
    const batchPrompt = adapter.continues.find((turn) => turn.agentId === parent.id)?.prompt ?? "";
    expect(batchPrompt).toContain("CollaborationDeliveryBatch (3 deliveries; canonical server order)");
    expect(batchPrompt.indexOf("#Parent first completed result")).toBeLessThan(batchPrompt.indexOf("#Parent second completed result"));
    expect(batchPrompt.indexOf("#Parent second completed result")).toBeLessThan(batchPrompt.indexOf("#Parent third completed result"));
    expect(store.getCollaborationViewDetail(master.id)?.messages.filter((message) => message.text === "#Parent first completed result")).toHaveLength(1);
    await cancelAndWait(app, child.id);
    await app.close();
  });

  it("does not resurrect an active collaboration delivery after explicit user cancellation", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Cancel delivery", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Cancellation" });
    const agent = store.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: master.id });
    adapter.mode = "hang";

    const sent = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "Stop this delivery", recipientAgentIds: [agent.id] },
    });
    expect(sent.statusCode).toBe(200);
    await waitForSeedCount(1);

    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel` })).json())
      .toEqual({ cancelled: true });
    await vi.waitFor(() => expect(adapter.abortedSeeds).toBe(1));
    await sleep(20);
    expect(adapter.seeds).toHaveLength(1);

    const messageId = sent.json<{ message: { id: string } }>().message.id;
    const delivery = new CollaborationDeliveryStore(dataDir).getForMessageTarget(messageId, agent.id);
    expect(delivery).toMatchObject({ status: "cancelled", failure: "cancelled by user", attempts: 1 });
    await app.close();
  });

  it("starts queued tags after a normal tool-boundary turn completes", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Safe boundary" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    adapter.mode = "boundary";
    await app.inject({ method: "POST", url: `/api/agents/${parent.id}/messages`, payload: { text: "Work through a tool call." } });
    await waitForSeedCount(1);

    await Promise.all([
      app.inject({ method: "POST", url: `/api/conversations/${master.id}/collaboration/messages`, payload: { text: "result one", recipientAgentIds: [parent.id] } }),
      app.inject({ method: "POST", url: `/api/conversations/${master.id}/collaboration/messages`, payload: { text: "result two", recipientAgentIds: [parent.id] } }),
    ]);
    await waitForRun(parent.id, 2);
    const prompt = adapter.continues.find((turn) => turn.agentId === parent.id)?.prompt ?? "";
    expect(prompt).toContain("CollaborationDeliveryBatch (2 deliveries; canonical server order)");
    expect(prompt.indexOf("#Parent result one")).toBeLessThan(prompt.indexOf("#Parent result two"));
    await app.close();
  });

  it("creates a normal managed agent, injects shared Broadcasts, and permits direct need-to-know collaboration", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Child result delivery" });
    const parent = store.createAgent(project.id, { title: "Cedar Breaks", engine: "codex", conversationId: master.id });

    adapter.mode = "hang";
    await app.inject({
      method: "POST", url: `/api/conversations/${master.id}/messages`,
      payload: { text: "#broadcast Shared policy: verify claims before reporting." },
    });
    await app.inject({ method: "POST", url: `/api/agents/${parent.id}/messages`, payload: { text: "Create a research report." } });
    await waitForSeedCount(1);
    const parentToken = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect(adapter.seeds[0]!.environment!.PONDEROSA_AGENT_SPAWN_URL).toBe("http://127.0.0.1:8787/api/agent-spawns");
    const spawned = await app.inject({
      method: "POST",
      url: "/api/agent-spawns",
      headers: { authorization: `Bearer ${parentToken}` },
      payload: { displayName: "Research", initialMessage: "Research and report back.", runtime: "codex", idempotencyKey: "child-result" },
    });
    expect(spawned.statusCode).toBe(201);
    const child = spawned.json<{ agent: AgentDto }>().agent;
    expect(child).toMatchObject({
      managerAgentId: parent.id,
      spawnedByAgentId: parent.id,
      spawnedByExecutionId: expect.any(String),
      spawnPrompt: "Research and report back.",
    });
    const replay = await app.inject({
      method: "POST", url: "/api/agent-spawns", headers: { authorization: `Bearer ${parentToken}` },
      payload: { displayName: "Research", initialMessage: "Research and report back.", runtime: "codex", idempotencyKey: "child-result" },
    });
    expect(replay.json()).toMatchObject({ replayed: true, agent: { id: child.id } });
    await waitForSeedCount(2);
    const childSeed = adapter.seeds.find((seed) => seed.agentId === child.id);
    const childToken = childSeed?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect(childToken).toBeTruthy();
    expect(childSeed?.prompt).toContain(`Your direct manager is the stable agent id ${parent.id}`);
    expect(childSeed?.prompt).toContain("That relationship defines accountability, escalation, creation, and lifecycle ownership; it does not restrict who you may contact.");
    expect(childSeed?.prompt).toContain("Contact your manager when the manager owns the outcome");
    expect(childSeed?.prompt).toContain("You may collaborate directly with any relevant agent in the project");
    expect(childSeed?.prompt).toContain("Do not Broadcast");
    expect(childSeed?.prompt).toContain("Do not send routine acknowledgments or duplicate summaries");
    expect(childSeed?.prompt).toContain("Shared policy: verify claims before reporting.");
    expect(childSeed?.prompt).toContain("Research and report back.");

    const eventsBeforeRejectedBroadcast = store.readCommunicationEvents(project.id);
    const rejectedBroadcast = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${childToken}` },
      payload: {
        intent: "broadcast",
        text: "This delegated result must not reach the organization.",
        document: { title: "Private delegated result", content: "# Must remain private" },
      },
    });
    expect(rejectedBroadcast.statusCode).toBe(409);
    expect(rejectedBroadcast.json()).toEqual({
      error: "managed agents cannot broadcast; use collaboration with the agents who need the information",
      managerAgentId: parent.id,
    });
    expect(store.readCommunicationEvents(project.id)).toEqual(eventsBeforeRejectedBroadcast);
    expect(store.getConversationDetail(master.id)?.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("must not reach the organization") })]),
    );

    const result = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${childToken}` },
      payload: { intent: "collaboration", recipientAgentIds: [parent.id], text: "Huntsville result is ready.", idempotencyKey: "huntsville-result" },
    });
    expect(result.statusCode).toBe(200);
    const resultEventId = result.json<{ eventId: string }>().eventId;
    expect(store.getCommunicationEvent(project.id, resultEventId)).toMatchObject({
      intent: "collaboration",
      audience: { kind: "agents", agentIds: [parent.id] },
    });

    await app.inject({ method: "POST", url: `/api/agents/${parent.id}/cancel` });
    await waitForRun(parent.id);
    expect(adapter.continues.find((turn) => turn.agentId === parent.id)?.prompt).toContain(
      "Latest message for you:\n#Cedar-Breaks Huntsville result is ready.",
    );
    expect(store.getProjectedAgentMessages(parent.id).find((message) => message.communicationEventId === resultEventId)).toMatchObject({
      role: "assistant",
      authorAgentId: child.id,
      text: "#Cedar-Breaks Huntsville result is ready.",
    });
    expect(store.getCollaborationViewDetail(master.id)?.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("delivery dispatch rejected (400)") })]),
    );

    await cancelAndWait(app, child.id);
    await app.close();
  });

  it("wakes a managed agent's direct manager when the child runtime crashes", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Managed failure", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Failure supervision" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${manager.id}/messages`, payload: { text: "Supervise your reports." } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN;
    adapter.mode = "normal";
    adapter.failuresRemaining = 1;
    const spawned = await app.inject({
      method: "POST", url: "/api/agent-spawns", headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Fragile worker", initialMessage: "Try the risky work.", idempotencyKey: "fragile-1" },
    });
    const child = spawned.json<{ agent: AgentDto }>().agent;
    await waitForSeedCount(2);
    for (let index = 0; index < 80 && !store.readEvents(child.id).some((event) => event.event.type === "agent_lifecycle" && event.event.status === "failed"); index += 1) await sleep(10);

    await app.inject({ method: "POST", url: `/api/agents/${manager.id}/cancel` });
    await waitForRun(manager.id);
    const managerFollowUp = [...adapter.seeds, ...adapter.continues].find((turn) =>
      turn.agentId === manager.id && turn.prompt.includes("Internal managed-agent update"));
    expect(managerFollowUp?.prompt).toContain("Fragile worker");
    expect(managerFollowUp?.prompt).toContain("simulated runtime failure");
    expect(store.getCollaborationViewDetail(master.id)?.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("simulated runtime failure") })]),
    );
    await app.close();
  });

  it("completes managed collaboration work without forcing a duplicate parent handoff", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Managed completion", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Completion supervision" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });
    const child = store.createAgent(project.id, {
      title: "Quiet worker", engine: "codex", conversationId: master.id, managerAgentId: manager.id,
    });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${manager.id}/messages`, payload: { text: "Supervise this work." } });
    await waitForSeedCount(1);
    const managerToken = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN;
    adapter.mode = "normal";
    const assigned = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${managerToken}` },
      payload: { intent: "collaboration", recipientAgentIds: [child.id], text: "Complete the audit. No other agent needs a delivery from this synthetic adapter." },
    });
    expect(assigned.statusCode).toBe(200);
    await waitForSeedCount(2);
    await waitForRun(child.id);
    await vi.waitFor(() => expect(store.readEvents(child.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ type: "agent_lifecycle", status: "completed", reason: "turn_completed" }) }),
    ])));

    const childPrompt = adapter.seeds.find((turn) => turn.agentId === child.id)?.prompt ?? "";
    expect(childPrompt).toContain("The organization graph describes accountability and lifecycle ownership, not permitted communication paths.");
    expect(childPrompt).toContain("If this collaboration-triggered turn produces a result, question, or material blocker another agent needs");
    expect(childPrompt).not.toContain("Required managed-agent completion contract");
    const childRun = (await app.inject({ method: "GET", url: `/api/agents/${child.id}` }))
      .json<{ runs: Array<{ status: string; reason: string }> }>().runs.at(-1);
    expect(childRun).toMatchObject({ status: "completed", reason: "turn_completed" });
    expect(store.readCommunicationEvents(project.id).some((event) =>
      event.intent === "collaboration" && event.sender.kind === "agent" && event.sender.agentId === child.id)).toBe(false);

    await app.inject({ method: "POST", url: `/api/agents/${manager.id}/cancel` });
    expect([...adapter.seeds, ...adapter.continues].some((turn) =>
      turn.agentId === manager.id && turn.prompt.includes("without the required explicit Collaboration handoff"))).toBe(false);
    await app.close();
  });

  it("lets a managed agent deliver directly to a needed agent in another reporting branch", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Direct collaboration", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Cross-branch work" });
    const director = store.createAgent(project.id, { title: "Director", engine: "codex", conversationId: master.id });
    const firstManager = store.createAgent(project.id, {
      title: "First manager", engine: "codex", conversationId: master.id, managerAgentId: director.id,
    });
    const secondManager = store.createAgent(project.id, {
      title: "Second manager", engine: "codex", conversationId: master.id, managerAgentId: director.id,
    });
    const child = store.createAgent(project.id, {
      title: "Reporting worker", engine: "codex", conversationId: master.id, managerAgentId: firstManager.id,
    });
    const consumer = store.createAgent(project.id, {
      title: "Result consumer", engine: "codex", conversationId: master.id, managerAgentId: secondManager.id,
    });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${firstManager.id}/messages`, payload: { text: "Coordinate the first branch." } });
    await waitForSeedCount(1);
    const managerToken = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN;
    adapter.mode = "normal";
    adapter.beforeResponse = async (opts) => {
      if (opts.agentId !== child.id) return;
      const report = await app.inject({
        method: "POST", url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { intent: "collaboration", recipientAgentIds: [consumer.id], text: "Schema contract ready for your integration." },
      });
      expect(report.statusCode).toBe(200);
    };
    await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${managerToken}` },
      payload: { intent: "collaboration", recipientAgentIds: [child.id], text: "Prepare the schema contract for the other branch's consumer." },
    });
    await waitForSeedCount(2);
    await waitForRun(child.id);
    await vi.waitFor(() => expect(store.readEvents(child.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ type: "agent_lifecycle", status: "completed", reason: "turn_completed" }) }),
    ])));

    const childRun = (await app.inject({ method: "GET", url: `/api/agents/${child.id}` }))
      .json<{ runs: Array<{ id: string; status: string; reason: string }> }>().runs.at(-1)!;
    expect(childRun).toMatchObject({ status: "completed", reason: "turn_completed" });
    expect(store.readCommunicationEvents(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        intent: "collaboration",
        sender: { kind: "agent", agentId: child.id, executionId: childRun.id },
        audience: { kind: "agents", agentIds: [consumer.id] },
        text: "Schema contract ready for your integration.",
      }),
    ]));
    expect(store.readCommunicationEvents(project.id).some((event) =>
      event.intent === "collaboration" &&
      event.sender.kind === "agent" &&
      event.sender.agentId === child.id &&
      event.audience.agentIds.includes(firstManager.id))).toBe(false);
    const childPrompt = adapter.seeds.find((turn) => turn.agentId === child.id)?.prompt ?? "";
    expect(childPrompt).toContain("You may collaborate directly with any relevant agent in the project, including agents in other reporting branches.");
    await app.inject({ method: "POST", url: `/api/agents/${firstManager.id}/cancel` });
    await app.close();
  });

  it("recovers queued and interrupted collaboration deliveries after restart in FIFO order", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Restart recovery" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    const firstMessage = appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { role: "user", text: "#Parent interrupted first result" },
      undefined,
      "collaboration",
      [{ targetAgentId: parent.id, relayDepth: 0, mentionTrail: [], kind: "tag" }],
    )!;
    const secondMessage = appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { role: "user", text: "#Parent queued second result" },
      undefined,
      "collaboration",
      [{ targetAgentId: parent.id, relayDepth: 0, mentionTrail: [], kind: "tag" }],
    )!;
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const first = deliveries.queue({
      conversationId: master.id,
      messageId: firstMessage.id,
      targetAgentId: parent.id,
      text: firstMessage.text,
      relayDepth: 0,
      mentionTrail: [],
      kind: "tag",
    }).delivery;
    deliveries.markDelivered(first.id);
    deliveries.queue({
      conversationId: master.id,
      messageId: secondMessage.id,
      targetAgentId: parent.id,
      text: secondMessage.text,
      relayDepth: 0,
      mentionTrail: [],
      kind: "tag",
    });

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(parent.id);

    const prompt = adapter.seeds.find((turn) => turn.agentId === parent.id)?.prompt ?? "";
    expect(prompt).toContain("CollaborationDeliveryBatch (2 deliveries; canonical server order)");
    expect(prompt.lastIndexOf("#Parent interrupted first result")).toBeLessThan(prompt.lastIndexOf("#Parent queued second result"));
    await app.close();
  });

  it("dispatches a fixed, exact collaboration batch and leaves in-flight arrivals for the next turn", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Batch room" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    const other = store.createAgent(project.id, { title: "Other", engine: "codex", conversationId: master.id });
    const author = store.createAgent(project.id, { title: "Mesa Author", engine: "codex", conversationId: master.id });
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const firstAt = "2026-07-11T10:00:00.000Z";
    const secondAt = "2026-07-11T10:00:01.000Z";
    const queue = (messageId: string, targetAgentId: string, text: string, createdAt: string) => deliveries.queue({
      conversationId: master.id,
      messageId,
      targetAgentId,
      authorAgentId: author.id,
      text,
      relayDepth: 0,
      mentionTrail: [],
      kind: "tag",
      createdAt,
      orderKey: createdAt,
    }).delivery;
    const first = queue("batch-first", parent.id, "first exact\nline two", firstAt);
    const second = queue("batch-second", parent.id, "second exact", secondAt);
    const isolated = queue("batch-other", other.id, "other recipient only", firstAt);

    adapter.mode = "boundary";
    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForSeedCount(2);
    await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/collaboration/messages`,
      payload: { text: "arrived during active batch", recipientAgentIds: [parent.id] },
    });
    await waitForRun(parent.id, 2);
    await waitForRun(other.id);

    const parentTurns = [
      ...adapter.seeds.filter((turn) => turn.agentId === parent.id),
      ...adapter.continues.filter((turn) => turn.agentId === parent.id),
    ];
    expect(parentTurns).toHaveLength(2);
    expect(parentTurns[0]?.prompt).toContain(
      `Author: Mesa Author (#Mesa-Author, agent ${author.id})\nUTC timestamp: ${firstAt}\nOriginal message (exact):\nfirst exact\nline two`,
    );
    expect(parentTurns[0]?.prompt).toContain(`UTC timestamp: ${secondAt}\nOriginal message (exact):\nsecond exact`);
    expect(parentTurns[0]?.prompt).not.toContain("arrived during active batch");
    expect(parentTurns[1]?.prompt).toContain("#Parent arrived during active batch");
    expect(adapter.seeds.find((turn) => turn.agentId === other.id)?.prompt).toContain("other recipient only");
    expect(parentTurns.every((turn) => !turn.prompt.includes("other recipient only"))).toBe(true);

    const persisted = new CollaborationDeliveryStore(dataDir);
    expect([first.id, second.id, isolated.id].map((id) => persisted.get(id)?.status)).toEqual([
      "acknowledged",
      "acknowledged",
      "acknowledged",
    ]);
    await app.close();
  });

  it("retries every unacknowledged batch member after a shared runtime failure", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Batch retry" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const ids = ["one", "two"].map((text, index) => deliveries.queue({
      conversationId: master.id,
      messageId: `retry-${text}`,
      targetAgentId: parent.id,
      text,
      relayDepth: 0,
      mentionTrail: [],
      kind: "tag",
      createdAt: `2026-07-11T10:00:0${index}.000Z`,
    }).delivery.id);
    adapter.failNextTurn = true;

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(parent.id, 2);
    const turns = [...adapter.seeds, ...adapter.continues].filter((turn) => turn.agentId === parent.id);
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.prompt.includes("Original message (exact):\none") && turn.prompt.includes("Original message (exact):\ntwo"))).toBe(true);
    const persisted = new CollaborationDeliveryStore(dataDir);
    expect(ids.map((id) => persisted.get(id)?.status)).toEqual(["acknowledged", "acknowledged"]);
    await app.close();
  });

  it("rebuilds a missing inbox record from a canonical tagged message", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Crash window" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    new CollaborationDeliveryStore(dataDir);
    appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { role: "user", text: "#Parent result persisted before the inbox write" },
      undefined,
      "collaboration",
      [{ targetAgentId: parent.id, relayDepth: 0, mentionTrail: [], kind: "tag" }],
    );

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(parent.id);
    expect(adapter.seeds.find((turn) => turn.agentId === parent.id)?.prompt).toContain(
      "Latest message for you:\n#Parent result persisted before the inbox write",
    );
    await app.close();
  });

  it("reconciles an #everyone crash window once per still-eligible recipient with audit provenance", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Broadcast crash window" });
    const first = store.createAgent(project.id, { title: "First", engine: "codex", conversationId: master.id });
    const second = store.createAgent(project.id, { title: "Second", engine: "codex", conversationId: master.id });
    const archived = store.createAgent(project.id, { title: "Archived", engine: "codex", conversationId: master.id });
    const deleted = store.createAgent(project.id, { title: "Deleted", engine: "codex", conversationId: master.id });
    new CollaborationDeliveryStore(dataDir);
    const intent = (targetAgentId: string) => ({
      targetAgentId,
      relayDepth: 0,
      mentionTrail: [],
      kind: "tag" as const,
      audience: "everyone" as const,
    });
    const message = appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { role: "user", text: "#everyone recover this broadcast" },
      undefined,
      "collaboration",
      [intent(first.id), intent(second.id), intent(archived.id), intent(deleted.id)],
    )!;
    store.updateAgent(archived.id, { archived: true });
    store.deleteAgent(deleted.id);

    adapter.mode = "hang";
    const firstStart = createServer({ dataDir, store, engines, logger: false });
    await firstStart.ready();
    await waitForSeedCount(2);
    await firstStart.close();

    const restartedStore = new AgentStore(dataDir);
    const secondStart = createServer({ dataDir, store: restartedStore, engines, logger: false });
    await secondStart.ready();
    await secondStart.close();

    const records = readFileSync(path.join(dataDir, "collaboration-deliveries.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as {
        type: string;
        delivery?: { id: string; messageId: string; targetAgentId: string; audience?: string };
      });
    const deliveries = records
      .flatMap((record) => record.delivery ? [record.delivery] : [])
      .filter((delivery) => delivery.messageId === message.id);
    const uniqueByTarget = new Map(deliveries.map((delivery) => [delivery.targetAgentId, delivery]));
    expect([...uniqueByTarget.keys()].sort()).toEqual([first.id, second.id].sort());
    expect(new Set(deliveries.map((delivery) => delivery.id)).size).toBe(2);
    expect(deliveries.every((delivery) => delivery.audience === "everyone")).toBe(true);
  });

  it("preserves canonical FIFO when an older message is reconstructed", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "FIFO crash window" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const intent = { targetAgentId: parent.id, relayDepth: 0, mentionTrail: [], kind: "tag" as const };
    const afterReconciliationBoundary = new Date(Date.now() + 1_000);
    vi.useFakeTimers();
    vi.setSystemTime(afterReconciliationBoundary);
    const older = appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { role: "user", text: "#Parent older message missing its inbox write" },
      undefined,
      "collaboration",
      [intent],
    )!;
    const newer = appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { role: "user", text: "#Parent newer message already queued" },
      undefined,
      "collaboration",
      [intent],
    )!;
    vi.useRealTimers();
    expect(older.createdAt).toBe(newer.createdAt);
    deliveries.queue({
      conversationId: master.id,
      messageId: newer.id,
      targetAgentId: parent.id,
      text: newer.text,
      relayDepth: 0,
      mentionTrail: [],
      kind: "tag",
      createdAt: newer.createdAt,
      orderKey: store.getConversationMessageDeliveryOrderKey(master.id, newer.id),
    });

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(parent.id);
    const turns = [
      ...adapter.seeds.filter((turn) => turn.agentId === parent.id),
      ...adapter.continues.filter((turn) => turn.agentId === parent.id),
    ];
    expect(turns).toHaveLength(1);
    expect(turns[0]?.prompt.indexOf("#Parent older message missing its inbox write")).toBeLessThan(
      turns[0]?.prompt.indexOf("#Parent newer message already queued") ?? -1,
    );
    await app.close();
  });

  it("preserves mixed collaboration and direct FIFO when timestamps tie", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Mixed FIFO crash window" });
    const parent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const afterReconciliationBoundary = new Date(Date.now() + 1_000);
    vi.useFakeTimers();
    vi.setSystemTime(afterReconciliationBoundary);
    const older = appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { role: "user", text: "#Parent older collaboration message missing its inbox write" },
      undefined,
      "collaboration",
      [{ targetAgentId: parent.id, relayDepth: 0, mentionTrail: [], kind: "tag" }],
    )!;
    const directCreatedAt = new Date().toISOString();
    deliveries.queue({
      messageId: "newer-direct-manager-message",
      targetAgentId: parent.id,
      text: "Newer direct manager message already queued",
      relayDepth: 0,
      mentionTrail: [],
      kind: "direct",
      createdAt: directCreatedAt,
      orderKey: store.nextDeliveryOrderKey(directCreatedAt),
    });
    vi.useRealTimers();
    expect(older.createdAt).toBe(directCreatedAt);

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(parent.id, 2);
    const turns = [
      ...adapter.seeds.filter((turn) => turn.agentId === parent.id),
      ...adapter.continues.filter((turn) => turn.agentId === parent.id),
    ];
    expect(turns[0]?.prompt).toContain(
      "Latest message for you:\n#Parent older collaboration message missing its inbox write",
    );
    expect(turns[1]?.prompt).toContain("Latest message for you:\nNewer direct manager message already queued");
    await app.close();
  });

  it("does not infer delivery for canonical messages without an authorized intent", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Blocked recovery" });
    store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    new CollaborationDeliveryStore(dataDir);
    expect(() => store.appendConversationMessage(
      master.id,
      { role: "assistant", text: "#Parent blocked or historical mention" },
      undefined,
      "collaboration",
    )).toThrow(/canonical communication event/);

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await sleep(20);
    expect(adapter.seeds).toHaveLength(0);
    await app.close();
  });

  it("recovers a durable direct manager follow-up after restart", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Worker", engine: "codex" });
    new CollaborationDeliveryStore(dataDir).queue({
      messageId: "direct-restart",
      targetAgentId: agent.id,
      text: "Continue after restart",
      relayDepth: 0,
      mentionTrail: [],
      kind: "direct",
    });

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(agent.id);
    expect(adapter.seeds.find((turn) => turn.agentId === agent.id)?.prompt).toContain(
      "Latest message for you:\nContinue after restart",
    );
    await app.close();
  });

  it("does not mutate a delivery ledger after shutdown begins", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Worker", engine: "codex" });
    new CollaborationDeliveryStore(dataDir).queue({
      messageId: "active-during-close",
      targetAgentId: agent.id,
      text: "Handle this after restart",
      relayDepth: 0,
      mentionTrail: [],
      kind: "direct",
    });
    adapter.mode = "hang";
    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForSeedCount(1);

    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    await sleep(20);
    expect(() => statSync(dataDir)).toThrow();
  });

  it("allows collaboration beyond the legacy 12-handoff cap", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Long collaboration", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Long chain" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reviewer = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });
    const priorTrail = Array.from({ length: 12 }, (_, index) =>
      createHash("sha256").update(`prior-handoff-${index}`).digest("hex"));
    let handoffStatus: number | undefined;
    adapter.beforeResponse = async (opts) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { intent: "collaboration", recipientAgentIds: [reviewer.id], text: "thirteenth useful handoff" },
      });
      handoffStatus = response.statusCode;
    };

    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/messages`,
      payload: { text: "continue the coordination", agentMentionDepth: 12, agentMentionTrail: priorTrail },
    });
    expect(started.statusCode).toBe(200);
    await waitForRun(author.id);
    expect(handoffStatus).toBe(200);

    const message = store.getCollaborationViewDetail(master.id)?.messages
      .find((item) => item.text === "#Reviewer thirteenth useful handoff");
    expect(message).toBeDefined();
    const delivery = new CollaborationDeliveryStore(dataDir).getForMessageTarget(message!.id, reviewer.id);
    expect(delivery).toMatchObject({ relayDepth: 13 });
    expect(delivery?.mentionTrail).toHaveLength(13);
    await app.close();
  });

  it("still blocks an exact repeated handoff inside the bounded replay window", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Replay protection", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Replay chain" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reviewer = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });
    const renderedText = "#Reviewer repeat this handoff";
    const fingerprint = createHash("sha256")
      .update(author.id).update("\0").update(reviewer.id).update("\0").update(renderedText.toLocaleLowerCase())
      .digest("hex");
    let replayResponse: { statusCode: number; body: string } | undefined;
    adapter.beforeResponse = async (opts) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { intent: "collaboration", recipientAgentIds: [reviewer.id], text: "repeat this handoff" },
      });
      replayResponse = { statusCode: response.statusCode, body: response.body };
    };

    await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/messages`,
      payload: { text: "try the replay", agentMentionDepth: 1, agentMentionTrail: [fingerprint] },
    });
    await waitForRun(author.id);
    expect(replayResponse?.statusCode).toBe(400);
    expect(JSON.parse(replayResponse!.body)).toEqual({
      error: "the same collaboration handoff already occurred in this delivery chain",
    });
    expect(adapter.seeds.filter((turn) => turn.agentId === reviewer.id)).toHaveLength(0);
    await app.close();
  });

  it("merges replay lineage from every delivery in a collaboration batch", async () => {
    const project = store.createProject({ label: "Batch lineage", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Batch chain" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reviewer = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });
    const renderedText = "#Reviewer replay from second lineage";
    const repeatedFingerprint = createHash("sha256")
      .update(author.id).update("\0").update(reviewer.id).update("\0").update(renderedText.toLocaleLowerCase())
      .digest("hex");
    const ledger = new CollaborationDeliveryStore(dataDir);
    ledger.queue({
      conversationId: master.id, messageId: "batch-first", targetAgentId: author.id,
      text: "first delivery", relayDepth: 1,
      mentionTrail: [createHash("sha256").update("first-lineage").digest("hex")], kind: "tag",
    });
    ledger.queue({
      conversationId: master.id, messageId: "batch-second", targetAgentId: author.id,
      text: "second delivery", relayDepth: 1,
      mentionTrail: [repeatedFingerprint], kind: "tag",
    });
    let replayResponse: { statusCode: number; body: string } | undefined;
    const app = createServer({ dataDir, store, engines, logger: false });
    adapter.beforeResponse = async (opts) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: { intent: "collaboration", recipientAgentIds: [reviewer.id], text: "replay from second lineage" },
      });
      replayResponse = { statusCode: response.statusCode, body: response.body };
    };

    await app.ready();
    await waitForRun(author.id);
    expect(adapter.seeds.find((turn) => turn.agentId === author.id)?.prompt)
      .toContain("CollaborationDeliveryBatch (2 deliveries; canonical server order)");
    expect(replayResponse?.statusCode).toBe(400);
    expect(JSON.parse(replayResponse!.body)).toEqual({
      error: "the same collaboration handoff already occurred in this delivery chain",
    });
    expect(adapter.seeds.filter((turn) => turn.agentId === reviewer.id)).toHaveLength(0);
    await app.close();
  });

  it("splits a batch before disjoint replay lineages would exceed the bounded window", async () => {
    const project = store.createProject({ label: "Bounded batch lineage", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Bounded batch chain" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const reviewer = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: master.id });
    const renderedText = "#Reviewer replay from the first full lineage";
    const repeatedFingerprint = createHash("sha256")
      .update(author.id).update("\0").update(reviewer.id).update("\0").update(renderedText.toLocaleLowerCase())
      .digest("hex");
    const firstTrail = [
      repeatedFingerprint,
      ...Array.from({ length: 63 }, (_, index) =>
        createHash("sha256").update(`first-full-lineage-${index}`).digest("hex")),
    ];
    const secondTrail = Array.from({ length: 64 }, (_, index) =>
      createHash("sha256").update(`second-full-lineage-${index}`).digest("hex"));
    const ledger = new CollaborationDeliveryStore(dataDir);
    const first = ledger.queue({
      conversationId: master.id, messageId: "full-batch-first", targetAgentId: author.id,
      text: "first full delivery", relayDepth: 64, mentionTrail: firstTrail, kind: "tag", orderKey: "0001",
    }).delivery;
    const second = ledger.queue({
      conversationId: master.id, messageId: "full-batch-second", targetAgentId: author.id,
      text: "second full delivery", relayDepth: 64, mentionTrail: secondTrail, kind: "tag", orderKey: "0002",
    }).delivery;
    let replayResponse: { statusCode: number; body: string } | undefined;
    const app = createServer({ dataDir, store, engines, logger: false });
    adapter.beforeResponse = async (opts) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${opts.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
        payload: {
          intent: "collaboration",
          recipientAgentIds: [reviewer.id],
          text: "replay from the first full lineage",
        },
      });
      replayResponse = { statusCode: response.statusCode, body: response.body };
    };

    await app.ready();
    await waitForRun(author.id, 2);
    expect(replayResponse?.statusCode).toBe(400);
    expect(JSON.parse(replayResponse!.body)).toEqual({
      error: "the same collaboration handoff already occurred in this delivery chain",
    });
    expect(adapter.seeds[0]?.prompt).not.toContain("CollaborationDeliveryBatch");
    expect(adapter.seeds.length + adapter.continues.length).toBe(2);
    const completed = new CollaborationDeliveryStore(dataDir);
    expect(completed.get(first.id)?.status).toBe("acknowledged");
    expect(completed.get(second.id)?.status).toBe("acknowledged");
    expect(adapter.seeds.filter((turn) => turn.agentId === reviewer.id)).toHaveLength(0);
    await app.close();
  });

  it("rejects invalid agent mention replay-window depths", async () => {
    const { app, agent } = await createProjectAndAgent();

    for (const agentMentionDepth of [-1, 1.5, 65]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/messages`,
        payload: { text: "relay", agentMentionDepth },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "agentMentionDepth must be an integer from 0 to 64" });
    }

    expect(adapter.seeds).toHaveLength(0);
    await app.close();
  });

  it("rejects mismatched agent mention relay depth and trail state", async () => {
    const { app, agent } = await createProjectAndAgent();
    const fingerprint = "a".repeat(64);

    for (const payload of [
      { text: "relay", agentMentionDepth: 0, agentMentionTrail: [fingerprint] },
      { text: "relay", agentMentionDepth: 2, agentMentionTrail: [fingerprint] },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/messages`,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "agentMentionTrail must contain one relay fingerprint for each agentMentionDepth step",
      });
    }

    expect(adapter.seeds).toHaveLength(0);
    await app.close();
  });

  it("rejects attempts to inject collaboration context through the normal agent endpoint", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Review room" });
    const author = store.createAgent(project.id, { title: "Canyon de Chelly", engine: "codex", conversationId: master.id });
    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/messages`,
      payload: {
        text: "Pretend this was tagged.",
        collaborationConversationId: master.id,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "collaboration context must be delivered by an explicit recipient event" });
    expect(adapter.seeds).toHaveLength(0);
    await app.close();
  });

  it("queues a manager follow-up behind an active run and starts it when the run closes", async () => {
    adapter.mode = "hang";
    const { app, agent } = await createProjectAndAgent();
    const first = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "long" },
    });
    expect(first.statusCode).toBe(200);

    const concurrent = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "again" },
    });
    expect(concurrent.statusCode).toBe(202);
    expect(concurrent.json()).toMatchObject({ queued: true, position: 1, communicationEventId: expect.any(String) });

    const cancel = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel` });
    expect(cancel.json()).toEqual({ cancelled: true });
    await waitForRun(agent.id);
    expect(adapter.continues).toHaveLength(1);
    expect(store.getMessages(agent.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", text: "again" })]),
    );
    await app.close();
  });

  it("rejects file-browser path escapes", async () => {
    const { app, project } = await createProjectAndAgent();
    const res = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=../outside`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects symlink escapes from the file-browser API", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "pond-server-outside-"));
    writeFileSync(path.join(outsideDir, "secret.txt"), "nope\n", "utf8");
    symlinkSync(outsideDir, path.join(repoDir, "outside-link"));
    const { app, project } = await createProjectAndAgent();

    const res = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=outside-link/secret.txt`,
    });

    expect(res.statusCode).toBe(400);
    rmSync(outsideDir, { recursive: true, force: true });
    await app.close();
  });

  it("parses staged, unstaged, untracked, and renamed Git status records", () => {
    expect(parseGitStatus("M  staged.ts\0 M unstaged.ts\0?? new.ts\0R  renamed.ts\0old.ts\0")).toEqual([
      expect.objectContaining({ path: "new.ts", kind: "create", untracked: true }),
      expect.objectContaining({ path: "renamed.ts", previousPath: "old.ts", kind: "rename", staged: true }),
      expect.objectContaining({ path: "staged.ts", kind: "edit", staged: true, unstaged: false }),
      expect.objectContaining({ path: "unstaged.ts", kind: "edit", staged: false, unstaged: true }),
    ]);
  });

  it("serves Git-backed workspace review without exposing credential files", async () => {
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir });
    writeFileSync(path.join(repoDir, "README.md"), "# changed\n", "utf8");
    writeFileSync(path.join(repoDir, "new.ts"), "export const ready = true;\n", "utf8");
    writeFileSync(path.join(repoDir, ".env"), "TOKEN=hidden\n", "utf8");
    const { app, project } = await createProjectAndAgent();

    const status = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      projectId: project.id,
      isGitRepository: true,
      changes: expect.arrayContaining([
        expect.objectContaining({ path: "README.md", kind: "edit", unstaged: true }),
        expect.objectContaining({ path: "new.ts", kind: "create", untracked: true }),
      ]),
    });
    expect(status.json<{ changes: Array<{ path: string }> }>().changes.some((change) => change.path === ".env")).toBe(false);

    const review = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace/file?path=README.md` });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ projectId: project.id, path: "README.md", exists: true, content: "# changed\n" });
    expect(review.json<{ diff: string }>().diff).toContain("+# changed");

    const hidden = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace/file?path=.env` });
    expect(hidden.statusCode).toBe(400);
    await app.close();
  });

  it("rejects cross-origin browser mutations while allowing same-origin requests", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { host: "ponderosa.test", origin: "https://evil.test" },
      payload: { label: "Demo", hostPath: repoDir },
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { host: "ponderosa.test", origin: "https://ponderosa.test" },
      payload: { label: "Demo", hostPath: repoDir },
    });
    expect(rejected.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    await app.close();
  });

  it("caps file-browser reads and preserves binary data as base64", async () => {
    writeFileSync(path.join(repoDir, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
    writeFileSync(path.join(repoDir, "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    const { app, project } = await createProjectAndAgent();
    const large = await app.inject({ method: "GET", url: `/api/files?projectId=${project.id}&path=large.bin` });
    const binary = await app.inject({ method: "GET", url: `/api/files?projectId=${project.id}&path=binary.bin` });
    expect(large.statusCode).toBe(400);
    expect(large.json()).toEqual({ error: "file exceeds 2 MiB browser limit" });
    expect(binary.json()).toEqual(expect.objectContaining({ encoding: "base64", content: "//79" }));
    await app.close();
  });

  it("reports engine auth status without requiring real CLI auth", async () => {
    const failing = new MockAdapter();
    failing.id = "broken";
    failing.displayName = "Broken";
    const app = createServer({
      dataDir,
      store,
      logger: false,
      engines: [
        { adapter, authStatus: async () => ({ authenticated: true, detail: "test" }) },
        {
          adapter: failing,
          authStatus: async () => {
            throw new Error("not logged in");
          },
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/api/engines" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: "codex", authenticated: true, authDetail: "test" }),
      expect.objectContaining({ id: "broken", authenticated: false, authDetail: "not logged in" }),
    ]);
    await app.close();
  });

  it("caches inherited engine capabilities instead of repeatedly spawning host CLIs", async () => {
    let discoveries = 0;
    Object.assign(adapter, { capabilities: async () => {
      discoveries += 1;
      return { steering: true, persistentSessions: true, commands: [], mcpServers: [] };
    } });
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Capabilities", hostPath: repoDir });

    const first = await app.inject({ method: "GET", url: `/api/projects/${project.id}/engine-capabilities` });
    const second = await app.inject({ method: "GET", url: `/api/projects/${project.id}/engine-capabilities` });

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(discoveries).toBe(1);
    await app.close();
  });

  it("keeps v2 routes as explicit 501 stubs", async () => {
    const { app, agent } = await createProjectAndAgent();

    const switchEngine = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/switch-engine`,
      payload: { engine: "claude" },
    });
    const search = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/search?q=history`,
    });

    expect(switchEngine.statusCode).toBe(501);
    expect(search.statusCode).toBe(501);
    await app.close();
  });

  it("deletes an agent: removes projections + on-disk log, cancels active run", async () => {
    const { app, project, agent } = await createProjectAndAgent();

    // Give the agent some history so there's a log + projections to remove.
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "do work" },
    });
    await waitForRun(agent.id);
    expect(store.readEvents(agent.id).length).toBeGreaterThan(0);

    const del = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ deleted: boolean }>().deleted).toBe(true);

    // Gone from the projection list and by id.
    const list = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agents` });
    expect(list.json<unknown[]>()).toHaveLength(0);
    const detail = await app.inject({ method: "GET", url: `/api/agents/${agent.id}` });
    expect(detail.statusCode).toBe(404);

    // Deleting again is a 404.
    const again = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}` });
    expect(again.statusCode).toBe(404);

    // On-disk agent directory is gone (rebuild won't resurrect it).
    store.rebuildProjections();
    const afterRebuild = await app.inject({ method: "GET", url: `/api/agents/${agent.id}` });
    expect(afterRebuild.statusCode).toBe(404);
    await app.close();
  });

  it("does not recreate a run claim when deletion finishes before claim creation", async () => {
    let beforeClaimReached = false;
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const app = createServer({
      dataDir,
      store,
      engines,
      logger: false,
      messageLifecycleFaults: {
        beforeRunClaim: async () => {
          beforeClaimReached = true;
          await claimGate;
        },
      },
    });
    const project = store.createProject({ label: "Pre-claim deletion race", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Pre-claim Racing", engine: "codex" });

    const pendingMessage = app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "must never claim after deletion" },
    });
    await vi.waitFor(() => expect(beforeClaimReached).toBe(true));
    const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}` });
    expect(deleted.statusCode).toBe(200);
    releaseClaim();

    const messageResponse = await pendingMessage;
    expect(messageResponse.statusCode).toBe(404);
    expect(adapter.seeds).toHaveLength(0);
    expect(readFileSync(path.join(dataDir, "runtime-runs.jsonl"), "utf8")).not.toContain(agent.id);
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel` })).json())
      .toEqual({ cancelled: false });
    await app.close();
  });

  it("fences a message handler whose durable claim races agent deletion", async () => {
    let claimReached = false;
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const app = createServer({
      dataDir,
      store,
      engines,
      logger: false,
      messageLifecycleFaults: {
        afterRunClaim: async () => {
          claimReached = true;
          await claimGate;
        },
      },
    });
    const project = store.createProject({ label: "Deletion race", hostPath: repoDir });
    const agent = store.createAgent(project.id, { title: "Racing", engine: "codex" });

    const pendingMessage = app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "must never start after deletion" },
    });
    await vi.waitFor(() => expect(claimReached).toBe(true));
    const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}` });
    expect(deleted.statusCode).toBe(200);
    releaseClaim();

    const messageResponse = await pendingMessage;
    expect(messageResponse.statusCode).toBe(404);
    expect(adapter.seeds).toHaveLength(0);
    expect(readFileSync(path.join(dataDir, "runtime-runs.jsonl"), "utf8")).not.toContain(agent.id);
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel` })).json())
      .toEqual({ cancelled: false });
    await app.close();
  });

  it("serves the web build with SPA fallback and scoped static paths", async () => {
    const webDist = mkdtempSync(path.join(tmpdir(), "pond-server-web-"));
    mkdirSync(path.join(webDist, "assets"));
    mkdirSync(path.join(webDist, "static", "js"), { recursive: true });
    writeFileSync(path.join(webDist, "index.html"), "<main>app</main>", "utf8");
    writeFileSync(path.join(webDist, "assets", "app.js"), "console.log('app');\n", "utf8");
    writeFileSync(path.join(webDist, "static", "js", "app.123.js"), "console.log('fingerprinted');\n", "utf8");
    writeFileSync(path.join(webDist, "sw.js"), "self.addEventListener('install', () => {});\n", "utf8");
    writeFileSync(path.join(webDist, "register-sw.js"), "console.log('register');\n", "utf8");
    const app = createServer({ dataDir, store, engines, webDist, logger: false });

    const index = await app.inject({ method: "GET", url: "/" });
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    const fingerprinted = await app.inject({ method: "GET", url: "/static/js/app.123.js" });
    const serviceWorker = await app.inject({ method: "GET", url: "/sw.js" });
    const registerSw = await app.inject({ method: "GET", url: "/register-sw.js" });
    const fallback = await app.inject({ method: "GET", url: "/agents/abc" });
    const apiMiss = await app.inject({ method: "GET", url: "/api/not-real" });
    const escape = await app.inject({ method: "GET", url: "/%5c..%5cpackage.json" });

    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("<main>app</main>");
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(index.headers["x-content-type-options"]).toBe("nosniff");
    expect(index.headers["x-frame-options"]).toBe("DENY");
    expect(index.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(asset.body).toContain("console.log");
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(fallback.headers["cache-control"]).toBe("no-cache");
    expect(serviceWorker.headers["cache-control"]).toBe("no-cache");
    expect(registerSw.headers["cache-control"]).toBe("no-cache");
    expect(fingerprinted.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["cache-control"]).toBe("public, max-age=3600");
    expect(fallback.body).toContain("<main>app</main>");
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.body).not.toContain("<main>app</main>");
    expect(escape.statusCode).toBe(404);

    await app.close();
    rmSync(webDist, { recursive: true, force: true });
  });

  it("does not expose legacy delegation registration or output routes", async () => {
    adapter.mode = "hang";
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Delegation room" });
    const agent = store.createAgent(project.id, { title: "Parent", engine: "codex", conversationId: master.id });
    const parent = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "delegate" } });
    const parentRunId = parent.json<{ runId: string }>().runId;

    expect((await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/assignments`,
      payload: { parentRunId, displayLabel: "Spoof", delegationPrompt: "bad", runtime: "codex", idempotencyKey: "legacy" },
    })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/internal/assignments/missing/launch", payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/internal/assignments/missing/output", payload: { text: "forged" } })).statusCode).toBe(404);

    await cancelAndWait(app, agent.id);
    await app.close();
  });

  it("validates, scopes, persists, serves, and prevents deletion of sent image attachments", async () => {
    const { app, agent } = await createProjectAndAgent();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const rejected = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/attachments`, headers: { "content-type": "image/png" }, payload: Buffer.from("<svg><script/></svg>") });
    expect(rejected.statusCode).toBe(415);
    const uploaded = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/attachments`, headers: { "content-type": "image/png", "x-ponderosa-filename": "../../screen.png" }, payload: png });
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json<{ id: string; name: string; url: string }>();
    expect(attachment.name).toBe("screen.png");
    expect(attachment.url).not.toContain(dataDir);
    const send = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Inspect this", attachmentIds: [attachment.id] } });
    expect(send.statusCode).toBe(200);
    await waitForRun(agent.id);
    expect(store.getMessages(agent.id)[0]?.attachments?.[0]).toMatchObject({ id: attachment.id, agentId: agent.id });
    store.rebuildProjections();
    expect(store.getMessages(agent.id)[0]?.attachments?.[0]).toMatchObject({ id: attachment.id, agentId: agent.id });
    expect(adapter.seeds[0]?.prompt).toContain("Attached images");
    expect(adapter.seeds[0]?.prompt).not.toContain("base64");
    expect((await app.inject({ method: "GET", url: attachment.url })).headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ method: "DELETE", url: attachment.url })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/agents/not-${agent.id}/messages`, payload: { text: "x", attachmentIds: [attachment.id] } })).statusCode).toBe(404);
    await app.close();
  });

  it("serves general assets only as bounded private downloads with non-enumerating ownership failures", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const second = store.createAgent(project.id, { title: "Other", engine: "codex" });
    const uploaded = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/attachments`,
      headers: { "content-type": "application/octet-stream", "x-ponderosa-media-type": "application/pdf", "x-ponderosa-filename": "résumé.pdf" },
      payload: Buffer.from("%PDF-1.7\n<script>download only</script>"),
    });
    expect(uploaded.statusCode).toBe(201);
    const asset = uploaded.json<{ id: string; url: string; previewUrl?: string; downloadUrl: string }>();
    expect(asset.previewUrl).toBeUndefined();
    expect(asset.url).toBe(asset.downloadUrl);
    const download = await app.inject({ method: "GET", url: asset.downloadUrl });
    expect(download.statusCode).toBe(200);
    expect(download.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "accept-ranges": "none",
    });
    expect(download.headers["content-disposition"]).toContain("attachment;");
    expect((await app.inject({ method: "GET", url: asset.downloadUrl, headers: { range: "bytes=0-2" } })).statusCode).toBe(416);
    const foreignUrl = `/api/agents/${second.id}/assets/${asset.id}/download`;
    expect((await app.inject({ method: "GET", url: foreignUrl })).json()).toEqual({ error: "asset not found" });
    expect((await app.inject({ method: "GET", url: `/api/agents/${second.id}/assets/${randomUUID()}/download` })).json()).toEqual({ error: "asset not found" });
    expect((await app.inject({ method: "DELETE", url: `/api/agents/${agent.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: asset.downloadUrl })).statusCode).toBe(404);
    expect(existsSync(path.join(dataDir, "projects", project.id, "agents", agent.id))).toBe(false);
    await app.close();
  });

  it("streams live SSE and replays from last seen seq without duplicates", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const base = `http://127.0.0.1:${address.port}`;

    const liveAbort = new AbortController();
    const live = await fetch(`${base}/api/agents/${agent.id}/stream`, { signal: liveAbort.signal });
    const reader = live.body!.getReader();
    await fetch(`${base}/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "stream" }),
    });

    let chunk = "";
    for (let i = 0; i < 30 && !chunk.includes('"type":"agent_output"'); i += 1) {
      const read = await reader.read();
      chunk += new TextDecoder().decode(read.value);
    }
    liveAbort.abort();
    expect(chunk).toContain("id: 2");
    expect(chunk).toContain('"type":"session"');
    expect(chunk).toContain('"type":"agent_output"');
    expect(chunk).toContain('"executionId":');
    expect(chunk).toContain('"text":"done"');
    expect(chunk).not.toContain('"replayed":true');
    await waitForRun(agent.id);

    const replayAbort = new AbortController();
    const replay = await fetch(`${base}/api/agents/${agent.id}/stream?lastEventId=1`, {
      signal: replayAbort.signal,
    });
    const replayReader = replay.body!.getReader();
    const replayRead = await replayReader.read();
    replayAbort.abort();
    const replayChunk = new TextDecoder().decode(replayRead.value);
    expect(replayChunk).toContain("id: 2");
    expect(replayChunk).not.toContain("id: 1");
    expect(replayChunk).toContain('"replayed":true');

    expect(project.id).toBeTruthy();
    await app.close();
  }, 10000);

  it("validates individual reply targets and sends compact quoted context", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Original question" } });
    await waitForRun(agent.id);
    const original = store.getMessages(agent.id)[0]!;
    const other = store.createAgent(project.id, { title: "Other", engine: "codex" });
    const rejected = await app.inject({ method: "POST", url: `/api/agents/${other.id}/messages`, payload: { text: "Cross-boundary", replyToMessageId: original.id } });
    expect(rejected.statusCode).toBe(400);
    const accepted = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Specific answer", replyToMessageId: original.id } });
    expect(accepted.statusCode).toBe(200);
    expect(adapter.continues.at(-1)?.prompt).toContain("Replying specifically to this earlier message");
    expect(adapter.continues.at(-1)?.prompt).toContain("Original question");
    expect(store.getMessages(agent.id).find((message) => message.text === "Specific answer")?.replyTo?.messageId).toBe(original.id);
    await waitForRun(agent.id);
    await app.close();
  });

  it("delivers Reply Directly once and replays a stable receipt", async () => {
    const { app, project } = await createProjectAndAgent();
    const master = store.createConversation(project.id, { title: "Room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const other = store.createAgent(project.id, { title: "Other", engine: "codex", conversationId: master.id });
    const report = appendCanonicalMessage(store, project.id, master.id, { role: "assistant", text: "Result" }, author.id)!;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const upload = await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/attachments`,
      headers: { "content-type": "image/png", "x-ponderosa-filename": "direct.png" },
      payload: png,
    });
    expect(upload.statusCode).toBe(201);
    const attachmentId = upload.json<{ id: string }>().id;

    const accepted = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: { text: "Follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, attachmentIds: [attachmentId], idempotencyKey: "reply-1" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ replayed: false, targetAuthorAgentId: author.id });
    await waitForRun(author.id);
    expect(adapter.seeds.find((turn) => turn.agentId === author.id)?.prompt)
      .toContain("Replying specifically to this earlier message:\n> Result");

    const replayed = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: { text: "Follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, attachmentIds: [attachmentId], idempotencyKey: "reply-1" },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ replayed: true, messageId: accepted.json<{ messageId: string }>().messageId });
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#Author Follow up")).toHaveLength(1);
    expect(store.getMessages(author.id).filter((message) => message.text === "Follow up")).toHaveLength(1);
    expect(store.getConversationMessages(master.id).find((message) => message.text === "#Author Follow up")?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    expect(store.getMessages(author.id).find((message) => message.text === "Follow up")?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: { text: "Changed payload", replyToMessageId: report.id, targetAuthorAgentId: author.id, idempotencyKey: "reply-1" },
    });
    expect(conflict.statusCode).toBe(409);

    const concurrentPayload = { text: "Concurrent follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, idempotencyKey: "reply-concurrent" };
    const concurrent = await Promise.all([
      app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload: concurrentPayload }),
      app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload: concurrentPayload }),
    ]);
    expect(concurrent.some((response) => response.statusCode === 200)).toBe(true);
    const concurrentReplay = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload: concurrentPayload });
    expect(concurrentReplay.json()).toMatchObject({ replayed: true });
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#Author Concurrent follow up")).toHaveLength(1);
    await waitForRun(author.id, 2);

    const spoofed = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: { text: "Wrong target", replyToMessageId: report.id, targetAuthorAgentId: other.id, idempotencyKey: "reply-2" },
    });
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.json()).toMatchObject({ error: expect.stringMatching(/must be the author/) });
    await app.close();
  });

  it("repairs a same-process direct-reply crash window and double replay without duplicates or spawning", async () => {
    const { app, project } = await createProjectAndAgent();
    const master = store.createConversation(project.id, { title: "Recovery room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const report = appendCanonicalMessage(store, project.id, master.id, { role: "assistant", text: "Result" }, author.id)!;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const upload = await app.inject({
      method: "POST",
      url: `/api/agents/${author.id}/attachments`,
      headers: { "content-type": "image/png", "x-ponderosa-filename": "recovered.png" },
      payload: png,
    });
    const attachmentId = upload.json<{ id: string }>().id;
    const receiptKey = `direct-reply:${master.id}:crash-window`;
    const canonical = appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { text: "#Author Recovered follow up", replyToMessageId: report.id, directReplyToAuthorAgentId: author.id, attachments: [upload.json()] },
      undefined,
      "main",
      [{ targetAgentId: author.id, relayDepth: 0, mentionTrail: [], kind: "direct" }],
      receiptKey,
    )!;
    const agentCount = store.listAgents(project.id).length;
    const payload = { text: "Recovered follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, attachmentIds: [attachmentId], idempotencyKey: "crash-window" };
    const replay = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ messageId: canonical.id, replayed: true });
    const secondReplay = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload });
    expect(secondReplay.json()).toMatchObject({ messageId: canonical.id, replayed: true });
    await waitForRun(author.id);
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#Author Recovered follow up")).toHaveLength(1);
    expect(store.getMessages(author.id).filter((message) => message.text === "Recovered follow up")).toHaveLength(1);
    expect(store.getMessages(author.id).find((message) => message.text === "Recovered follow up")?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    expect(store.listAgents(project.id)).toHaveLength(agentCount);
    await app.close();
  });

  it("returns a truthful retryable failure when a canonical direct reply has no persisted delivery intent", async () => {
    const { app, project } = await createProjectAndAgent();
    const master = store.createConversation(project.id, { title: "Incomplete recovery room" });
    const author = store.createAgent(project.id, { title: "Author", engine: "codex", conversationId: master.id });
    const report = appendCanonicalMessage(store, project.id, master.id, { role: "assistant", text: "Result" }, author.id)!;
    appendCanonicalMessage(
      store,
      project.id,
      master.id,
      { text: "#Author Incomplete follow up", replyToMessageId: report.id, directReplyToAuthorAgentId: author.id },
      undefined,
      "main",
      undefined,
      `direct-reply:${master.id}:missing-intent`,
      [author.id],
    );

    const replay = await app.inject({
      method: "POST",
      url: `/api/conversations/${master.id}/direct-replies`,
      payload: { text: "Incomplete follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, idempotencyKey: "missing-intent" },
    });
    expect(replay.statusCode).toBe(503);
    expect(replay.json()).toMatchObject({ retryable: true, error: expect.stringMatching(/intent is unavailable/) });
    expect(replay.json()).not.toHaveProperty("replayed");
    expect(store.getMessages(author.id).filter((message) => message.text === "Incomplete follow up")).toHaveLength(0);
    await app.close();
  });

  it("queues one direct reply for a busy author and deduplicates retries", async () => {
    const { app, project } = await createProjectAndAgent();
    const master = store.createConversation(project.id, { title: "Busy room" });
    const author = store.createAgent(project.id, { title: "Busy author", engine: "codex", conversationId: master.id });
    const report = appendCanonicalMessage(store, project.id, master.id, { role: "assistant", text: "Working" }, author.id)!;
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/messages`, payload: { text: "Current work" } });
    await waitForSeedCount(1);

    const payload = { text: "Queued follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id, idempotencyKey: "busy-reply" };
    const first = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload });
    const retry = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload });
    expect(first.json()).toMatchObject({ replayed: false, queued: true });
    expect(retry.json()).toMatchObject({ replayed: true, queued: true, messageId: first.json<{ messageId: string }>().messageId });
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#Busy-author Queued follow up")).toHaveLength(1);

    adapter.mode = "normal";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/cancel` });
    for (let i = 0; i < 80 && !store.getMessages(author.id).some((message) => message.text === payload.text); i += 1) await sleep(10);
    expect(store.getMessages(author.id).filter((message) => message.text === payload.text)).toHaveLength(1);
    await app.close();
  });

  it("updates mutable agent organization through stable IDs without rewriting delegation provenance", async () => {
    const { app, project, agent: parent } = await createProjectAndAgent();
    const child = store.createAgent(project.id, { title: "Child", engine: "codex" });
    const grandchild = store.createAgent(project.id, { title: "Grandchild", engine: "codex" });

    const demoted = await app.inject({
      method: "PUT", url: `/api/agents/${child.id}/manager`, payload: { managerAgentId: parent.id },
    });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json()).toMatchObject({ id: child.id, managerAgentId: parent.id });
    await app.inject({ method: "PUT", url: `/api/agents/${grandchild.id}/manager`, payload: { managerAgentId: child.id } });
    const cycle = await app.inject({ method: "PUT", url: `/api/agents/${parent.id}/manager`, payload: { managerAgentId: grandchild.id } });
    expect(cycle.statusCode).toBe(400);
    expect(cycle.json()).toMatchObject({ error: expect.stringMatching(/cycle/) });

    const promoted = await app.inject({ method: "PUT", url: `/api/agents/${child.id}/manager`, payload: { managerAgentId: null } });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).not.toHaveProperty("managerAgentId");
    expect(store.readAgentOrganizationEvents(project.id)).toHaveLength(3);
    await app.close();
  });
});
