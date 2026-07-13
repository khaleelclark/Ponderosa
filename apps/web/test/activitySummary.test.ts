import { describe, expect, it } from "vitest";
import { formatActivitySpan, groupActivityByExecution, summarizeActivityText } from "../src/components/panes";

describe("activity summaries", () => {
  it("collapses multiline output and bounds large payloads", () => {
    expect(summarizeActivityText("one\n  two\nthree", 80)).toBe("one two three");
    const summary = summarizeActivityText("x".repeat(1_000), 40);
    expect(summary).toHaveLength(40);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("groups durable activity by execution and preserves chronological order", () => {
    const groups = groupActivityByExecution([
      { id: "two", agentId: "agent", executionId: "run-a", seq: 2, createdAt: "2026-07-12T00:00:03.000Z", event: { type: "file_change", path: "a.ts", kind: "edit" } },
      { id: "three", agentId: "agent", executionId: "run-b", seq: 3, createdAt: "2026-07-12T00:01:00.000Z", event: { type: "test_result", passed: true, summary: "ok" } },
      { id: "one", agentId: "agent", executionId: "run-a", seq: 1, createdAt: "2026-07-12T00:00:01.000Z", event: { type: "command", command: "test", cwd: "/repo" } },
    ]);
    expect(groups.map((group) => [group.executionId, group.items.map((item) => item.id)])).toEqual([
      ["run-a", ["one", "two"]], ["run-b", ["three"]],
    ]);
    expect(formatActivitySpan(groups[0]!.firstAt, groups[0]!.lastAt)).toBe("2s activity span");
  });
});
