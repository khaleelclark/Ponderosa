import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ActivityPane, scrollActivityToCurrent } from "../src/components/panes";
import { AGENT_DETAIL_TAB_LABELS } from "../src/components/AgentDetail";

describe("merged Activity", () => {
  it("merges into Activity while the primary workspace exposes exactly the approved tabs", () => {
    expect(AGENT_DETAIL_TAB_LABELS).toEqual(["Chat", "Activity", "Triggers", "Files & Results", "Settings"]);
  });

  it("renders completed responses and transient reasoning distinctly in chronological order", () => {
    const html = renderToStaticMarkup(<ActivityPane activity={[]} connected running={false} runOutput={[
      {
        id: "later", agentId: "agent", executionId: "run-1", kind: "reasoning", text: "Checking constraints",
        completed: false, seq: 8, sourceSeqStart: 8, sourceSeqEnd: 8, createdAt: "2026-07-12T01:00:02.000Z",
      },
      {
        id: "earlier", agentId: "agent", executionId: "run-1", kind: "response", text: "Completed output",
        completed: true, seq: 4, sourceSeqStart: 2, sourceSeqEnd: 3, createdAt: "2026-07-12T01:00:01.000Z",
        fileActivity: [{
          path: "src/result.ts", kind: "edit", status: "completed", sourceSeq: 3,
          artifactId: "agent:a:3:0", previewable: true, additions: 2, deletions: 1,
        }],
      },
    ]} />);

    expect(html).toContain('aria-label="Agent activity"');
    expect(html).toContain("Response");
    expect(html).toContain("Thinking");
    expect(html).toContain("1 changed file");
    expect(html).toContain("+2");
    expect(html).toContain("−1");
    expect(html.indexOf("Completed output")).toBeLessThan(html.indexOf("Checking constraints"));
  });

  it("labels unpreviewable files for the Files & results fallback without rendering a diff", () => {
    const html = renderToStaticMarkup(<ActivityPane activity={[]} connected running={false} projectId="project" runOutput={[{
      id: "binary", agentId: "agent", executionId: "run-3", kind: "response", text: "Generated image",
      completed: true, seq: 10, sourceSeqStart: 9, sourceSeqEnd: 10, createdAt: "2026-07-12T01:00:03.000Z",
      fileActivity: [{
        path: "result.png", kind: "create", status: "completed", sourceSeq: 9,
        artifactId: "generated-9", artifactKind: "generated_file", previewable: false,
      }],
    }]} />);
    expect(html).toContain("Open file artifact for result.png");
    expect(html).toContain("Files &amp; Results");
    expect(html).toContain("Preview");
    expect(html).toContain("Download");
    expect(html).toContain("/api/projects/project/artifacts/generated-9/download");
    expect(html).not.toContain("diff --git");
  });

  it("offers and activates Back to Current Work when the current Run has no loaded entries", () => {
    const scrollNode = {
      scrollTop: 0,
      clientHeight: 100,
      scrollTo: vi.fn(),
    };
    const view = create(<ActivityPane
      activity={[]}
      connected
      running
      activeExecutionId="run-current"
      runs={[
        { id: "run-previous", agentId: "agent", engine: "codex", status: "completed", title: "Previous", startedAt: "2026-07-12T00:00:00.000Z", completedAt: "2026-07-12T00:01:00.000Z" },
        { id: "run-current", agentId: "agent", engine: "codex", status: "running", title: "Current", startedAt: "2026-07-12T01:00:00.000Z" },
      ]}
      runOutput={[{
        id: "previous-output", agentId: "agent", executionId: "run-previous", kind: "response", text: "Earlier work",
        completed: true, seq: 1, sourceSeqStart: 1, sourceSeqEnd: 1, createdAt: "2026-07-12T00:00:30.000Z",
      }]}
    />, {
      createNodeMock: (element) => element.props["data-testid"] === "activity-scroll-region" ? scrollNode : {},
    });
    const region = view.root.findByProps({ "data-testid": "activity-scroll-region" });
    scrollNode.scrollTop = 240;
    act(() => region.props.onScroll({ currentTarget: scrollNode }));
    expect(view.root.findByProps({ "aria-label": "Back to Current Work" })).toBeDefined();
    scrollActivityToCurrent(scrollNode as unknown as HTMLElement);
    expect(scrollNode.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    view.unmount();
  });
});
