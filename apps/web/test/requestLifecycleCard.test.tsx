import type {
  AgentWorkItemDetailsDto,
  ConversationMessageDto,
  TeamOperationalEventDto,
} from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { CollaborationTimeline } from "../src/components/ConversationView.parts";
import { RequestLifecycleCard } from "../src/components/RequestLifecycleCard";

const resultText = `${"A".repeat(1_000)}TAIL`;
const details: AgentWorkItemDetailsDto = {
  projectId: "project-1",
  itemId: "request:request-1",
  recordId: "request-1",
  details: [],
  requestLifecycle: {
    request: {
      id: "request-1",
      requesterAgentId: "manager",
      recipientAgentId: "candidate",
      state: "completed",
      version: 4,
      text: "Review the production architecture.",
      refs: [],
      communicationEventId: "communication-1",
      createdAt: "2026-07-27T10:00:00.000Z",
      updatedAt: "2026-07-27T10:04:00.000Z",
    },
    updates: [
      {
        id: "progress-1",
        kind: "progress",
        actorKind: "agent",
        actorId: "candidate",
        text: "Checking durability.",
        refs: [],
        artifacts: [],
        resultingState: "in_progress",
        resultingVersion: 1,
        createdAt: "2026-07-27T10:01:00.000Z",
      },
      {
        id: "question-1",
        kind: "question",
        actorKind: "agent",
        actorId: "candidate",
        text: "Should recovery favor availability?",
        refs: [],
        artifacts: [],
        resultingState: "awaiting_answer",
        resultingVersion: 2,
        createdAt: "2026-07-27T10:02:00.000Z",
      },
      {
        id: "answer-1",
        kind: "answer",
        actorKind: "agent",
        actorId: "manager",
        inReplyToUpdateId: "question-1",
        text: "Favor durable correctness.",
        refs: [],
        artifacts: [],
        resultingState: "in_progress",
        resultingVersion: 3,
        createdAt: "2026-07-27T10:03:00.000Z",
      },
      {
        id: "completed-1",
        kind: "completed",
        actorKind: "agent",
        actorId: "candidate",
        text: resultText,
        refs: ["ponderosa://artifact/artifact-1"],
        artifacts: [{
          id: "artifact-1",
          title: "Architecture result",
          mediaType: "text/markdown",
          byteLength: 12_000,
          previewUrl: "/api/projects/project-1/artifacts/artifact-1/preview",
          downloadUrl: "/api/projects/project-1/artifacts/artifact-1/download",
        }],
        resultingState: "completed",
        resultingVersion: 4,
        createdAt: "2026-07-27T10:04:00.000Z",
      },
    ],
  },
};

afterEach(() => vi.restoreAllMocks());

describe("RequestLifecycleCard", () => {
  it("loads updates only after expansion and relates questions, answers, and bounded results", async () => {
    const getDetails = vi
      .spyOn(api, "getAgentWorkItemDetails")
      .mockResolvedValue(details);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <RequestLifecycleCard
          projectId="project-1"
          conversationId="conversation-1"
          requestId="request-1"
          state="completed"
          requesterAgentId="manager"
          recipientAgentId="candidate"
          requestText="Review the production architecture."
          hasUpdates
          hasResult
          updatedAt="2026-07-27T10:04:00.000Z"
          agentTitle={(id) =>
            id === "manager" ? "Manager" : id === "candidate" ? "Candidate" : "Deleted Agent"}
        />
      </QueryClientProvider>,
    );

    expect(getDetails).not.toHaveBeenCalled();
    expect(screen.getByText("Result available")).toBeTruthy();
    await user.click(screen.getByRole("button", {
      name: "Expand updates for request from Manager to Candidate",
    }));

    await waitFor(() => expect(getDetails).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Question 1")).toBeTruthy();
    expect(screen.getByText("Answer to Question 1")).toBeTruthy();
    expect(screen.queryByText("TAIL")).toBeNull();

    await user.click(screen.getByRole("button", { name: "View full result" }));
    expect(screen.getByText(resultText)).toBeTruthy();
    expect(screen.getByRole("link", {
      name: "Open result Architecture result",
    }).getAttribute("href")).toBe(
      "/api/projects/project-1/artifacts/artifact-1/preview",
    );
  });

  it("groups a Request with its durable Communication instead of rendering duplicate rows", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const requestEvent: TeamOperationalEventDto = {
      id: "request:request-1",
      kind: "request",
      state: "in_progress",
      text: "Manager asked Candidate to work",
      agentIds: ["manager", "candidate"],
      createdAt: "2026-07-27T10:00:00.000Z",
      updatedAt: "2026-07-27T10:01:00.000Z",
      request: {
        recordId: "request-1",
        requesterAgentId: "manager",
        recipientAgentId: "candidate",
        communicationEventId: "communication-request-1",
        preview: "Review the production architecture.",
        hasUpdates: true,
        latestUpdateKind: "progress",
        latestUpdateAt: "2026-07-27T10:01:00.000Z",
        hasResult: false,
      },
    };
    const messages: ConversationMessageDto[] = [
      {
        id: "request-message",
        communicationEventId: "communication-request-1",
        conversationId: "conversation-1",
        role: "assistant",
        authorAgentId: "manager",
        text: "Review the production architecture.",
        createdAt: "2026-07-27T10:00:00.000Z",
      },
      {
        id: "ordinary-message",
        communicationEventId: "communication-ordinary",
        conversationId: "conversation-1",
        role: "assistant",
        authorAgentId: "candidate",
        text: "An ordinary Team Chat update.",
        createdAt: "2026-07-27T10:02:00.000Z",
      },
    ];
    render(
      <QueryClientProvider client={client}>
        <CollaborationTimeline
          operationalEventGroups={[{
            id: requestEvent.id,
            representative: requestEvent,
            events: [requestEvent],
          }]}
          expandedOperationalEventGroups={new Set()}
          setExpandedOperationalEventGroups={() => undefined}
          operationalEvents={[requestEvent]}
          collaborationMessages={messages}
          onOpenAgentWork={() => undefined}
          projectId="project-1"
          conversationId="conversation-1"
          healthByAgentId={new Map()}
          agentTitle={(id) =>
            id === "manager" ? "Manager" : id === "candidate" ? "Candidate" : "Deleted Agent"}
          agentIdForHandle={() => undefined}
          onOpenAgent={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(screen.getAllByText("“Review the production architecture.”")).toHaveLength(1);
    expect(screen.getByText("An ordinary Team Chat update.")).toBeTruthy();
  });
});
