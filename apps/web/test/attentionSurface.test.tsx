import { Button } from "@mui/material";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { AttentionSurface } from "../src/components/AttentionSurface";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    Dialog: forwardRef<HTMLDivElement, { open: boolean; children?: ReactNode }>(({ open, children }, ref) =>
      open ? createElement("div", { ref, role: "dialog" }, children) : null),
  };
});

const notification: WorkspaceNotificationDto = {
  id: "issue-1",
  projectId: "project-1",
  conversationId: "chat-1",
  conversationIds: ["chat-1", "chat-2"],
  agentId: "manager",
  agentIds: ["manager", "worker"],
  kind: "operational",
  category: "coordination",
  severity: "attention",
  status: "open",
  title: "Worker's assignment needs a decision",
  body: "Ponderosa could not confirm whether the Agent finished or published a result.",
  createdAt: "2026-07-23T00:00:00.000Z",
  resolution: {
    kind: "coordination_request",
    traceId: "trace-1",
    requestId: "request-1",
    recipientAgentId: "worker",
    recipientTitle: "Worker",
    assignment: "Verify the release and report the evidence.",
    outcome: "outcome_unknown",
    retryAvailable: true,
  },
};

describe("current issue resolution surface", () => {
  it("keeps chat compact and opens a focused resolution dialog", () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    const view = create(<QueryClientProvider client={client}>
      <AttentionSurface
        notifications={[notification]}
        projectId="project-1"
        conversationId="chat-2"
        conversationAgentIds={["worker"]}
        onOpen={vi.fn()}
      />
    </QueryClientProvider>);

    const compact = JSON.stringify(view.toJSON());
    expect(compact).toContain("Worker's assignment needs a decision");
    expect(compact).not.toContain("Verify the release and report the evidence.");

    const resolveButton = view.root.findAllByType(Button).find((button) => button.props.children === "Resolve")!;
    act(() => resolveButton.props.onClick());

    const dialog = JSON.stringify(view.toJSON());
    expect(dialog).toContain("Current Issues");
    expect(dialog).toContain("Verify the release and report the evidence.");
    expect(dialog).toContain("Retry Assignment");
    expect(dialog).toContain("No Further Action");
    expect(dialog).toContain("Open Diagnostics");
    expect(dialog).not.toContain("needs your attention");
    view.unmount();
    client.clear();
  });
});
