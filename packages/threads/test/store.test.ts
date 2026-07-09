import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadStore } from "../src/store.js";
import type { LogEvent } from "../src/log-event.js";

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
  const tables = ["projects", "threads", "messages", "tasks", "artifacts", "events"];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM ${t} ORDER BY id`).all() as unknown[];
    out[t] = rows;
  }
  return out;
}

function seedThread(): { projectId: string; threadId: string } {
  const project = store.createProject({ label: "Demo", hostPath: "/repo" });
  const thread = store.createThread(project.id, { title: "Auth", engine: "codex" });
  return { projectId: project.id, threadId: thread.id };
}

const RUN: LogEvent[] = [
  { type: "user_message", text: "Refactor authentication" },
  { type: "session", sessionId: "sess-abc" },
  { type: "text", delta: "I'll handle this." },
  { type: "command", command: "pnpm test", cwd: "/repo" },
  { type: "tool_result", id: "i0", output: "ok", isError: false },
  { type: "file_change", path: "auth.ts", kind: "edit" },
  { type: "text", delta: "Done — auth refactor complete." },
  { type: "turn_done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
];

describe("ThreadStore — append + projection", () => {
  it("projects a full run into the four panes", () => {
    const { threadId } = seedThread();
    for (const ev of RUN) store.appendEvent(threadId, ev);

    const detail = store.getThreadDetail(threadId)!;
    // Chat: user turn + 2 assistant texts (reasoning would NOT appear)
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    // Tasks: one task, closed done by turn_done
    expect(detail.tasks).toHaveLength(1);
    expect(detail.tasks[0]!.status).toBe("done");
    expect(detail.tasks[0]!.title).toBe("Refactor authentication");
    // Artifacts: one diff from the file_change
    expect(detail.artifacts).toHaveLength(1);
    expect(detail.artifacts[0]!.kind).toBe("diff");
    expect(detail.artifacts[0]!.path).toBe("auth.ts");
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
    store.rebuildProjections();
    const after = snapshot(store);

    expect(after).toEqual(before);
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
    for (const t of ["projects", "threads", "messages", "tasks", "artifacts", "events"]) {
      db.exec(`DELETE FROM ${t}`);
    }
    expect((snapshot(store).messages as unknown[]).length).toBe(0);

    store.rebuildProjections();
    expect(snapshot(store)).toEqual(before);
  });
});
