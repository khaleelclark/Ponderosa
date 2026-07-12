import type { MessageDto, SseEventEnvelope, ThreadDetailDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { runningAfterAgentEvent, updateThreadDetail } from "../src/hooks/useThreadStream";

describe("updateThreadDetail", () => {
  it("does not resurrect a finished run when its terminal lifecycle record arrives", () => {
    expect(runningAfterAgentEvent(true, { type: "turn_done" })).toBe(false);
    expect(runningAfterAgentEvent(false, { type: "agent_lifecycle", status: "completed", reason: "turn_completed" })).toBe(false);
    expect(runningAfterAgentEvent(false, { type: "agent_lifecycle", status: "running", reason: "active_run" })).toBe(true);
  });

  it("ignores an invalid cached message while appending streamed text", () => {
    const liveMessage: MessageDto = {
      id: "live-agent-thread-1-2",
      threadId: "thread-1",
      seq: 2,
      role: "assistant",
      text: "Hello",
      createdAt: "2026-07-11T08:00:00.000Z",
    };
    const detail = {
      messages: [undefined, liveMessage],
      tasks: [],
      artifacts: [],
      thread: { activeEngine: "codex" },
    } as unknown as ThreadDetailDto;
    const envelope = {
      seq: 3,
      ts: "2026-07-11T08:00:01.000Z",
      event: { type: "text", delta: " world" },
    } as SseEventEnvelope;

    expect(updateThreadDetail("thread-1", envelope, detail).messages).toEqual([
      { ...liveMessage, text: "Hello world" },
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
});
