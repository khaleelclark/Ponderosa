import type { AgentRunDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { RunsPane } from "../src/components/panes";

describe("Run cause visibility", () => {
  it("shows the source manifest by default and opens the exact Agent Work trace", () => {
    const run = {
      id: "run-1",
      agentId: "agent-1",
      title: "Review result",
      status: "completed",
      reason: "turn_completed",
      engine: "codex",
      wakeCause: "collaboration",
      startedAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:01:00.000Z",
      completedAt: "2026-07-19T12:01:00.000Z",
      providerInput: {
        promptHash: "a".repeat(64),
        exactPromptAvailable: true,
        sourceManifest: {
          schemaVersion: 3,
          historyMessageCount: 1,
          retainedSessionSourceCount: 0,
          activationIds: ["activation-1", "activation-2"],
          communicationEventIds: ["message-1"],
          artifactIds: [],
          providerSessionDisposition: "fresh_task",
          sources: [
            { kind: "activation", ref: "activation-1", delivery: "submitted" },
            { kind: "activation", ref: "activation-2", delivery: "submitted" },
            { kind: "communication", ref: "message-1", delivery: "submitted" },
          ],
        },
      },
    } satisfies AgentRunDto;
    const onOpenAgentWork = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    act(() => {
      view = create(<QueryClientProvider client={client}><RunsPane
        runs={[run]}
        workItems={[]}
        timeline={[]}
        onOpenAgentWork={onOpenAgentWork}
      /></QueryClientProvider>);
    });

    const rendered = JSON.stringify(view.toJSON());
    expect(rendered).toContain("Why this Run started");
    expect(rendered).toContain("activation-1");
    expect(rendered).toContain("activation-2");
    expect(rendered).toContain("message-1");
    expect(rendered).toContain("Show exact provider input");
    const cause = view.root.findAll((node) => node.type === "button" && JSON.stringify(node.children).includes("Why this Run started"))[0]!;
    act(() => cause.props.onClick());
    expect(onOpenAgentWork).toHaveBeenCalledWith(run.id);
    view.unmount();
    client.clear();
  });
});
