import type {
  AllChatPageDto,
  ProjectDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AllChatView } from "../src/components/AllChatView";
import { queryKeys } from "../src/queryKeys";

const createdAt = "2026-08-01T20:00:00.000Z";
const project: ProjectDto = {
  id: "project-one",
  label: "Testing",
  hostPath: "/tmp/testing",
  defaultEngine: "codex",
  createdAt,
};
const preferences: WorkspacePreferencesDto = {
  projectSort: "last_used",
  projectOrder: [],
  starredProjectIds: [],
  sidebarCollapsed: false,
  sidebarWidth: 320,
  notifications: {
    mentions: true,
    directReplies: true,
    projectChatMessages: true,
    broadcasts: true,
    allMessages: false,
  },
  fontFamily: "inter",
  providerAvailability: {},
  engineDefaults: {},
  claudeModelOptions: [],
  globalInstructions: "",
  maxConcurrentAgentRuns: 8,
  contextRolloverEnabled: true,
  contextRolloverTokens: 120_000,
  contextRolloverWindowFraction: 0.8,
  onboardingCompletedAt: createdAt,
  profile: {
    displayName: "Operator",
    handle: "operator",
    avatarId: "default-user",
  },
  updatedAt: createdAt,
};

describe("All Messages mention presentation", () => {
  it("highlights punctuation-delimited authored handles after rename and deletion", () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const page: AllChatPageDto = {
      items: [{
        communicationEventId: "communication-one",
        messageId: "message-one",
        communicationIntent: "user_dm",
        directMessageAgents: [
          { id: "agent-oak", title: "Redwood" },
          { id: "agent-pine", title: "Pine" },
        ],
        agentMentions: [
          { handle: "Oak", agentId: "agent-oak" },
          { handle: "Pine", agentId: "agent-pine" },
        ],
        project: { id: project.id, label: project.label },
        source: {
          kind: "project",
          conversationId: "conversation-one",
          title: "Primary",
        },
        author: { kind: "user", label: "User" },
        text: "(#Oak), (#Pine) Private update",
        createdAt,
      }],
      decisions: [],
      history: { limit: 50, hasMore: false },
    };
    client.setQueryData(queryKeys.allChat(50), page);
    client.setQueryData(queryKeys.workspacePreferences.all, preferences);
    client.setQueryData(queryKeys.engines.all, []);
    client.setQueryData(queryKeys.projects.all, [project]);

    render(
      <QueryClientProvider client={client}>
        <AllChatView onNavigate={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", { name: "Open agent Oak" }).textContent)
      .toBe("#Oak");
    expect(screen.getByRole("button", { name: "Open agent Pine" }).textContent)
      .toBe("#Pine");
    expect(screen.getByRole("article", {
      name: /\(#Oak\), \(#Pine\) Private update/u,
    }).textContent).toContain("(#Oak), (#Pine) Private update");
  });
});
