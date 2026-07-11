import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AgentEvent, ContinueOptions, EffortOption, ModelOption, SeedOptions } from "@ponderosa/core";
import { ThreadStore } from "@ponderosa/threads";
import { createServer, type EngineRegistration } from "../src/app.js";
import { CollaborationDeliveryStore } from "../src/handoffs.js";
import { DelegationStore } from "../src/delegations.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class MockAdapter implements Adapter {
  id = "codex";
  displayName = "Mock Codex";
  readonly seeds: SeedOptions[] = [];
  readonly continues: ContinueOptions[] = [];
  abortedSeeds = 0;
  mode: "normal" | "hang" | "boundary" = "normal";
  responseText = "done";

  listModels(): ModelOption[] {
    return [{ id: "mock-model", label: "Mock Model" }];
  }

  listEfforts(): EffortOption[] {
    return [{ id: "high", label: "High" }];
  }

  async *seed(opts: SeedOptions): AsyncIterable<AgentEvent> {
    this.seeds.push(opts);
    yield { type: "session", sessionId: "sess-1" };
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

  it("sends current master-chat context and teammate reply guidance on spawn and mention turns", async () => {
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
      "separate it from preceding text with whitespace",
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
    expect(adapter.continues[0]?.prompt).toContain("The main chat is manager-facing");
    expect(adapter.continues[0]?.prompt).toContain("do not use @mentions here to coordinate with teammates");
    expect(adapter.continues[0]?.prompt).toContain("Agent-to-agent discussion belongs in the separate Collaboration chat");
    expect(adapter.continues[0]?.prompt).toContain("Do not repeat, recap, or answer with the whole conversation");
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
    expect(store.getMasterChatMessages(master.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", text: "Check the first-run path." })]),
    );
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
    expect(adapter.seeds[0]?.prompt).toContain("You received this context because you were successfully @mentioned.");
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
    expect(adapter.seeds[0]?.prompt).toContain("You received this context because you were successfully @mentioned.");
    expect(store.getMessages(wrangell.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", text: "@Wrangell-St-Elias can you review this?" })]),
    );
    await app.close();
  });

  it("never sends collaboration context until a valid agent mention is accepted", async () => {
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
    expect(untargeted.statusCode).toBe(200);
    expect(adapter.seeds).toHaveLength(0);

    const targeted = await app.inject({
      method: "POST",
      url: `/api/master-chats/${master.id}/collaboration/messages`,
      payload: { text: "@Yosemite Please review the private notes." },
    });
    expect(targeted.statusCode).toBe(200);
    await waitForRun(agent.id);

    const prompt = adapter.seeds[0]?.prompt ?? "";
    expect(prompt).toContain("Private review notes that should not reach an agent yet.");
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

  it("lets an active agent send authenticated messages to all three channels", async () => {
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
    const send = (channel: "individual" | "main" | "collaboration", text: string) =>
      app.inject({
        method: "POST",
        url: "/api/agent-messages",
        headers: { authorization: `Bearer ${token}` },
        payload: { channel, text },
      });

    expect((await send("individual", "Private implementation note.")).statusCode).toBe(200);
    expect((await send("main", "Manager-facing checkpoint.")).statusCode).toBe(200);
    expect((await send("collaboration", "@Review-Agent Please review the API contract.")).statusCode).toBe(200);
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
    await Promise.all([cancelAndWait(app, author.id), cancelAndWait(app, reviewer.id)]);
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
    // its queued tags; all three start as separate FIFO continuation turns.
    adapter.mode = "normal";
    await app.inject({ method: "POST", url: `/api/threads/${parent.id}/cancel` });
    await waitForRun(parent.id, 3);
    expect(adapter.continues.filter((turn) => turn.threadId === parent.id)).toHaveLength(3);
    expect(store.getMessages(parent.id).filter((message) => message.role === "user").map((message) => message.text)).toEqual(
      expect.arrayContaining(["@Parent first completed result", "@Parent second completed result", "@Parent third completed result"]),
    );
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
    await waitForRun(parent.id, 3);
    expect(adapter.continues.filter((turn) => turn.threadId === parent.id)).toHaveLength(2);
    expect(adapter.continues.map((turn) => turn.prompt)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Latest message for you:\n@Parent result one"),
        expect.stringContaining("Latest message for you:\n@Parent result two"),
      ]),
    );
    await app.close();
  });

  it("automatically records and delivers a delegated completion to its active parent", async () => {
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
      expect.objectContaining({ id: run.id, status: "completed", completionDelivery: expect.objectContaining({ status: "queued" }) }),
    ]);

    await app.inject({ method: "POST", url: `/api/threads/${parent.id}/cancel` });
    await waitForRun(parent.id, 1);
    expect(adapter.continues.filter((turn) => turn.threadId === parent.id)).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/master-chats/${master.id}/subagents` })).json()).toEqual([
      expect.objectContaining({ id: run.id, completionDelivery: expect.objectContaining({ status: "acknowledged" }) }),
    ]);
    const completionMessage = store.getCollaborationChatDetail(master.id)?.messages.find(
      (message) => message.text.includes("Delegated task “Research” completed"),
    );
    expect(completionMessage?.text).toContain("@Parent, the result is ready");
    expect(completionMessage?.text).not.toContain("has been notified");
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
    await waitForRun(parent.id, 2);

    expect(adapter.seeds.find((turn) => turn.threadId === parent.id)?.prompt).toContain(
      "Latest message for you:\n@Parent interrupted first result",
    );
    expect(adapter.continues.find((turn) => turn.threadId === parent.id)?.prompt).toContain(
      "Latest message for you:\n@Parent queued second result",
    );
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

  it("preserves canonical FIFO when an older message is reconstructed", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "FIFO crash window" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const deliveries = new CollaborationDeliveryStore(dataDir);
    const intent = { targetThreadId: parent.id, relayDepth: 0, mentionTrail: [], kind: "tag" as const };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
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
    await waitForRun(parent.id, 2);
    const turns = [
      ...adapter.seeds.filter((turn) => turn.threadId === parent.id),
      ...adapter.continues.filter((turn) => turn.threadId === parent.id),
    ];
    expect(turns[0]?.prompt).toContain("Latest message for you:\n@Parent older message missing its inbox write");
    expect(turns[1]?.prompt).toContain("Latest message for you:\n@Parent newer message already queued");
    await app.close();
  });

  it("preserves mixed collaboration and direct FIFO when timestamps tie", async () => {
    const project = store.createProject({ label: "Demo", hostPath: repoDir });
    const master = store.createMasterChat(project.id, { title: "Mixed FIFO crash window" });
    const parent = store.createThread(project.id, { title: "Parent", engine: "codex", masterChatId: master.id });
    const deliveries = new CollaborationDeliveryStore(dataDir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
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
    delegations.settle(spawned.run.id, "completed");
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
      expect.objectContaining({ id: queued.run.id, status: "completed" }),
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
    expect(response.json()).toEqual({ error: "collaboration context must be delivered by a successful @mention" });
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
    await waitForRun(reviewer.id, 51);
    expect(adapter.continues).toHaveLength(51);
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
    expect(concurrent.json()).toEqual({ queued: true, position: 1 });

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
});
