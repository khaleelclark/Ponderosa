import type { SseEventEnvelope, ThreadDetailDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { runningAfterAgentEvent, updateThreadDetail } from "../src/hooks/useThreadStream";
import { formatExecutionElapsed } from "../src/components/AgentDetail";

describe("updateThreadDetail", () => {
  it("formats a stable stopwatch from the canonical execution start", () => {
    expect(formatExecutionElapsed("2026-07-12T00:00:00.000Z", Date.parse("2026-07-12T00:02:03.000Z"))).toBe("2:03");
    expect(formatExecutionElapsed("2026-07-12T00:00:00.000Z", Date.parse("2026-07-12T01:02:03.000Z"))).toBe("1:02:03");
  });
  it("does not resurrect a finished run when its terminal lifecycle record arrives", () => {
    expect(runningAfterAgentEvent(true, { type: "turn_done" })).toBe(false);
    expect(runningAfterAgentEvent(false, { type: "agent_lifecycle", status: "completed", reason: "turn_completed" })).toBe(false);
    expect(runningAfterAgentEvent(false, { type: "agent_lifecycle", status: "running", reason: "active_run" })).toBe(true);
  });

  it("keeps streamed response and reasoning deltas in distinct transient Work log entries", () => {
    const detail = {
      messages: [],
      runOutput: [],
      activity: [],
      changedFiles: [],
      tasks: [],
      artifacts: [],
      thread: { activeEngine: "codex" },
    } as unknown as ThreadDetailDto;
    const response = {
      seq: 3,
      ts: "2026-07-11T08:00:01.000Z",
      event: { type: "text", delta: "final answer", executionId: "run-1" },
    } as SseEventEnvelope;
    const reasoning = {
      seq: 4,
      ts: "2026-07-11T08:00:02.000Z",
      event: { type: "reasoning", delta: "checking", executionId: "run-1" },
    } as SseEventEnvelope;

    const updated = updateThreadDetail("thread-1", reasoning, updateThreadDetail("thread-1", response, detail));
    expect(updated.messages).toEqual([]);
    expect(updated.runOutput).toEqual([
      expect.objectContaining({ kind: "response", text: "final answer", completed: false, executionId: "run-1" }),
      expect.objectContaining({ kind: "reasoning", text: "checking", completed: false, executionId: "run-1" }),
    ]);
  });

  it("replaces transient response text with the canonical completed output", () => {
    const detail = {
      messages: [],
      runOutput: [{
        id: "live-runOutput:run-1:response", threadId: "thread-1", executionId: "run-1", kind: "response",
        text: "partial", completed: false, seq: 2, sourceSeqStart: 2, sourceSeqEnd: 2, createdAt: "2026-07-11T08:00:00.000Z",
      }],
      tasks: [], artifacts: [], thread: { activeEngine: "codex" },
    } as unknown as ThreadDetailDto;
    const envelope = {
      seq: 5,
      ts: "2026-07-11T08:00:03.000Z",
      event: { type: "agent_output", executionId: "run-1", text: "complete", sourceSeqStart: 2, sourceSeqEnd: 4 },
    } as SseEventEnvelope;

    expect(updateThreadDetail("thread-1", envelope, detail).runOutput).toEqual([
      expect.objectContaining({ kind: "response", text: "complete", completed: true, executionId: "run-1", seq: 5 }),
    ]);
  });

  it("ignores invalid cached tasks while projecting a task update", () => {
    const detail = {
      messages: [],
      tasks: [undefined],
      artifacts: [],
      thread: { activeEngine: "codex" },
    } as unknown as ThreadDetailDto;
    const envelope = {
      seq: 4,
      ts: "2026-07-11T08:00:02.000Z",
      event: { type: "task_update", taskId: "task-1", title: "Run checks", status: "running" },
    } as SseEventEnvelope;

    expect(updateThreadDetail("thread-1", envelope, detail).tasks).toEqual([
      expect.objectContaining({ id: "thread-1:t:task-1", title: "Run checks", status: "running" }),
    ]);
  });

  it("ignores invalid cached artifacts while projecting a file change", () => {
    const detail = {
      messages: [],
      tasks: [],
      artifacts: [undefined],
      thread: { activeEngine: "codex" },
    } as unknown as ThreadDetailDto;
    const envelope = {
      seq: 5,
      ts: "2026-07-11T08:00:03.000Z",
      event: { type: "file_change", path: "src/app.ts", kind: "modified" },
    } as SseEventEnvelope;

    expect(updateThreadDetail("thread-1", envelope, detail).artifacts).toEqual([
      expect.objectContaining({ id: "live-artifact-5", path: "src/app.ts" }),
    ]);
  });

  it("projects streamed execution activity and changed files without duplicating replay", () => {
    const detail = {
      messages: [], runOutput: [], activity: [], changedFiles: [], tasks: [], artifacts: [],
      thread: { activeEngine: "codex" },
    } as unknown as ThreadDetailDto;
    const envelope = {
      seq: 9, ts: "2026-07-11T08:00:04.000Z",
      event: { type: "file_change", path: "src/index.ts", kind: "edit", diff: "+export {}" },
    } as SseEventEnvelope;
    const once = updateThreadDetail("thread-1", envelope, detail);
    const twice = updateThreadDetail("thread-1", { ...envelope, replayed: true }, once);
    expect(twice.activity).toEqual([expect.objectContaining({ seq: 9, event: envelope.event })]);
    expect(twice.changedFiles).toEqual([expect.objectContaining({ path: "src/index.ts", diff: "+export {}" })]);
  });
});
