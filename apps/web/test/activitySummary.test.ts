import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityPane, diffLineKind, formatActivitySpan, groupActivityByExecution, resolveWorkspaceReviewPath, summarizeActivityText, unifiedDiffLineTotals } from "../src/components/panes";

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

  it("owns a keyboard-focusable bounded scroll region through the complete Agent pane height chain", () => {
    const activity = Array.from({ length: 80 }, (_, index) => ({
      id: `event-${index}`,
      agentId: "agent",
      executionId: "run-a",
      seq: index + 1,
      createdAt: new Date(Date.UTC(2026, 6, 12, 0, 0, index)).toISOString(),
      event: { type: "command" as const, command: `printf ${index}`, cwd: "/repo" },
    }));
    const markup = renderToStaticMarkup(createElement("div", { style: { height: 180, minHeight: 0, overflow: "hidden" } },
      createElement(ActivityPane, { activity, connected: true, running: false })));

    expect(markup).toContain("height:180px");
    expect(markup).toContain('data-testid="activity-scroll-region"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("overflow-y:auto");
    expect(markup).toContain("max-height:100%");
    expect(markup).toContain("height:100%");
    expect(markup).toContain("align-self:stretch");
    expect(markup).toContain("overscroll-behavior:contain");
    expect(markup).toContain("printf 79");
    const detailSource = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
    expect(detailSource).toContain('height: "100%", maxHeight: "100%", minHeight: 0');
    expect(detailSource).toContain('maxHeight: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid"');
    expect(detailSource).toContain('tab === "chat" || tab === "activity" || tab === "technical" ? "hidden" : "auto"');
    expect(detailSource).toContain('gridTemplateRows: tab === "chat" ? "auto minmax(0, 1fr)" : hasOlderTelemetry ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)"');
    expect(markup).toContain('data-testid="activity-execution"');
  });

  it("counts content lines without treating unified-diff headers as changes", () => {
    expect(unifiedDiffLineTotals(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+added",
    )).toEqual({ additions: 2, deletions: 1 });
    expect(unifiedDiffLineTotals("diff --git a/image.png b/image.png")).toBeUndefined();
    expect(diffLineKind("+added")).toBe("addition");
    expect(diffLineKind("-removed")).toBe("deletion");
    expect(diffLineKind("+++ b/file.ts")).toBe("neutral");
    expect(diffLineKind("--- a/file.ts")).toBe("neutral");
  });

  it("keeps an operator-selected review file until it disappears", () => {
    const changes = [{ path: "first.ts" }, { path: "selected.ts" }];
    expect(resolveWorkspaceReviewPath(changes, "selected.ts", "first.ts")).toBe("selected.ts");
    expect(resolveWorkspaceReviewPath([{ path: "first.ts" }], "selected.ts", "first.ts")).toBe("first.ts");
    expect(resolveWorkspaceReviewPath([{ path: "fallback.ts" }], "missing.ts", "also-missing.ts")).toBe("fallback.ts");
    expect(resolveWorkspaceReviewPath([], "missing.ts", "also-missing.ts")).toBeUndefined();
  });
});
import { readFileSync } from "node:fs";
