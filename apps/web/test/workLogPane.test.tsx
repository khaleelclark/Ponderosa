import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkLogPane } from "../src/components/panes";
import { AGENT_DETAIL_TAB_LABELS } from "../src/components/AgentDetail";

describe("WorkLogPane", () => {
  it("is a dedicated agent-detail tab beside the existing panes", () => {
    expect(AGENT_DETAIL_TAB_LABELS).toEqual(["Chat", "Work log", "Activity", "Changed Files", "Review", "Runs", "Files & results"]);
  });

  it("renders completed responses and transient reasoning distinctly in chronological order", () => {
    const html = renderToStaticMarkup(<WorkLogPane entries={[
      {
        id: "later", agentId: "agent", executionId: "run-2", kind: "reasoning", text: "Checking constraints",
        completed: false, seq: 8, sourceSeqStart: 8, sourceSeqEnd: 8, createdAt: "2026-07-12T01:00:02.000Z",
      },
      {
        id: "earlier", agentId: "agent", executionId: "run-1", kind: "response", text: "Completed output",
        completed: true, seq: 4, sourceSeqStart: 2, sourceSeqEnd: 3, createdAt: "2026-07-12T01:00:01.000Z",
      },
    ]} />);

    expect(html).toContain('aria-label="Agent work log"');
    expect(html).toContain("Response");
    expect(html).toContain("Reasoning");
    expect(html.indexOf("Completed output")).toBeLessThan(html.indexOf("Checking constraints"));
  });
});
