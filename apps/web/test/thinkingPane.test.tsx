import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThinkingPane } from "../src/components/panes";
import { AGENT_DETAIL_TAB_LABELS } from "../src/components/AgentDetail";

describe("ThinkingPane", () => {
  it("is a dedicated agent-detail tab beside the existing panes", () => {
    expect(AGENT_DETAIL_TAB_LABELS).toEqual(["Chat", "Thinking", "Activity", "Changed Files", "Review", "Tasks", "Artifacts"]);
  });

  it("renders completed responses and transient reasoning distinctly in chronological order", () => {
    const html = renderToStaticMarkup(<ThinkingPane entries={[
      {
        id: "later", threadId: "agent", executionId: "run-2", kind: "reasoning", text: "Checking constraints",
        completed: false, seq: 8, sourceSeqStart: 8, sourceSeqEnd: 8, createdAt: "2026-07-12T01:00:02.000Z",
      },
      {
        id: "earlier", threadId: "agent", executionId: "run-1", kind: "response", text: "Completed output",
        completed: true, seq: 4, sourceSeqStart: 2, sourceSeqEnd: 3, createdAt: "2026-07-12T01:00:01.000Z",
      },
    ]} />);

    expect(html).toContain('aria-label="Agent thinking"');
    expect(html).toContain("Response");
    expect(html).toContain("Reasoning");
    expect(html.indexOf("Completed output")).toBeLessThan(html.indexOf("Checking constraints"));
  });
});
