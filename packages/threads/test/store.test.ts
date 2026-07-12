import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadStore } from "../src/store.js";
import type { LogEvent } from "../src/log-event.js";
import { artifactContentPath, masterChatMessagesPath } from "../src/paths.js";

let dir: string;
let store: ThreadStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pond-store-"));
  store = new ThreadStore(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Read every projection table as plain sorted rows (for equality snapshots). */
function snapshot(s: ThreadStore): Record<string, unknown[]> {
  const db = s.sqlite;
  const tables = [
    "projects",
    "agent_presets",
    "master_chats",
    "master_chat_messages",
    "thread_master_chat_memberships",
    "threads",
    "messages",
    "tasks",
    "artifacts",
    "events",
  ];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const order = t === "thread_master_chat_memberships" ? "thread_id, position" : "id";
    const rows = db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all() as unknown[];
    out[t] = rows;
  }
  return out;
}

function seedThread(): { projectId: string; threadId: string } {
  const project = store.createProject({ label: "Demo", hostPath: "/repo" });
  const thread = store.createThread(project.id, { title: "Auth", engine: "codex" });
  return { projectId: project.id, threadId: thread.id };
}

describe("ThreadStore — multi-master-chat membership", () => {
  it("rebuilds membership and removes only a deleted room", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const first = store.createMasterChat(project.id, { title: "First" });
    const second = store.createMasterChat(project.id, { title: "Second" });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex", masterChatId: first.id });
    expect(store.updateThreadMasterChatMemberships(thread.id, { masterChatIds: [first.id, second.id], primaryMasterChatId: second.id }))
      .toMatchObject({ masterChatId: second.id, masterChatIds: [first.id, second.id] });
    expect(store.getMasterChatDetail(first.id)?.threads.map((item) => item.id)).toEqual([thread.id]);
    expect(store.getMasterChatDetail(second.id)?.threads.map((item) => item.id)).toEqual([thread.id]);
    store.rebuildProjections();
    expect(store.getThread(thread.id)?.masterChatIds).toEqual([first.id, second.id]);
    store.deleteMasterChat(second.id);
    expect(store.getThread(thread.id)).toMatchObject({ masterChatId: first.id, masterChatIds: [first.id] });
  });

  it("rejects cross-project membership", () => {
    const one = store.createProject({ label: "One", hostPath: "/one" });
    const two = store.createProject({ label: "Two", hostPath: "/two" });
    const thread = store.createThread(one.id, { title: "Agent", engine: "codex" });
    const foreign = store.createMasterChat(two.id, { title: "Foreign" });
    expect(() => store.updateThreadMasterChatMemberships(thread.id, { masterChatIds: [foreign.id], primaryMasterChatId: foreign.id })).toThrow("does not belong");
  });
});

const RUN: LogEvent[] = [
  { type: "user_message", text: "Refactor authentication" },
  { type: "session", sessionId: "sess-abc" },
  { type: "text", delta: "I'll handle this." },
  { type: "command", command: "pnpm test", cwd: "/repo" },
  { type: "tool_result", id: "i0", output: "ok", isError: false },
  {
    type: "file_change",
    path: "auth.ts",
    kind: "edit",
    diff: "diff --git a/auth.ts b/auth.ts\n",
  },
  { type: "text", delta: "Done — auth refactor complete." },
  { type: "turn_done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
];

describe("ThreadStore — append + projection", () => {
  it("projects a full run into the four panes", () => {
    const { projectId, threadId } = seedThread();
    for (const ev of RUN) store.appendEvent(threadId, ev);

    const detail = store.getThreadDetail(threadId)!;
    // Chat: user turn + 2 assistant texts (reasoning would NOT appear)
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    // Tasks: one task, closed done by turn_done
    expect(detail.tasks).toHaveLength(1);
    expect(detail.tasks[0]!.status).toBe("done");
    expect(detail.tasks[0]!.title).toBe("Refactor authentication");
    // Artifacts: command log + diff from the file_change
    expect(detail.artifacts).toHaveLength(2);
    expect(detail.artifacts.map((a) => a.kind)).toEqual(["log", "diff"]);
    expect(detail.artifacts[0]!.path).toBe("000004-command.md");
    expect(detail.artifacts[1]!.path).toBe("000006-diff.patch");
    const commandFile = artifactContentPath(
      dir,
      projectId,
      threadId,
      detail.artifacts[0]!.path,
    );
    expect(existsSync(commandFile)).toBe(true);
    expect(readFileSync(commandFile, "utf8")).toContain("pnpm test");
    // session id captured for resume
    expect(store.resumeSessionId(threadId)).toBe("sess-abc");
  });

  it("assigns monotonic per-thread seq and is append-only (readSince works)", () => {
    const { threadId } = seedThread();
    const seqs = RUN.map((ev) => store.appendEvent(threadId, ev).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(store.readEvents(threadId)).toHaveLength(8);
    // SSE replay-from-seq
    expect(store.readEventsSince(threadId, 5).map((e) => e.seq)).toEqual([6, 7, 8]);
    // The public surface has no update/delete of events (append-only by design).
    expect((store as unknown as Record<string, unknown>)["deleteEvent"]).toBeUndefined();
  });

  it("clears only the resumable engine session for fresh-session rollover", () => {
    const { threadId } = seedThread();
    store.appendEvent(threadId, { type: "session", sessionId: "stale-session" });
    const before = store.getThread(threadId);
    const eventsBefore = store.readEvents(threadId);

    expect(store.clearResumeSession(threadId, "explicit_compaction")).toBe(true);
    expect(store.resumeSessionId(threadId)).toBeUndefined();
    expect(store.getThread(threadId)).toMatchObject({
      id: before?.id,
      projectId: before?.projectId,
      masterChatId: before?.masterChatId,
      masterChatIds: before?.masterChatIds,
    });
    expect(store.readEvents(threadId).slice(0, -1)).toEqual(eventsBefore);
    expect(store.readEvents(threadId).at(-1)?.event).toEqual({
      type: "session_reset",
      reason: "explicit_compaction",
    });
    store.rebuildProjections();
    expect(store.resumeSessionId(threadId)).toBeUndefined();
    expect(store.clearResumeSession("missing-thread", "explicit_compaction")).toBe(false);
  });
});

describe("ThreadStore — rebuild is byte-identical (the property)", () => {
  it("wiping SQLite and rebuilding from the logs yields identical rows", () => {
    // Two threads, two runs, to exercise multiple projects/threads.
    const p = store.createProject({ label: "Demo", hostPath: "/repo" });
    const t1 = store.createThread(p.id, { title: "Auth", engine: "codex" });
    const t2 = store.createThread(p.id, { title: "UI", engine: "codex" });
    for (const ev of RUN) store.appendEvent(t1.id, ev);
    for (const ev of RUN.slice(0, 5)) store.appendEvent(t2.id, ev);
    // a second run on t1
    store.appendEvent(t1.id, { type: "user_message", text: "Now fix mobile login" });
    store.appendEvent(t1.id, { type: "command", command: "pnpm build", cwd: "/repo" });
    store.appendEvent(t1.id, { type: "turn_done" });

    const before = snapshot(store);
    const commandFile = artifactContentPath(dir, p.id, t1.id, "000004-command.md");
    const staleFile = artifactContentPath(dir, p.id, t1.id, "stale.txt");
    writeFileSync(commandFile, "stale command content", "utf8");
    writeFileSync(staleFile, "old derived artifact", "utf8");

    store.rebuildProjections();
    const after = snapshot(store);

    expect(after).toEqual(before);
    expect(readFileSync(commandFile, "utf8")).toContain("pnpm test");
    expect(existsSync(staleFile)).toBe(false);
    // sanity: it actually contained data
    expect((before.messages as unknown[]).length).toBeGreaterThan(0);
    expect((before.tasks as unknown[]).length).toBeGreaterThan(0);
    expect((before.events as unknown[]).length).toBeGreaterThan(0);
  });

  it("rebuild reconstructs projections after a total SQLite loss", () => {
    const { threadId } = seedThread();
    for (const ev of RUN) store.appendEvent(threadId, ev);
    const before = snapshot(store);

    // Simulate SQLite loss: delete all projection rows, then rebuild from logs.
    const db = store.sqlite;
    for (const t of [
      "projects",
      "master_chats",
      "master_chat_messages",
      "threads",
      "messages",
      "tasks",
      "artifacts",
      "events",
    ]) {
      db.exec(`DELETE FROM ${t}`);
    }
    expect((snapshot(store).messages as unknown[]).length).toBe(0);

    store.rebuildProjections();
    expect(snapshot(store)).toEqual(before);
  });

  it("catches a stale SQLite projection up automatically on restart", () => {
    const { threadId } = seedThread();
    for (const ev of RUN) store.appendEvent(threadId, ev);
    const before = snapshot(store);
    store.sqlite.exec("DELETE FROM events; DELETE FROM messages; DELETE FROM tasks; DELETE FROM artifacts;");
    store.close();

    store = new ThreadStore(dir);
    expect(snapshot(store)).toEqual(before);
  });

  it("persists model-agnostic master chats and linked agent threads across rebuilds", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const masterChat = store.createMasterChat(project.id, {
      title: "Release control room",
      defaultEngine: "codex",
      defaultModel: "gpt-5",
      defaultEffort: "high",
    });
    const message = store.appendMasterChatMessage(masterChat.id, {
      text: "Spin up one agent for API work and one for UI work.",
    });
    const thread = store.createThread(project.id, {
      title: "API agent",
      engine: "codex",
      masterChatId: masterChat.id,
    });

    expect(message?.role).toBe("user");
    expect(thread.masterChatId).toBe(masterChat.id);

    const before = snapshot(store);
    store.rebuildProjections();

    expect(snapshot(store)).toEqual(before);
    expect(store.getMasterChatDetail(masterChat.id)).toMatchObject({
      masterChat: {
        id: masterChat.id,
        title: "Release control room",
        defaultEngine: "codex",
      },
      messages: [{ text: "Spin up one agent for API work and one for UI work." }],
      threads: [{ id: thread.id, masterChatId: masterChat.id }],
    });
  });

  it("persists reply references canonically for thread and master-chat messages", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const master = store.createMasterChat(project.id, { title: "Room" });
    const first = store.appendMasterChatMessage(master.id, { text: "Original context" })!;
    store.appendMasterChatMessage(master.id, { text: "Answer", replyToMessageId: first.id });
    const thread = store.createThread(project.id, { title: "Agent", engine: "codex" });
    store.appendEvent(thread.id, { type: "user_message", text: "Thread original" });
    const originalMessageId = store.getMessages(thread.id)[0]!.id;
    store.appendEvent(thread.id, {
      type: "user_message",
      text: "Thread answer",
      replyTo: { messageId: originalMessageId, text: "Thread original", role: "user" },
    });

    store.rebuildProjections();
    expect(store.getMasterChatMessages(master.id)[1]?.replyTo).toMatchObject({ messageId: first.id, text: "Original context" });
    expect(store.getMessages(thread.id)[1]?.replyTo).toMatchObject({ text: "Thread original" });
    expect(() => store.appendMasterChatMessage(master.id, { text: "bad", replyToMessageId: "elsewhere" })).toThrow(/not found/);
  });

  it("records direct replies only for the referenced active agent author", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    const master = store.createMasterChat(project.id, { title: "Room" });
    const author = store.createThread(project.id, { title: "Author", engine: "codex", masterChatId: master.id });
    const other = store.createThread(project.id, { title: "Other", engine: "codex", masterChatId: master.id });
    const report = store.appendMasterChatMessage(master.id, { role: "assistant", text: "Done" }, author.id)!;
    const managerMessage = store.appendMasterChatMessage(master.id, { text: "Manager note" })!;

    const direct = store.appendMasterChatMessage(master.id, {
      text: "Please revise",
      replyToMessageId: report.id,
      directReplyToAuthorThreadId: author.id,
    }, undefined, "main", [{ targetThreadId: author.id, relayDepth: 0, mentionTrail: [], kind: "direct" }], "direct-receipt")!;
    expect(direct.replyTo?.authorThreadId).toBe(author.id);
    expect(store.getMasterChatMessageByReceiptKey(master.id, "direct-receipt")?.id).toBe(direct.id);
    expect(store.getMasterChatDeliveryIntents(master.id)).toMatchObject([{ message: { id: direct.id }, intent: { kind: "direct", targetThreadId: author.id }, messageReceiptKey: "direct-receipt" }]);
    expect(readFileSync(masterChatMessagesPath(dir, project.id, master.id), "utf8"))
      .toContain(`"directReplyToAuthorThreadId":"${author.id}"`);
    expect(() => store.appendMasterChatMessage(master.id, {
      text: "Spoofed",
      replyToMessageId: report.id,
      directReplyToAuthorThreadId: other.id,
    })).toThrow(/must be the author/);
    expect(() => store.appendMasterChatMessage(master.id, {
      text: "No agent author",
      replyToMessageId: managerMessage.id,
      directReplyToAuthorThreadId: author.id,
    })).toThrow(/must be the author/);

    store.updateThread(author.id, { archived: true });
    expect(() => store.appendMasterChatMessage(master.id, {
      text: "Archived",
      replyToMessageId: report.id,
      directReplyToAuthorThreadId: author.id,
    })).toThrow(/not an active agent/);
  });
});

describe("artifactContentPath", () => {
  it("keeps artifact reads and writes inside the thread artifacts directory", () => {
    const { projectId, threadId } = seedThread();

    expect(artifactContentPath(dir, projectId, threadId, "000001-command.md")).toContain(
      "artifacts",
    );
    expect(() => artifactContentPath(dir, projectId, threadId, "../thread.json")).toThrow(
      /escapes/,
    );
    expect(() => artifactContentPath(dir, projectId, threadId, "/tmp/elsewhere")).toThrow(
      /escapes/,
    );
  });
});

describe("agent presets", () => {
  it("seeds editable suggestions, persists CRUD canonically, and snapshots guidance at spawn", () => {
    const project = store.createProject({ label: "Demo", hostPath: "/repo" });
    expect(store.listAgentPresets(project.id).map((preset) => preset.name)).toEqual(["Documentation", "Frontend", "QA", "Security"]);
    const preset = store.createAgentPreset(project.id, { name: "Release", description: "Ship safely", guidance: "Verify every release gate before shipping.", engine: "codex", enabled: true });
    const thread = store.createThread(project.id, { title: "Ship", engine: "codex", presetId: preset.id });
    store.updateAgentPreset(preset.id, { guidance: "Changed later and must not affect active agents." });
    expect(store.getThread(thread.id)?.presetSnapshot?.guidance).toBe("Verify every release gate before shipping.");
    expect(store.deleteAgentPreset(preset.id)).toBe(true);
    store.rebuildProjections();
    expect(store.getAgentPreset(preset.id)).toBeUndefined();
    expect(store.getThread(thread.id)?.presetSnapshot?.name).toBe("Release");
  });
});
