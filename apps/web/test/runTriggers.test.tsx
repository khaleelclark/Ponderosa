import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunsPane } from "../src/components/panes.js";

describe("Runs trigger audit", () => {
  it("shows the accepted source message and structural trigger type", () => {
    const html = renderToStaticMarkup(<RunsPane
      tasks={[]}
      timeline={[]}
      runTriggers={[{
        triggerId: "event-1:agent:agent-1",
        projectId: "project-1",
        agentId: "agent-1",
        communicationEventId: "event-1",
        source: "project_request",
        createdAt: "2026-07-13T00:00:00.000Z",
      }]}
      messages={[{
        id: "message-1",
        agentId: "agent-1",
        seq: 1,
        role: "user",
        text: "Review the onboarding flow",
        createdAt: "2026-07-13T00:00:00.000Z",
        communicationEventId: "event-1",
      }]}
    />);

    expect(html).toContain("Starts &amp; deliveries");
    expect(html).toContain("Project request");
    expect(html).toContain("Review the onboarding flow");
  });
});
