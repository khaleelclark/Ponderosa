import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AgentEvent, ContinueOptions, EffortOption, ModelOption, SeedOptions } from "@ponderosa/core";
import { ThreadStore } from "@ponderosa/threads";
import { boundedSeedHistory, createServer, type EngineRegistration } from "../src/app.js";
import { CollaborationDeliveryStore } from "../src/handoffs.js";
import { DelegationStore } from "../src/delegations.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class MockAdapter implements Adapter {
  id = "codex";
  displayName = "Mock Codex";
  readonly seeds: SeedOptions[] = [];
  readonly continues: ContinueOptions[] = [];
  abortedSeeds = 0;
  mode: "normal" | "hang" | "boundary" | "resume_compaction_fail" | "material_compaction_fail" = "normal";
  responseText = "done";
  failuresRemaining = 0;
  failNextTurn = false;

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
    await sleep(5);
    yield { type: "command", command: "pnpm test", cwd: opts.cwd };
    yield { type: "file_change", path: "a.ts", kind: "edit", diff: "diff --git a/a.ts b/a.ts\n" };
    yield { type: "text", delta: this.responseText };
    yield { type: "turn_done" };
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

let dataDir: string;
let repoDir: string;
let store: ThreadStore;
let adapter: MockAdapter;
let engines: EngineRegistration[];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "pond-server-data-"));
  repoDir = mkdtempSync(path.join(tmpdir(), "pond-server-repo-"));
  writeFileSync(path.join(repoDir, "README.md"), "# demo\n", "utf8");
  store = new ThreadStore(dataDir);
  adapter = new MockAdapter();
  engines = [{ adapter, authStatus: async () => ({ authenticated: true, detail: "test" }) }];
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

async function createProjectAndThread() {
  const app = createServer({ dataDir, store, engines, logger: false });
  const projectRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { label: "Demo", hostPath: repoDir },
  });
  const project = projectRes.json<{ id: string }>();
  const threadRes = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/threads`,
    payload: { title: "Thread", engine: "codex" },
  });
  const thread = threadRes.json<{ id: string }>();
  return { app, project, thread };
}

async function waitForRun(threadId: string, expectedTurnDoneCount = 1): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const done = store.readEvents(threadId).filter((event) => event.event.type === "turn_done").length;
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

describe("message reactions", () => {
  it("persists/replays separately from notification and causes zero runtime side effects", async () => {
    const project = store.createProject({ label: "Reaction room", hostPath: repoDir });
    const room = store.createMasterChat(project.id, { title: "Room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: room.id });
    const message = store.appendMasterChatMessage(room.id, { role: "assistant", text: "Result" }, author.id)!;
    const app = createServer({ dataDir, store, engines, logger: false });
    const request = { emoji: "👍", active: true, idempotencyKey: "manager-global" };
    const first = await app.inject({ method: "PUT", url: `/api/master-chats/${room.id}/main/messages/${message.id}/reaction`, payload: request });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ replayed: false, persistence: "recorded", notification: "queued", reactions: [{ emoji: "👍", count: 1, reactedByCurrentActor: true }] });
    const replay = await app.inject({ method: "PUT", url: `/api/master-chats/${room.id}/main/messages/${message.id}/reaction`, payload: request });
    expect(replay.json()).toMatchObject({ occurrenceId: first.json<{ occurrenceId: string }>().occurrenceId, replayed: true });
    expect(adapter.seeds).toHaveLength(0);
    expect(adapter.continues).toHaveLength(0);
    expect(store.readEvents(author.id)).toHaveLength(0);
    const detail = await app.inject({ method: "GET", url: `/api/master-chats/${room.id}` });
    expect(detail.json<{ messages: Array<{ reactions: unknown[] }> }>().messages[0]?.reactions).toEqual([{ emoji: "👍", count: 1, reactedByCurrentActor: true }]);
    await app.close();
  });
});

async function cancelAndWait(app: ReturnType<typeof createServer>, threadId: string): Promise<void> {
  await app.inject({ method: "POST", url: `/api/threads/${threadId}/cancel` });
  for (let i = 0; i < 80; i += 1) {
    const response = await app.inject({ method: "POST", url: `/api/threads/${threadId}/cancel` });
    if (!response.json<{ cancelled: boolean }>().cancelled) return;
    await sleep(10);
  }
  throw new Error("run did not cancel");
}

describe("server chunk F", () => {
  it("serves server-owned agent health at project and master-chat scope", async () => {
    const project = store.createProject({ label: "Health", hostPath: repoDir });
    const room = store.createMasterChat(project.id, { title: "Room" });
    const agent = store.createThread(project.id, { title: "Agent", engine: "codex", masterChatId: room.id });
    const outside = store.createThread(project.id, { title: "Outside", engine: "codex" });
    const app = createServer({ dataDir, store, engines, logger: false });

    const roomHealth = await app.inject({ method: "GET", url: `/api/master-chats/${room.id}/agent-health` });
    expect(roomHealth.statusCode).toBe(200);
    expect(roomHealth.json()).toMatchObject({
      scope: { type: "master_chat", id: room.id },
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
    const agent = store.createThread(project.id, { title: "Agent", engine: "codex" });
    const app = createServer({ dataDir, store, engines, logger: false });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${agent.id}/messages`, payload: { text: "Work" } });
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
      .toMatchObject({ agents: [expect.objectContaining({ agentId: agent.id, status: "cancelled", reason: "thread_cancelled" })] });
    await app.close();
  });

  it("bounds fresh-session history by both characters and message count", () => {
    const history = Array.from({ length: 80 }, (_, index) => ({ role: "user" as const, text: `${index}:` + "x".repeat(1_000) }));
    const bounded = boundedSeedHistory(history, 5_000, 4);
    expect(bounded).toHaveLength(4);
    expect(bounded.reduce((total, message) => total + message.text.length, 0)).toBeLessThanOrEqual(5_000);
    expect(bounded.at(-1)?.text.startsWith("79:")).toBe(true);
  });

  it("separates daemon liveness from work readiness", async () => {
    const app = createServer({ dataDir, store, engines, authToken: "operator-secret", logger: false });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", service: "ponderosa", version: "0.0.0" });

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
      store: new ThreadStore(dataDir),
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

  it("validates preset options and snapshots server-resolved guidance into spawned agents", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Demo", hostPath: repoDir } })).json<{ id: string }>();
    const invalid = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent-presets`, payload: { name: "Security", description: "Review", guidance: "Review carefully", engine: "codex", model: "not-real" } });
    expect(invalid.statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent-presets`, payload: { name: "Security", description: "Review trust boundaries", guidance: "Review trust boundaries and capability checks.", engine: "codex", model: "mock-model", effort: "high" } });
    expect(created.statusCode).toBe(201);
    const preset = created.json<{ id: string }>();
    const spawned = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads`, payload: { title: "Audit", engine: "spoofed", presetId: preset.id } });
    expect(spawned.statusCode).toBe(200);
    expect(spawned.json<{ activeEngine: string; presetSnapshot: { guidance: string } }>()).toMatchObject({ activeEngine: "codex", presetSnapshot: { guidance: "Review trust boundaries and capability checks." } });
    await app.close();
  });

  it("creates master chats, records control messages, and spawns linked agent threads", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Demo", hostPath: repoDir },
    });
    const project = projectRes.json<{ id: string }>();

    const masterRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/master-chats`,
      payload: {
        title: "Release control room",
        defaultEngine: "codex",
        defaultModel: "mock-model",
        defaultEffort: "high",
      },
    });
    expect(masterRes.statusCode).toBe(200);
    const masterChat = masterRes.json<{ id: string; defaultEngine: string }>();
    expect(masterChat.defaultEngine).toBe("codex");

    const messageRes = await app.inject({
      method: "POST",
      url: `/api/master-chats/${masterChat.id}/messages`,
      payload: { text: "Start an API agent." },
    });
    expect(messageRes.statusCode).toBe(200);
    const recordedMessage = messageRes.json<{ communicationEventId: string }>();
    expect(recordedMessage.communicationEventId).toBeTruthy();
    expect(store.readCommunicationEvents(project.id)).toEqual([
      expect.objectContaining({
        eventId: recordedMessage.communicationEventId,
        intent: "broadcast",
        sender: { kind: "user", userId: "local-operator" },
      }),
    ]);
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);

    const threadRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads`,
      payload: { title: "API agent", engine: "codex", masterChatId: masterChat.id },
    });
    expect(threadRes.statusCode).toBe(200);
    const thread = threadRes.json<{ id: string; masterChatId: string }>();
    expect(thread.masterChatId).toBe(masterChat.id);

    const detailRes = await app.inject({
      method: "GET",
      url: `/api/master-chats/${masterChat.id}`,
    });
    expect(detailRes.statusCode).toBe(200);
    expect(
      detailRes.json<{
        messages: { text: string }[];
        threads: { id: string; masterChatId: string }[];
      }>(),
    ).toMatchObject({
      messages: [{ text: "Start an API agent." }],
      threads: [{ id: thread.id, masterChatId: masterChat.id }],
    });

    await app.close();
  });

  it("deletes a master chat and preserves its agents as unassigned", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = (await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { label: "Delete demo", hostPath: repoDir },
    })).json<{ id: string }>();
    const masterChat = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/master-chats`,
      payload: { title: "Temporary room" },
    })).json<{ id: string }>();
    const thread = (await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads`,
      payload: { title: "Preserved agent", engine: "codex", masterChatId: masterChat.id },
    })).json<{ id: string }>();

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/master-chats/${masterChat.id}` });
    expect(deleteRes.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/master-chats/${masterChat.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/threads/${thread.id}` })).json<{ thread: { masterChatId?: string } }>().thread.masterChatId).toBeUndefined();
    expect((await app.inject({ method: "DELETE", url: `/api/master-chats/${masterChat.id}` })).statusCode).toBe(404);

    await app.close();
  });

  it("rejects linking an agent thread to another project's master chat", async () => {
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
      url: `/api/projects/${firstProject.id}/master-chats`,
      payload: { title: "Project one control room" },
    });
    const masterChat = masterRes.json<{ id: string }>();

    const threadRes = await app.inject({
      method: "POST",
      url: `/api/projects/${secondProject.id}/threads`,
      payload: { title: "Wrong project", engine: "codex", masterChatId: masterChat.id },
    });

    expect(threadRes.statusCode).toBe(400);
    expect(threadRes.json()).toEqual({ error: "master chat does not belong to project" });
    await app.close();
  });

  it("authorizes membership changes and routes a secondary-chat turn", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: { label: "Demo", hostPath: repoDir } })).json<{ id: string }>();
    const first = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/master-chats`, payload: { title: "Home" } })).json<{ id: string }>();
    const second = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/master-chats`, payload: { title: "Review" } })).json<{ id: string }>();
    const thread = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads`, payload: { title: "Agent", engine: "codex", masterChatId: first.id } })).json<{ id: string }>();
    const membership = await app.inject({ method: "PUT", url: `/api/threads/${thread.id}/master-chat-memberships`, payload: { masterChatIds: [first.id, second.id], primaryMasterChatId: first.id } });
    expect(membership.statusCode).toBe(200);
    expect(membership.json()).toMatchObject({ masterChatIds: [first.id, second.id] });
    const turn = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "Review this", sourceChannel: "main", sourceMasterChatId: second.id } });
    expect(turn.statusCode).toBe(200);
    await waitForRun(thread.id);
    expect(store.getMasterChatMessages(second.id).some((message) => message.authorThreadId === thread.id)).toBe(true);
    expect(store.getMasterChatMessages(first.id).some((message) => message.authorThreadId === thread.id)).toBe(false);
    await app.close();
  });

  it("seeds first message, then continues with the captured session id", async () => {
    const { app, thread } = await createProjectAndThread();
    const first = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "first", model: "mock-model", effort: "high" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ mode: "seed" });
    await waitForRun(thread.id);
    const firstEventId = first.json<{ communicationEventId: string }>().communicationEventId;
    expect(firstEventId).toBeTruthy();
    expect(store.getMessages(thread.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", text: "first", communicationEventId: firstEventId }),
    ]));
    expect(store.getMessages(thread.id).filter((message) => message.role === "assistant"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ communicationEventId: expect.any(String) })]));
    expect(store.readCommunicationEvents(store.getThread(thread.id)!.projectId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sender: expect.objectContaining({ kind: "agent", agentId: thread.id }), causationId: firstEventId }),
    ]));
    expect(store.reconcileCommunicationEvents(store.getThread(thread.id)!.projectId)).toMatchObject({ ok: true });

    const second = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "second" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ mode: "continue" });
    await waitForRun(thread.id, 2);

    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.history).toEqual([]);
    expect(adapter.continues).toHaveLength(1);
    expect(adapter.continues[0]?.resumeSessionId).toBe("sess-1");
    const artifacts = store.getArtifacts(thread.id);
    const artifactRes = await app.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/artifacts/${artifacts.find((artifact) => artifact.kind === "diff")?.id}`,
    });
    expect(artifactRes.statusCode).toBe(200);
    expect(artifactRes.json<{ content: string; contentType: string }>()).toMatchObject({
      content: "diff --git a/a.ts b/a.ts\n",
      contentType: "diff",
    });
    await app.close();
  });

  it("rolls a failed Codex compaction resume into one fresh seeded session", async () => {
    const { app, thread } = await createProjectAndThread();
    await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "first" },
    });
    await waitForRun(thread.id);

    adapter.mode = "resume_compaction_fail";
    const second = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "second" },
    });
    expect(second.json()).toMatchObject({ mode: "continue" });
    await waitForRun(thread.id, 2);

    expect(adapter.continues).toHaveLength(1);
    expect(adapter.seeds).toHaveLength(2);
    expect(adapter.seeds[1]?.history.map((message) => message.text)).toContain("first");
    expect(store.readEvents(thread.id).filter((item) => item.event.type === "session_reset"))
      .toHaveLength(1);
    expect(store.readEvents(thread.id).some((item) =>
      item.event.type === "error" && item.event.message.includes("pre-sampling compact"),
    )).toBe(false);
    expect(store.resumeSessionId(thread.id)).toBe("sess-1");
    await app.close();
  });

  it("does not replay a failed resume after material side effects", async () => {
    const { app, thread } = await createProjectAndThread();
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "first" } });
    await waitForRun(thread.id);

    adapter.mode = "material_compaction_fail";
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "second" } });
    await vi.waitFor(() => {
      expect(store.readEvents(thread.id).some((item) => item.event.type === "error" && item.event.message.includes("pre-sampling compact"))).toBe(true);
    });

    expect(adapter.continues).toHaveLength(1);
    expect(adapter.seeds).toHaveLength(1);
    expect(store.readEvents(thread.id).some((item) => item.event.type === "command" && item.event.command === "touch already-ran")).toBe(true);
    expect(store.readEvents(thread.id).some((item) => item.event.type === "error" && item.event.message.includes("pre-sampling compact"))).toBe(true);
    await app.close();
  });

  it("lets an active agent schedule a safe session rollover at turn completion", async () => {
    const { app, thread } = await createProjectAndThread();
    adapter.mode = "boundary";
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "work then refresh" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const url = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_ROLLOVER_URL;
    expect(token).toBeTruthy();
    expect(url).toBe("http://127.0.0.1:8787/api/agent-session/rollover");

    const scheduled = await app.inject({ method: "POST", url: "/api/agent-session/rollover", headers: { authorization: `Bearer ${token}` } });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json()).toMatchObject({ scheduled: true });
    await waitForRun(thread.id);

    expect(store.resumeSessionId(thread.id)).toBeUndefined();
    expect(store.readEvents(thread.id).some((item) => item.event.type === "session_reset" && item.event.reason === "explicit_compaction")).toBe(true);
    await app.close();
  });

  it("explicitly compacts only an idle persisted runtime session", async () => {
    const { app, thread } = await createProjectAndThread();
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "active" } });
    await waitForSeedCount(1);

    const active = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/compact` });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toMatchObject({ retryable: true });
    await cancelAndWait(app, thread.id);

    const compacted = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/compact` });
    expect(compacted.statusCode).toBe(200);
    expect(compacted.json()).toEqual({ compacted: true });
    expect(store.resumeSessionId(thread.id)).toBeUndefined();
    expect(store.readEvents(thread.id).filter((item) => item.event.type === "session_reset"))
      .toEqual([expect.objectContaining({ event: expect.objectContaining({ reason: "explicit_compaction" }) })]);

    const replay = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/compact` });
    expect(replay.json()).toEqual({ compacted: false });
    expect(store.readEvents(thread.id).filter((item) => item.event.type === "session_reset"))
      .toHaveLength(1);
    await app.close();
  });

  it("seeds bounded room context once and sends only the new message on continuation", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Release room" });
    store.appendMasterChatMessage(master.id, { text: "Ship the API change." });
    const thread = store.createThread(project.id, {
      title: "Aspen",
      engine: "codex",
      masterChatId: master.id,
    });

    await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "Ship the API change.", sourceChannel: "main" },
    });
    await waitForRun(thread.id);

    expect(adapter.seeds[0]?.prompt).toContain("whether it came from the manager or a teammate");
    expect(adapter.seeds[0]?.prompt).toContain("never use a canned acknowledgment");
    expect(adapter.seeds[0]?.prompt).toContain("Manager: Ship the API change.");
    expect(adapter.seeds[0]?.prompt).toContain("Latest message for you:\nShip the API change.");
    expect(adapter.seeds[0]?.prompt).toContain("- channel: main");
    expect(adapter.seeds[0]?.prompt).toContain("- author: Manager");
    expect(adapter.seeds[0]?.prompt).toContain("- you were tagged: no");
    expect(adapter.seeds[0]?.prompt).toContain(
      "never write routing @mentions into message text",
    );

    store.appendMasterChatMessage(master.id, { text: "@Aspen Is it tested?" });
    await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "@Aspen Is it tested?", sourceChannel: "main" },
    });
    await waitForRun(thread.id, 2);

    expect(adapter.continues[0]?.prompt).toContain("Aspen: done");
    expect(adapter.continues[0]?.prompt).toContain("Manager: @Aspen Is it tested?");
    expect(adapter.continues[0]?.prompt).not.toContain("The main chat is manager-facing");
    expect(adapter.continues[0]?.prompt).not.toContain("PONDEROSA_DELEGATION_URL");
    expect(adapter.continues[0]?.prompt).toContain("Context injection accounting: room_messages=2; room_characters=24");
    expect(adapter.continues[0]?.prompt).toContain("Latest message for you:\n@Aspen Is it tested?");
    expect(adapter.continues[0]?.prompt).toContain("- tagged agents: @Aspen");
    expect(adapter.continues[0]?.prompt).toContain("- you were tagged: yes");
    expect(store.getMasterChatMessages(master.id)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authorThreadId: thread.id, text: "Got it — I’m on it." }),
      ]),
    );
    await app.close();
  });

  it("delivers only accepted-session room deltas and does not replay unchanged history", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Incremental room" });
    store.appendMasterChatMessage(master.id, { text: "seed-only marker" });
    const thread = store.createThread(project.id, { title: "Delta", engine: "codex", masterChatId: master.id });

    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "seed", sourceChannel: "main" } });
    await waitForRun(thread.id);
    expect(adapter.seeds[0]?.prompt).toContain("seed-only marker");
    expect(adapter.seeds[0]?.prompt).toContain("Context injection accounting: room_messages=1; room_characters=16");

    store.appendMasterChatMessage(master.id, { text: "delta marker" });
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "delta", sourceChannel: "main" } });
    await waitForRun(thread.id, 2);
    expect(adapter.continues[0]?.prompt).toContain("delta marker");
    expect(adapter.continues[0]?.prompt).not.toContain("seed-only marker");

    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "unchanged", sourceChannel: "main" } });
    await waitForRun(thread.id, 3);
    expect(adapter.continues[1]?.prompt).toContain("Delta: continued sess-1");
    expect(adapter.continues[1]?.prompt).toContain("room_messages=1; room_characters=16");
    expect(adapter.continues[1]?.prompt).not.toContain("delta marker");
    expect(adapter.continues[1]?.prompt).not.toContain("seed-only marker");
    await app.close();
  });

  it("does not advance context after a failed turn and reseeds a changed session epoch", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Retry room" });
    store.appendMasterChatMessage(master.id, { text: "original context" });
    const thread = store.createThread(project.id, { title: "Retry", engine: "codex", masterChatId: master.id });
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "seed", sourceChannel: "main" } });
    await waitForRun(thread.id);

    store.appendMasterChatMessage(master.id, { text: "must redeliver" });
    adapter.failNextTurn = true;
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "fails", sourceChannel: "main" } });
    await waitForRun(thread.id, 2);
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "retry", sourceChannel: "main" } });
    await waitForRun(thread.id, 3);
    expect(adapter.continues[0]?.prompt).toContain("must redeliver");
    expect(adapter.continues[1]?.prompt).toContain("must redeliver");

    store.appendEvent(thread.id, { type: "session", sessionId: "sess-2" });
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "new epoch", sourceChannel: "main" } });
    await waitForRun(thread.id, 4);
    expect(adapter.continues[2]?.resumeSessionId).toBe("sess-2");
    expect(adapter.continues[2]?.prompt).toContain("original context");
    expect(adapter.continues[2]?.prompt).toContain("The main chat is manager-facing");
    await app.close();
  });

  it("keeps incremental cursors isolated by visible master room", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const first = store.createMasterChat(project.id, { title: "First" });
    const second = store.createMasterChat(project.id, { title: "Second" });
    store.appendMasterChatMessage(first.id, { text: "first-room secret" });
    store.appendMasterChatMessage(second.id, { text: "second-room secret" });
    const thread = store.createThread(project.id, { title: "Rooms", engine: "codex", masterChatId: first.id });
    store.updateThreadMasterChatMemberships(thread.id, { masterChatIds: [first.id, second.id], primaryMasterChatId: first.id });
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "first", sourceChannel: "main", sourceMasterChatId: first.id } });
    await waitForRun(thread.id);
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "second", sourceChannel: "main", sourceMasterChatId: second.id } });
    await waitForRun(thread.id, 2);
    expect(adapter.continues[0]?.prompt).toContain("second-room secret");
    expect(adapter.continues[0]?.prompt).not.toContain("first-room secret");
    expect(adapter.continues[0]?.prompt).toContain("The main chat is manager-facing");
    await app.close();
  });

  it("preserves accepted context cursors across a server restart", async () => {
    const firstApp = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Restart room" });
    store.appendMasterChatMessage(master.id, { text: "before-restart marker" });
    const thread = store.createThread(project.id, { title: "Restart", engine: "codex", masterChatId: master.id });
    await firstApp.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "seed", sourceChannel: "main" } });
    await waitForRun(thread.id);
    await firstApp.close();

    store = new ThreadStore(dataDir);
    store.appendMasterChatMessage(master.id, { text: "after-restart marker" });
    const secondApp = createServer({ dataDir, store, engines, logger: false });
    await secondApp.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "resume", sourceChannel: "main" } });
    await waitForRun(thread.id, 2);
    expect(adapter.continues[0]?.prompt).toContain("after-restart marker");
    expect(adapter.continues[0]?.prompt).not.toContain("before-restart marker");
    await secondApp.close();
  });

  it("starts a new master-chat agent with its initial message in the creation request", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Release room" });

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/threads`,
      payload: {
        title: "Acadia",
        engine: "codex",
        masterChatId: master.id,
        initialMessage: "Check the first-run path.",
      },
    });

    expect(response.statusCode).toBe(200);
    const thread = response.json<{ id: string }>();
    await waitForRun(thread.id);
    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain("Latest message for you:\nCheck the first-run path.");
    const shared = store.getMasterChatMessages(master.id).find((message) => message.text === "Check the first-run path.");
    const audit = store.getMessages(thread.id).find((message) => message.text === "Check the first-run path.");
    expect(shared).toMatchObject({ role: "user", communicationEventId: expect.any(String) });
    expect(audit?.communicationEventId).toBe(shared?.communicationEventId);
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);
    await app.close();
  });

  it("dispatches a valid collaboration-chat mention without exposing it in the main chat", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Collaboration room" });
    const yosemite = store.createThread(project.id, {
      title: "Yosemite",
      engine: "codex",
      masterChatId: master.id,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@Yosemite can you review this?" },
    });

    expect(response.statusCode).toBe(200);
    await waitForRun(yosemite.id);
    expect(adapter.seeds).toHaveLength(1);
    expect(adapter.seeds[0]?.prompt).toContain("You received this context because you were an explicit collaboration recipient.");
    expect(adapter.seeds[0]?.prompt).toContain("This is the only chat for agent-to-agent coordination.");
    expect(adapter.seeds[0]?.prompt).toContain("Do not move collaboration discussion to the main chat");
    expect(adapter.seeds[0]?.prompt).toContain("Latest message for you:\n@Yosemite can you review this?");
    expect(store.getMessages(yosemite.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", text: "@Yosemite can you review this?" })]),
    );
    expect(store.getMasterChatMessages(master.id)).toEqual([]);
    expect(store.getMasterChatMessages(master.id, "collaboration")).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "@Yosemite can you review this?" })]),
    );
    await app.close();
  });

  it("acknowledges a collaboration delivery only after a successful recipient turn", async () => {
    adapter.failuresRemaining = 1;
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Retry recipient failure" });
    const recipient = store.createThread(project.id, { title: "Yosemite", engine: "codex", masterChatId: master.id });

    const response = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@Yosemite retry this failed turn" },
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
    const master = store.createMasterChat(project.id, { title: "Bounded recipient failure" });
    const recipient = store.createThread(project.id, { title: "Yosemite", engine: "codex", masterChatId: master.id });

    const response = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@Yosemite fail this turn twice" },
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
    const master = store.createMasterChat(project.id, { title: "Collaboration room" });
    const wrangell = store.createThread(project.id, {
      title: "Wrangell-St. Elias",
      engine: "codex",
      masterChatId: master.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@Wrangell-St-Elias can you review this?" },
    });

    expect(response.statusCode).toBe(200);
    await waitForRun(wrangell.id);
    expect(adapter.seeds[0]?.prompt).toContain("You received this context because you were an explicit collaboration recipient.");
    expect(store.getMessages(wrangell.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", text: "@Wrangell-St-Elias can you review this?" })]),
    );
    await app.close();
  });

  it("delivers @everyone once to every non-archived collaboration member", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Broadcast room" });
    const first = store.createThread(project.id, { title: "First", engine: "codex", masterChatId: master.id });
    const second = store.createThread(project.id, { title: "Second", engine: "codex", masterChatId: master.id });
    const archived = store.createThread(project.id, { title: "Archived", engine: "codex", masterChatId: master.id });
    store.updateThread(archived.id, { archived: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@everyone @First please report status." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ notifiedAgentIds: string[] }>().notifiedAgentIds).toEqual([first.id, second.id]);
    await waitForSeedCount(2);
    expect(adapter.seeds).toHaveLength(2);
    expect(store.getMessages(first.id).filter((message) => message.text.includes("@everyone"))).toHaveLength(1);
    expect(store.getMessages(second.id).filter((message) => message.text.includes("@everyone"))).toHaveLength(1);
    expect(store.getMessages(archived.id)).toHaveLength(0);
    const intents = store.getMasterChatDeliveryIntents(master.id);
    expect(intents.map(({ intent }) => ({ id: intent.targetThreadId, audience: intent.audience }))).toEqual([
      { id: first.id, audience: "everyone" },
      { id: second.id, audience: "everyone" },
    ]);
    await Promise.all([cancelAndWait(app, first.id), cancelAndWait(app, second.id)]);
    await app.close();
  });

  it("rejects recipient-free collaboration and sends context only after explicit routing", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Private collaboration" });
    const agent = store.createThread(project.id, {
      title: "Yosemite",
      engine: "codex",
      masterChatId: master.id,
    });
    store.appendMasterChatMessage(master.id, { text: "Main-chat-only deployment plan." });

    const untargeted = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "Private review notes that should not reach an agent yet." },
    });
    expect(untargeted.statusCode).toBe(400);
    expect(untargeted.json()).toMatchObject({ error: expect.stringContaining("explicit recipient") });
    expect(adapter.seeds).toHaveLength(0);

    const targeted = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "Please review the private notes.", recipientAgentIds: [agent.id] },
    });
    expect(targeted.statusCode).toBe(200);
    await waitForRun(agent.id);

    const prompt = adapter.seeds[0]?.prompt ?? "";
    expect(prompt).not.toContain("Private review notes that should not reach an agent yet.");
    expect(prompt).toContain("@Yosemite Please review the private notes.");
    expect(prompt).not.toContain("Main-chat-only deployment plan.");
    expect(store.getMasterChatMessages(master.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Main-chat-only deployment plan." })]),
    );
    expect(store.getMasterChatMessages(master.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Private review notes that should not reach an agent yet." })]),
    );
    await app.close();
  });

  it("isolates three-agent collaboration context by canonical recipient audience", async () => {
    const app = createServer({
      dataDir, store, engines, logger: false, communicationReadMode: "authoritative",
    });
    const project = store.createProject({ label: "Audience isolation", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Three-agent room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: master.id });
    const reviewer = store.createThread(project.id, { title: "Reviewer", engine: "codex", masterChatId: master.id });
    const verifier = store.createThread(project.id, { title: "Verifier", engine: "codex", masterChatId: master.id });

    // Organization-audience system guidance is explicitly shared with every
    // project agent even when rendered on the Collaboration surface.
    const sharedAt = "2026-07-12T00:00:00.000Z";
    store.appendCommunicationEvent({
      eventId: "shared-collaboration-guidance", schemaVersion: 1, projectId: project.id, masterChatId: master.id,
      sender: { kind: "system", component: "collaboration-policy" }, intent: "broadcast",
      audience: { kind: "organization", organizationId: project.id },
      text: "Shared system guidance for all project agents.", createdAt: sharedAt,
    });
    store.appendCommunicationProjection(project.id, {
      eventId: "shared-collaboration-guidance", surface: "collaboration_chat", projectionKey: master.id,
      projectedAt: sharedAt,
      message: { messageId: "shared-guidance-message", role: "system", createdAt: sharedAt },
    });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${author.id}/messages`, payload: { text: "Coordinate reviews." } });
    await waitForSeedCount(1);
    const authorToken = adapter.seeds.find((turn) => turn.threadId === author.id)?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
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
      method: "POST", url: `/api/master-chats/${master.id}/collaboration/messages`,
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

    const reviewerPrompt = adapter.seeds.find((turn) => turn.threadId === reviewer.id)?.prompt ?? "";
    const verifierPrompt = adapter.seeds.find((turn) => turn.threadId === verifier.id)?.prompt ?? "";
    expect(reviewerPrompt).toContain("Reviewer-only launch credential: ALPHA.");
    expect(reviewerPrompt).toContain("Shared system guidance for all project agents.");
    expect(verifierPrompt).toContain("Verifier-only release checklist.");
    expect(verifierPrompt).toContain("Shared system guidance for all project agents.");
    expect(verifierPrompt).not.toContain("Reviewer-only launch credential: ALPHA.");

    await Promise.all([
      cancelAndWait(app, author.id),
      cancelAndWait(app, reviewer.id),
      cancelAndWait(app, verifier.id),
    ]);
    await app.close();
  });

  it("seeds only promoted summaries from local communication into future agent context", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    store.appendCommunicationEvent({
      eventId: "private-source", schemaVersion: 1, projectId: project.id,
      sender: { kind: "agent", agentId: "source-agent" }, intent: "direct_to_user",
      audience: { kind: "user", userId: "local-operator" },
      text: "raw local secret must not be seeded", createdAt: "2026-07-12T00:00:00.000Z",
    });
    store.promoteKnowledge({
      promotionId: "promotion-1", sourceEventId: "private-source", organizationId: project.id,
      summary: "Use the reviewed deployment invariant.", promotedBy: { kind: "user", userId: "local-operator" },
      promotedAt: "2026-07-12T00:01:00.000Z",
    });
    const thread = store.createThread(project.id, { title: "Future Agent", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "Begin." } });
    await waitForRun(thread.id);

    expect(adapter.seeds[0]?.prompt).toContain("Curated organizational knowledge");
    expect(adapter.seeds[0]?.prompt).toContain("[source private-source] Use the reviewed deployment invariant.");
    expect(adapter.seeds[0]?.prompt).not.toContain("raw local secret must not be seeded");
    await app.close();
  });

  it("rolls communication and curated context back independently", async () => {
    const project = store.createProject({ label: "Rollback", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Room" });
    const source = {
      eventId: "existing-local", schemaVersion: 1 as const, projectId: project.id,
      sender: { kind: "agent" as const, agentId: "source" }, intent: "direct_to_user" as const,
      audience: { kind: "user" as const, userId: "local-operator" }, text: "raw local",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    store.appendCommunicationEvent(source);
    store.promoteKnowledge({
      promotionId: "existing-promotion", sourceEventId: source.eventId, organizationId: project.id,
      summary: "Must be disabled", promotedBy: { kind: "user", userId: "local-operator" },
      promotedAt: "2026-07-12T00:01:00.000Z",
    });
    const baseline = store.readCommunicationEvents(project.id).length;
    const app = createServer({
      dataDir, store, engines, logger: false, communicationMode: "off", curatedContextEnabled: false,
    });
    const message = await app.inject({
      method: "POST", url: `/api/master-chats/${master.id}/messages`, payload: { text: "Legacy-only message" },
    });
    expect(message.statusCode).toBe(200);
    expect(message.json()).not.toHaveProperty("communicationEventId");
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex" });
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "Begin" } });
    await waitForRun(thread.id);
    expect(adapter.seeds[0]?.prompt).not.toContain("Must be disabled");
    expect(store.readCommunicationEvents(project.id)).toHaveLength(baseline);
    expect((await app.inject({ method: "GET", url: "/api/ready" })).json())
      .toMatchObject({ checks: { communicationMigration: { ok: true, detail: "communication=off; reads=shadow; legacy_routing=accept; curated_context=off; parity=disabled" } } });
    await app.close();
  });

  it("fails readiness when authoritative reads are combined with disabled canonical capture", async () => {
    const app = createServer({
      dataDir, store, engines, logger: false, communicationMode: "off", communicationReadMode: "authoritative",
    });
    const ready = await app.inject({ method: "GET", url: "/api/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      status: "not_ready",
      checks: { communicationMigration: { ok: false, detail: expect.stringContaining("parity=disabled") } },
    });
    await app.close();
  });

  it("serves room timelines from canonical projections in authoritative read mode", async () => {
    const app = createServer({ dataDir, store, engines, logger: false, communicationReadMode: "authoritative" });
    const project = store.createProject({ label: "Cutover", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Canonical room" });
    const agent = store.createThread(project.id, { title: "Reviewer", engine: "codex", masterChatId: master.id });

    const main = await app.inject({
      method: "POST", url: `/api/master-chats/${master.id}/messages`, payload: { text: "Shared decision" },
    });
    const collaboration = await app.inject({
      method: "POST", url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "Review this", recipientAgentIds: [agent.id] },
    });
    expect(main.statusCode).toBe(200);
    expect(collaboration.statusCode, collaboration.body).toBe(200);
    await waitForRun(agent.id);

    const mainDetail = (await app.inject({ method: "GET", url: `/api/master-chats/${master.id}` })).json<{
      messages: MasterChatMessageDto[];
    }>();
    const collaborationDetail = (await app.inject({ method: "GET", url: `/api/master-chats/${master.id}/collaboration` })).json<{
      messages: MasterChatMessageDto[];
    }>();
    expect(mainDetail.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId: main.json().communicationEventId, text: "Shared decision" }),
    ]));
    expect(collaborationDetail.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId: collaboration.json<{ message: { communicationEventId: string } }>().message.communicationEventId, text: "@Reviewer Review this" }),
    ]));
    expect((await app.inject({ method: "GET", url: "/api/ready" })).json())
      .toMatchObject({ status: "ready", checks: { communicationMigration: { ok: true } } });
    await app.close();
  });

  it("fails authoritative readiness when legacy room history is not canonical", async () => {
    const project = store.createProject({ label: "Drift", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Pre-cutover room" });
    const legacy = store.appendMasterChatMessage(master.id, { text: "Unmigrated history" })!;
    const app = createServer({ dataDir, store, engines, logger: false, communicationReadMode: "authoritative" });

    const ready = await app.inject({ method: "GET", url: "/api/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      status: "not_ready",
      checks: { communicationMigration: { ok: false, detail: expect.stringContaining("parity=drift") } },
    });
    expect(store.reconcileCommunicationEvents(project.id).unlinkedLegacyMessageIds).toEqual([legacy.id]);
    const dryRun = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/communication-backfill`, payload: { dryRun: true },
    });
    expect(dryRun.json()).toMatchObject({ dryRun: true, candidates: 1, migrated: 0, blocked: [] });
    const applied = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/communication-backfill`, payload: { dryRun: false },
    });
    expect(applied.json()).toMatchObject({ dryRun: false, candidates: 1, migrated: 1, blocked: [] });
    expect((await app.inject({ method: "GET", url: "/api/ready" })).json())
      .toMatchObject({ status: "ready", checks: { communicationMigration: { ok: true } } });
    await app.close();
  });

  it.each(["first", "second"])("rehearses authoritative cutover and legacy read rollback without data mutation (%s pass)", async (pass) => {
    const project = store.createProject({ label: `Rehearsal ${pass}`, hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Rollback room" });
    const shadow = createServer({ dataDir, store, engines, logger: false, communicationReadMode: "shadow" });
    const created = await shadow.inject({
      method: "POST", url: `/api/master-chats/${master.id}/messages`, payload: { text: "Durable checkpoint" },
    });
    expect(created.statusCode).toBe(200);
    const eventId = created.json<{ communicationEventId: string }>().communicationEventId;
    await shadow.close();
    store = new ThreadStore(dataDir);

    const authoritative = createServer({ dataDir, store, engines, logger: false, communicationReadMode: "authoritative" });
    const canonical = (await authoritative.inject({ method: "GET", url: `/api/master-chats/${master.id}` }))
      .json<{ messages: MasterChatMessageDto[] }>().messages;
    expect(canonical).toEqual([expect.objectContaining({ communicationEventId: eventId, text: "Durable checkpoint" })]);
    await authoritative.close();
    store = new ThreadStore(dataDir);

    const rollback = createServer({ dataDir, store, engines, logger: false, communicationReadMode: "legacy" });
    const legacy = (await rollback.inject({ method: "GET", url: `/api/master-chats/${master.id}` }))
      .json<{ messages: MasterChatMessageDto[] }>().messages;
    expect(legacy).toEqual(canonical);
    expect(store.readCommunicationEvents(project.id).map((event) => event.eventId)).toEqual([eventId]);
    await rollback.close();
  });

  it("routes authenticated agent communication intents and renders collaboration recipients", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Routing room" });
    const author = store.createThread(project.id, {
      title: "Author Agent",
      engine: "codex",
      masterChatId: master.id,
    });
    const reviewer = store.createThread(project.id, {
      title: "Review Agent",
      engine: "codex",
      masterChatId: master.id,
    });

    adapter.mode = "hang";
    await app.inject({
      method: "POST",
      url: `/api/threads/${author.id}/messages`,
      payload: { text: "@Review-Agent is tagged, but this is in my individual chat." },
    });
    await waitForSeedCount(1);
    expect(adapter.seeds[0]?.prompt).toContain("- channel: individual");
    expect(adapter.seeds[0]?.prompt).toContain("- tagged agents: @Review-Agent");
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

    const direct = await send({ intent: "direct_to_user", text: "Private implementation note." });
    const broadcast = await send({ intent: "broadcast", text: "Manager-facing checkpoint." });
    const collaboration = await send({ intent: "collaboration", recipientAgentIds: [reviewer.id], text: "Please review the API contract." });
    expect(direct.statusCode).toBe(200);
    expect(broadcast.statusCode).toBe(200);
    expect(collaboration.statusCode).toBe(200);
    await waitForSeedCount(2);

    expect(store.getMessages(author.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "Private implementation note." })]),
    );
    expect(store.getMasterChatMessages(master.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authorThreadId: author.id, text: "Manager-facing checkpoint." }),
      ]),
    );
    expect(store.getMasterChatMessages(master.id, "collaboration")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorThreadId: author.id,
          text: "@Review-Agent Please review the API contract.",
        }),
      ]),
    );
    const reviewerPrompt = adapter.seeds[1]?.prompt ?? "";
    expect(reviewerPrompt).toContain("- channel: collaboration");
    expect(reviewerPrompt).toContain("- author: Author Agent");
    expect(reviewerPrompt).toContain("- tagged agents: @Review-Agent");
    expect(reviewerPrompt).toContain("- you were tagged: yes");
    const communicationEvents = store.readCommunicationEvents(project.id);
    expect(communicationEvents).toHaveLength(4);
    expect(communicationEvents.map((event) => event.eventId)).toEqual(expect.arrayContaining([
      direct.json<{ eventId: string }>().eventId,
      broadcast.json<{ eventId: string }>().eventId,
      collaboration.json<{ eventId: string }>().eventId,
    ]));
    expect(communicationEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ intent: "direct_to_user", audience: { kind: "user", userId: "local-operator" } }),
      expect.objectContaining({ intent: "broadcast", audience: { kind: "organization", organizationId: project.id } }),
      expect.objectContaining({ intent: "collaboration", audience: { kind: "agents", agentIds: [reviewer.id] } }),
    ]));
    expect(store.getMessages(author.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        communicationEventId: direct.json<{ eventId: string }>().eventId,
        text: "Private implementation note.",
      }),
    ]));
    expect(store.getMasterChatMessages(master.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId: broadcast.json<{ eventId: string }>().eventId }),
    ]));
    expect(store.getMasterChatMessages(master.id, "collaboration")).toEqual(expect.arrayContaining([
      expect.objectContaining({ communicationEventId: collaboration.json<{ eventId: string }>().eventId }),
    ]));
    expect(store.reconcileCommunicationEvents(project.id)).toMatchObject({
      canonicalEvents: 4,
      linkedProjections: 7,
      missingProjectionEventIds: [],
      duplicateProjectionEventIds: [],
      orphanProjectionEventIds: [],
      missingClassificationEventIds: [],
      missingProjectionMetadataEventIds: [],
      unlinkedLegacyMessageIds: [],
      projectionReadMismatchMessageIds: [],
      ok: true,
    });
    const reconciliation = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/communication-reconciliation`,
    });
    expect(reconciliation.statusCode).toBe(200);
    expect(reconciliation.json()).toMatchObject({ ok: true, canonicalEvents: 4, linkedProjections: 7 });
    const promotionPayload = {
      sourceEventId: direct.json<{ eventId: string }>().eventId,
      summary: "The private implementation note is now project-level guidance.",
      idempotencyKey: "promote-private-note",
    };
    const promoted = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/knowledge-promotions`, payload: promotionPayload,
    });
    const promotionRetry = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/knowledge-promotions`, payload: promotionPayload,
    });
    expect(promoted.statusCode).toBe(201);
    expect(promoted.json()).toMatchObject({ replayed: false, promotion: { sourceEventId: promotionPayload.sourceEventId } });
    expect(promotionRetry.statusCode).toBe(200);
    expect(promotionRetry.json()).toMatchObject({ replayed: true, promotion: { promotionId: promoted.json<{ promotion: { promotionId: string } }>().promotion.promotionId } });
    await Promise.all([cancelAndWait(app, author.id), cancelAndWait(app, reviewer.id)]);
    await app.close();
  });

  it("retires mention routing while preserving explicit intents behind the rollback flag", async () => {
    const app = createServer({ dataDir, store, engines, logger: false, legacyRoutingMode: "reject" });
    const project = store.createProject({ label: "Retirement", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Explicit room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: master.id });
    const reviewer = store.createThread(project.id, { title: "Reviewer", engine: "codex", masterChatId: master.id });

    const manualMention = await app.inject({
      method: "POST", url: `/api/master-chats/${master.id}/collaboration/messages`, payload: { text: "@Reviewer inspect this" },
    });
    expect(manualMention.statusCode).toBe(400);
    expect(manualMention.json()).toMatchObject({ error: expect.stringContaining("explicit recipientAgentIds") });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${author.id}/messages`, payload: { text: "Begin" } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const legacy = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${token}` },
      payload: { channel: "collaboration", text: "@Reviewer legacy route" },
    });
    expect(legacy.statusCode).toBe(410);
    const explicit = await app.inject({
      method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${token}` },
      payload: { intent: "collaboration", recipientAgentIds: [reviewer.id], text: "Explicit route" },
    });
    expect(explicit.statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/api/threads/${author.id}/cancel` });
    for (let index = 0; index < 80 && adapter.abortedSeeds < 1; index += 1) await sleep(10);
    expect(adapter.abortedSeeds).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("rejects recipient-free and out-of-room collaboration intents before persistence", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Routing room" });
    const otherMaster = store.createMasterChat(project.id, { title: "Other room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: master.id });
    const outsider = store.createThread(project.id, { title: "Outsider", engine: "codex", masterChatId: otherMaster.id });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${author.id}/messages`, payload: { text: "Start." } });
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
    expect(store.getMasterChatMessages(master.id, "collaboration")).toHaveLength(0);
    expect(store.getMasterChatDeliveryIntents(master.id)).toHaveLength(0);
    await cancelAndWait(app, author.id);
    await app.close();
  });

  it("lets a room member broadcast idempotently without delivering to itself", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Agent broadcast" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: master.id });
    const reviewer = store.createThread(project.id, { title: "Reviewer", engine: "codex", masterChatId: master.id });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${author.id}/messages`, payload: { text: "Start." } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const payload = { channel: "collaboration", text: "@everyone review this.", idempotencyKey: "broadcast-review" };
    const first = await app.inject({ method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${token}` }, payload });
    const retry = await app.inject({ method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${token}` }, payload });

    expect(first.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ replayed: true, messageId: first.json<{ messageId: string }>().messageId });
    await waitForSeedCount(2);
    expect(adapter.seeds).toHaveLength(2);
    expect(store.getMessages(author.id).filter((message) => message.text.includes("@everyone"))).toHaveLength(0);
    expect(store.getMessages(reviewer.id).filter((message) => message.text.includes("@everyone"))).toHaveLength(1);
    expect(store.getMasterChatDeliveryIntents(master.id).filter(({ message }) => message.id === first.json<{ messageId: string }>().messageId))
      .toHaveLength(1);
    await Promise.all([cancelAndWait(app, author.id), cancelAndWait(app, reviewer.id)]);
    await app.close();
  });

  it("rejects a broadcast when the authenticated agent is no longer a current room member", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Membership room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: master.id });
    const reviewer = store.createThread(project.id, { title: "Reviewer", engine: "codex", masterChatId: master.id });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${author.id}/messages`, payload: { text: "Start." } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    store.updateThreadMasterChatMemberships(author.id, { masterChatIds: [] });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: "collaboration", text: "@everyone should not receive this.", idempotencyKey: "removed-author" },
    });

    expect(response.statusCode).toBe(409);
    expect(store.getMasterChatMessages(master.id, "collaboration")).toHaveLength(0);
    expect(store.getMessages(reviewer.id)).toHaveLength(0);
    expect(store.getMasterChatDeliveryIntents(master.id)).toHaveLength(0);
    await cancelAndWait(app, author.id);
    await app.close();
  });

  it("expires an agent messaging capability when its run ends", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Room" });
    const thread = store.createThread(project.id, {
      title: "Agent",
      engine: "codex",
      masterChatId: master.id,
    });
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "Finish." } });
    await waitForRun(thread.id);
    const token = adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: "individual", text: "Too late." },
    });
    expect(response.statusCode).toBe(401);
    expect(store.getMasterChatMessages(master.id)).toEqual([]);
    await app.close();
  });

  it("does not let forwarded or Host headers redirect capability callbacks", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex" });
    adapter.mode = "hang";
    await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: { host: "pine.example.test", "x-forwarded-proto": "https" },
      payload: { text: "Use the routed endpoint." },
    });
    await waitForSeedCount(1);
    expect(adapter.seeds[0]?.environment?.PONDEROSA_AGENT_MESSAGE_URL).toBe("http://127.0.0.1:8787/api/agent-messages");
    await cancelAndWait(app, thread.id);
    await app.close();
  });

  it("queues an agent-authored mention until the tagged agent finishes its active turn", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Collaboration room" });
    const reviewer = store.createThread(project.id, {
      title: "Pinnacles",
      engine: "codex",
      masterChatId: master.id,
    });
    const author = store.createThread(project.id, {
      title: "Badlands",
      engine: "codex",
      masterChatId: master.id,
    });

    adapter.mode = "hang";
    await app.inject({
      method: "POST",
      url: `/api/threads/${reviewer.id}/messages`,
      payload: { text: "Review another change first." },
    });

    adapter.mode = "normal";
    adapter.responseText = "@Pinnacles please review my completed change.";
    await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@Badlands Finish and request the security review." },
    });
    await waitForRun(author.id);

    // The reviewer is still busy, so the follow-up must remain queued rather than
    // being discarded. Finishing that turn should immediately activate it.
    await app.inject({ method: "POST", url: `/api/threads/${reviewer.id}/cancel` });
    await waitForRun(reviewer.id);

    expect(adapter.continues).toHaveLength(1);
    expect(adapter.continues[0]?.prompt).toContain(
      "Latest message for you:\n@Pinnacles please review my completed change.",
    );
    expect(store.getMessages(reviewer.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "@Pinnacles please review my completed change." }),
      ]),
    );
    await app.close();
  });

  it("queues a handoff sent through an active agent's messaging capability", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Collaboration room" });
    const reviewer = store.createThread(project.id, { title: "Pinnacles", engine: "codex", masterChatId: master.id });
    const author = store.createThread(project.id, { title: "Badlands", engine: "codex", masterChatId: master.id });

    adapter.mode = "hang";
    await app.inject({
      method: "POST",
      url: `/api/threads/${reviewer.id}/messages`,
      payload: { text: "Review the current change." },
    });
    await app.inject({
      method: "POST",
      url: `/api/threads/${author.id}/messages`,
      payload: { text: "Prepare the handoff." },
    });
    await waitForSeedCount(2);
    const token = adapter.seeds.find((seed) => seed.threadId === author.id)?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect(token).toBeTruthy();

    const handoff = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: "collaboration", text: "@Pinnacles Please review this once you finish." },
    });
    expect(handoff.statusCode).toBe(200);

    await app.inject({ method: "POST", url: `/api/threads/${reviewer.id}/cancel` });
    await waitForRun(reviewer.id);
    expect(adapter.continues.at(-1)?.prompt).toContain(
      "Latest message for you:\n@Pinnacles Please review this once you finish.",
    );

    await cancelAndWait(app, author.id);
    await app.close();
  });

  it("persists several active-turn tags, retries a cancelled delivery, and de-duplicates an agent retry", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Async handoffs" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const child = store.createThread(project.id, { title: "Child", engine: "codex", masterChatId: master.id });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${parent.id}/messages`, payload: { text: "Stay busy." } });
    await app.inject({ method: "POST", url: `/api/threads/${child.id}/messages`, payload: { text: "Wait for a retry." } });
    await waitForSeedCount(2);
    const childToken = adapter.seeds.find((seed) => seed.threadId === child.id)?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect(childToken).toBeTruthy();

    const tag = { channel: "collaboration" as const, text: "@Parent first completed result", idempotencyKey: "result-1" };
    const first = await app.inject({ method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${childToken}` }, payload: tag });
    const retry = await app.inject({ method: "POST", url: "/api/agent-messages", headers: { authorization: `Bearer ${childToken}` }, payload: tag });
    expect(first.json()).toMatchObject({ replayed: false });
    expect(retry.json()).toMatchObject({ replayed: true, messageId: first.json<{ messageId: string }>().messageId });
    await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@Parent second completed result" },
    });
    await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@Parent third completed result" },
    });

    // The recipient is still in a tool-like wait. Cancellation must not consume
    // its queued tags; all three enter one lossless FIFO continuation turn.
    adapter.mode = "normal";
    await app.inject({ method: "POST", url: `/api/threads/${parent.id}/cancel` });
    await waitForRun(parent.id);
    const batchPrompt = adapter.continues.find((turn) => turn.threadId === parent.id)?.prompt ?? "";
    expect(batchPrompt).toContain("CollaborationDeliveryBatch (3 deliveries; canonical server order)");
    expect(batchPrompt.indexOf("@Parent first completed result")).toBeLessThan(batchPrompt.indexOf("@Parent second completed result"));
    expect(batchPrompt.indexOf("@Parent second completed result")).toBeLessThan(batchPrompt.indexOf("@Parent third completed result"));
    expect(store.getCollaborationChatDetail(master.id)?.messages.filter((message) => message.text === "@Parent first completed result")).toHaveLength(1);
    await cancelAndWait(app, child.id);
    await app.close();
  });

  it("starts queued tags after a normal tool-boundary turn completes", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Safe boundary" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    adapter.mode = "boundary";
    await app.inject({ method: "POST", url: `/api/threads/${parent.id}/messages`, payload: { text: "Work through a tool call." } });
    await waitForSeedCount(1);

    await Promise.all([
      app.inject({ method: "POST", url: `/api/master-chats/${master.id}/collaboration/messages`, payload: { text: "@Parent result one" } }),
      app.inject({ method: "POST", url: `/api/master-chats/${master.id}/collaboration/messages`, payload: { text: "@Parent result two" } }),
    ]);
    await waitForRun(parent.id, 2);
    const prompt = adapter.continues.find((turn) => turn.threadId === parent.id)?.prompt ?? "";
    expect(prompt).toContain("CollaborationDeliveryBatch (2 deliveries; canonical server order)");
    expect(prompt.indexOf("@Parent result one")).toBeLessThan(prompt.indexOf("@Parent result two"));
    await app.close();
  });

  it("keeps a delegated objective awaiting disposition after turn_done without notifying its parent", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Completion delivery" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${parent.id}/messages`, payload: { text: "Delegate and stop waiting." } });
    await waitForSeedCount(1);
    const token = adapter.seeds[0]!.environment!.PONDEROSA_DELEGATION_TOKEN;
    adapter.mode = "normal";
    const delegated = await app.inject({
      method: "POST",
      url: "/api/agent-delegations",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayLabel: "Research", delegationPrompt: "Return the result.", runtime: "codex", idempotencyKey: "completion-1" },
    });
    expect(delegated.statusCode).toBe(202);
    const run = delegated.json<{ run: { id: string; childThreadId: string } }>().run;
    await waitForRun(run.childThreadId);
    expect((await app.inject({ method: "GET", url: `/api/master-chats/${master.id}/subagents` })).json()).toEqual([
      expect.objectContaining({ id: run.id, status: "awaiting_disposition", canCancel: true }),
    ]);
    const completionMessage = store.getCollaborationChatDetail(master.id)?.messages.find(
      (message) => message.text.includes("Delegated task “Research” completed"),
    );
    expect(completionMessage).toBeUndefined();
    expect(adapter.continues.filter((turn) => turn.threadId === parent.id)).toHaveLength(0);
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);
    await app.close();
  });

  it("accepts an authenticated explicit completion exactly once and notifies the parent", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Explicit outcome" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${parent.id}/messages`, payload: { text: "Delegate." } });
    await waitForSeedCount(1);
    const parentToken = adapter.seeds[0]!.environment!.PONDEROSA_DELEGATION_TOKEN;
    const delegated = await app.inject({ method: "POST", url: "/api/agent-delegations", headers: { authorization: `Bearer ${parentToken}` }, payload: { displayLabel: "Research", delegationPrompt: "Finish.", runtime: "codex", idempotencyKey: "explicit-1" } });
    const run = delegated.json<{ run: { id: string; childThreadId: string } }>().run;
    await waitForSeedCount(2);
    const outcomeToken = adapter.seeds.find((seed) => seed.threadId === run.childThreadId)!.environment!.PONDEROSA_DELEGATION_TOKEN;
    const payload = { outcome: "completed", message: "Verified result.", idempotencyKey: "outcome-1" };
    const first = await app.inject({ method: "POST", url: "/api/agent-delegation-outcomes", headers: { authorization: `Bearer ${outcomeToken}` }, payload });
    const duplicate = await app.inject({ method: "POST", url: "/api/agent-delegation-outcomes", headers: { authorization: `Bearer ${outcomeToken}` }, payload });
    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(first.json().run).toEqual(expect.objectContaining({ status: "completed", disposition: expect.objectContaining({ outcome: "completed" }) }));
    const completionMessages = store.getCollaborationChatDetail(master.id)?.messages
      .filter((message) => message.text.includes("Delegated task “Research” completed")) ?? [];
    expect(completionMessages).toHaveLength(1);
    expect(completionMessages[0]?.communicationEventId).toEqual(expect.any(String));
    expect(store.reconcileCommunicationEvents(project.id).ok).toBe(true);
    await app.close();
  });

  it("delivers an ordinary collaboration result from a delegated child", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Child result delivery" });
    const parent = store.createThread(project.id, { title: "Cedar Breaks", engine: "codex", masterChatId: master.id });

    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${parent.id}/messages`, payload: { text: "Delegate research." } });
    await waitForSeedCount(1);
    const delegationToken = adapter.seeds[0]!.environment!.PONDEROSA_DELEGATION_TOKEN;
    const delegated = await app.inject({
      method: "POST",
      url: "/api/agent-delegations",
      headers: { authorization: `Bearer ${delegationToken}` },
      payload: { displayLabel: "Research", delegationPrompt: "Research and report back.", runtime: "codex", idempotencyKey: "child-result" },
    });
    expect(delegated.statusCode).toBe(202);
    const run = delegated.json<{ run: { childThreadId: string } }>().run;
    await waitForSeedCount(2);
    const childToken = adapter.seeds.find((seed) => seed.threadId === run.childThreadId)?.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN;
    expect(childToken).toBeTruthy();

    const result = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${childToken}` },
      payload: { channel: "collaboration", text: "@Cedar-Breaks Huntsville result is ready.", idempotencyKey: "huntsville-result" },
    });
    expect(result.statusCode).toBe(200);

    await app.inject({ method: "POST", url: `/api/threads/${parent.id}/cancel` });
    await waitForRun(parent.id);
    expect(adapter.continues.find((turn) => turn.threadId === parent.id)?.prompt).toContain(
      "Latest message for you:\n@Cedar-Breaks Huntsville result is ready.",
    );
    expect(store.getCollaborationChatDetail(master.id)?.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("delivery dispatch rejected (400)") })]),
    );

    await cancelAndWait(app, run.childThreadId);
    await app.close();
  });

  it("recovers queued and interrupted collaboration deliveries after restart in FIFO order", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Restart recovery" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const firstMessage = store.appendMasterChatMessage(
      master.id,
      { role: "user", text: "@Parent interrupted first result" },
      undefined,
      "collaboration",
      [{ targetThreadId: parent.id, relayDepth: 0, mentionTrail: [], kind: "tag" }],
    )!;
    const secondMessage = store.appendMasterChatMessage(
      master.id,
      { role: "user", text: "@Parent queued second result" },
      undefined,
      "collaboration",
    )!;
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const first = deliveries.queue({
      masterChatId: master.id,
      messageId: firstMessage.id,
      targetThreadId: parent.id,
      text: firstMessage.text,
      relayDepth: 0,
      mentionTrail: [],
      kind: "tag",
    }).delivery;
    deliveries.markDelivered(first.id);
    deliveries.queue({
      masterChatId: master.id,
      messageId: secondMessage.id,
      targetThreadId: parent.id,
      text: secondMessage.text,
      relayDepth: 0,
      mentionTrail: [],
      kind: "tag",
    });

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(parent.id);

    const prompt = adapter.seeds.find((turn) => turn.threadId === parent.id)?.prompt ?? "";
    expect(prompt).toContain("CollaborationDeliveryBatch (2 deliveries; canonical server order)");
    expect(prompt.lastIndexOf("@Parent interrupted first result")).toBeLessThan(prompt.lastIndexOf("@Parent queued second result"));
    await app.close();
  });

  it("dispatches a fixed, exact collaboration batch and leaves in-flight arrivals for the next turn", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Batch room" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const other = store.createThread(project.id, { title: "Other", engine: "codex", masterChatId: master.id });
    const author = store.createThread(project.id, { title: "Mesa Author", engine: "codex", masterChatId: master.id });
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const firstAt = "2026-07-11T10:00:00.000Z";
    const secondAt = "2026-07-11T10:00:01.000Z";
    const queue = (messageId: string, targetThreadId: string, text: string, createdAt: string) => deliveries.queue({
      masterChatId: master.id,
      messageId,
      targetThreadId,
      authorThreadId: author.id,
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
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@Parent arrived during active batch" },
    });
    await waitForRun(parent.id, 2);
    await waitForRun(other.id);

    const parentTurns = [
      ...adapter.seeds.filter((turn) => turn.threadId === parent.id),
      ...adapter.continues.filter((turn) => turn.threadId === parent.id),
    ];
    expect(parentTurns).toHaveLength(2);
    expect(parentTurns[0]?.prompt).toContain(
      `Author: Mesa Author (@Mesa-Author, thread ${author.id})\nUTC timestamp: ${firstAt}\nOriginal message (exact):\nfirst exact\nline two`,
    );
    expect(parentTurns[0]?.prompt).toContain(`UTC timestamp: ${secondAt}\nOriginal message (exact):\nsecond exact`);
    expect(parentTurns[0]?.prompt).not.toContain("arrived during active batch");
    expect(parentTurns[1]?.prompt).toContain("@Parent arrived during active batch");
    expect(adapter.seeds.find((turn) => turn.threadId === other.id)?.prompt).toContain("other recipient only");
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
    const master = store.createMasterChat(project.id, { title: "Batch retry" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const ids = ["one", "two"].map((text, index) => deliveries.queue({
      masterChatId: master.id,
      messageId: `retry-${text}`,
      targetThreadId: parent.id,
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
    const turns = [...adapter.seeds, ...adapter.continues].filter((turn) => turn.threadId === parent.id);
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.prompt.includes("Original message (exact):\none") && turn.prompt.includes("Original message (exact):\ntwo"))).toBe(true);
    const persisted = new CollaborationDeliveryStore(dataDir);
    expect(ids.map((id) => persisted.get(id)?.status)).toEqual(["acknowledged", "acknowledged"]);
    await app.close();
  });

  it("rebuilds a missing inbox record from a canonical tagged message", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Crash window" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    new CollaborationDeliveryStore(dataDir);
    store.appendMasterChatMessage(
      master.id,
      { role: "user", text: "@Parent result persisted before the inbox write" },
      undefined,
      "collaboration",
      [{ targetThreadId: parent.id, relayDepth: 0, mentionTrail: [], kind: "tag" }],
    );

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(parent.id);
    expect(adapter.seeds.find((turn) => turn.threadId === parent.id)?.prompt).toContain(
      "Latest message for you:\n@Parent result persisted before the inbox write",
    );
    await app.close();
  });

  it("reconciles an @everyone crash window once per still-eligible recipient with audit provenance", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Broadcast crash window" });
    const first = store.createThread(project.id, { title: "First", engine: "codex", masterChatId: master.id });
    const second = store.createThread(project.id, { title: "Second", engine: "codex", masterChatId: master.id });
    const archived = store.createThread(project.id, { title: "Archived", engine: "codex", masterChatId: master.id });
    const deleted = store.createThread(project.id, { title: "Deleted", engine: "codex", masterChatId: master.id });
    new CollaborationDeliveryStore(dataDir);
    const intent = (targetThreadId: string) => ({
      targetThreadId,
      relayDepth: 0,
      mentionTrail: [],
      kind: "tag" as const,
      audience: "everyone" as const,
    });
    const message = store.appendMasterChatMessage(
      master.id,
      { role: "user", text: "@everyone recover this broadcast" },
      undefined,
      "collaboration",
      [intent(first.id), intent(second.id), intent(archived.id), intent(deleted.id)],
    )!;
    store.updateThread(archived.id, { archived: true });
    store.deleteThread(deleted.id);

    adapter.mode = "hang";
    const firstStart = createServer({ dataDir, store, engines, logger: false });
    await firstStart.ready();
    await waitForSeedCount(2);
    await firstStart.close();

    const restartedStore = new ThreadStore(dataDir);
    const secondStart = createServer({ dataDir, store: restartedStore, engines, logger: false });
    await secondStart.ready();
    await secondStart.close();

    const records = readFileSync(path.join(dataDir, "collaboration-deliveries.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as {
        type: string;
        delivery?: { id: string; messageId: string; targetThreadId: string; audience?: string };
      });
    const deliveries = records
      .flatMap((record) => record.delivery ? [record.delivery] : [])
      .filter((delivery) => delivery.messageId === message.id);
    const uniqueByTarget = new Map(deliveries.map((delivery) => [delivery.targetThreadId, delivery]));
    expect([...uniqueByTarget.keys()].sort()).toEqual([first.id, second.id].sort());
    expect(new Set(deliveries.map((delivery) => delivery.id)).size).toBe(2);
    expect(deliveries.every((delivery) => delivery.audience === "everyone")).toBe(true);
  });

  it("preserves canonical FIFO when an older message is reconstructed", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "FIFO crash window" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const intent = { targetThreadId: parent.id, relayDepth: 0, mentionTrail: [], kind: "tag" as const };
    const afterReconciliationBoundary = new Date(Date.now() + 1_000);
    vi.useFakeTimers();
    vi.setSystemTime(afterReconciliationBoundary);
    const older = store.appendMasterChatMessage(
      master.id,
      { role: "user", text: "@Parent older message missing its inbox write" },
      undefined,
      "collaboration",
      [intent],
    )!;
    const newer = store.appendMasterChatMessage(
      master.id,
      { role: "user", text: "@Parent newer message already queued" },
      undefined,
      "collaboration",
      [intent],
    )!;
    vi.useRealTimers();
    expect(older.createdAt).toBe(newer.createdAt);
    deliveries.queue({
      masterChatId: master.id,
      messageId: newer.id,
      targetThreadId: parent.id,
      text: newer.text,
      relayDepth: 0,
      mentionTrail: [],
      kind: "tag",
      createdAt: newer.createdAt,
      orderKey: store.getMasterChatMessageDeliveryOrderKey(master.id, newer.id),
    });

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(parent.id);
    const turns = [
      ...adapter.seeds.filter((turn) => turn.threadId === parent.id),
      ...adapter.continues.filter((turn) => turn.threadId === parent.id),
    ];
    expect(turns).toHaveLength(1);
    expect(turns[0]?.prompt.indexOf("@Parent older message missing its inbox write")).toBeLessThan(
      turns[0]?.prompt.indexOf("@Parent newer message already queued") ?? -1,
    );
    await app.close();
  });

  it("preserves mixed collaboration and direct FIFO when timestamps tie", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Mixed FIFO crash window" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const afterReconciliationBoundary = new Date(Date.now() + 1_000);
    vi.useFakeTimers();
    vi.setSystemTime(afterReconciliationBoundary);
    const older = store.appendMasterChatMessage(
      master.id,
      { role: "user", text: "@Parent older collaboration message missing its inbox write" },
      undefined,
      "collaboration",
      [{ targetThreadId: parent.id, relayDepth: 0, mentionTrail: [], kind: "tag" }],
    )!;
    const directCreatedAt = new Date().toISOString();
    deliveries.queue({
      messageId: "newer-direct-manager-message",
      targetThreadId: parent.id,
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
      ...adapter.seeds.filter((turn) => turn.threadId === parent.id),
      ...adapter.continues.filter((turn) => turn.threadId === parent.id),
    ];
    expect(turns[0]?.prompt).toContain(
      "Latest message for you:\n@Parent older collaboration message missing its inbox write",
    );
    expect(turns[1]?.prompt).toContain("Latest message for you:\nNewer direct manager message already queued");
    await app.close();
  });

  it("does not infer delivery for canonical messages without an authorized intent", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Blocked recovery" });
    store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    new CollaborationDeliveryStore(dataDir);
    store.appendMasterChatMessage(
      master.id,
      { role: "assistant", text: "@Parent blocked or historical mention" },
      undefined,
      "collaboration",
    );

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await sleep(20);
    expect(adapter.seeds).toHaveLength(0);
    await app.close();
  });

  it("rebuilds a delegated completion delivery missing after message append", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Completion crash window" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const child = store.createThread(project.id, { title: "Child", engine: "codex", masterChatId: master.id });
    new CollaborationDeliveryStore(dataDir);
    const delegations = new DelegationStore(dataDir);
    const spawned = delegations.spawn(master.id, {
      parentRunId: "parent-run",
      displayLabel: "Crash completion",
      delegationPrompt: "finish",
      runtime: "codex",
      idempotencyKey: "completion-gap",
    }, true, [], parent.id);
    delegations.bindChildThread(spawned.run.id, child.id);
    delegations.claim(spawned.run.id);
    delegations.declareDisposition(spawned.run.id, { outcome: "completed", idempotencyKey: "crash-outcome" });
    store.appendMasterChatMessage(
      master.id,
      { role: "system", text: "✅ Delegated task “Crash completion” completed. @Parent, the result is ready." },
      child.id,
      "collaboration",
      [{
        targetThreadId: parent.id,
        relayDepth: 0,
        mentionTrail: [],
        kind: "delegation_completion",
        delegatedRunId: spawned.run.id,
      }],
    );

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(parent.id);
    expect((await app.inject({ method: "GET", url: `/api/master-chats/${master.id}/subagents` })).json()).toEqual([
      expect.objectContaining({
        id: spawned.run.id,
        completionDelivery: expect.objectContaining({ status: "acknowledged" }),
      }),
    ]);
    await app.close();
  });

  it("recovers a durable direct manager follow-up after restart", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const thread = store.createThread(project.id, { title: "Worker", engine: "codex" });
    new CollaborationDeliveryStore(dataDir).queue({
      messageId: "direct-restart",
      targetThreadId: thread.id,
      text: "Continue after restart",
      relayDepth: 0,
      mentionTrail: [],
      kind: "direct",
    });

    const app = createServer({ dataDir, store, engines, logger: false });
    await app.ready();
    await waitForRun(thread.id);
    expect(adapter.seeds.find((turn) => turn.threadId === thread.id)?.prompt).toContain(
      "Latest message for you:\nContinue after restart",
    );
    await app.close();
  });

  it("does not mutate a delivery ledger after shutdown begins", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const thread = store.createThread(project.id, { title: "Worker", engine: "codex" });
    new CollaborationDeliveryStore(dataDir).queue({
      messageId: "active-during-close",
      targetThreadId: thread.id,
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

  it("reconciles interrupted delegations and relaunches authorized queued work", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Delegation recovery" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const delegations = new DelegationStore(dataDir);
    const make = (parentRunId: string, label: string) => delegations.spawn(master.id, {
      parentRunId,
      displayLabel: label,
      delegationPrompt: `Do ${label}`,
      runtime: "codex",
      idempotencyKey: label,
    }, true, [], parent.id);

    const queued = make("parent-queued", "Queued child");
    const queuedThread = store.createThread(project.id, { title: "Queued child", engine: "codex", masterChatId: master.id });
    delegations.bindChildThread(queued.run.id, queuedThread.id);
    const interrupted = make("parent-running", "Interrupted child");
    const interruptedThread = store.createThread(project.id, { title: "Interrupted child", engine: "codex", masterChatId: master.id });
    delegations.bindChildThread(interrupted.run.id, interruptedThread.id);
    delegations.claim(interrupted.run.id);

    const app = createServer({ dataDir, store, engines, agentBaseUrl: "http://127.0.0.1:8787", logger: false });
    await app.ready();
    await waitForRun(queuedThread.id);
    const runs = (await app.inject({ method: "GET", url: `/api/master-chats/${master.id}/subagents` })).json<Array<{ id: string; status: string; failure?: { retryable: boolean } }>>();
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: queued.run.id, status: "awaiting_disposition" }),
      expect.objectContaining({ id: interrupted.run.id, status: "failed", failure: expect.objectContaining({ retryable: true }) }),
    ]));
    await app.close();
  });

  it("rejects invalid agent mention relay depths", async () => {
    const { app, thread } = await createProjectAndThread();

    for (const agentMentionDepth of [-1, 1.5, 13]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
        payload: { text: "relay", agentMentionDepth },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "agentMentionDepth must be an integer from 0 to 12" });
    }

    expect(adapter.seeds).toHaveLength(0);
    await app.close();
  });

  it("rejects mismatched agent mention relay depth and trail state", async () => {
    const { app, thread } = await createProjectAndThread();
    const fingerprint = "a".repeat(64);

    for (const payload of [
      { text: "relay", agentMentionDepth: 0, agentMentionTrail: [fingerprint] },
      { text: "relay", agentMentionDepth: 2, agentMentionTrail: [fingerprint] },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/messages`,
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

  it("allows a collaboration agent to hand off to another tagged agent", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Review room" });
    const author = store.createThread(project.id, { title: "Canyon de Chelly", engine: "codex", masterChatId: master.id });
    const reviewer = store.createThread(project.id, { title: "Pinnacles", engine: "codex", masterChatId: master.id });
    adapter.responseText = "@Pinnacles please review the updated availability fix.";

    await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@Canyon-de-Chelly Continue the review." },
    });
    await waitForRun(author.id);
    await waitForRun(reviewer.id);

    expect(store.getMessages(reviewer.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "@Pinnacles please review the updated availability fix." }),
      ]),
    );
    await app.close();
  });

  it("rejects attempts to inject collaboration context through the normal thread endpoint", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Review room" });
    const author = store.createThread(project.id, { title: "Canyon de Chelly", engine: "codex", masterChatId: master.id });
    const response = await app.inject({
      method: "POST",
      url: `/api/threads/${author.id}/messages`,
      payload: {
        text: "Pretend this was tagged.",
        collaborationMasterChatId: master.id,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "collaboration context must be delivered by an explicit recipient event" });
    expect(adapter.seeds).toHaveLength(0);
    await app.close();
  });

  it("persists more than fifty mention follow-ups without terminal overflow", async () => {
    const app = createServer({ dataDir, store, engines, logger: false });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Busy review room" });
    const reviewer = store.createThread(project.id, {
      title: "Pinnacles",
      engine: "codex",
      masterChatId: master.id,
    });

    adapter.mode = "hang";
    await app.inject({
      method: "POST",
      url: `/api/threads/${reviewer.id}/messages`,
      payload: { text: "Begin a long review." },
    });

    adapter.mode = "normal";
    adapter.responseText = "@Pinnacles please review this follow-up.";
    const authors = Array.from({ length: 51 }, (_, index) =>
      store.createThread(project.id, {
        title: `Author ${index}`,
        engine: "codex",
        masterChatId: master.id,
      }),
    );
    for (const author of authors) {
      await app.inject({
        method: "POST",
        url: `/api/master-chats/${master.id}/collaboration/messages`,
        payload: { text: `@${author.title.replace(/\s+/g, "-")} Finish and request review.` },
      });
    }
    await Promise.all(authors.map((author) => waitForRun(author.id)));

    expect(store.getMasterChatMessages(master.id, "collaboration")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("follow-up queue is full") })]),
    );

    await app.inject({ method: "POST", url: `/api/threads/${reviewer.id}/cancel` });
    await waitForRun(reviewer.id, 3);
    const reviewerTurns = adapter.continues.filter((turn) => turn.threadId === reviewer.id);
    expect(reviewerTurns).toHaveLength(3);
    expect(reviewerTurns.map((turn) => turn.prompt.match(/CollaborationDeliveryBatch \((\d+) deliveries/)?.[1])).toEqual(["20", "20", "11"]);
    await app.close();
  });

  it("queues a manager follow-up behind an active run and starts it when the run closes", async () => {
    adapter.mode = "hang";
    const { app, thread } = await createProjectAndThread();
    const first = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "long" },
    });
    expect(first.statusCode).toBe(200);

    const concurrent = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "again" },
    });
    expect(concurrent.statusCode).toBe(202);
    expect(concurrent.json()).toMatchObject({ queued: true, position: 1, communicationEventId: expect.any(String) });

    const cancel = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/cancel` });
    expect(cancel.json()).toEqual({ cancelled: true });
    await waitForRun(thread.id);
    expect(adapter.continues).toHaveLength(1);
    expect(store.getMessages(thread.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", text: "again" })]),
    );
    await app.close();
  });

  it("rejects file-browser path escapes", async () => {
    const { app, project } = await createProjectAndThread();
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
    const { app, project } = await createProjectAndThread();

    const res = await app.inject({
      method: "GET",
      url: `/api/files?projectId=${project.id}&path=outside-link/secret.txt`,
    });

    expect(res.statusCode).toBe(400);
    rmSync(outsideDir, { recursive: true, force: true });
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
    const { app, project } = await createProjectAndThread();
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

  it("keeps v2 routes as explicit 501 stubs", async () => {
    const { app, thread } = await createProjectAndThread();

    const switchEngine = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/switch-engine`,
      payload: { engine: "claude" },
    });
    const search = await app.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/search?q=history`,
    });

    expect(switchEngine.statusCode).toBe(501);
    expect(search.statusCode).toBe(501);
    await app.close();
  });

  it("deletes a thread: removes projections + on-disk log, cancels active run", async () => {
    const { app, project, thread } = await createProjectAndThread();

    // Give the thread some history so there's a log + projections to remove.
    await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      payload: { text: "do work" },
    });
    await waitForRun(thread.id);
    expect(store.readEvents(thread.id).length).toBeGreaterThan(0);

    const del = await app.inject({ method: "DELETE", url: `/api/threads/${thread.id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ deleted: boolean }>().deleted).toBe(true);

    // Gone from the projection list and by id.
    const list = await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads` });
    expect(list.json<unknown[]>()).toHaveLength(0);
    const detail = await app.inject({ method: "GET", url: `/api/threads/${thread.id}` });
    expect(detail.statusCode).toBe(404);

    // Deleting again is a 404.
    const again = await app.inject({ method: "DELETE", url: `/api/threads/${thread.id}` });
    expect(again.statusCode).toBe(404);

    // On-disk thread directory is gone (rebuild won't resurrect it).
    store.rebuildProjections();
    const afterRebuild = await app.inject({ method: "GET", url: `/api/threads/${thread.id}` });
    expect(afterRebuild.statusCode).toBe(404);
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
    const fallback = await app.inject({ method: "GET", url: "/threads/abc" });
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
    const master = store.createMasterChat(project.id, { title: "Delegation room" });
    const thread = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const parent = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "delegate" } });
    const parentRunId = parent.json<{ runId: string }>().runId;

    expect((await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/subagents`,
      payload: { parentRunId, displayLabel: "Spoof", delegationPrompt: "bad", runtime: "codex", idempotencyKey: "legacy" },
    })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/internal/subagents/missing/launch", payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/internal/subagents/missing/output", payload: { text: "forged" } })).statusCode).toBe(404);

    await cancelAndWait(app, thread.id);
    await app.close();
  });

  it("delegates through a run-bound bridge without exposing ownership or registration proof", async () => {
    adapter.mode = "hang";
    const app = createServer({
      dataDir,
      store,
      engines,
      agentBaseUrl: "http://127.0.0.1:8787/",
      logger: false,
    });
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Delegation room" });
    const thread = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "delegate" } });
    await waitForSeedCount(1);
    const environment = adapter.seeds[0]!.environment!;
    expect(environment.PONDEROSA_AGENT_MESSAGE_URL).toBe("http://127.0.0.1:8787/api/agent-messages");
    expect(environment.PONDEROSA_DELEGATION_URL).toBe("http://127.0.0.1:8787/api/agent-delegations");
    expect(environment.PONDEROSA_INTERNAL_SUBAGENTS_DISABLED).toBe("1");
    expect(environment.PONDEROSA_AGENT_MESSAGE_TOKEN).not.toBe(environment.PONDEROSA_DELEGATION_TOKEN);

    const spoof = await app.inject({
      method: "POST",
      url: "/api/agent-delegations",
      headers: { authorization: `Bearer ${environment.PONDEROSA_DELEGATION_TOKEN}` },
      payload: { parentThreadId: "another-thread", displayLabel: "Spoof", delegationPrompt: "bad", runtime: "codex", idempotencyKey: "spoof-1" },
    });
    expect(spoof.statusCode).toBe(403);
    expect(spoof.json()).toMatchObject({ error: { code: "unauthorized_parent" } });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent-delegations",
      headers: { authorization: `Bearer ${environment.PONDEROSA_DELEGATION_TOKEN}` },
      payload: { displayLabel: "Safe review", delegationPrompt: "private secret task", runtime: "codex", idempotencyKey: "bridge-1" },
    });
    expect(response.statusCode).toBe(202);
    const created = response.json<{ run: { id: string; parentThreadId?: string; childThreadId?: string; parentRunId: string; rootRunId: string; runtime: string; status: string }; accepted: boolean }>();
    expect(created).toMatchObject({ accepted: true, run: { runtime: "codex", status: "running" } });
    expect(created.run.parentThreadId).toBe(thread.id);
    expect(created.run.childThreadId).toBeTruthy();
    expect(created.run.parentRunId).toBe(created.run.rootRunId);
    expect(JSON.stringify(response.json())).not.toContain("private secret task");
    expect(JSON.stringify(response.json())).not.toContain("credential");
    await waitForSeedCount(2);
    const childId = created.run.childThreadId!;
    const childDetail = (await app.inject({ method: "GET", url: `/api/threads/${childId}` })).json();
    expect(childDetail).toMatchObject({
      thread: { id: childId, title: "Safe review", masterChatId: master.id },
      messages: [{ role: "user", text: "Delegated task: Safe review" }],
    });
    expect(JSON.stringify(childDetail)).not.toContain("private secret task");
    expect(adapter.seeds[1]!.environment?.PONDEROSA_DELEGATION_TOKEN).toBeTruthy();
    expect(adapter.seeds[1]!.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN).toBeTruthy();
    expect(adapter.seeds[1]!.environment?.PONDEROSA_AGENT_MESSAGE_TOKEN).not.toBe(adapter.seeds[1]!.environment?.PONDEROSA_DELEGATION_TOKEN);
    expect(adapter.seeds[1]!.environment?.PONDEROSA_AGENT_MESSAGE_URL).toBe("http://127.0.0.1:8787/api/agent-messages");
    expect(adapter.seeds[1]!.environment?.PONDEROSA_DELEGATION_URL).toBe("http://127.0.0.1:8787/api/agent-delegations");

    const childCollaboration = await app.inject({
      method: "POST",
      url: "/api/agent-messages",
      headers: { authorization: `Bearer ${adapter.seeds[1]!.environment!.PONDEROSA_AGENT_MESSAGE_TOKEN}` },
      payload: { channel: "collaboration", text: "@Parent progress from child" },
    });
    expect(childCollaboration.statusCode).toBe(200);
    expect(store.getCollaborationChatDetail(master.id)?.messages).toEqual([
      expect.objectContaining({ authorThreadId: childId, text: "@Parent progress from child" }),
    ]);

    const followUp = await app.inject({
      method: "POST",
      url: `/api/threads/${childId}/messages`,
      payload: { text: "Explain the result directly" },
    });
    expect(followUp.json()).toMatchObject({ queued: true, position: 1 });

    const cancel = await app.inject({
      method: "POST",
      url: `/api/threads/${childId}/cancel`,
    });
    expect(cancel.json()).toEqual({ cancelled: true });
    for (let i = 0; i < 80 && adapter.continues.length === 0; i += 1) await sleep(10);
    expect(adapter.continues).toHaveLength(1);
    expect(adapter.continues[0]?.threadId).toBe(childId);
    await waitForRun(childId);
    expect((await app.inject({ method: "GET", url: `/api/master-chats/${master.id}/subagents` })).json()).toEqual([
      expect.objectContaining({ id: created.run.id, status: "cancelled", delegationSummary: "Safe review" }),
    ]);
    const audit = readFileSync(path.join(dataDir, "delegations.jsonl"), "utf8");
    expect(audit.split("private secret task")).toHaveLength(2);
    await cancelAndWait(app, thread.id);
    await app.close();
  });

  it("repairs delegation persistence permissions on startup", async () => {
    const file = path.join(dataDir, "delegations.jsonl");
    writeFileSync(file, "", { mode: 0o644 });
    const app = createServer({ dataDir, store, engines, logger: false });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await app.close();
  });

  it("validates, scopes, persists, serves, and prevents deletion of sent image attachments", async () => {
    const { app, thread } = await createProjectAndThread();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const rejected = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/attachments`, headers: { "content-type": "image/png" }, payload: Buffer.from("<svg><script/></svg>") });
    expect(rejected.statusCode).toBe(415);
    const uploaded = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/attachments`, headers: { "content-type": "image/png", "x-ponderosa-filename": "../../screen.png" }, payload: png });
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json<{ id: string; name: string; url: string }>();
    expect(attachment.name).toBe("screen.png");
    expect(attachment.url).not.toContain(dataDir);
    const send = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "Inspect this", attachmentIds: [attachment.id] } });
    expect(send.statusCode).toBe(200);
    await waitForRun(thread.id);
    expect(store.getMessages(thread.id)[0]?.attachments?.[0]).toMatchObject({ id: attachment.id, threadId: thread.id });
    store.rebuildProjections();
    expect(store.getMessages(thread.id)[0]?.attachments?.[0]).toMatchObject({ id: attachment.id, threadId: thread.id });
    expect(adapter.seeds[0]?.prompt).toContain("Attached images");
    expect(adapter.seeds[0]?.prompt).not.toContain("base64");
    expect((await app.inject({ method: "GET", url: attachment.url })).headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ method: "DELETE", url: attachment.url })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/threads/not-${thread.id}/messages`, payload: { text: "x", attachmentIds: [attachment.id] } })).statusCode).toBe(404);
    await app.close();
  });

  it("serves general assets only as bounded private downloads with non-enumerating ownership failures", async () => {
    const { app, project, thread } = await createProjectAndThread();
    const second = store.createThread(project.id, { title: "Other", engine: "codex" });
    const uploaded = await app.inject({
      method: "POST", url: `/api/threads/${thread.id}/attachments`,
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
    const foreignUrl = `/api/threads/${second.id}/assets/${asset.id}/download`;
    expect((await app.inject({ method: "GET", url: foreignUrl })).json()).toEqual({ error: "asset not found" });
    expect((await app.inject({ method: "GET", url: `/api/threads/${second.id}/assets/${randomUUID()}/download` })).json()).toEqual({ error: "asset not found" });
    expect((await app.inject({ method: "DELETE", url: `/api/threads/${thread.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: asset.downloadUrl })).statusCode).toBe(404);
    expect(existsSync(path.join(dataDir, "projects", project.id, "threads", thread.id))).toBe(false);
    await app.close();
  });

  it("streams live SSE and replays from last seen seq without duplicates", async () => {
    const { app, project, thread } = await createProjectAndThread();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const base = `http://127.0.0.1:${address.port}`;

    const liveAbort = new AbortController();
    const live = await fetch(`${base}/api/threads/${thread.id}/stream`, { signal: liveAbort.signal });
    const reader = live.body!.getReader();
    await fetch(`${base}/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "stream" }),
    });

    let chunk = "";
    for (let i = 0; i < 30 && !chunk.includes('"type":"session"'); i += 1) {
      const read = await reader.read();
      chunk += new TextDecoder().decode(read.value);
    }
    liveAbort.abort();
    expect(chunk).toContain("id: 2");
    expect(chunk).toContain('"type":"session"');
    await waitForRun(thread.id);

    const replayAbort = new AbortController();
    const replay = await fetch(`${base}/api/threads/${thread.id}/stream?lastEventId=1`, {
      signal: replayAbort.signal,
    });
    const replayReader = replay.body!.getReader();
    const replayRead = await replayReader.read();
    replayAbort.abort();
    const replayChunk = new TextDecoder().decode(replayRead.value);
    expect(replayChunk).toContain("id: 2");
    expect(replayChunk).not.toContain("id: 1");

    expect(project.id).toBeTruthy();
    await app.close();
  }, 10000);

  it("validates individual reply targets and sends compact quoted context", async () => {
    const { app, project, thread } = await createProjectAndThread();
    await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "Original question" } });
    await waitForRun(thread.id);
    const original = store.getMessages(thread.id)[0]!;
    const other = store.createThread(project.id, { title: "Other", engine: "codex" });
    const rejected = await app.inject({ method: "POST", url: `/api/threads/${other.id}/messages`, payload: { text: "Cross-boundary", replyToMessageId: original.id } });
    expect(rejected.statusCode).toBe(400);
    const accepted = await app.inject({ method: "POST", url: `/api/threads/${thread.id}/messages`, payload: { text: "Specific answer", replyToMessageId: original.id } });
    expect(accepted.statusCode).toBe(200);
    expect(adapter.continues.at(-1)?.prompt).toContain("Replying specifically to this earlier message");
    expect(adapter.continues.at(-1)?.prompt).toContain("Original question");
    expect(store.getMessages(thread.id).find((message) => message.text === "Specific answer")?.replyTo?.messageId).toBe(original.id);
    await waitForRun(thread.id);
    await app.close();
  });

  it("delivers Reply Directly once and replays a stable receipt", async () => {
    const { app, project } = await createProjectAndThread();
    const master = store.createMasterChat(project.id, { title: "Room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: master.id });
    const other = store.createThread(project.id, { title: "Other", engine: "codex", masterChatId: master.id });
    const report = store.appendMasterChatMessage(master.id, { role: "assistant", text: "Result" }, author.id)!;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const upload = await app.inject({
      method: "POST",
      url: `/api/threads/${author.id}/attachments`,
      headers: { "content-type": "image/png", "x-ponderosa-filename": "direct.png" },
      payload: png,
    });
    expect(upload.statusCode).toBe(201);
    const attachmentId = upload.json<{ id: string }>().id;

    const accepted = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/direct-replies`,
      payload: { text: "Follow up", replyToMessageId: report.id, targetAuthorThreadId: author.id, attachmentIds: [attachmentId], idempotencyKey: "reply-1" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ replayed: false, targetAuthorThreadId: author.id });
    await waitForRun(author.id);

    const replayed = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/direct-replies`,
      payload: { text: "Follow up", replyToMessageId: report.id, targetAuthorThreadId: author.id, attachmentIds: [attachmentId], idempotencyKey: "reply-1" },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ replayed: true, messageId: accepted.json<{ messageId: string }>().messageId });
    expect(store.getMasterChatMessages(master.id).filter((message) => message.text === "Follow up")).toHaveLength(1);
    expect(store.getMessages(author.id).filter((message) => message.text === "Follow up")).toHaveLength(1);
    expect(store.getMasterChatMessages(master.id).find((message) => message.text === "Follow up")?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    expect(store.getMessages(author.id).find((message) => message.text === "Follow up")?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/direct-replies`,
      payload: { text: "Changed payload", replyToMessageId: report.id, targetAuthorThreadId: author.id, idempotencyKey: "reply-1" },
    });
    expect(conflict.statusCode).toBe(409);

    const concurrentPayload = { text: "Concurrent follow up", replyToMessageId: report.id, targetAuthorThreadId: author.id, idempotencyKey: "reply-concurrent" };
    const concurrent = await Promise.all([
      app.inject({ method: "POST", url: `/api/master-chats/${master.id}/direct-replies`, payload: concurrentPayload }),
      app.inject({ method: "POST", url: `/api/master-chats/${master.id}/direct-replies`, payload: concurrentPayload }),
    ]);
    expect(concurrent.some((response) => response.statusCode === 200)).toBe(true);
    const concurrentReplay = await app.inject({ method: "POST", url: `/api/master-chats/${master.id}/direct-replies`, payload: concurrentPayload });
    expect(concurrentReplay.json()).toMatchObject({ replayed: true });
    expect(store.getMasterChatMessages(master.id).filter((message) => message.text === concurrentPayload.text)).toHaveLength(1);
    await waitForRun(author.id, 2);

    const spoofed = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/direct-replies`,
      payload: { text: "Wrong target", replyToMessageId: report.id, targetAuthorThreadId: other.id, idempotencyKey: "reply-2" },
    });
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.json()).toMatchObject({ error: expect.stringMatching(/must be the author/) });
    await app.close();
  });

  it("repairs a same-process direct-reply crash window and double replay without duplicates or spawning", async () => {
    const { app, project } = await createProjectAndThread();
    const master = store.createMasterChat(project.id, { title: "Recovery room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: master.id });
    const report = store.appendMasterChatMessage(master.id, { role: "assistant", text: "Result" }, author.id)!;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const upload = await app.inject({
      method: "POST",
      url: `/api/threads/${author.id}/attachments`,
      headers: { "content-type": "image/png", "x-ponderosa-filename": "recovered.png" },
      payload: png,
    });
    const attachmentId = upload.json<{ id: string }>().id;
    const receiptKey = `direct-reply:${master.id}:crash-window`;
    const canonical = store.appendMasterChatMessage(
      master.id,
      { text: "Recovered follow up", replyToMessageId: report.id, directReplyToAuthorThreadId: author.id, attachments: [upload.json()] },
      undefined,
      "main",
      [{ targetThreadId: author.id, relayDepth: 0, mentionTrail: [], kind: "direct" }],
      receiptKey,
    )!;
    const threadCount = store.listThreads(project.id).length;
    const payload = { text: "Recovered follow up", replyToMessageId: report.id, targetAuthorThreadId: author.id, attachmentIds: [attachmentId], idempotencyKey: "crash-window" };
    const replay = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/direct-replies`,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ messageId: canonical.id, replayed: true });
    const secondReplay = await app.inject({ method: "POST", url: `/api/master-chats/${master.id}/direct-replies`, payload });
    expect(secondReplay.json()).toMatchObject({ messageId: canonical.id, replayed: true });
    await waitForRun(author.id);
    expect(store.getMasterChatMessages(master.id).filter((message) => message.text === "Recovered follow up")).toHaveLength(1);
    expect(store.getMessages(author.id).filter((message) => message.text === "Recovered follow up")).toHaveLength(1);
    expect(store.getMessages(author.id).find((message) => message.text === "Recovered follow up")?.attachments?.map((item) => item.id)).toEqual([attachmentId]);
    expect(store.listThreads(project.id)).toHaveLength(threadCount);
    await app.close();
  });

  it("returns a truthful retryable failure when a canonical direct reply has no persisted delivery intent", async () => {
    const { app, project } = await createProjectAndThread();
    const master = store.createMasterChat(project.id, { title: "Incomplete recovery room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: master.id });
    const report = store.appendMasterChatMessage(master.id, { role: "assistant", text: "Result" }, author.id)!;
    store.appendMasterChatMessage(
      master.id,
      { text: "Incomplete follow up", replyToMessageId: report.id, directReplyToAuthorThreadId: author.id },
      undefined,
      "main",
      undefined,
      `direct-reply:${master.id}:missing-intent`,
    );

    const replay = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/direct-replies`,
      payload: { text: "Incomplete follow up", replyToMessageId: report.id, targetAuthorThreadId: author.id, idempotencyKey: "missing-intent" },
    });
    expect(replay.statusCode).toBe(503);
    expect(replay.json()).toMatchObject({ retryable: true, error: expect.stringMatching(/intent is unavailable/) });
    expect(replay.json()).not.toHaveProperty("replayed");
    expect(store.getMessages(author.id).filter((message) => message.text === "Incomplete follow up")).toHaveLength(0);
    await app.close();
  });

  it("queues one direct reply for a busy author and deduplicates retries", async () => {
    const { app, project } = await createProjectAndThread();
    const master = store.createMasterChat(project.id, { title: "Busy room" });
    const author = store.createThread(project.id, { title: "Busy author", engine: "codex", masterChatId: master.id });
    const report = store.appendMasterChatMessage(master.id, { role: "assistant", text: "Working" }, author.id)!;
    adapter.mode = "hang";
    await app.inject({ method: "POST", url: `/api/threads/${author.id}/messages`, payload: { text: "Current work" } });
    await waitForSeedCount(1);

    const payload = { text: "Queued follow up", replyToMessageId: report.id, targetAuthorThreadId: author.id, idempotencyKey: "busy-reply" };
    const first = await app.inject({ method: "POST", url: `/api/master-chats/${master.id}/direct-replies`, payload });
    const retry = await app.inject({ method: "POST", url: `/api/master-chats/${master.id}/direct-replies`, payload });
    expect(first.json()).toMatchObject({ replayed: false, queued: true });
    expect(retry.json()).toMatchObject({ replayed: true, queued: true, messageId: first.json<{ messageId: string }>().messageId });
    expect(store.getMasterChatMessages(master.id).filter((message) => message.text === payload.text)).toHaveLength(1);

    adapter.mode = "normal";
    await app.inject({ method: "POST", url: `/api/threads/${author.id}/cancel` });
    for (let i = 0; i < 80 && !store.getMessages(author.id).some((message) => message.text === payload.text); i += 1) await sleep(10);
    expect(store.getMessages(author.id).filter((message) => message.text === payload.text)).toHaveLength(1);
    await app.close();
  });
});
