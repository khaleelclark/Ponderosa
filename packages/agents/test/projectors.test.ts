import { describe, expect, it } from "vitest";
import {
  initProjectionState,
  projectAll,
  projectEvent,
  type ProjectionOp,
} from "../src/projectors.js";
import type { StoredLogEvent } from "../src/log-event.js";

const T = "agent-1";

function stored(seq: number, event: StoredLogEvent["event"]): StoredLogEvent {
  return { seq, ts: `2026-01-01T00:00:0${seq}.000Z`, event };
}

function kinds(ops: ProjectionOp[]): string[] {
  return ops.map((o) => o.kind);
}

describe("projectEvent — routing (SPEC §5)", () => {
  it("user_message → a user Chat message and captures the pending run title", () => {
    const { ops } = projectEvent(T, initProjectionState("codex"), stored(1, {
      type: "user_message",
      text: "Refactor auth",
    }));
    const msg = ops.find((o) => o.kind === "insert_message");
    expect(msg).toBeDefined();
    if (msg?.kind === "insert_message") {
      expect(msg.row.role).toBe("user");
      expect(msg.row.text).toBe("Refactor auth");
      expect(msg.row.id).toBe("agent-1:m:1");
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

  it("lifecycle creates the canonical Run and command activity links its real execution id", () => {
    let state = initProjectionState("codex");
    state = projectEvent(T, state, stored(1, { type: "user_message", text: "go" })).state;
    const started = projectEvent(T, state, stored(2, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-real" }));
    const run = started.ops.find((o) => o.kind === "insert_run");
    expect(run?.kind === "insert_run" && run.row).toMatchObject({ id: "run-real", title: "go", status: "running" });
    const { ops } = projectEvent(T, started.state, stored(3, {
      type: "command",
      command: "pnpm test",
      cwd: "/p",
    }));
    expect(kinds(ops)).toContain("insert_artifact");
    expect(ops.some((o) => o.kind === "insert_message")).toBe(false);
    const artifact = ops.find((o) => o.kind === "insert_artifact");
    if (artifact?.kind === "insert_artifact") {
      expect(artifact.row.kind).toBe("log");
      expect(artifact.row.executionId).toBe("run-real");
      expect(artifact.row.path).toBe("000003-command.md");
      expect(artifact.content).toContain("pnpm test");
    }
  });

  it("file_change → an execution-associated diff Artifact", () => {
    let state = initProjectionState("codex");
    state = projectEvent(T, state, stored(1, { type: "user_message", text: "go" })).state;
    state = projectEvent(T, state, stored(2, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-real" })).state;
    const { ops } = projectEvent(T, state, stored(3, {
      type: "file_change",
      path: "auth.ts",
      kind: "edit",
      diff: "--- a/auth.ts\n+++ b/auth.ts\n-old\n+new",
    }));
    const art = ops.find((o) => o.kind === "insert_artifact");
    expect(art).toBeDefined();
    if (art?.kind === "insert_artifact") {
      expect(art.row.kind).toBe("diff");
      expect(art.row.id).toBe("agent-1:a:3:0");
      expect(art.row.path).toBe("000003-diff.patch");
      expect(art.row.executionId).toBe("run-real");
      expect(art.content).toContain("+new");
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

  it("explicit browser screenshot → a run-scoped screenshot Artifact, never Chat", () => {
    const { ops } = projectEvent(T, initProjectionState("codex"), stored(4, {
      type: "browser_screenshot",
      sessionId: "browser-1",
      executionId: "run-real",
      path: "browser/frame.png",
      width: 1280,
      height: 720,
    }));
    const artifact = ops.find((op) => op.kind === "insert_artifact");
    expect(artifact?.kind === "insert_artifact" && artifact.row).toMatchObject({
      id: "agent-1:a:4:0", executionId: "run-real", kind: "screenshot", path: "browser/frame.png",
    });
    expect(ops.some((op) => op.kind === "insert_message")).toBe(false);
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

  it("terminal lifecycle closes the exact execution rather than inferring from turn_done", () => {
    let state = initProjectionState("codex");
    state = projectEvent(T, state, stored(1, { type: "user_message", text: "go" })).state;
    state = projectEvent(T, state, stored(2, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-real" })).state;
    const { ops } = projectEvent(T, state, stored(3, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-real" }));
    const upd = ops.find((o) => o.kind === "update_run");
    expect(upd).toEqual({
      kind: "update_run",
      id: "run-real",
      status: "completed",
      reason: "turn_completed",
      updatedAt: "2026-01-01T00:00:03.000Z",
      completedAt: "2026-01-01T00:00:03.000Z",
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
      stored(3, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-1" }),
      stored(4, { type: "command", command: "pnpm i", cwd: "/p" }),
      stored(5, { type: "file_change", path: "a.ts", kind: "create" }),
      stored(6, { type: "text", delta: "done" }),
      stored(7, { type: "turn_done" }),
      stored(8, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-1" }),
    ];
    const a = JSON.stringify(projectAll(T, log, "codex"));
    const b = JSON.stringify(projectAll(T, log, "codex"));
    expect(a).toBe(b);
  });
});
