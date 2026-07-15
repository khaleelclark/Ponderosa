import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunsPane } from "../src/components/panes.js";

describe("Runs trigger audit", () => {
  it("shows the accepted source message and structural trigger type", () => {
    const html = renderToStaticMarkup(<RunsPane
      runs={[{
        id: "run-1",
        agentId: "agent-1",
        title: "Review onboarding",
        status: "completed",
        reason: "turn_completed",
        engine: "codex",
        wakeCause: "wait_satisfied",
        startedAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:01:00.000Z",
        completedAt: "2026-07-13T00:01:00.000Z",
      }]}
      activeWait={{
        waitId: "wait-1",
        mode: "all",
        expectedAgentIds: ["agent-2", "agent-3"],
        receivedAgentIds: ["agent-2"],
        quorum: 2,
        createdAt: "2026-07-13T00:00:00.000Z",
      }}
      workItems={[]}
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

    expect(html).toContain("Run triggers");
    expect(html).toContain("Project request");
    expect(html).toContain("Review the onboarding flow");
    expect(html).toContain("Waiting for reports: 1 of 2 received");
    expect(html).toContain("Started by Expected reports received");
  });
});
