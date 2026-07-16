import type { SseEventEnvelope, AgentDetailDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { reconcileAgentCursor, runningAfterAgentEvent, updateAgentDetail } from "../src/hooks/useAgentStream";
import { formatExecutionElapsed } from "../src/components/AgentDetail";

describe("updateAgentDetail", () => {
  it("detects gaps and duplicates with a constant-memory ordered cursor", () => {
    expect(reconcileAgentCursor(4, { seq: 4 })).toEqual({ cursor: 4, duplicate: true, gap: false });
    expect(reconcileAgentCursor(4, { seq: 5 })).toEqual({ cursor: 5, duplicate: false, gap: false });
    expect(reconcileAgentCursor(4, { seq: 7 })).toEqual({ cursor: 7, duplicate: false, gap: true });
  });
  it("formats a stable stopwatch from the canonical execution start", () => {
    expect(formatExecutionElapsed("2026-07-12T00:00:00.000Z", Date.parse("2026-07-12T00:02:03.000Z"))).toBe("2:03");
    expect(formatExecutionElapsed("2026-07-12T00:00:00.000Z", Date.parse("2026-07-12T01:02:03.000Z"))).toBe("1:02:03");
  });
  it("does not resurrect a finished run when its terminal lifecycle record arrives", () => {
    expect(runningAfterAgentEvent(true, { type: "turn_done" })).toBe(false);
    expect(runningAfterAgentEvent(false, { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run" })).toBe(false);
    expect(runningAfterAgentEvent(false, { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run" })).toBe(true);
  });

  it("projects lifecycle events onto the real execution id", () => {
    const detail = {
      messages: [{ id: "message", agentId: "agent-1", seq: 1, role: "user", text: "Inspect routing", createdAt: "2026-07-11T08:00:00.000Z", communicationEventId: "event-1" }],
      runs: [], workItems: [], runOutput: [], activity: [], changedFiles: [], artifacts: [],
      agent: { activeEngine: "codex" },
    } as unknown as AgentDetailDto;
    const started = updateAgentDetail("agent-1", {
      seq: 2, ts: "2026-07-11T08:00:01.000Z",
      event: { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-real" },
    } as SseEventEnvelope, detail);
    const completed = updateAgentDetail("agent-1", {
      seq: 3, ts: "2026-07-11T08:00:02.000Z",
      event: { type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run-real" },
    } as SseEventEnvelope, started);
    expect(completed.runs).toEqual([expect.objectContaining({
      id: "run-real", title: "Inspect routing", communicationEventId: "event-1", status: "completed",
    })]);
  });

  it("keeps streamed response and reasoning deltas in distinct transient Work log entries", () => {
    const detail = {
      messages: [],
      runOutput: [],
      activity: [],
      changedFiles: [],
      runs: [],
      workItems: [],
      artifacts: [],
      agent: { activeEngine: "codex" },
    } as unknown as AgentDetailDto;
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

    const updated = updateAgentDetail("agent-1", reasoning, updateAgentDetail("agent-1", response, detail));
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
        id: "live-runOutput:run-1:response", agentId: "agent-1", executionId: "run-1", kind: "response",
        text: "partial", completed: false, seq: 2, sourceSeqStart: 2, sourceSeqEnd: 2, createdAt: "2026-07-11T08:00:00.000Z",
      }],
      runs: [], workItems: [], artifacts: [], agent: { activeEngine: "codex" },
    } as unknown as AgentDetailDto;
    const envelope = {
      seq: 5,
      ts: "2026-07-11T08:00:03.000Z",
      event: { type: "agent_output", executionId: "run-1", text: "complete", sourceSeqStart: 2, sourceSeqEnd: 4 },
    } as SseEventEnvelope;

    expect(updateAgentDetail("agent-1", envelope, detail).runOutput).toEqual([
      expect.objectContaining({ kind: "response", text: "complete", completed: true, executionId: "run-1", seq: 5 }),
    ]);
  });

  it("ignores invalid cached work items while projecting a work-item update", () => {
    const detail = {
      messages: [],
      runs: [],
      workItems: [undefined],
      artifacts: [],
      agent: { activeEngine: "codex" },
    } as unknown as AgentDetailDto;
    const envelope = {
      seq: 4,
      ts: "2026-07-11T08:00:02.000Z",
      event: { type: "work_item_update", workItemId: "checks", title: "Run checks", status: "running", executionId: "run-1" },
    } as SseEventEnvelope;

    expect(updateAgentDetail("agent-1", envelope, detail).workItems).toEqual([
      expect.objectContaining({ id: "agent-1:work-item:checks", executionId: "run-1", title: "Run checks", status: "running" }),
    ]);
  });

  it("ignores invalid cached artifacts while projecting a file change", () => {
    const detail = {
      messages: [],
      runs: [], workItems: [],
      artifacts: [undefined],
      agent: { activeEngine: "codex" },
    } as unknown as AgentDetailDto;
    const envelope = {
      seq: 5,
      ts: "2026-07-11T08:00:03.000Z",
      event: { type: "file_change", path: "src/app.ts", kind: "modified" },
    } as SseEventEnvelope;

    expect(updateAgentDetail("agent-1", envelope, detail).artifacts).toEqual([
      expect.objectContaining({ id: "agent-1:a:5:0", path: "src/app.ts" }),
    ]);
  });

  it("keeps live and replayed file activity on the exact response without duplicates", () => {
    const detail = {
      messages: [], runOutput: [], activity: [], changedFiles: [], runs: [], workItems: [], artifacts: [],
      agent: { activeEngine: "codex" },
    } as unknown as AgentDetailDto;
    const started = updateAgentDetail("agent-1", {
      seq: 1, ts: "2026-07-11T08:00:00.000Z",
      event: { type: "agent_lifecycle", status: "running", reason: "active_run", executionId: "run-1" },
    } as SseEventEnvelope, detail);
    const responding = updateAgentDetail("agent-1", {
      seq: 2, ts: "2026-07-11T08:00:01.000Z",
      event: { type: "text", delta: "Working", executionId: "run-1" },
    } as SseEventEnvelope, started);
    const fileEnvelope = {
      seq: 3, ts: "2026-07-11T08:00:02.000Z",
      event: { type: "file_change", path: "src/live.ts", kind: "edit", diff: "--- a/src/live.ts\n+++ b/src/live.ts\n-old\n+new" },
    } as SseEventEnvelope;
    const live = updateAgentDetail("agent-1", fileEnvelope, responding);
    const replayed = updateAgentDetail("agent-1", { ...fileEnvelope, replayed: true }, live);
    expect(replayed.runOutput[0]?.fileActivity).toEqual([expect.objectContaining({
      path: "src/live.ts", status: "in_progress", additions: 1, deletions: 1,
      artifactId: "agent-1:a:3:0",
    })]);
    const completed = updateAgentDetail("agent-1", {
      seq: 4, ts: "2026-07-11T08:00:03.000Z",
      event: { type: "agent_output", executionId: "run-1", text: "Done", sourceSeqStart: 2, sourceSeqEnd: 3 },
    } as SseEventEnvelope, replayed);
    expect(completed.runOutput[0]?.fileActivity).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("projects streamed execution activity and changed files without duplicating replay", () => {
    const detail = {
      messages: [], runOutput: [], activity: [], changedFiles: [], runs: [], workItems: [], artifacts: [],
      agent: { activeEngine: "codex" },
    } as unknown as AgentDetailDto;
    const envelope = {
      seq: 9, ts: "2026-07-11T08:00:04.000Z",
      event: { type: "file_change", path: "src/index.ts", kind: "edit", diff: "+export {}" },
    } as SseEventEnvelope;
    const once = updateAgentDetail("agent-1", envelope, detail);
    const twice = updateAgentDetail("agent-1", { ...envelope, replayed: true }, once);
    expect(twice.activity).toEqual([expect.objectContaining({ seq: 9, event: envelope.event })]);
    expect(twice.changedFiles).toEqual([expect.objectContaining({ path: "src/index.ts", diff: "+export {}" })]);
  });

  it("keeps browser lifecycle in Activity and explicit screenshots in Files & results", () => {
    const detail = {
      messages: [], runOutput: [], activity: [], changedFiles: [], runs: [], workItems: [], artifacts: [],
      agent: { activeEngine: "codex", projectId: "project" },
    } as unknown as AgentDetailDto;
    const lifecycle = updateAgentDetail("agent-1", {
      seq: 10, ts: "2026-07-11T08:00:05.000Z",
      event: { type: "browser_session", sessionId: "browser", executionId: "run-1", status: "ready", controlOwner: "agent", controlEpoch: 1 },
    } as SseEventEnvelope, detail);
    const screenshot = updateAgentDetail("agent-1", {
      seq: 11, ts: "2026-07-11T08:00:06.000Z",
      event: { type: "browser_screenshot", sessionId: "browser", executionId: "run-1", path: "browser/frame.png", width: 1280, height: 720 },
    } as SseEventEnvelope, lifecycle);
    expect(screenshot.messages).toEqual([]);
    expect(screenshot.activity).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ type: "browser_session" }) }),
      expect.objectContaining({ event: expect.objectContaining({ type: "browser_screenshot" }) }),
    ]);
    expect(screenshot.artifacts).toEqual([expect.objectContaining({
      id: "agent-1:a:11:0", executionId: "run-1", kind: "screenshot", mediaType: "image/png",
    })]);
  });
});
