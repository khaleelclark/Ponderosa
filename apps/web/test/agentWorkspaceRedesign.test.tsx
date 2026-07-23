import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentActivityDto, AgentRunDto, RunOutputDto } from "@ponderosa/core";
import { ActivityPane, mergeActivityByRun } from "../src/components/panes";
import { AGENT_DETAIL_TAB_LABELS } from "../src/components/AgentDetail";

const runs: AgentRunDto[] = [
  { id: "run-oldest", agentId: "agent", title: "First assignment", engine: "codex", status: "completed", startedAt: "2026-07-23T08:00:00.000Z", completedAt: "2026-07-23T08:01:00.000Z" },
  { id: "run-previous", agentId: "agent", title: "Previous assignment", engine: "codex", status: "completed", startedAt: "2026-07-23T09:00:00.000Z", completedAt: "2026-07-23T09:02:00.000Z" },
  { id: "run-current", agentId: "agent", title: "Current assignment", engine: "codex", status: "running", startedAt: "2026-07-23T10:00:00.000Z" },
];

const activity: AgentActivityDto[] = [
  { id: "command", agentId: "agent", executionId: "run-current", seq: 4, createdAt: "2026-07-23T10:00:04.000Z", event: { type: "command", command: "pnpm test", cwd: "/repo" } },
  { id: "tool", agentId: "agent", executionId: "run-previous", seq: 2, createdAt: "2026-07-23T09:00:02.000Z", event: { type: "tool_call", name: "read_file", input: { path: "a.ts" } } },
];

const runOutput: RunOutputDto[] = [
  { id: "thinking", agentId: "agent", executionId: "run-current", kind: "reasoning", text: "Inspecting the route contract", completed: true, seq: 3, sourceSeqStart: 3, sourceSeqEnd: 3, createdAt: "2026-07-23T10:00:03.000Z" },
  { id: "response", agentId: "agent", executionId: "run-current", kind: "response", text: "Verification passed", completed: true, seq: 5, sourceSeqStart: 5, sourceSeqEnd: 5, createdAt: "2026-07-23T10:00:05.000Z" },
];

describe("Agent workspace redesign", () => {
  it("exposes exactly the five approved primary tabs in order", () => {
    expect(AGENT_DETAIL_TAB_LABELS).toEqual(["Chat", "Activity", "Triggers", "Files & Results", "Settings"]);
  });

  it("interleaves work output and execution evidence, with current first and previous Runs newest-first", () => {
    const groups = mergeActivityByRun(activity, runOutput, runs, "run-current");
    expect(groups.map((group) => group.executionId)).toEqual(["run-current", "run-previous", "run-oldest"]);
    expect(groups[0]!.entries.map((entry) => [entry.type, entry.seq])).toEqual([
      ["work", 3],
      ["activity", 4],
      ["work", 5],
    ]);

    const html = renderToStaticMarkup(<ActivityPane
      activity={activity}
      runOutput={runOutput}
      runs={runs}
      connected
      running
      activeExecutionId="run-current"
    />);
    expect(html.indexOf("Current assignment")).toBeLessThan(html.indexOf("Previous assignment"));
    expect(html).toContain('data-current-run="true"');
    expect(html).toContain('data-current-run="false"');
    expect(html).toContain('data-activity-kind="reasoning"');
    expect(html).toContain('data-activity-kind="command"');
  });

  it("keeps history bounded and cursor-backed, and Technical Details read-only", () => {
    const detail = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
    const inspector = readFileSync(new URL("../src/components/AgentWorkInspector.tsx", import.meta.url), "utf8");
    const api = readFileSync(new URL("../src/api/real.ts", import.meta.url), "utf8");
    const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");

    expect(detail).toContain("useAgent(agentId, 100)");
    expect(detail).toContain('api.getAgentHistory(agentId, stream, 100, detail.telemetryHistory?.[stream]?.cursor)');
    expect(detail).toContain("Load Earlier Activity");
    expect(detail).toContain('aria-label="Agent settings"');
    expect(detail).toContain("apply only to the next Run");
    expect(detail).toContain('label: "Technical Details"');
    expect(inspector).toContain("Current State");
    expect(inspector).toContain("Coordination Timeline");
    expect(inspector).toContain("Execution History");
    expect(inspector).toContain("Advanced Technical Model");
    expect(inspector).toContain("limit: 200");
    expect(api).not.toContain("retryCoordinationRequest");
    expect(panes).not.toContain("Retry Assignment");
    expect(panes).not.toContain("Stop Assignment");
  });
});
