import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AgentEvent, ApiPriceProfile, CommunicationEvent, ContinueOptions, EffortOption, ModelOption, OpenRuntimeSessionOptions, RuntimeSession, RuntimeTurnInput, SeedOptions } from "@ponderosa/core";
import { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import { boundedSeedHistory, conciseConversationTitle, createServer, isProjectFileReferenceAllowed, normalizeExternalCitations, notificationKindForCommunication, notificationPreferenceMatches, parseGitStatus, projectedRunCost, runtimeIdentityPrompt, semanticConversationTitle, workspaceAgentEventCategory, type EngineRegistration } from "../src/app.js";

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

describe("workspace synchronization policy", () => {
  it("keeps high-frequency execution deltas off the global workspace log", () => {
    expect(workspaceAgentEventCategory({ type: "text", delta: "chunk", executionId: "run" })).toBeUndefined();
    expect(workspaceAgentEventCategory({ type: "reasoning", delta: "thought", executionId: "run" })).toBeUndefined();
    expect(workspaceAgentEventCategory({ type: "agent_output", executionId: "run", text: "done", sourceSeqStart: 1, sourceSeqEnd: 2 })).toBeUndefined();
    expect(workspaceAgentEventCategory({ type: "turn_done" })).toBeUndefined();
    expect(workspaceAgentEventCategory({ type: "agent_lifecycle", executionId: "run", status: "running", reason: "user_message" })).toBe("lifecycle");
    expect(workspaceAgentEventCategory({ type: "file_change", path: "src/app.ts", kind: "edit" })).toBe("file");
  });

  it("routes notifications from structural communication intent only", () => {
    const base = { eventId: "event", schemaVersion: 2 as const, projectId: "project", conversationId: "chat", sender: { kind: "agent" as const, agentId: "agent" }, text: "Done", createdAt: new Date(0).toISOString() };
    const broadcast = { ...base, intent: "broadcast" as const, audience: { kind: "organization" as const, organizationId: "project" } };
    const collaboration = { ...base, intent: "collaboration" as const, audience: { kind: "agents" as const, agentIds: ["peer"] } };
    expect(notificationKindForCommunication(broadcast)).toBe("broadcasts");
    expect(notificationPreferenceMatches("project_responses", broadcast, "broadcasts")).toBe(true);
    expect(notificationKindForCommunication(collaboration)).toBe("collaboration");
    expect(notificationPreferenceMatches("project_responses", collaboration, "collaboration")).toBe(false);
    expect(notificationPreferenceMatches("mentions", collaboration, "collaboration")).toBe(false);
    expect(notificationPreferenceMatches("all_messages", collaboration, "collaboration")).toBe(true);
  });

  it("derives a bounded local title without routing labels", () => {
    expect(conciseConversationTitle("#broadcast #Agent fix the flaky cache invalidation please today")).toBe("fix the flaky cache invalidation please");
    expect(conciseConversationTitle("hello")).toBeUndefined();
  });

  it("derives semantic title-case titles from the first exchange", () => {
    expect(semanticConversationTitle("Track down the flaky cache invalidation", "I found the stale cursor path")).toBe("Found Stale Cursor Path");
  });

  it("normalizes explicit external sources and rejects local or credentialed URLs", () => {
    expect(normalizeExternalCitations([{ url: "https://example.com/docs#part", title: "  Product   docs " }], "2026-01-01T00:00:00.000Z")).toEqual([
      { url: "https://example.com/docs", title: "Product docs", verifiedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(() => normalizeExternalCitations([{ url: "http://127.0.0.1/private", title: "Private" }])).toThrow(/external/);
    expect(() => normalizeExternalCitations([{ url: "https://user:secret@example.com", title: "Credentials" }])).toThrow(/external/);
  });
});

describe("localhost link preview registration", () => {
  it("requires browser authentication, exact active-run ownership, and tears down after the run", async () => {
    const project = store.createProject({ label: "Preview", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Preview room" });
    const agent = store.createAgent(project.id, { title: "Previewer", engine: "codex", conversationId: room.id });
    const otherProject = store.createProject({ label: "Other", hostPath: repoDir });
    const app = createServer({ dataDir, store, engines, logger: false, authToken: "preview-secret" });
    const headers = { authorization: "Bearer preview-secret" };
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, headers: { authorization: "Bearer preview-secret" }, payload: { text: "Serve the app" } });
    await waitForSeedCount(1);
    const health = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health`, headers });
    const runId = health.json<{ agents: Array<{ runtimeActivity?: { executionId: string } }> }>().agents[0]!.runtimeActivity!.executionId;
    const scope = { projectId: project.id, agentId: agent.id, runId, conversationId: room.id };
    const unauthorized = await app.inject({ method: "POST", url: "/api/link-previews", payload: { url: "http://localhost:5173/app", ...scope } });
    expect(unauthorized.statusCode).toBe(401);

    const accepted = await app.inject({ method: "POST", url: "/api/link-previews", headers, payload: { url: "http://localhost:5173/app", ...scope } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ targetOrigin: "http://127.0.0.1:5173", openUrl: expect.stringMatching(/^\/api\/link-previews\/.+\/app$/) });

    for (const badScope of [
      { ...scope, projectId: otherProject.id },
      { ...scope, agentId: randomUUID() },
      { ...scope, runId: randomUUID() },
      { ...scope, conversationId: randomUUID() },
    ]) expect((await app.inject({ method: "POST", url: "/api/link-previews", headers, payload: { url: "http://localhost:5173/app", ...badScope } })).statusCode).toBe(409);

    for (const url of ["http://localhost/no-port", "https://localhost:5173/", "http://192.168.1.5:5173/", "file:///etc/passwd", "http://user:pass@localhost:5173/"]) {
      expect((await app.inject({ method: "POST", url: "/api/link-previews", headers, payload: { url, ...scope } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel`, headers })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const afterCancel = await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent-health`, headers });
      if (!afterCancel.json<{ agents: Array<{ runtimeActivity?: unknown }> }>().agents[0]?.runtimeActivity) break;
      await sleep(10);
    }
    expect((await app.inject({ method: "GET", url: accepted.json<{ openUrl: string }>().openUrl, headers })).statusCode).toBe(404);
    await app.close();
  });
});

describe("link favicon loading", () => {
  it("serves a bounded same-origin favicon and rejects unsafe targets before loading", async () => {
    const linkFaviconLoader = vi.fn(async () => ({ body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png" }));
    const app = createServer({ dataDir, store, engines, logger: false, linkFaviconLoader });
    const favicon = await app.inject({ method: "GET", url: "/api/link-favicon?url=https%3A%2F%2Fdocs.example.com%2Fguide" });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers["content-type"]).toContain("image/png");
    expect(favicon.rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(linkFaviconLoader).toHaveBeenCalledWith(new URL("https://docs.example.com/favicon.ico"));

    for (const url of ["http://example.com/", "https://localhost:443/", "https://127.0.0.1/", "file:///etc/passwd", "https://user:secret@example.com/"]) {
      expect((await app.inject({ method: "GET", url: `/api/link-favicon?url=${encodeURIComponent(url)}` })).statusCode).toBe(400);
    }
    expect(linkFaviconLoader).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

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
  turnUsage?: { inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; totalTokens?: number };

  listModels(): ModelOption[] {
    return [{ id: "mock-model", label: "Mock Model" }];
  }

  listEfforts(): EffortOption[] {
    return [{ id: "high", label: "High" }];
  }

  apiPriceProfile(): ApiPriceProfile {
    return {
      id: "mock-model", pricingModel: "mock-model", catalogVersion: "test", effectiveAt: "2026-01-01",
      sourceUrl: "https://example.test/pricing", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1,
      cacheWriteInputUsdPerMillion: 1.25, outputUsdPerMillion: 5,
    };
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
  readonly queues: TestEventQueue[] = [];

  completeTurn(sessionIndex: number): void {
    this.queues[sessionIndex]?.push({ type: "turn_done" });
  }

  async openSession(opts: OpenRuntimeSessionOptions): Promise<RuntimeSession> {
    this.opened += 1;
    this.openedOptions.push(opts);
    const queue = new TestEventQueue();
    this.queues.push(queue);
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
  process.env.PONDEROSA_BROWSE_ROOTS = repoDir;
  writeFileSync(path.join(repoDir, "README.md"), "# demo\n", "utf8");
  store = new AgentStore(dataDir);
  adapter = new MockAdapter();
  engines = [{ adapter, authStatus: async () => ({ authenticated: true, detail: "test" }) }];
});

afterEach(() => {
  delete process.env.PONDEROSA_BROWSE_ROOTS;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

async function createProjectAndAgent() {
  const app = createServer({ dataDir, store, engines, logger: false });
  const projectRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" },
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
  it("applies long-context pricing to individual provider requests", () => {
    const profile: ApiPriceProfile = {
      id: "tiered", pricingModel: "tiered", catalogVersion: "test", effectiveAt: "2026-01-01",
      sourceUrl: "https://example.test/pricing", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1,
      outputUsdPerMillion: 5,
      longContext: { inputTokenThreshold: 100, inputMultiplier: 2, outputMultiplier: 1.5 },
    };
    const aggregate = { inputTokens: 160, cachedInputTokens: 20, outputTokens: 30, totalTokens: 190 };

    expect(projectedRunCost(aggregate, profile, [
      { inputTokens: 80, cachedInputTokens: 10, outputTokens: 15, totalTokens: 95 },
      { inputTokens: 80, cachedInputTokens: 10, outputTokens: 15, totalTokens: 95 },
    ])?.usd).toBeCloseTo(0.000292);
    expect(projectedRunCost(aggregate, profile, [
      { inputTokens: 120, cachedInputTokens: 20, outputTokens: 20, totalTokens: 140 },
      { inputTokens: 40, cachedInputTokens: 0, outputTokens: 10, totalTokens: 50 },
    ])?.usd).toBeCloseTo(0.000444);
    expect(projectedRunCost(aggregate, profile)).toBeUndefined();
  });

  it("reports provider usage at agent, project, and overall scopes after a real run", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    adapter.turnUsage = { inputTokens: 120, cachedInputTokens: 40, cacheWriteInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 150 };
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Meter this run" } })).statusCode).toBe(202);
    await waitForRun(agent.id);
    await expect.poll(() => store.getRuns(agent.id)[0]?.status).toBe("completed");

    const agentUsage = (await app.inject({ method: "GET", url: `/api/agents/${agent.id}/usage` })).json();
    expect(agentUsage).toMatchObject({ scope: "agent", scopeId: agent.id, inputTokens: 120, cachedInputTokens: 40, cacheWriteInputTokens: 20, outputTokens: 30, totalTokens: 150, finalizedRuns: 1, reportedRuns: 1, coverage: 1 });
    expect(agentUsage.metricAvailability).toMatchObject({ inputTokens: "available", cachedInputTokens: "available", reasoningOutputTokens: "available" });
    expect(agentUsage.breakdown).toEqual([expect.objectContaining({ projectId: project.id, agentId: agent.id, runs: 1, usage: expect.objectContaining({ totalTokens: 150 }), pricingAvailableRuns: 1 })]);
    expect(agentUsage.recentTurns[0]).toMatchObject({ projectId: project.id, agentId: agent.id, executionId: expect.any(String), pricingAvailable: true });
    expect(agentUsage.projectedApiCost).toMatchObject({
      usd: 0.000239, basis: "api_list_price_proxy", pricedRuns: 1, unpricedRuns: 0, coverage: 1,
      components: {
        uncachedInput: { tokens: 60, usd: 0.00006 },
        cachedInput: { tokens: 40, usd: 0.000004 },
        cacheWriteInput: { tokens: 20, usd: 0.000025 },
        output: { tokens: 30, usd: 0.00015 },
      },
      breakdown: [{
        pricingModel: "mock-model",
        components: {
          uncachedInput: { tokens: 60, usd: 0.00006 },
          cachedInput: { tokens: 40, usd: 0.000004 },
          cacheWriteInput: { tokens: 20, usd: 0.000025 },
          output: { tokens: 30, usd: 0.00015 },
        },
      }],
    });
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/usage` })).json()).toMatchObject({ scope: "project", totalTokens: 150 });
    expect((await app.inject({ method: "GET", url: "/api/usage" })).json()).toMatchObject({ scope: "overall", totalTokens: 150 });
    expect((await app.inject({ method: "GET", url: "/api/usage?from=2099-01-01T00:00:00.000Z" })).json()).toMatchObject({ scope: "overall", finalizedRuns: 0, recentTurns: [], breakdown: [] });
    expect((await app.inject({ method: "GET", url: "/api/usage?from=not-a-date" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/agents/missing/usage" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("idempotent runtime controls", () => {
  it("replays a stop receipt without appending a second cancellation", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const first = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel`, payload: { idempotencyKey: "stop-retry" } });
    const second = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/cancel`, payload: { idempotencyKey: "stop-retry" } });
    expect(first.json()).toEqual({ cancelled: false, replayed: false });
    expect(second.json()).toEqual({ cancelled: false, replayed: true });
    await app.close();
  });
});

describe("project lifecycle API", () => {
  it("deduplicates retried Project chat sends by their stable idempotency key", async () => {
    const { app, project } = await createProjectAndAgent();
    const conversationId = project.lastConversationId!;
    const request = { text: "#broadcast Retry-safe update", idempotencyKey: "broadcast-retry" };
    const first = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload: request });
    const second = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload: request });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(store.getConversationMessages(conversationId).filter((message) => message.text.includes("Retry-safe update"))).toHaveLength(1);
    expect(store.readCommunicationEvents(project.id).filter((event) => event.idempotencyKey === `broadcast:${conversationId}:broadcast-retry`)).toHaveLength(1);
    await app.close();
  });

  it("persists staged draft attachments and restores them after a server restart", async () => {
    let app = createServer({ dataDir, store, engines, logger: false });
    const created = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Drafts", hostPath: repoDir, defaultEngine: "codex" } });
    const project = created.json<{ id: string }>();
    const conversationId = store.getProject(project.id)!.lastConversationId!;
    const upload = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/draft-attachments`,
      headers: { "content-type": "application/octet-stream", "x-ponderosa-media-type": "text/plain", "x-ponderosa-filename": "notes.txt" },
      payload: Buffer.from("durable draft file"),
    });
    expect(upload.statusCode).toBe(201);
    const attachment = upload.json<{ id: string; downloadUrl: string }>();
    const saved = await app.inject({ method: "PUT", url: `/api/conversations/${conversationId}/draft`, payload: { text: "keep this", attachmentIds: [attachment.id], expectedRevision: 0, clientId: "tab-a" } });
    expect(saved.json()).toMatchObject({ text: "keep this", attachmentIds: [attachment.id], attachments: [{ id: attachment.id, name: "notes.txt" }] });
    expect((await app.inject({ method: "GET", url: attachment.downloadUrl })).rawPayload.toString()).toBe("durable draft file");

    await app.close();
    store = new AgentStore(dataDir);
    app = createServer({ dataDir, store, engines, logger: false });
    const restored = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/draft` });
    expect(restored.json()).toMatchObject({ revision: 1, text: "keep this", attachments: [{ id: attachment.id }] });
    const conflict = await app.inject({ method: "PUT", url: `/api/conversations/${conversationId}/draft`, payload: { text: "stale", attachmentIds: [], expectedRevision: 0, clientId: "tab-b" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ current: { revision: 1, text: "keep this" }, displaced: { text: "stale", clientId: "tab-b" } });
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conversationId}/draft-conflicts` })).json()).toMatchObject({ conversationId, conflicts: [expect.objectContaining({ displaced: expect.objectContaining({ text: "stale" }) })] });
    await app.close();
  });

  it("persists independent drafts for Project, Collaboration, and Agent chats", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const conversationId = store.getProject(project.id)!.lastConversationId!;
    const surfaces = [conversationId, `collaboration:${conversationId}`, `agent:${agent.id}`];
    for (const [index, surface] of surfaces.entries()) {
      const saved = await app.inject({
        method: "PUT",
        url: `/api/conversations/${encodeURIComponent(surface)}/draft`,
        payload: { text: `draft-${index}`, attachmentIds: [], expectedRevision: 0, clientId: "tab-a" },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ conversationId: surface, text: `draft-${index}`, revision: 1 });
    }
    expect((await app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(`agent:${agent.id}`)}/draft` })).json()).toMatchObject({ text: "draft-2" });
    await app.close();
  });

  it("projects normalized agent citations into the message Sources contract", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Sources", hostPath: repoDir, defaultEngine: "codex" });
    const conversationId = project.lastConversationId!;
    const agent = store.createAgent(project.id, { title: "Researcher", engine: "codex", conversationId });
    const eventId = randomUUID();
    const citations = normalizeExternalCitations([{ url: "https://example.com/reference", title: "Reference" }], "2026-01-01T00:00:00.000Z");
    store.appendCommunicationEvent({
      eventId, schemaVersion: 2, projectId: project.id, conversationId,
      sender: { kind: "agent", agentId: agent.id, executionId: "run" },
      intent: "broadcast", audience: { kind: "organization", organizationId: project.id },
      text: "Verified finding", citations, createdAt: new Date().toISOString(),
    });
    store.appendConversationMessage(conversationId, { role: "assistant", text: "Verified finding" }, agent.id, "main", undefined, undefined, eventId);
    const detail = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}` });
    expect(detail.json<{ messages: Array<{ citations?: unknown }> }>().messages[0]?.citations).toEqual(citations);
    await app.close();
  });

  it("bridges runtime lifecycle, task, file, and completion events into the workspace cursor", async () => {
    const { app, agent } = await createProjectAndAgent();
    await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Run with workspace updates" } });
    await waitForRun(agent.id);
    const allEvents = new WorkspaceStore(dataDir).readSince(0).map((item) => item.event);
    const events = allEvents.filter((event) => event.type === "agent_event");
    expect(events.map((event) => event.type === "agent_event" ? event.category : undefined)).toEqual(expect.arrayContaining(["lifecycle", "task", "file"]));
    expect(events.some((event) => event.type === "agent_event" && ["text", "reasoning", "agent_output", "turn_done"].includes(event.eventType))).toBe(false);
    expect(allEvents.some((event) => event.type === "usage_changed" && event.agentId === agent.id)).toBe(true);
    expect(events.every((event) => event.type !== "agent_event" || event.agentId === agent.id)).toBe(true);
    await app.close();
  });

  it("generates a concise New chat title locally without spending an agent run", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Titles", hostPath: repoDir, defaultEngine: "codex" });
    const conversationId = project.lastConversationId!;
    appendCanonicalMessage(store, project.id, conversationId, { text: "Track down the flaky cache invalidation" });
    appendCanonicalMessage(store, project.id, conversationId, { text: "I found the stale cursor path" }, "agent-title");
    const generated = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/generate-title` });
    expect(generated.json()).toEqual({ title: "Found Stale Cursor Path", generated: true });
    expect(store.getConversation(conversationId)?.title).toBe("Found Stale Cursor Path");
    expect(adapter.seeds).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/generate-title` })).json()).toEqual({ title: "Found Stale Cursor Path", generated: false });
    await app.close();
  });

  it("requires an explicit validated working-folder choice", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const response = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Missing folder", defaultEngine: "codex" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "a validated host folder is required" });
    await app.close();
  });

  it("lists only registered and managed folders and creates a named empty managed folder", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    store.createProject({ label: "Registered", hostPath: repoDir });
    const outside = mkdtempSync(path.join(tmpdir(), "pond-unregistered-"));
    const created = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Created", createFolderName: "fresh-work", defaultEngine: "codex" } });
    expect(created.statusCode).toBe(200);
    const createdProject = created.json<{ hostPath: string }>();
    expect(createdProject.hostPath).toBe(path.join(dataDir, "workspaces", "fresh-work"));
    expect(readdirSync(createdProject.hostPath)).toEqual([]);
    const choices = await app.inject({ method: "GET", url: "/api/project-folders" });
    const paths = choices.json<{ folders: Array<{ hostPath: string }> }>().folders.map((folder) => folder.hostPath);
    expect(paths).toContain(repoDir);
    expect(paths).toContain(createdProject.hostPath);
    expect(paths).not.toContain(outside);
    const collision = await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Collision", createFolderName: "fresh-work", defaultEngine: "codex" } });
    expect(collision.statusCode).toBe(409);
    rmSync(outside, { recursive: true, force: true });
    await app.close();
  });

  it("browses only configured host roots and rejects symlink traversal", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    mkdirSync(path.join(repoDir, "inside"));
    const outside = mkdtempSync(path.join(tmpdir(), "pond-browse-outside-"));
    symlinkSync(outside, path.join(repoDir, "escape"));
    const listed = await app.inject({ method: "GET", url: `/api/project-folders/browse?path=${encodeURIComponent(repoDir)}` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ folders: Array<{ name: string }> }>().folders.map((item) => item.name)).toEqual(["inside"]);
    expect((await app.inject({ method: "GET", url: `/api/project-folders/browse?path=${encodeURIComponent(path.join(repoDir, "escape"))}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Escape", hostPath: outside, defaultEngine: "codex" } })).statusCode).toBe(400);
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
    expect(steered.statusCode).toBe(202);
    expect(steered.json()).toMatchObject({ queued: true, activationId: expect.any(String) });
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
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "run" } })).statusCode).toBe(202);
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
    const room = store.createConversation(project.id, { title: "Directory room" });
    const preset = store.listAgentPresets(project.id).find((item) => item.name === "Frontend")!;
    const parent = store.createAgent(project.id, { title: "Lead", engine: "codex", presetId: preset.id, conversationId: room.id });
    const child = store.createAgent(project.id, { title: "Reviewer", engine: "codex", conversationId: room.id }, {
      agentId: parent.id, executionId: "directory-run",
      prompt: "Challenge release safety and report concise findings.", idempotencyKey: "directory-reviewer",
    });
    store.updateAgentOrganization(child.id, { managerAgentId: parent.id });
    store.appendEvent(parent.id, { type: "work_item_update", workItemId: "directory", title: "Build directory", status: "running" });

    await app.inject({ method: "POST", url: `/api/agents/${parent.id}/messages`, payload: { text: "Start" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const directory = await app.inject({ method: "GET", url: "/api/agent-directory", headers: { authorization: `Bearer ${token}` } });
    expect(directory.statusCode).toBe(200);
    expect(directory.json()).toMatchObject({ projectId: project.id, agents: expect.arrayContaining([
      expect.objectContaining({ agentId: parent.id, role: "Frontend", status: "running", childAgentIds: [child.id], engine: "codex" }),
      expect.objectContaining({
        agentId: child.id, managerAgentId: parent.id, role: "Reviewer",
        description: "Challenge release safety and report concise findings.",
      }),
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
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" } })).json<{ id: string }>();
    const invalid = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent-presets`, payload: { name: "Security", description: "Review", guidance: "Review carefully", engine: "codex", model: "not-real" } });
    expect(invalid.statusCode).toBe(400);
    const invalidEffort = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent-presets`, payload: { name: "Security", description: "Review", guidance: "Review carefully", engine: "codex", model: "mock-model", effort: "minimal" } });
    expect(invalidEffort.statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent-presets`, payload: { name: "Security", description: "Review trust boundaries", guidance: "Review trust boundaries and capability checks.", engine: "codex", model: "mock-model", effort: "high" } });
    expect(created.statusCode).toBe(201);
    const preset = created.json<{ id: string }>();
    const spawned = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agents`, payload: { title: "Audit", engine: "spoofed", presetId: preset.id } });
    expect(spawned.statusCode).toBe(200);
    expect(spawned.json<{ activeEngine: string; presetSnapshot: { guidance: string } }>()).toMatchObject({ activeEngine: "codex", presetSnapshot: { guidance: "Review trust boundaries and capability checks." } });
    await app.close();
  });

  it("reports model-specific efforts and rejects incompatible selections before side effects", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Runtime compatibility", hostPath: repoDir });

    const roster = await app.inject({ method: "GET", url: "/api/engines" });
    expect(roster.statusCode).toBe(200);
    expect(roster.json()).toContainEqual(expect.objectContaining({
      id: "codex",
      models: [expect.objectContaining({
        id: "mock-model",
        efforts: [{ id: "high", label: "High" }],
      })],
    }));

    const invalidConversation = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      payload: { title: "Invalid", defaultEngine: "codex", defaultModel: "mock-model", defaultEffort: "minimal" },
    });
    expect(invalidConversation.statusCode).toBe(400);
    expect(store.listConversations(project.id)).toHaveLength(1);

    const conversation = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      payload: { title: "Valid", defaultEngine: "codex", defaultModel: "mock-model", defaultEffort: "high" },
    })).json<{ id: string }>();
    const agent = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/agents`,
      payload: { title: "Compatible", engine: "codex", model: "mock-model", effort: "high", conversationId: conversation.id },
    })).json<{ id: string }>();

    const invalidMessage = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "This must not be persisted.", model: "mock-model", effort: "minimal" },
    });
    expect(invalidMessage.statusCode).toBe(400);
    expect(invalidMessage.json()).toEqual({ error: "effort is not available for model" });
    expect(store.getRuns(agent.id)).toHaveLength(0);
    expect(store.getProjectedAgentMessages(agent.id)).toHaveLength(0);

    const models = vi.spyOn(adapter, "listModels").mockReturnValue([
      { id: "mock-model", label: "Mock Model", efforts: [{ id: "high", label: "High" }] },
      { id: "alternate", label: "Alternate", efforts: [{ id: "low", label: "Low" }] },
    ]);
    const efforts = vi.spyOn(adapter, "listEfforts").mockImplementation((model) =>
      model === "alternate" ? [{ id: "low", label: "Low" }] : [{ id: "high", label: "High" }],
    );
    const changedModel = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Use the new model default.", model: "alternate" },
    });
    expect(changedModel.statusCode, changedModel.body).toBe(202);
    await waitForRun(agent.id, 1);
    expect(adapter.seeds.at(-1)).toMatchObject({ model: "alternate", effort: undefined });

    const resetDefaults = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Return to provider defaults.", model: "", effort: "" },
    });
    expect(resetDefaults.statusCode, resetDefaults.body).toBe(202);
    await waitForRun(agent.id, 2);
    expect(adapter.continues.at(-1)).toMatchObject({ model: undefined, effort: undefined });

    models.mockReturnValue([{ id: "", label: "Codex default" }]);
    const unknownCache = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "Continue while provider metadata is unavailable." },
    });
    expect(unknownCache.statusCode, unknownCache.body).toBe(202);
    await waitForRun(agent.id, 3);
    expect(adapter.continues.at(-1)).toMatchObject({ model: undefined, effort: undefined });
    models.mockRestore();
    efforts.mockRestore();
    await app.close();
  });

  it("fails closed without crashing when a stored conversation engine is no longer configured", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Stale engine", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "Stale", defaultEngine: "removed" });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/conversations/${conversation.id}`,
      payload: { title: "Still stale" },
    });
    expect(updated.statusCode).toBe(400);
    expect(updated.json()).toEqual({ error: "unknown engine" });
    await app.close();
  });

  it("creates conversations, records control messages, and spawns linked agents", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" },
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
    expect(prompt).toContain("Communication V3 separates messages, correlated requests, joins, activations, and runs.");
    expect(prompt).toContain("Investigate the usability risk and report to your manager.");
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
    expect(shared.statusCode, shared.body).toBe(202);
    await waitForRun(responsible.id);

    const { communicationEventId: eventId } = shared.json<{ communicationEventId: string }>();
    const runId = store.getRuns(responsible.id).at(-1)!.id;
    expect(store.getCommunicationEvent(project.id, eventId)).toMatchObject({
      intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "Fix the onboarding flow",
    });
    expect(new CoordinationV3Store(store.sqlite).runtimeCommunications(project.id).find((item) =>
      (item.payload as { communication?: { eventId?: string } }).communication?.eventId === eventId,
    )).toBeTruthy();
    const responsibleDetail = await app.inject({ method: "GET", url: `/api/agents/${responsible.id}` });
    expect(responsibleDetail.json<{ runs: Array<{ id: string; communicationEventId?: string; status: string }> }>().runs)
      .toEqual([expect.objectContaining({ id: runId, status: "completed" })]);
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
    expect(store.getMessages(responsible.id)).toHaveLength(0);
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
    expect(turn.statusCode, turn.body).toBe(202);
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
      expect(store.readCommunicationProjections(project.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventId: communication?.eventId, surface: "direct_agent_audit", projectionKey: agent.id,
          message: expect.objectContaining({ role: "user", renderedText: text }),
        }),
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
    expect(adapter.seeds[0]?.prompt).toContain("Original agent result");
    expect(adapter.seeds[0]?.prompt).toContain("user_reaction");
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
    expect(task.statusCode, task.body).toBe(202);
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
      payload: { label: "Delete demo", hostPath: repoDir, defaultEngine: "codex" },
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
      payload: { label: "One", hostPath: repoDir, defaultEngine: "codex" },
    });
    const secondProjectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Two", hostPath: repoDir, defaultEngine: "codex" },
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
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" } })).json<{ id: string }>();
    const first = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/conversations`, payload: { title: "Home" } })).json<{ id: string }>();
    const second = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/conversations`, payload: { title: "Review" } })).json<{ id: string }>();
    const agent = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/agents`, payload: { title: "Agent", engine: "codex", conversationId: first.id } })).json<{ id: string }>();
    const membership = await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/conversation-memberships`, payload: { conversationIds: [first.id, second.id], primaryConversationId: first.id } });
    expect(membership.statusCode).toBe(200);
    expect(membership.json()).toMatchObject({ conversationIds: [first.id, second.id] });
    const turn = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Review this", sourceChannel: "main", sourceConversationId: second.id } });
    expect(turn.statusCode).toBe(202);
    await waitForRun(agent.id);
    expect(store.getConversationMessages(second.id).some((message) => message.authorAgentId === agent.id)).toBe(false);
    expect(store.getConversationMessages(first.id).some((message) => message.authorAgentId === agent.id)).toBe(false);
    expect(store.getAgentDetail(agent.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), text: "done", completed: true }),
    ]);
    await app.close();
  });

  it("seeds first message, then continues with the captured session id", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const room = store.createConversation(project.id, { title: "Scoped directory" });
    store.updateAgentConversationMemberships(agent.id, { conversationIds: [room.id], primaryConversationId: room.id });
    const first = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "first", model: "mock-model", effort: "high" },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ queued: true, activationId: expect.any(String) });
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
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ queued: true, activationId: expect.any(String) });
    await waitForRun(agent.id, 2);

    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain(`your agent id: ${agent.id}`);
    expect(adapter.seeds[0]?.prompt).toContain("your display name: Agent");
    expect(adapter.seeds[0]?.history).toEqual([]);
    expect(adapter.continues).toHaveLength(1);
    expect(adapter.continues[0]?.resumeSessionId).toBe("sess-1");
    expect(adapter.continues[0]).toMatchObject({ model: "mock-model", effort: "high" });
    expect(store.getRuns(agent.id)).toEqual([
      expect.objectContaining({ model: "mock-model", effort: "high" }),
      expect.objectContaining({ model: "mock-model", effort: "high" }),
    ]);
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

    store.createAgent(project.id, { title: "New Specialist", engine: "codex", conversationId: room.id });
    await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { text: "third" },
    });
    await waitForRun(agent.id, 3);
    expect(adapter.continues[1]?.prompt).toContain("Current Team Directory");
    expect(adapter.continues[1]?.prompt).toContain("New Specialist");
    await app.close();
  });

  it("fails closed when a submitted resume cannot prove a safe replay", async () => {
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
    expect(second.json()).toMatchObject({ queued: true, activationId: expect.any(String) });
    await expect.poll(() => new CoordinationV3Store(store.sqlite).schedulerMetrics().outcomeUnknownRuns).toBe(1);

    expect(adapter.continues).toHaveLength(1);
    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.continues[0]?.prompt).not.toContain("Current Team Directory");
    expect(store.readEvents(agent.id).some((item) =>
      item.event.type === "error" && item.event.message.includes("pre-sampling compact"),
    )).toBe(true);
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
    expect(adapter.seeds[0]?.prompt).toContain("Do not poll, sleep, send acknowledgments, or create progress-only wakeups.");
    expect(adapter.seeds[0]?.prompt).toContain("Manager: Ship the API change.");
    expect(adapter.seeds[0]?.prompt).toContain("Latest message for you:\nShip the API change.");
    expect(adapter.seeds[0]?.prompt).toContain("- channel: main");
    expect(adapter.seeds[0]?.prompt).toContain("- author: Manager");
    expect(adapter.seeds[0]?.prompt).toContain("- you were tagged: no");

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
    expect(adapter.continues[0]?.prompt).not.toContain("Current Team Directory");
    expect(adapter.continues[0]?.prompt).not.toContain("managed-agent creation bridge");
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
    expect(adapter.continues[2]?.prompt).toContain("original context");
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
    expect(adapter.seeds[1]?.prompt).toContain("second-room secret");
    expect(adapter.seeds[1]?.prompt).not.toContain("first-room secret");
    expect(adapter.seeds[1]?.resumeSessionId).toBeUndefined();
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
    expect(adapter.seeds[0]?.prompt).toContain("Communication V3 separates messages, correlated requests, joins, activations, and runs.");
    expect(adapter.seeds[0]?.prompt).toContain("#Yosemite can you review this?");
    expect(store.readCommunicationProjections(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: "direct_agent_audit", projectionKey: yosemite.id }),
    ]));
    expect(store.getConversationMessages(master.id)).toEqual([]);
    expect(store.getAgentDetail(yosemite.id)?.runOutput).toEqual([
      expect.objectContaining({ executionId: expect.any(String), text: "done", completed: true }),
    ]);
    expect(store.getConversationMessages(master.id, "collaboration")).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "#Yosemite can you review this?" })]),
    );
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
    expect(adapter.seeds[0]?.prompt).toContain("Communication V3 separates messages, correlated requests, joins, activations, and runs.");
    expect(adapter.seeds[0]?.prompt).toContain("#Wrangell-St-Elias can you review this?");
    expect(store.readCommunicationProjections(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: "direct_agent_audit", projectionKey: wrangell.id }),
    ]));
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
    const auditRecipients = store.readCommunicationProjections(project.id)
      .filter((projection) => projection.surface === "direct_agent_audit" && projection.message?.renderedText?.includes("please report status"))
      .map((projection) => projection.projectionKey);
    expect(new Set(auditRecipients)).toEqual(new Set([first.id, second.id]));
    expect(auditRecipients).not.toContain(archived.id);
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
    expect(opening.statusCode, opening.body).toBe(202);
    await waitForRun(first.id);

    const openingPrompt = adapter.seeds.find((turn) => turn.agentId === first.id)?.prompt ?? "";
    expect(openingPrompt).toContain("Send its actual completed answer with intent broadcast, never direct_to_user");
    expect(openingPrompt).toContain("Required completion contract for this Project-chat request:");
    expect(openingPrompt).toContain("The user cannot see your ordinary runtime response");
    expect(openingPrompt).toContain("ponderosa_message");
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
    expect(privateTurn.statusCode, privateTurn.body).toBe(202);
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
    expect(followUp.statusCode, followUp.body).toBe(202);
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

  it("runs correlated V3 work through exactly three tools and a fenced activation cycle", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 4, leaseMs: 60 },
      executionLeaseScheduling: { leaseMs: 180, heartbeatMs: 20 },
    });
    const project = store.createProject({ label: "V3", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const requester = store.createAgent(project.id, { title: "Requester", engine: "codex", conversationId: conversation.id });
    const recipient = store.createAgent(project.id, { title: "Recipient", engine: "codex", conversationId: conversation.id });

    const started = await app.inject({
      method: "POST", url: `/api/agents/${requester.id}/messages`,
      payload: { text: "Coordinate the review", sourceChannel: "main", sourceConversationId: conversation.id },
    });
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json()).toMatchObject({ queued: true, position: 1 });
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const requesterRuntime = persistent.openedOptions[0]!;
    expect(requesterRuntime.dynamicTools?.map((tool) => tool.name)).toEqual([
      "ponderosa_coordinate", "ponderosa_update_request", "ponderosa_message",
    ]);
    expect(requesterRuntime.dynamicTools?.find((tool) => tool.name === "ponderosa_update_request")?.inputSchema.required)
      .toEqual(["updateId", "kind"]);
    expect(requesterRuntime.dynamicTools?.some((tool) => tool.name.includes("wait") || tool.name.includes("spawn"))).toBe(false);

    const coordinated = await requesterRuntime.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "review-cycle",
        requests: [{
          requestId: "review-request",
          recipientAgentId: recipient.id,
          text: "Review the change and report a terminal outcome.",
          lifetime: { kind: "indefinite" },
        }],
        join: { id: "review-join", mode: "all" },
      },
    });
    expect(coordinated.success, coordinated.text).toBe(true);
    expect(JSON.parse(coordinated.text)).toMatchObject({
      requestIds: ["review-request"], joinId: "review-join", replayed: false,
    });

    persistent.completeTurn(0);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(2));
    const recipientRuntime = persistent.openedOptions[1]!;
    await vi.waitFor(() => expect(persistent.starts.some((turn) => turn.prompt.includes("review-request"))).toBe(true));
    await sleep(140);
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE status IN ('leased', 'running')
    `).get()).toEqual({ count: 1 });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE status = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });
    expect(store.sqlite.prepare("SELECT state FROM coordination_requests WHERE id = 'review-request'").get())
      .toEqual({ state: "open" });
    const mistyped = await recipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: {
        requestId: "review-requesx",
        updateId: "review-complete",
        kind: "completed",
        text: "Review passed.",
      },
    });
    expect(mistyped.success).toBe(false);
    expect(JSON.parse(mistyped.text)).toMatchObject({
      error: "request not found",
      currentRequestIds: ["review-request"],
      hint: "Retry without requestId to target the current run's attached request",
    });
    const earlyOutcomeMessage = await recipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_message",
      arguments: {
        intent: "collaboration",
        recipientAgentIds: [requester.id],
        text: "Audit copy sent before the terminal Request update.",
        idempotencyKey: "early-review-outcome",
      },
    });
    expect(earlyOutcomeMessage.success, earlyOutcomeMessage.text).toBe(true);
    expect(JSON.parse(earlyOutcomeMessage.text)).toMatchObject({ passiveRecipientAgentIds: [requester.id] });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'ordinary_message' AND agent_id = ?
    `).get(requester.id)).toEqual({ count: 0 });
    const completed = await recipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: {
        updateId: "review-complete",
        kind: "completed",
        text: "Review passed.",
      },
    });
    expect(completed.success, completed.text).toBe(true);
    expect(JSON.parse(completed.text)).toMatchObject({ requestId: "review-request", state: "completed" });
    const duplicateOutcomeMessage = await recipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_message",
      arguments: {
        intent: "collaboration",
        recipientAgentIds: [requester.id],
        text: "Duplicate audit copy: review passed.",
        idempotencyKey: "duplicate-review-outcome",
      },
    });
    expect(duplicateOutcomeMessage.success, duplicateOutcomeMessage.text).toBe(true);
    expect(JSON.parse(duplicateOutcomeMessage.text)).toMatchObject({
      passiveRecipientAgentIds: [requester.id],
    });
    expect(store.sqlite.prepare(`
      SELECT actionable FROM runtime_communications
      WHERE json_extract(payload_json, '$.idempotencyKey') = 'duplicate-review-outcome'
    `).get()).toEqual({ actionable: 0 });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations
      WHERE kind = 'ordinary_message' AND agent_id = ?
    `).get(requester.id)).toEqual({ count: 0 });
    persistent.completeTurn(1);

    await vi.waitFor(() => expect(persistent.starts.some((turn) =>
      turn.prompt.includes("coordination_join_satisfied") && turn.prompt.includes("Review passed."),
    )).toBe(true));
    const sqlite = store.sqlite;
    expect(sqlite.prepare("SELECT state FROM coordination_requests WHERE id = 'review-request'").get()).toEqual({ state: "completed" });
    expect(sqlite.prepare("SELECT state FROM coordination_joins WHERE id = 'review-join'").get()).toEqual({ state: "satisfied" });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE status IN ('leased', 'running', 'completed')
    `).get()).toEqual({ count: 3 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM agent_activations WHERE kind = 'coordination_join_satisfied'
    `).get()).toEqual({ count: 1 });

    const metrics = (await app.inject({ method: "GET", url: "/api/communication-v3/metrics" })).json<{
      storage: { outcomeUnknownRuns: number }; scheduler: { acceptedRuns: number };
    }>();
    expect(metrics.storage.outcomeUnknownRuns).toBe(0);
    expect(metrics.scheduler.acceptedRuns).toBeGreaterThanOrEqual(2);
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      ok: true,
      missingProjectionMetadataEventIds: [],
    });

    const openedBeforeSecond = persistent.openedOptions.length;
    const requesterSessionIndex = persistent.openedOptions.map((option) => option.agentId).lastIndexOf(requester.id);
    const second = new CoordinationV3Store(store.sqlite).coordinate({
      projectId: project.id,
      requesterAgentId: requester.id,
      actorScope: `agent:${requester.id}`,
      idempotencyKey: "second-review-cycle",
      requests: [{
        requestId: "second-review-request",
        recipientAgentId: recipient.id,
        payload: { text: "Review README.md independently and report a terminal outcome." },
        lifetime: { kind: "indefinite" },
      }],
    });
    expect(second).toMatchObject({ requestIds: ["second-review-request"], replayed: false });
    persistent.completeTurn(requesterSessionIndex);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(openedBeforeSecond + 1));
    expect(store.readEvents(recipient.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({
        type: "session_reset", reason: "request_context_rollover",
      }) }),
    ]));
    const secondRecipientSessionIndex = persistent.openedOptions.length - 1;
    expect(persistent.openedOptions[secondRecipientSessionIndex]).toMatchObject({
      agentId: recipient.id, resumeSessionId: undefined,
    });
    expect(persistent.closed).toBeGreaterThanOrEqual(1);
    const secondRecipientRuntime = persistent.openedOptions[secondRecipientSessionIndex]!;
    const secondCompleted = await secondRecipientRuntime.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: { updateId: "second-review-complete", kind: "completed", text: "README review passed." },
    });
    expect(secondCompleted.success, secondCompleted.text).toBe(true);
    persistent.completeTurn(secondRecipientSessionIndex);
    await vi.waitFor(() => expect(store.sqlite.prepare(
      "SELECT state FROM coordination_requests WHERE id = 'second-review-request'",
    ).get()).toEqual({ state: "completed" }));
    await app.close();
  });

  it("blocks cross-chat coordination until the user explicitly adds the recipient to that Team Chat", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 4 },
    });
    const project = store.createProject({ label: "Chat boundaries", hostPath: repoDir });
    const veteransChat = store.createConversation(project.id, { title: "Veterans Memorial" });
    const bigHoleChat = store.createConversation(project.id, { title: "Big Hole" });
    const veterans = store.createAgent(project.id, {
      title: "Vietnam Veterans Memorial", engine: "codex", conversationId: veteransChat.id,
    });
    const bigHole = store.createAgent(project.id, {
      title: "Big Hole", engine: "codex", conversationId: bigHoleChat.id,
    });

    expect((await app.inject({
      method: "POST", url: `/api/agents/${veterans.id}/messages`,
      payload: { text: "Work within this chat", sourceConversationId: veteransChat.id },
    })).statusCode).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const runtime = persistent.openedOptions[0]!;
    const token = runtime.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN!;
    const directory = await app.inject({
      method: "GET", url: "/api/agent-directory", headers: { authorization: `Bearer ${token}` },
    });
    expect(directory.statusCode, directory.body).toBe(200);
    expect(directory.json<{ agents: Array<{ agentId: string }> }>().agents.map((agent) => agent.agentId))
      .toEqual([veterans.id]);

    const blocked = await runtime.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "cross-chat-blocked",
        requests: [{
          requestId: "cross-chat-request", recipientAgentId: bigHole.id,
          text: "Build unrelated UI", lifetime: { kind: "indefinite" },
        }],
      },
    });
    expect(blocked.success).toBe(false);
    expect(JSON.parse(blocked.text)).toMatchObject({
      error: "every recipient must be a different active agent in this Team Chat",
    });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM coordination_requests WHERE id = 'cross-chat-request'").get())
      .toEqual({ count: 0 });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_activations WHERE agent_id = ?").get(bigHole.id))
      .toEqual({ count: 0 });

    store.updateAgentConversationMemberships(bigHole.id, {
      conversationIds: [bigHoleChat.id, veteransChat.id], primaryConversationId: bigHoleChat.id,
    });
    const allowed = await runtime.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "shared-chat-allowed",
        requests: [{
          requestId: "shared-chat-request", recipientAgentId: bigHole.id,
          text: "Collaborate in the shared chat", lifetime: { kind: "indefinite" },
        }],
      },
    });
    expect(allowed.success, allowed.text).toBe(true);
    expect(store.sqlite.prepare(`
      SELECT conversation_id FROM coordination_requests WHERE id = 'shared-chat-request'
    `).get()).toEqual({ conversation_id: veteransChat.id });
    await app.close();
  });

  it("derives and resumes a nested join continuation from authoritative run state", async () => {
    const persistent = new SteerableMockAdapter();
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true }) }];
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 4, leaseMs: 60 },
      executionLeaseScheduling: { leaseMs: 180, heartbeatMs: 20 },
    });
    const project = store.createProject({ label: "V3 nested", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const requester = store.createAgent(project.id, {
      title: "Requester", engine: "codex", conversationId: conversation.id,
    });
    const delivery = store.createAgent(project.id, {
      title: "Delivery", engine: "codex", conversationId: conversation.id,
    });
    const specialist = store.createAgent(project.id, {
      title: "Specialist", engine: "codex", conversationId: conversation.id,
    });

    const started = await app.inject({
      method: "POST", url: `/api/agents/${requester.id}/messages`,
      payload: { text: "Coordinate nested delivery", sourceChannel: "main", sourceConversationId: conversation.id },
    });
    expect(started.statusCode, started.body).toBe(202);
    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(1));
    const outer = await persistent.openedOptions[0]!.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "outer-work",
        requests: [{
          requestId: "delivery-work", recipientAgentId: delivery.id,
          text: "Coordinate a specialist, integrate the result, and complete this request.",
          lifetime: { kind: "indefinite" },
        }],
        join: { id: "outer-join", mode: "all" },
      },
    });
    expect(outer.success, outer.text).toBe(true);
    expect(JSON.parse(outer.text)).toMatchObject({
      joinId: "outer-join", executionDirective: expect.stringContaining("End this turn"),
    });
    persistent.completeTurn(0);

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(2));
    const inner = await persistent.openedOptions[1]!.handleDynamicToolCall!({
      name: "ponderosa_coordinate",
      arguments: {
        idempotencyKey: "inner-work",
        requests: [{
          requestId: "specialist-work", recipientAgentId: specialist.id,
          text: "Return the bounded specialist result.", lifetime: { kind: "indefinite" },
        }],
        join: { id: "inner-join", mode: "all" },
      },
    });
    expect(inner.success, inner.text).toBe(true);
    expect(store.sqlite.prepare("SELECT state FROM coordination_requests WHERE id = 'delivery-work'").get())
      .toEqual({ state: "waiting_dependency" });
    expect(store.sqlite.prepare(`
      SELECT continuation_request_ids_json AS continuations FROM coordination_joins WHERE id = 'inner-join'
    `).get()).toEqual({ continuations: '["delivery-work"]' });
    persistent.completeTurn(1);
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM coordination_request_updates
      WHERE request_id = 'delivery-work' AND kind = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(3));
    const childCompleted = await persistent.openedOptions[2]!.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: { updateId: "specialist-complete", kind: "completed", text: "Specialist result ready." },
    });
    expect(childCompleted.success, childCompleted.text).toBe(true);
    persistent.completeTurn(2);

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(4));
    const parentCompleted = await persistent.openedOptions[3]!.handleDynamicToolCall!({
      name: "ponderosa_update_request",
      arguments: { updateId: "delivery-complete", kind: "completed", text: "Integrated result ready." },
    });
    expect(parentCompleted.success, parentCompleted.text).toBe(true);
    expect(JSON.parse(parentCompleted.text)).toMatchObject({ requestId: "delivery-work", state: "completed" });
    persistent.completeTurn(3);

    await vi.waitFor(() => expect(persistent.openedOptions).toHaveLength(5));
    expect(store.sqlite.prepare("SELECT state FROM coordination_requests WHERE id = 'delivery-work'").get())
      .toEqual({ state: "completed" });
    expect(store.sqlite.prepare("SELECT state FROM coordination_joins WHERE id = 'outer-join'").get())
      .toEqual({ state: "satisfied" });
    expect(store.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE status = 'outcome_unknown'
    `).get()).toEqual({ count: 0 });
    persistent.completeTurn(4);
    await app.close();
  });

  it("accepts an actionable shared V3 request without an invalid audit projection", async () => {
    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    const project = store.createProject({ label: "V3 shared", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, {
      title: "Lead", engine: "codex", conversationId: conversation.id,
    });

    const response = await app.inject({
      method: "POST", url: `/api/agents/${agent.id}/messages`,
      payload: {
        text: "Deliver the shared project result.",
        sourceChannel: "main",
        sourceConversationId: conversation.id,
        shareWithOrganization: true,
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({ queued: true, activationId: expect.any(String) });
    const communicationEventId = response.json<{ communicationEventId: string }>().communicationEventId;
    expect(new CoordinationV3Store(store.sqlite).runtimeCommunications(project.id).some((item) =>
      (item.payload as { communication?: { eventId?: string } }).communication?.eventId === communicationEventId,
    )).toBe(true);
    expect(store.getConversationMessages(conversation.id, "main")).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId, text: "Deliver the shared project result." }),
    ]));
    await app.close();
  });

  it("rebuilds a missing communication projection from SQLite before V3 scheduling starts", async () => {
    const project = store.createProject({ label: "V3 recovery", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, {
      title: "Recipient", engine: "codex", conversationId: conversation.id,
    });
    const event: CommunicationEvent = {
      eventId: randomUUID(), schemaVersion: 2, projectId: project.id, conversationId: conversation.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "user_dm",
      audience: { kind: "user_agent", userId: "local-operator", agentId: agent.id },
      text: "Recover me", createdAt: new Date().toISOString(),
    };
    new CoordinationV3Store(store.sqlite).recordRuntimeCommunication({
      id: `dispatch:${event.eventId}:${agent.id}`,
      projectId: project.id,
      sender: event.sender,
      intent: event.intent,
      audience: event.audience,
      payload: { communication: event, dispatch: { text: event.text } },
      activation: {
        agentId: agent.id, kind: "human_message", priority: 100,
        dispatchPolicy: "steer_or_run", promptClass: "human",
      },
      now: event.createdAt,
    });
    expect(store.getCommunicationEvent(project.id, event.eventId)).toBeUndefined();

    const app = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    await app.ready();
    expect(store.getCommunicationEvent(project.id, event.eventId)).toEqual(event);
    await app.close();
  });

  it("recovers an attachment-only communication after the SQLite commit crash window", async () => {
    const project = store.createProject({ label: "Attachment recovery", hostPath: repoDir });
    const conversation = store.createConversation(project.id, { title: "General" });
    const agent = store.createAgent(project.id, {
      title: "Recipient", engine: "codex", conversationId: conversation.id,
    });
    const stagingApp = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    const uploaded = await stagingApp.inject({
      method: "POST", url: `/api/agents/${agent.id}/attachments`,
      headers: { "content-type": "application/pdf", "x-ponderosa-filename": "brief.pdf" },
      payload: Buffer.from("%PDF-1.7\nrecovery evidence"),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const attachment = uploaded.json<{ id: string; name: string; mediaType: string; size: number }>();
    await stagingApp.close();
    store = new AgentStore(dataDir);

    const event: CommunicationEvent = {
      eventId: randomUUID(), schemaVersion: 2, projectId: project.id, conversationId: conversation.id,
      sender: { kind: "user", userId: "local-operator" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "", createdAt: new Date().toISOString(),
    };
    new CoordinationV3Store(store.sqlite).recordRuntimeCommunication({
      id: `dispatch:${event.eventId}:${agent.id}`,
      projectId: project.id,
      sender: event.sender,
      intent: event.intent,
      audience: { agentId: agent.id },
      payload: {
        communication: event,
        dispatch: {
          text: "",
          attachments: [{
            id: attachment.id, name: attachment.name,
            mediaType: attachment.mediaType, size: attachment.size,
          }],
        },
      },
      activation: {
        agentId: agent.id, kind: "human_message", priority: 100,
        dispatchPolicy: "steer_or_run", promptClass: "human",
      },
      now: event.createdAt,
    });
    const malformedEventId = randomUUID();
    new CoordinationV3Store(store.sqlite).recordRuntimeCommunication({
      id: `dispatch:${malformedEventId}:${agent.id}`,
      projectId: project.id,
      sender: event.sender,
      intent: event.intent,
      audience: { agentId: agent.id },
      payload: {
        communication: { ...event, eventId: malformedEventId },
        dispatch: { text: "", attachments: [{ id: "missing" }] },
      },
      now: event.createdAt,
    });

    const recoveredApp = createServer({
      dataDir, store, engines, logger: false,
      communicationV3: { pollMs: 5, maxConcurrentRuns: 0 },
    });
    await recoveredApp.ready();
    expect(store.getCommunicationEvent(project.id, event.eventId)).toMatchObject({
      text: "",
      attachments: [expect.objectContaining({
        id: attachment.id, agentId: agent.id, name: "brief.pdf", state: "associated",
      })],
    });
    expect(store.getCommunicationEvent(project.id, malformedEventId)).toBeUndefined();
    expect((await recoveredApp.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    await recoveredApp.close();
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
    expect(turn.statusCode).toBe(202);
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
    expect(prompt).toContain("Additional coalesced Activations for this scheduler-owned Run:");
    expect(prompt.indexOf("#Parent result one")).toBeLessThan(prompt.indexOf("#Parent result two"));
    await app.close();
  });

  it("wakes a managed agent's direct manager when the child runtime crashes", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Managed failure", hostPath: repoDir });
    const master = store.createConversation(project.id, { title: "Failure supervision" });
    const manager = store.createAgent(project.id, { title: "Manager", engine: "codex", conversationId: master.id });

    adapter.failuresRemaining = 1;
    const created = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agents`,
      payload: {
        title: "Fragile worker", engine: "codex", conversationId: master.id,
        managerAgentId: manager.id, initialMessage: "Try the risky work.",
      },
    });
    expect(created.statusCode).toBe(200);
    const child = created.json<AgentDto>();
    await waitForSeedCount(2);
    for (let index = 0; index < 80 && !store.readEvents(child.id).some((event) => event.event.type === "agent_lifecycle" && event.event.status === "failed"); index += 1) await sleep(10);

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
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "unknown message field" });
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
    expect(first.statusCode).toBe(202);
    await waitForSeedCount(1);

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
      payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" },
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { host: "ponderosa.test", origin: "https://ponderosa.test" },
      payload: { label: "Demo", hostPath: repoDir, defaultEngine: "codex" },
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

  it("continues a conversation after a historical message author is deleted", async () => {
    const project = store.createProject({ label: "Deleted author history", hostPath: repoDir });
    const room = store.createConversation(project.id, { title: "Durable history" });
    const author = store.createAgent(project.id, { title: "Former author", engine: "codex", conversationId: room.id });
    const recipient = store.createAgent(project.id, { title: "Current recipient", engine: "codex", conversationId: room.id });
    const event: CommunicationEvent = {
      eventId: randomUUID(), schemaVersion: 2, projectId: project.id, conversationId: room.id,
      sender: { kind: "agent", agentId: author.id, executionId: "historical-execution" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id }, text: "Historical answer",
      createdAt: "2026-07-15T02:19:10.342Z",
    };
    store.appendCommunicationEvent(event);
    store.appendConversationMessage(room.id, { role: "assistant", text: event.text }, author.id, "main", undefined, undefined, event.eventId);
    expect(store.deleteAgent(author.id)).toBe(true);

    const app = createServer({ dataDir, store, engines, logger: false });
    const detail = await app.inject({ method: "GET", url: `/api/conversations/${room.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ messages: Array<{ text: string; authorAgentId?: string; fileActivity?: unknown }> }>().messages)
      .toEqual([expect.objectContaining({ text: event.text, authorAgentId: author.id })]);
    expect(detail.json<{ messages: Array<{ fileActivity?: unknown }> }>().messages[0]).not.toHaveProperty("fileActivity");

    const sent = await app.inject({
      method: "POST", url: `/api/agents/${recipient.id}/messages`, payload: { text: "Continue from that answer." },
    });
    expect(sent.statusCode).toBe(202);
    await waitForRun(recipient.id);
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
    const send = await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "", attachmentIds: [attachment.id] } });
    expect(send.statusCode).toBe(202);
    const communicationEventId = send.json<{ communicationEventId: string }>().communicationEventId;
    expect(store.getCommunicationEvent(agent.projectId, communicationEventId)).toMatchObject({
      text: "",
      attachments: [expect.objectContaining({ id: attachment.id, agentId: agent.id, name: "screen.png" })],
    });
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
    expect(replayChunk).not.toMatch(/(?:^|\n)id: 1\n/);
    expect(replayChunk).toContain('"replayed":true');

    expect(project.id).toBeTruthy();
    await app.close();
  }, 10000);

  it("resets an ahead workspace cursor and replays from the canonical beginning", async () => {
    const { app } = await createProjectAndAgent();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workspace/stream?lastEventId=999999`, { signal: abort.signal });
    const reader = response.body!.getReader();
    let chunk = "";
    for (let index = 0; index < 10 && !chunk.includes("id: 1"); index += 1) {
      const read = await reader.read();
      chunk += new TextDecoder().decode(read.value);
    }
    abort.abort();
    expect(chunk).toContain("event: workspace_status");
    expect(chunk).toContain('"reset":true');
    expect(chunk).toContain('"instanceId":');
    expect(chunk).toContain("id: 1");
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
    expect(accepted.statusCode).toBe(202);
    await waitForRun(agent.id, 2);
    const replyTurn = [...adapter.seeds, ...adapter.continues].find((turn) => turn.prompt.includes("Specific answer"));
    expect(replyTurn?.prompt).toContain("Replying specifically to this earlier message");
    expect(replyTurn?.prompt).toContain("Original question");
    expect(store.getMessages(agent.id).find((message) => message.text === "Specific answer")?.replyTo?.messageId).toBe(original.id);
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
    expect(store.getConversationMessages(master.id).find((message) => message.text === "#Author Follow up")?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    const directAudit = store.readCommunicationProjections(project.id).find((projection) =>
      projection.surface === "direct_agent_audit" && projection.projectionKey === author.id &&
      projection.message?.renderedText === "Follow up");
    expect(directAudit?.message?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
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

  it("creates missing V3 runtime state from an authored direct-reply projection without duplicates", async () => {
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
    expect(replay.json()).toMatchObject({ messageId: canonical.id, replayed: false });
    const secondReplay = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload });
    expect(secondReplay.json()).toMatchObject({ messageId: canonical.id, replayed: true });
    await waitForRun(author.id);
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#Author Recovered follow up")).toHaveLength(1);
    const audit = store.readCommunicationProjections(project.id).find((projection) =>
      projection.surface === "direct_agent_audit" && projection.projectionKey === author.id &&
      projection.message?.renderedText === "Recovered follow up");
    expect(audit?.message?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    expect(store.listAgents(project.id)).toHaveLength(agentCount);
    await app.close();
  });

  it("creates V3 activation state when an authored direct reply has no runtime record", async () => {
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
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: false, queued: true });
    await waitForRun(author.id);
    expect(store.readCommunicationProjections(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: "direct_agent_audit", projectionKey: author.id }),
    ]));
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

    const payload = {
      text: "Queued follow up", replyToMessageId: report.id, targetAuthorAgentId: author.id,
      idempotencyKey: "busy-reply", activeRunDelivery: "queue" as const,
    };
    const first = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload });
    const retry = await app.inject({ method: "POST", url: `/api/conversations/${master.id}/direct-replies`, payload });
    expect(first.json()).toMatchObject({ replayed: false, queued: true });
    expect(retry.json()).toMatchObject({ replayed: true, queued: true, messageId: first.json<{ messageId: string }>().messageId });
    expect(store.getConversationMessages(master.id).filter((message) => message.text === "#Busy-author Queued follow up")).toHaveLength(1);

    adapter.mode = "normal";
    await app.inject({ method: "POST", url: `/api/agents/${author.id}/cancel` });
    await expect.poll(() => adapter.seeds.length + adapter.continues.length).toBe(2);
    expect([...adapter.seeds, ...adapter.continues]
      .filter((turn) => turn.agentId === author.id && turn.prompt.includes(payload.text))).toHaveLength(1);
    await app.close();
  });

  it("uses the same safe-boundary Steer semantics in Project and Agent chat", async () => {
    const persistent = new SteerableMockAdapter();
    adapter = persistent;
    engines = [{ adapter: persistent, authStatus: async () => ({ authenticated: true, detail: "test" }) }];
    const { app, project, agent } = await createProjectAndAgent();
    const masterId = store.getProject(project.id)!.lastConversationId!;
    await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/conversation-memberships`, payload: { conversationIds: [masterId], primaryConversationId: masterId } });
    expect((await app.inject({ method: "POST", url: `/api/agents/${agent.id}/messages`, payload: { text: "Active turn" } })).statusCode).toBe(202);
    await expect.poll(() => persistent.starts.length).toBe(1);

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${masterId}/direct-messages`,
      payload: { text: "Steer from Project chat", recipients: [{ agentId: agent.id }], idempotencyKey: "project-steer", activeRunDelivery: "steer" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ recipients: [{ agentId: agent.id, queued: true, state: "queued" }] });
    await expect.poll(() => persistent.steers.length).toBe(1);
    expect((await app.inject({ method: "GET", url: `/api/conversations/${masterId}/queued-messages` })).json()).toEqual([]);
    await app.close();
  });

  it("appends one immutable correction and dispatches exactly one idempotent follow-up turn", async () => {
    const { app, project, agent } = await createProjectAndAgent();
    const masterId = store.getProject(project.id)!.lastConversationId!;
    await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/conversation-memberships`, payload: { conversationIds: [masterId], primaryConversationId: masterId } });
    const originalSend = await app.inject({
      method: "POST", url: `/api/conversations/${masterId}/direct-messages`,
      payload: { text: "Original request", recipients: [{ agentId: agent.id }], idempotencyKey: "original-request" },
    });
    const originalMessageId = originalSend.json<{ messageId: string }>().messageId;
    await waitForRun(agent.id);

    const refusedSteer = await app.inject({
      method: "POST",
      url: `/api/conversations/${masterId}/messages/${originalMessageId}/corrections`,
      payload: { text: "Wrong delivery mode", idempotencyKey: "correction-steer", activeRunDelivery: "steer" },
    });
    expect(refusedSteer.statusCode).toBe(400);
    expect(refusedSteer.json()).toEqual({ error: "corrections always queue a new turn" });
    const correctionPayload = { text: "Corrected request", idempotencyKey: "correction-once" };
    const corrected = await app.inject({ method: "POST", url: `/api/conversations/${masterId}/messages/${originalMessageId}/corrections`, payload: correctionPayload });
    const replay = await app.inject({ method: "POST", url: `/api/conversations/${masterId}/messages/${originalMessageId}/corrections`, payload: correctionPayload });
    expect(corrected.json()).toMatchObject({ originalMessageId, replayed: false });
    expect(replay.json()).toMatchObject({ originalMessageId, replayed: true, correctionMessageId: corrected.json<{ correctionMessageId: string }>().correctionMessageId });
    await waitForRun(agent.id, 2);

    const timeline = store.getConversationMessages(masterId);
    expect(timeline.find((message) => message.id === originalMessageId)?.text).toBe("Original request");
    expect(timeline.find((message) => message.id === originalMessageId)?.correctedByMessageId).toBe(corrected.json<{ correctionMessageId: string }>().correctionMessageId);
    expect(timeline.filter((message) => message.correctionOfMessageId === originalMessageId)).toHaveLength(1);
    expect(new CoordinationV3Store(store.sqlite).runtimeCommunication(
      corrected.json<{ correctionMessageId: string }>().correctionMessageId,
    )).toBeTruthy();
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
