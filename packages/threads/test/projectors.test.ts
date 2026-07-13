import { describe, expect, it } from "vitest";
import {
  initProjectionState,
  projectAll,
  projectEvent,
  type ProjectionOp,
} from "../src/projectors.js";
import type { StoredLogEvent } from "../src/log-event.js";

const T = "thread-1";

function stored(seq: number, event: StoredLogEvent["event"]): StoredLogEvent {
  return { seq, ts: `2026-01-01T00:00:0${seq}.000Z`, event };
}

function kinds(ops: ProjectionOp[]): string[] {
  return ops.map((o) => o.kind);
}

describe("projectEvent — routing (SPEC §5)", () => {
  it("user_message → a user Chat message + opens a run", () => {
    const { ops } = projectEvent(T, initProjectionState("codex"), stored(1, {
      type: "user_message",
      text: "Refactor auth",
    }));
    const msg = ops.find((o) => o.kind === "insert_message");
    expect(msg).toBeDefined();
    if (msg?.kind === "insert_message") {
      expect(msg.row.role).toBe("user");
      expect(msg.row.text).toBe("Refactor auth");
      expect(msg.row.id).toBe("thread-1:m:1");
    }
    expect(kinds(ops)).toContain("insert_event");
  });

  it("ordinary text remains execution data and never creates a Chat message", () => {
    const { ops } = projectEvent(T, initProjectionState("codex"), stored(2, {
      type: "text",
      delta: "Working on it",
    }));
    expect(kinds(ops)).toEqual(["insert_event"]);
    expect(ops.some((o) => o.kind === "insert_message")).toBe(false);
  });

  it("completed agent output remains execution data and never creates a Chat message", () => {
    const { ops } = projectEvent(T, initProjectionState("codex"), stored(3, {
      type: "agent_output",
      executionId: "run-1",
      text: "Completed result",
      sourceSeqStart: 1,
      sourceSeqEnd: 2,
    }));
    expect(kinds(ops)).toEqual(["insert_event"]);
    expect(ops.some((o) => o.kind === "insert_message")).toBe(false);
  });

  it("reasoning → NOT a Chat message (events index only; keeps Chat clean)", () => {
    const { ops } = projectEvent(T, initProjectionState("codex"), stored(3, {
      type: "reasoning",
      delta: "runOutput…",
    }));
    expect(kinds(ops)).toEqual(["insert_event"]);
    expect(ops.some((o) => o.kind === "insert_message")).toBe(false);
  });

  it("command → creates a Task + log Artifact (execution), no Chat message", () => {
    let state = initProjectionState("codex");
    // open a run first
    state = projectEvent(T, state, stored(1, { type: "user_message", text: "go" })).state;
    const { ops } = projectEvent(T, state, stored(2, {
      type: "command",
      command: "pnpm test",
      cwd: "/p",
    }));
    expect(kinds(ops)).toContain("insert_task");
    expect(kinds(ops)).toContain("insert_artifact");
    expect(ops.some((o) => o.kind === "insert_message")).toBe(false);
    const task = ops.find((o) => o.kind === "insert_task");
    if (task?.kind === "insert_task") {
      expect(task.row.status).toBe("running");
      expect(task.row.id).toBe("thread-1:t:1"); // keyed by opening user_message seq
      expect(task.row.title).toBe("go");
    }
    const artifact = ops.find((o) => o.kind === "insert_artifact");
    if (artifact?.kind === "insert_artifact") {
      expect(artifact.row.kind).toBe("log");
      expect(artifact.row.path).toBe("000002-command.md");
      expect(artifact.content).toContain("pnpm test");
    }
  });

  it("file_change → Task + a diff Artifact", () => {
    let state = initProjectionState("codex");
    state = projectEvent(T, state, stored(1, { type: "user_message", text: "go" })).state;
    const { ops } = projectEvent(T, state, stored(2, {
      type: "file_change",
      path: "auth.ts",
      kind: "edit",
    }));
    const art = ops.find((o) => o.kind === "insert_artifact");
    expect(art).toBeDefined();
    if (art?.kind === "insert_artifact") {
      expect(art.row.kind).toBe("diff");
      expect(art.row.path).toBe("000002-diff.patch");
      expect(art.row.taskId).toBe("thread-1:t:1");
      expect(art.content).toContain("No diff text was provided");
    }
  });

  it("test_result → a test_report Artifact", () => {
    let state = initProjectionState("codex");
    state = projectEvent(T, state, stored(1, { type: "user_message", text: "go" })).state;
    const { ops } = projectEvent(T, state, stored(2, {
      type: "test_result",
      passed: false,
      summary: "2 failed",
    }));
    const art = ops.find((o) => o.kind === "insert_artifact");
    expect(art?.kind === "insert_artifact" && art.row.kind).toBe("test_report");
  });

  it("session → set_session for engine-agnostic resume", () => {
    const { ops } = projectEvent(T, initProjectionState("codex"), stored(1, {
      type: "session",
      sessionId: "sess-9",
    }));
    const s = ops.find((o) => o.kind === "set_session");
    expect(s).toEqual({ kind: "set_session", sessionId: "sess-9" });
  });

  it("session_reset clears the projected provider session", () => {
    const { ops } = projectEvent(T, initProjectionState("codex"), stored(2, {
      type: "session_reset",
      reason: "resume_compaction_failed",
    }));
    expect(ops).toContainEqual({ kind: "set_session", sessionId: null });
  });

  it("turn_done → closes the open task as done", () => {
    let state = initProjectionState("codex");
    state = projectEvent(T, state, stored(1, { type: "user_message", text: "go" })).state;
    state = projectEvent(T, state, stored(2, { type: "command", command: "x", cwd: "/p" })).state;
    const { ops } = projectEvent(T, state, stored(3, { type: "turn_done" }));
    const upd = ops.find((o) => o.kind === "update_task");
    expect(upd).toEqual({
      kind: "update_task",
      id: "thread-1:t:1",
      status: "done",
      updatedAt: "2026-01-01T00:00:03.000Z",
    });
  });

  it("every event lands in the searchable events index", () => {
    for (const ev of [
      { type: "text", delta: "hi" } as const,
      { type: "reasoning", delta: "x" } as const,
      { type: "tool_call", id: "a", name: "n", input: {} } as const,
      { type: "error", message: "boom" } as const,
    ]) {
      const { ops } = projectEvent(T, initProjectionState("codex"), stored(1, ev));
      expect(ops.some((o) => o.kind === "insert_event")).toBe(true);
    }
  });
});

describe("projectAll determinism", () => {
  it("is a pure function of its inputs (same ops every run)", () => {
    const log: StoredLogEvent[] = [
      stored(1, { type: "user_message", text: "go" }),
      stored(2, { type: "session", sessionId: "s1" }),
      stored(3, { type: "command", command: "pnpm i", cwd: "/p" }),
      stored(4, { type: "file_change", path: "a.ts", kind: "create" }),
      stored(5, { type: "text", delta: "done" }),
      stored(6, { type: "turn_done" }),
    ];
    const a = JSON.stringify(projectAll(T, log, "codex"));
    const b = JSON.stringify(projectAll(T, log, "codex"));
    expect(a).toBe(b);
  });
});
