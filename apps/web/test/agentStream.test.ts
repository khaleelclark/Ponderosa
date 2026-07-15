import type { SseEventEnvelope, AgentDetailDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { runningAfterAgentEvent, updateAgentDetail } from "../src/hooks/useAgentStream";
import { formatExecutionElapsed } from "../src/components/AgentDetail";

describe("updateAgentDetail", () => {
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
      runs: [], workItems: [], runTriggers: [], runOutput: [], activity: [], changedFiles: [], artifacts: [],
      activeWait: { waitId: "stale", mode: "any", expectedAgentIds: ["peer"], receivedAgentIds: [], quorum: 1, createdAt: "2026-07-11T07:59:00.000Z" },
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
    expect(started.activeWait).toBeUndefined();
  });

  it("updates and clears durable wait progress from canonical stream events", () => {
    const detail = {
      messages: [], runs: [], workItems: [], runTriggers: [], runOutput: [], activity: [], changedFiles: [], artifacts: [],
      agent: { activeEngine: "codex" },
    } as unknown as AgentDetailDto;
    const activeWait = {
      waitId: "wait-1", mode: "all" as const, expectedAgentIds: ["one", "two"],
      receivedAgentIds: ["one"], quorum: 2, createdAt: "2026-07-11T08:00:00.000Z",
    };
    const waiting = updateAgentDetail("agent-1", {
      seq: 2, ts: "2026-07-11T08:00:01.000Z", event: { type: "agent_wait_changed", activeWait },
    } as SseEventEnvelope, detail);
    const resumed = updateAgentDetail("agent-1", {
      seq: 3, ts: "2026-07-11T08:00:02.000Z", event: { type: "agent_wait_changed", activeWait: null },
    } as SseEventEnvelope, waiting);

    expect(waiting.activeWait).toEqual(activeWait);
    expect(resumed.activeWait).toBeUndefined();
  });

  it("keeps streamed response and reasoning deltas in distinct transient Work log entries", () => {
    const detail = {
      messages: [],
      runTriggers: [],
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
      runTriggers: [],
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
      expect.objectContaining({ id: "live-artifact-5", path: "src/app.ts" }),
    ]);
  });

  it("projects streamed execution activity and changed files without duplicating replay", () => {
    const detail = {
      messages: [], runTriggers: [], runOutput: [], activity: [], changedFiles: [], runs: [], workItems: [], artifacts: [],
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
});
